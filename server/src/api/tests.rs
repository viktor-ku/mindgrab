use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

use crate::auth::tests::{fixture, sign_in};
use crate::response_headers::assert_private_headers;

const METHODS: &[&str] = &[
    "getMe",
    "getHealth",
    "startLogin",
    "logout",
    "createProject",
    "listProjects",
    "getProject",
    "getProjectBaseline",
    "getProjectUpdates",
    "getProjectStatus",
    "getProjectState",
    "submitProjectUpdate",
];

#[sqlx::test]
async fn public_methods_accept_only_post(pool: PgPool) {
    let f = fixture(pool).await;
    let app = crate::router(f.state.clone());
    for function in METHODS {
        for method in ["GET", "HEAD", "PUT", "PATCH", "DELETE"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(format!("/api/{function}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} {function}"
            );
            assert_eq!(response.headers()[header::ALLOW], "POST");
            assert_private_headers(response.headers());
        }
        let response = app
            .clone()
            .oneshot(
                Request::post(format!("/api/{function}"))
                    .header(header::ORIGIN, "http://localhost:5173")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            !matches!(
                response.status(),
                StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
            ),
            "POST {function}"
        );
        assert_private_headers(response.headers());
    }
}

#[sqlx::test]
async fn json_rpc_arguments_are_required_and_strict(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let app = crate::router(f.state.clone());
    for function in [
        "createProject",
        "getProject",
        "getProjectBaseline",
        "getProjectUpdates",
        "getProjectStatus",
        "getProjectState",
        "listProjects",
    ] {
        let mut bodies = vec![
            String::new(),
            "{".into(),
            "[]".into(),
            json!({"projectId": "10000000-0000-4000-8000-000000000000", "unknown": 1}).to_string(),
        ];
        if function != "listProjects" {
            bodies.push("{}".into());
        }
        for body in bodies {
            let response = app
                .clone()
                .oneshot(
                    Request::post(format!("/api/{function}"))
                        .header(header::COOKIE, &cookie)
                        .header(header::ORIGIN, "http://localhost:5173")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{function}");
            assert_private_headers(response.headers());
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let error: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(error["error"]["code"], "invalid_request");
        }
    }
}
