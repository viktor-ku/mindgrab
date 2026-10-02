mod api;
mod auth;
mod config;
mod local_seed;
mod project;
mod rate_limits;
mod request_validation;
mod response_headers;
mod workos;

use std::{sync::Arc, time::Duration};

use axum::{Router, http::HeaderName, http::HeaderValue, http::header, routing::get};
use axum_login::tower_sessions::ExpiredDeletion;
use axum_server_timing::ServerTimingLayer;
use config::Config;
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Searches parent directories; process environment takes precedence.
    match dotenvy::dotenv() {
        Ok(_) => {}
        Err(error) if error.not_found() => {}
        Err(_) => return Err("Could not parse .env".into()),
    }
    tracing_subscriber::fmt::init();
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["reset-legacy-projects"] {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&std::env::var("DATABASE_URL")?)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        project::cutover::reset_legacy_projects(&pool).await?;
        println!("Obsolete snapshot tables removed; Yjs projects, users and sessions retained");
        return Ok(());
    }
    if args == ["rebuild-read-models"] {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        project::read_model::rebuild_all(&pool)
            .await
            .map_err(|_| "Read-model rebuild failed; see project errors above")?;
        println!("Read models rebuilt from canonical binary storage");
        return Ok(());
    }
    if !args.is_empty() {
        let usage = "Usage: server [reset-legacy-projects | rebuild-read-models | compact-project <uuid> <owner-external-id> | backup-project <uuid> <owner-external-id> <file> | restore-project <uuid> <source-owner-external-id> <destination-owner-external-id> <file>]";
        let expected = match args[0].as_str() {
            "compact-project" => 3,
            "backup-project" => 4,
            "restore-project" => 5,
            _ => return Err(usage.into()),
        };
        if args.len() != expected {
            return Err(usage.into());
        }
        let id = project::parse_new_project_id(&args[1]).map_err(|_| "Invalid project UUID")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&std::env::var("DATABASE_URL")?)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        match args[0].as_str() {
            "compact-project" => {
                let owner = project::updates::backup::owner(&pool, &args[2])
                    .await
                    .map_err(|_| "Owner not found")?;
                let metrics = project::updates::maintenance::compact(&pool, owner, id)
                    .await
                    .map_err(|_| "Compaction failed; source rows retained")?;
                println!("{}", serde_json::to_string(&metrics)?);
            }
            "backup-project" => {
                let archive = project::updates::backup::export(&pool, id, &args[2])
                    .await
                    .map_err(|_| "Backup validation failed")?;
                archive.write(std::path::Path::new(&args[3]))?;
                println!("Binary backup written for project {id}");
            }
            "restore-project" => {
                let archive =
                    project::updates::backup::Archive::read(std::path::Path::new(&args[4]))?;
                project::updates::backup::restore(&pool, id, &args[2], &args[3], archive)
                    .await
                    .map_err(
                        |_| "Restore refused or rolled back; check identities, archive and storage",
                    )?;
                println!("Canonical binary state restored for project {id}");
                let owner = project::updates::backup::owner(&pool, &args[3])
                    .await
                    .map_err(|_| "Owner not found")?;
                project::read_model::rebuild_project(&pool, owner, id).await.map_err(|_| "Binary restore committed; read-model rebuild failed. Run rebuild-read-models")?;
                println!("Read models rebuilt");
            }
            _ => unreachable!(),
        }
        return Ok(());
    }
    let config = Config::from_env()?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    if config.is_local() {
        if local_seed::is_local_mindgrab_database(&config.database_url) {
            local_seed::seed_user(&pool).await?;
        } else {
            eprintln!(
                "Skipping local development user seed: DATABASE_URL is not a loopback mindgrab database"
            );
        }
    }

    project::read_model::start_worker(pool.clone());
    project::updates::maintenance::start_worker(pool.clone());

    let cleanup_pool = pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            let sessions = auth::store::Store(cleanup_pool.clone())
                .delete_expired()
                .await;
            let attempts = sqlx::query("DELETE FROM auth_login_attempts WHERE expires_at <= NOW()")
                .execute(&cleanup_pool)
                .await;
            if sessions.is_err() || attempts.is_err() {
                eprintln!("Could not clean up expired authentication records");
            }
        }
    });

    let workos = workos::WorkOs::new(&config)?;
    let cors = cors_layer(&config)?;
    let state = Arc::new(auth::AppState {
        config,
        pool,
        workos,
    });
    let limits = rate_limits::RateLimits::default();
    let app = router_with_limits(state, &limits).layer(cors);
    limits.start_cleanup();
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    println!("Mindgrab API listening on http://localhost:3000");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
fn router(state: Arc<auth::AppState>) -> Router {
    router_with_limits(state, &rate_limits::RateLimits::default())
}

fn router_with_limits(state: Arc<auth::AppState>, limits: &rate_limits::RateLimits) -> Router {
    Router::new()
        .merge(api::router(state.clone(), limits))
        .merge(auth::router(state.clone(), limits))
        .merge(project::router(state, limits))
        .layer(response_headers::private_headers())
        // Wrap private routes and their rejecting layers; CORS stays outside.
        .layer(ServerTimingLayer::new("request"))
        .route("/", get(|| async { "Mindgrab API" }))
}

fn cors_layer(config: &Config) -> Result<CorsLayer, axum::http::header::InvalidHeaderValue> {
    let local = config.is_local();
    let origin: AllowOrigin = if local {
        Any.into()
    } else {
        AllowOrigin::list([config.origin().parse::<HeaderValue>()?])
    };

    Ok(CorsLayer::new()
        .allow_origin(origin)
        .allow_credentials(!local)
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            HeaderName::from_static("x-mindgrab-schema-version"),
            HeaderName::from_static("x-mindgrab-account"),
        ])
        .expose_headers([
            HeaderName::from_static("server-timing"),
            header::RETRY_AFTER,
        ]))
}

#[cfg(test)]
mod tests {
    use crate::response_headers::assert_private_headers;
    use axum::{
        body::Body,
        http::{HeaderMap, Request, StatusCode, request::Builder},
        response::Response,
        routing::post,
    };
    use tower::ServiceExt;

    use super::*;

    const ORIGIN: &str = "https://mindgrab.example";
    const CORS_HEADERS: &[(&str, &str)] = &[
        ("access-control-allow-origin", ORIGIN),
        ("access-control-allow-credentials", "true"),
        ("access-control-expose-headers", "server-timing,retry-after"),
    ];

    async fn send(app: &Router, request: Builder) -> Response {
        app.clone()
            .oneshot(
                request
                    .extension(rate_limits::test_peer())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    fn assert_headers(headers: &HeaderMap, expected: &[(&str, &str)]) {
        for (name, value) in expected {
            assert_eq!(headers[*name], *value, "{name}");
        }
    }

    pub(crate) fn timing_duration(headers: &HeaderMap, name: &str) -> f64 {
        let durations: Vec<f64> = headers
            .get_all("server-timing")
            .iter()
            .flat_map(|value| value.to_str().unwrap().split(','))
            .filter_map(|metric| {
                let (metric_name, duration) = metric.trim().split_once(";dur=").unwrap();
                (metric_name == name).then(|| duration.parse().unwrap())
            })
            .collect();
        assert_eq!(durations.len(), 1, "expected one {name} metric");
        assert!(durations[0].is_finite() && durations[0] >= 0.0);
        durations[0]
    }

    fn config(app_url: &str) -> Config {
        Config {
            database_url: String::new(),
            client_id: String::new(),
            api_key: String::new(),
            redirect_uri: String::new(),
            app_url: app_url.to_owned(),
            issuer: String::new(),
            secure_cookies: app_url.starts_with("https://"),
        }
    }

    fn test_app(config: &Config) -> Router {
        Router::new()
            .route("/api/getMe", post(|| async { "ok" }))
            .layer(cors_layer(config).unwrap())
    }

    #[sqlx::test]
    async fn private_router_boundaries_cover_redirects_and_rejections(pool: sqlx::PgPool) {
        const CALLBACK: &str = "/api/auth/callback";
        const SYNC: &str = "/sync/v1/10000000-0000-4000-8000-000000000000";
        let f = auth::tests::fixture(pool).await;
        let app = router(f.state.clone());
        for (method, path, status) in [
            ("GET", CALLBACK, StatusCode::SEE_OTHER),
            (
                "GET",
                "/api/auth/callback?code=one&code=two",
                StatusCode::BAD_REQUEST,
            ),
            ("POST", CALLBACK, StatusCode::METHOD_NOT_ALLOWED),
            ("GET", "/api/projects", StatusCode::UPGRADE_REQUIRED),
            ("PUT", "/api/projects", StatusCode::UPGRADE_REQUIRED),
            ("POST", "/api/projects", StatusCode::METHOD_NOT_ALLOWED),
            ("GET", SYNC, StatusCode::FORBIDDEN),
            ("POST", SYNC, StatusCode::METHOD_NOT_ALLOWED),
        ] {
            let response = send(&app, Request::builder().method(method).uri(path)).await;
            assert_eq!(response.status(), status, "{method} {path}");
            assert_private_headers(response.headers());
            timing_duration(response.headers(), "request");
        }
        let invalid_upgrade = send(
            &app,
            Request::get(SYNC).header(header::ORIGIN, f.state.config.origin()),
        )
        .await;
        // Shared authentication now rejects anonymous clients before upgrade
        // extraction, using the same JSON contract as the protected RPC routes.
        assert_eq!(invalid_upgrade.status(), StatusCode::UNAUTHORIZED);
        let root = send(&app, Request::get("/")).await;
        assert_eq!(root.status(), StatusCode::OK);
        assert!(!root.headers().contains_key(header::CACHE_CONTROL));
        assert!(!root.headers().contains_key(header::REFERRER_POLICY));
        assert!(!root.headers().contains_key("server-timing"));
        // Merged private routers also layer the default fallback, as before.
        let missing = send(&app, Request::get("/missing")).await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_private_headers(missing.headers());
        timing_duration(missing.headers(), "request");
    }

    #[sqlx::test]
    async fn private_headers_compose_with_production_cors(pool: sqlx::PgPool) {
        let mut f = auth::tests::fixture(pool).await;
        let config = &mut Arc::get_mut(&mut f.state).unwrap().config;
        config.app_url = format!("{ORIGIN}/");
        config.secure_cookies = true;
        let app = router(f.state.clone()).layer(cors_layer(&f.state.config).unwrap());
        for (method, path, status) in [
            ("POST", "/api/getHealth", StatusCode::OK),
            ("POST", "/api/getMe", StatusCode::UNAUTHORIZED),
            ("GET", "/api/getMe", StatusCode::METHOD_NOT_ALLOWED),
            ("POST", "/api/startLogin", StatusCode::SEE_OTHER),
            ("GET", "/api/auth/callback", StatusCode::SEE_OTHER),
        ] {
            let request = Request::builder()
                .method(method)
                .uri(path)
                .header(header::ORIGIN, ORIGIN);
            let response = send(&app, request).await;
            assert_eq!(response.status(), status, "{method} {path}");
            assert_private_headers(response.headers());
            assert_headers(response.headers(), CORS_HEADERS);
            timing_duration(response.headers(), "request");
            if path == "/api/startLogin" {
                let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
                for attribute in [
                    "HttpOnly",
                    "SameSite=Lax",
                    "Secure",
                    "Path=/",
                    "Max-Age=600",
                ] {
                    assert!(cookie.contains(attribute), "{attribute}");
                }
            }
        }
        // The existing outer CorsLayer answers preflights before private routers.
        let preflight = send(
            &app,
            Request::builder()
                .method("OPTIONS")
                .uri("/api/submitProjectUpdate")
                .header(header::ORIGIN, ORIGIN)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(
                    header::ACCESS_CONTROL_REQUEST_HEADERS,
                    "content-type,x-mindgrab-account",
                ),
        )
        .await;
        assert_eq!(preflight.status(), StatusCode::OK);
        assert_headers(preflight.headers(), &CORS_HEADERS[..2]);
        assert_eq!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
            "GET,POST"
        );
        assert!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS]
                .to_str()
                .unwrap()
                .contains("x-mindgrab-account")
        );
        assert!(!preflight.headers().contains_key(header::CACHE_CONTROL));
        assert!(!preflight.headers().contains_key(header::REFERRER_POLICY));
        assert!(!preflight.headers().contains_key("server-timing"));
    }

    #[tokio::test]
    async fn local_development_allows_any_origin_without_credentials() {
        let app = test_app(&config("http://localhost:5173/"));
        let response = send(
            &app,
            Request::post("/api/getMe").header(header::ORIGIN, "http://unconfigured.example"),
        )
        .await;
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert!(
            !response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
        );
    }

    #[tokio::test]
    async fn production_allows_only_the_configured_origin_with_credentials() {
        let app = test_app(&config(&format!("{ORIGIN}/")));
        let allowed = send(
            &app,
            Request::post("/api/getMe").header(header::ORIGIN, ORIGIN),
        )
        .await;
        assert_headers(allowed.headers(), CORS_HEADERS);
        let rejected = send(
            &app,
            Request::post("/api/getMe").header(header::ORIGIN, "https://attacker.example"),
        )
        .await;
        assert!(
            !rejected
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }
}
