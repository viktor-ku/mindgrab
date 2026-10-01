use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::auth::AppState;
use axum::{Extension, Json, extract::State, http::StatusCode, response::IntoResponse};
use axum_server_timing::ServerTimingExtension;
use serde::Serialize;

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

pub(super) async fn get_health(
    State(state): State<Arc<AppState>>,
    Extension(timing): Extension<ServerTimingExtension>,
) -> impl IntoResponse {
    let started = Instant::now();
    let reachable = matches!(
        tokio::time::timeout(
            DATABASE_TIMEOUT,
            sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.pool),
        )
        .await,
        Ok(Ok(1))
    );
    let elapsed = started.elapsed();
    timing
        .lock()
        .unwrap()
        .record_timing("db".to_owned(), elapsed, None);
    let latency = (elapsed.as_secs_f64() * 10_000.0).round() / 10.0;
    let (status, code, database_status) = if reachable {
        (Status::Ok, StatusCode::OK, ComponentStatus::Up)
    } else {
        (
            Status::Degraded,
            StatusCode::SERVICE_UNAVAILABLE,
            ComponentStatus::Down,
        )
    };
    let database = Component {
        status: database_status,
        latency_ms: reachable.then_some(latency),
    };
    (code, Json(Health { status, database }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use serde_json::Value;
    use sqlx::PgPool;
    use tower::ServiceExt;

    async fn check(pool: PgPool) -> (StatusCode, Value, f64) {
        let fixture = crate::auth::tests::fixture(pool).await;
        let response = crate::router(fixture.state.clone())
            .oneshot(
                axum::http::Request::post("/api/getHealth")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        crate::response_headers::assert_private_headers(response.headers());
        let duration = crate::tests::timing_duration(response.headers(), "db");
        assert!(crate::tests::timing_duration(response.headers(), "request") >= duration);
        assert_eq!(
            response.headers()["server-timing"]
                .to_str()
                .unwrap()
                .split(',')
                .count(),
            2
        );
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap(), duration)
    }

    #[sqlx::test]
    async fn reports_reachable_database_with_latency(pool: PgPool) {
        let (status, body, duration) = check(pool).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["database"]["status"], "up");
        assert!((body["database"]["latency_ms"].as_f64().unwrap() - duration).abs() <= 0.06);
        assert_eq!(body.as_object().unwrap().len(), 2);
        assert_eq!(body["database"].as_object().unwrap().len(), 2);
    }

    #[sqlx::test]
    async fn reports_unreachable_database_without_details(pool: PgPool) {
        pool.close().await;
        let (status, body, _) = check(pool).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            serde_json::json!({
                "status": "degraded",
                "database": { "status": "down", "latency_ms": null },
            })
        );
    }

    #[sqlx::test]
    async fn reports_timed_out_database_without_details(pool: PgPool) {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with((*pool.connect_options()).clone())
            .await
            .unwrap();
        let _connection = pool.acquire().await.unwrap();
        let (status, body, duration) =
            tokio::time::timeout(Duration::from_secs(5), check(pool.clone()))
                .await
                .expect("health probe must retain its two-second timeout");
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(duration >= DATABASE_TIMEOUT.as_secs_f64() * 1000.0);
        assert_eq!(
            body,
            serde_json::json!({
                "status": "degraded",
                "database": { "status": "down", "latency_ms": null },
            })
        );
    }
}
