use std::time::{Duration, Instant};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderName, StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use serde::Serialize;
use sqlx::PgPool;

const DATABASE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Ok,
    Degraded,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum ComponentStatus {
    Up,
    Down,
}

#[derive(Serialize)]
struct Component {
    status: ComponentStatus,
    latency_ms: Option<f64>,
}

#[derive(Serialize)]
struct Health {
    status: Status,
    database: Component,
}

pub fn router(pool: PgPool) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .with_state(pool)
}

async fn health(State(pool): State<PgPool>) -> impl IntoResponse {
    let started = Instant::now();
    let reachable = matches!(
        tokio::time::timeout(
            DATABASE_TIMEOUT,
            sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&pool),
        )
        .await,
        Ok(Ok(1))
    );
    let latency = (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0;
    let timing = format!("db;dur={latency}");
    let (status, code, database) = if reachable {
        (
            Status::Ok,
            StatusCode::OK,
            Component {
                status: ComponentStatus::Up,
                latency_ms: Some(latency),
            },
        )
    } else {
        (
            Status::Degraded,
            StatusCode::SERVICE_UNAVAILABLE,
            Component {
                status: ComponentStatus::Down,
                latency_ms: None,
            },
        )
    };
    (
        code,
        [
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (HeaderName::from_static("server-timing"), timing),
        ],
        Json(Health { status, database }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use serde_json::Value;
    use tower::ServiceExt;

    async fn check(pool: PgPool) -> (StatusCode, Value) {
        let response = router(pool)
            .oneshot(
                axum::http::Request::get("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let timing = response.headers()["server-timing"].to_str().unwrap();
        let duration: f64 = timing.strip_prefix("db;dur=").unwrap().parse().unwrap();
        assert!(duration >= 0.0);
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[sqlx::test]
    async fn reports_reachable_database_with_latency(pool: PgPool) {
        let (status, body) = check(pool).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["database"]["status"], "up");
        assert!(body["database"]["latency_ms"].as_f64().unwrap() >= 0.0);
        assert_eq!(body.as_object().unwrap().len(), 2);
        assert_eq!(body["database"].as_object().unwrap().len(), 2);
    }

    #[sqlx::test]
    async fn reports_unreachable_database_without_details(pool: PgPool) {
        pool.close().await;
        let (status, body) = check(pool).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            serde_json::json!({
                "status": "degraded",
                "database": { "status": "down", "latency_ms": null },
            })
        );
    }
}
