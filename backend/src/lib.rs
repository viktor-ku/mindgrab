pub mod analytics;
pub mod auth;
mod compute;
pub mod config;
mod disguise;
pub mod error;
mod phpmyadmin;
mod projects;

use crate::{analytics::Analytics, auth::Auth, compute::Compute, config::Config, error::Result};
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, RawQuery, Request, State},
    http::{HeaderMap, HeaderValue, header},
    middleware::{self, Next},
    response::Response,
    routing::{MethodRouter, any, get, post},
};
use sqlx::{
    PgPool,
    postgres::{PgConnectOptions, PgListener, PgPoolOptions},
};
use std::{sync::Arc, time::Duration};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

pub struct Backend {
    pub pool: PgPool,
    pub auth: Auth,
    pub analytics: Analytics,
    pub config: Config,
    pub changes: broadcast::Sender<String>,
    compute: Compute,
}
impl Backend {
    pub async fn connect(config: Config) -> Result<Arc<Self>> {
        // No statement, lock wait or idle transaction may keep a connection for
        // long: there are only a few, and every request needs one.
        let options = config.database_url.parse::<PgConnectOptions>()?.options([
            ("lock_timeout", "5s"),
            ("statement_timeout", "15s"),
            ("idle_in_transaction_session_timeout", "15s"),
        ]);
        let pool = PgPoolOptions::new()
            .max_connections(16)
            .acquire_timeout(Duration::from_secs(8))
            .connect_with(options)
            .await?;
        sqlx::raw_sql(include_str!("../schema.sql"))
            .execute(&pool)
            .await?;
        let (changes, _) = broadcast::channel(256);
        let app = Arc::new(Self {
            auth: Auth::new(pool.clone(), config.clone()),
            analytics: Analytics::new(config.posthog.clone()),
            pool,
            config,
            changes,
            compute: Compute::new(),
        });
        Ok(app)
    }
    pub fn router(self: &Arc<Self>) -> Router {
        let cors = CorsLayer::new()
            .allow_origin(self.config.origin().parse::<HeaderValue>().unwrap())
            .allow_credentials(true)
            .allow_methods([axum::http::Method::POST, axum::http::Method::GET])
            .allow_headers([
                header::CONTENT_TYPE,
                header::HeaderName::from_static("x-mindgrab-account.php"),
            ])
            .expose_headers([header::HeaderName::from_static("server-timing")])
            // The allowed origin is constant, so nothing varies. The default list
            // of three request headers is tower-http's alone and would name it.
            .vary([])
            // Every API POST is preflighted because the webapp is on another origin.
            .max_age(Duration::from_secs(3600));
        Router::new()
            // PHP runs a script for any method, and `/` is the directory's index.
            .route("/", any(projects::index))
            .route("/index.php", any(projects::index))
            .route("/api/auth/callback.php", get(projects::callback))
            .route("/api/getHealth.php", rpc("getHealth"))
            .route("/api/startLogin.php", rpc("startLogin"))
            .route("/api/logout.php", rpc("logout"))
            .route("/api/getMe.php", rpc("getMe"))
            .route("/api/getSharedProject.php", rpc("getSharedProject"))
            .route("/api/createProject.php", rpc("createProject"))
            .route("/api/deleteProject.php", rpc("deleteProject"))
            .route("/api/mergeProject.php", rpc("mergeProject"))
            .route("/api/commandProject.php", rpc("commandProject"))
            .route("/api/setShareLink.php", rpc("setShareLink"))
            .route("/api/listProjects.php", rpc("listProjects"))
            .route("/api/getProjectSnapshot.php", rpc("getProjectSnapshot"))
            .route("/api/getProjectState.php", rpc("getProjectState"))
            .route("/api/getShareLink.php", rpc("getShareLink"))
            .route("/ws/project/{id}", get(projects::socket))
            .route("/ws/share/{token}", get(projects::shared_socket))
            .route(
                "/ingest.php/{*path}",
                get(analytics::ingest).post(analytics::ingest),
            )
            .merge(phpmyadmin::routes())
            .fallback(disguise::missing)
            .layer(DefaultBodyLimit::max(
                mindgrab_state::MAX_SNAPSHOT_BYTES + 4096,
            ))
            .layer(middleware::from_fn(no_store))
            .layer(cors)
            .layer(middleware::from_fn(disguise::apply))
            .with_state(self.clone())
    }
    /// Postgres notifications are commit-ordered and reach every Rust process.
    /// Periodic client reconciliation also recovers notifications lost on reconnect.
    pub async fn listen_changes(self: Arc<Self>) {
        loop {
            match PgListener::connect_with(&self.pool).await {
                Ok(mut listener) => {
                    if listener.listen("mindgrab_loro").await.is_ok() {
                        while let Ok(notification) = listener.recv().await {
                            let _ = self.changes.send(notification.payload().to_string());
                        }
                    }
                }
                Err(_) => tracing::warn!("Database notification connection unavailable"),
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    pub async fn cleanup(self: Arc<Self>) {
        let mut timer = tokio::time::interval(Duration::from_secs(3600));
        loop {
            timer.tick().await;
            let _ = sqlx::query("DELETE FROM mindgrab_loro.sessions WHERE expires_at<=now()")
                .execute(&self.pool)
                .await;
            let _ = sqlx::query("DELETE FROM mindgrab_loro.login_attempts WHERE expires_at<=now()")
                .execute(&self.pool)
                .await;
        }
    }
}
/// Handles one RPC method at its own path through the shared `projects::rpc` dispatch.
fn rpc(method: &'static str) -> MethodRouter<Arc<Backend>> {
    post(
        move |state: AppState, headers: HeaderMap, query: RawQuery, body: Bytes| {
            projects::rpc(state, method, headers, query, body)
        },
    )
}
async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
pub(crate) type AppState = State<Arc<Backend>>;
