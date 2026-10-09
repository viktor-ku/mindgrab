pub mod auth;
pub mod config;
pub mod error;
mod limits;
mod projects;

use crate::{auth::Auth, config::Config, error::Result};
use axum::{
    Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, header},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use sqlx::{
    PgPool,
    postgres::{PgListener, PgPoolOptions},
};
use std::{sync::Arc, time::Duration};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

pub struct Backend {
    limits: limits::RateLimits,
    pub pool: PgPool,
    pub auth: Auth,
    pub config: Config,
    pub changes: broadcast::Sender<String>,
}
impl Backend {
    pub async fn connect(config: Config) -> Result<Arc<Self>> {
        let pool = PgPoolOptions::new()
            .max_connections(16)
            .acquire_timeout(Duration::from_secs(8))
            .connect(&config.database_url)
            .await?;
        sqlx::raw_sql(include_str!("../schema.sql"))
            .execute(&pool)
            .await?;
        let (changes, _) = broadcast::channel(256);
        let app = Arc::new(Self {
            limits: limits::RateLimits::default(),
            auth: Auth::new(pool.clone(), config.clone()),
            pool,
            config,
            changes,
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
                header::HeaderName::from_static("x-mindgrab-account"),
            ])
            .expose_headers([header::HeaderName::from_static("server-timing")]);
        Router::new()
            .route("/api/auth/callback", get(projects::callback))
            .route("/api/{method}", post(projects::rpc))
            .route("/sync/loro/{id}", get(projects::socket))
            .layer(DefaultBodyLimit::max(
                mindgrab_state::MAX_SNAPSHOT_BYTES + 4096,
            ))
            .layer(middleware::from_fn_with_state(self.clone(), limits::guard))
            .layer(middleware::from_fn(no_store))
            .layer(cors)
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
