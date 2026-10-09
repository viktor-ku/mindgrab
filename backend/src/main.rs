use mindgrab_backend::{Backend, config::Config};
use std::{path::PathBuf, time::Duration};
use tower_http::services::{ServeDir, ServeFile};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let _ = dotenvy::dotenv();
    if run().await.is_err() {
        eprintln!(
            "Rust backend startup failed; check database connectivity and WorkOS configuration"
        );
        std::process::exit(1);
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let app = Backend::connect(config).await?;
    let changes = tokio::spawn(app.clone().listen_changes());
    let cleanup = tokio::spawn(app.clone().cleanup());
    let root = std::env::var("WEBAPP_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../webapp/dist"));
    let router = app.router().fallback_service(
        ServeDir::new(&root).not_found_service(ServeFile::new(root.join("index.html"))),
    );
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".into())
        .parse()?;
    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let listener = tokio::net::TcpListener::bind(format!("{host}:{port}")).await?;
    println!(
        "Mindgrab Rust API listening on http://{}",
        listener.local_addr()?
    );
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            tokio::select! { _=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
    })
    .await?;
    changes.abort();
    cleanup.abort();
    tokio::time::timeout(Duration::from_secs(5), app.pool.close()).await?;
    Ok(())
}
