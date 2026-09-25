mod auth;
mod config;
mod health;
mod local_seed;
mod workos;

use std::{sync::Arc, time::Duration};

use axum::{Router, http::HeaderName, http::HeaderValue, http::header, routing::get};
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
            eprintln!("Skipping local development user seed: DATABASE_URL is not a loopback mindgrab database");
        }
    }

    let cleanup_pool = pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            for query in [
                "DELETE FROM auth_sessions WHERE expires_at <= NOW()",
                "DELETE FROM auth_login_attempts WHERE expires_at <= NOW()",
            ] {
                if sqlx::query(query).execute(&cleanup_pool).await.is_err() {
                    eprintln!("Could not clean up expired authentication records");
                }
            }
        }
    });

    let workos = workos::WorkOs::new(&config)?;
    let cors = cors_layer(&config)?;
    let health = health::router(pool.clone());
    let state = Arc::new(auth::AppState {
        config,
        pool,
        workos,
    });
    let app = Router::new()
        .route("/", get(|| async { "Mindgrab API" }))
        .merge(health)
        .merge(auth::router(state))
        .layer(cors);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    println!("Mindgrab API listening on http://localhost:3000");
    axum::serve(listener, app).await?;
    Ok(())
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
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
        ])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .expose_headers([HeaderName::from_static("server-timing")]))
}

#[cfg(test)]
mod tests {
    use axum::{Router, body::Body, http::Request, routing::get};
    use tower::ServiceExt;

    use super::*;

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
            .route("/api/me", get(|| async { "ok" }))
            .layer(cors_layer(config).unwrap())
    }

    #[tokio::test]
    async fn local_development_allows_any_origin_without_credentials() {
        let response = test_app(&config("http://localhost:5173/"))
            .oneshot(
                Request::builder()
                    .uri("/api/me")
                    .header(header::ORIGIN, "http://unconfigured.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert!(
            !response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
        );
    }

    #[tokio::test]
    async fn production_allows_only_the_configured_origin_with_credentials() {
        let app = test_app(&config("https://mindgrab.example/"));
        let allowed = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/me")
                    .header(header::ORIGIN, "https://mindgrab.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            allowed.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://mindgrab.example"
        );
        assert_eq!(
            allowed.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS],
            "true"
        );
        assert_eq!(
            allowed.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS],
            "server-timing"
        );

        let rejected = app
            .oneshot(
                Request::builder()
                    .uri("/api/me")
                    .header(header::ORIGIN, "https://attacker.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            !rejected
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }
}
