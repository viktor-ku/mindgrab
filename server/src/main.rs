mod auth;
mod config;
mod workos;

use std::{sync::Arc, time::Duration};

use axum::{Router, routing::get};
use config::Config;
use sqlx::postgres::PgPoolOptions;

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
    let state = Arc::new(auth::AppState {
        config,
        pool,
        workos,
    });
    let app = Router::new()
        .route("/", get(|| async { "Mindgrab API" }))
        .merge(auth::router(state));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    println!("Mindgrab API listening on http://localhost:3000");
    axum::serve(listener, app).await?;
    Ok(())
}
