use std::collections::HashSet;

use axum::{
    body::{Body, to_bytes},
    http::{HeaderMap, StatusCode, header},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use super::*;
use crate::auth::tests::{fixture, session_for, sign_in};

const ORIGIN: &str = "http://localhost:5173";
const CREATE_PROJECT: &str = "/api/createProject";

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

async fn send(
    state: &Arc<AppState>,
    method: &str,
    path: &str,
    cookies: &str,
    origin: Option<&str>,
    body: Option<Value>,
) -> Reply {
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header(header::COOKIE, cookies);
    if let Some(origin) = origin {
        builder = builder.header(header::ORIGIN, origin);
    }
    let body = match body {
        Some(body) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = crate::router(state.clone())
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    Reply {
        status,
        headers,
        body,
    }
}

async fn create(state: &Arc<AppState>, cookies: &str, body: Value) -> Reply {
    send(
        state,
        "POST",
        CREATE_PROJECT,
        cookies,
        Some(ORIGIN),
        Some(body),
    )
    .await
}

async fn rpc(state: &Arc<AppState>, method: &str, cookies: &str, args: Value) -> Reply {
    send(
        state,
        "POST",
        &format!("/api/{method}"),
        cookies,
        None,
        Some(args),
    )
    .await
}

fn new_id() -> Uuid {
    uuid::Builder::from_random_bytes(rand::random()).into_uuid()
}

fn register(id: Uuid) -> Value {
    json!({"projectId": id, "schemaVersion": 1})
}

fn error_code(reply: &Reply) -> &str {
    reply.body["error"]["code"].as_str().unwrap()
}

async fn user_id(pool: &PgPool, external_id: &str) -> i64 {
    sqlx::query_scalar("SELECT id FROM users WHERE external_id = $1")
        .bind(external_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn catalog_rows(pool: &PgPool, id: Uuid) -> Vec<i64> {
    sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn list_all(state: &Arc<AppState>, cookies: &str, limit: u32) -> Vec<Value> {
    let mut projects = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut args = json!({"limit": limit});
        if let Some(cursor) = &cursor {
            args["cursor"] = json!(cursor);
        }
        let page = rpc(state, "listProjects", cookies, args).await;
        assert_eq!(page.status, StatusCode::OK);
        let items = page.body["projects"].as_array().unwrap();
        assert!(items.len() <= limit as usize);
        projects.extend(items.iter().cloned());
        match page.body["nextCursor"].as_str() {
            Some(next) => {
                assert_eq!(items.len(), limit as usize);
                cursor = Some(next.to_owned());
            }
            None => return projects,
        }
    }
}

fn ids(projects: &[Value]) -> Vec<String> {
    projects
        .iter()
        .map(|project| project["projectId"].as_str().unwrap().to_owned())
        .collect()
}

#[sqlx::test]
async fn registration_is_idempotent_and_reports_reconnect_status(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    let id = new_id();

    let first = create(&f.state, &session, register(id)).await;
    assert_eq!(first.status, StatusCode::CREATED);
    assert!(!first.headers.contains_key(header::LOCATION));
    assert_eq!(first.headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(first.body["projectId"], id.to_string());
    assert_eq!(first.body["protocolVersion"], 1);
    assert_eq!(first.body["schemaVersion"], 1);
    assert_eq!(first.body["name"], Value::Null);
    assert_eq!(first.body["lastSequence"], "0");
    assert_eq!(first.body["contentUpdatedAt"], Value::Null);
    assert!(first.body["createdAt"].as_str().unwrap().ends_with('Z'));
    let keys: HashSet<_> = first.body.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        HashSet::from(
            [
                "projectId",
                "protocolVersion",
                "schemaVersion",
                "createdAt",
                "name",
                "nodeCount",
                "projectionSequence",
                "projectionVersion",
                "projectionStatus",
                "lastSequence",
                "contentUpdatedAt"
            ]
            .map(String::from)
        )
    );

    for _ in 0..2 {
        let retry = create(&f.state, &session, register(id)).await;
        assert_eq!(retry.status, StatusCode::OK);
        assert_eq!(retry.body, first.body);
    }
    let fetched = rpc(&f.state, "getProject", &session, json!({"projectId": id})).await;
    assert_eq!(fetched.status, StatusCode::OK);
    assert_eq!(fetched.body, first.body);

    let future_schema = create(
        &f.state,
        &session,
        json!({"projectId": id, "schemaVersion": 2}),
    )
    .await;
    assert_eq!(future_schema.status, StatusCode::UPGRADE_REQUIRED);
    assert_eq!(error_code(&future_schema), "unsupported_schema");
    assert_eq!(
        catalog_rows(&f.state.pool, id).await,
        vec![user_id(&f.state.pool, "user_test").await]
    );
}

#[sqlx::test]
async fn concurrent_registration_creates_one_project_for_one_owner(pool: PgPool) {
    let f = fixture(pool).await;
    let first = sign_in(&f).await;
    let second = session_for(&f, "other_user").await;
    let first_id = user_id(&f.state.pool, "user_test").await;
    let second_id = user_id(&f.state.pool, "other_user").await;
    for _ in 0..5 {
        let id = new_id();
        let mut tasks = tokio::task::JoinSet::new();
        for attempt in 0..8 {
            let state = f.state.clone();
            let cookies = if attempt % 2 == 0 {
                first.clone()
            } else {
                second.clone()
            };
            tasks.spawn(async move {
                let reply = create(&state, &cookies, register(id)).await;
                (attempt % 2 == 0, reply.status)
            });
        }
        let results = tasks.join_all().await;
        let owners = catalog_rows(&f.state.pool, id).await;
        assert_eq!(owners.len(), 1);
        let winner_is_first = owners[0] == first_id;
        assert!(winner_is_first || owners[0] == second_id);
        let created = results
            .iter()
            .filter(|(_, status)| *status == StatusCode::CREATED)
            .count();
        assert_eq!(created, 1);
        for (is_first, status) in results {
            if is_first == winner_is_first {
                assert!(matches!(status, StatusCode::CREATED | StatusCode::OK));
            } else {
                assert_eq!(status, StatusCode::CONFLICT);
            }
        }
    }
}

#[sqlx::test]
async fn listing_is_paginated_owner_scoped_and_stable(pool: PgPool) {
    let f = fixture(pool).await;
    let owner = sign_in(&f).await;
    let other = session_for(&f, "other_user").await;
    let owner_id = user_id(&f.state.pool, "user_test").await;
    for _ in 0..5 {
        create(&f.state, &owner, register(new_id())).await;
    }
    for _ in 0..2 {
        create(&f.state, &other, register(new_id())).await;
    }
    // Identical creation times must still page deterministically.
    sqlx::query(
        "INSERT INTO crdt_project (id, owner_id, protocol_version, schema_version, created_at) \
         SELECT gen_random_uuid(), $1, 1, 1, TIMESTAMPTZ '2026-01-02 03:04:05.678901Z' FROM generate_series(1, 3)",
    )
    .bind(owner_id)
    .execute(&f.state.pool)
    .await
    .unwrap();
    let expected: Vec<String> = sqlx::query_scalar(
        "SELECT id::TEXT FROM crdt_project WHERE owner_id = $1 ORDER BY created_at DESC, id DESC",
    )
    .bind(owner_id)
    .fetch_all(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(expected.len(), 8);

    for limit in [1, 2, 3, 7, 8, 100] {
        assert_eq!(ids(&list_all(&f.state, &owner, limit).await), expected);
    }
    let default_page = rpc(&f.state, "listProjects", &owner, json!({})).await;
    assert_eq!(default_page.body["projects"].as_array().unwrap().len(), 8);
    assert_eq!(default_page.body["nextCursor"], Value::Null);
    assert_eq!(list_all(&f.state, &other, 1).await.len(), 2);

    let first_page = rpc(&f.state, "listProjects", &owner, json!({"limit": 3})).await;
    let cursor = first_page.body["nextCursor"].as_str().unwrap();
    let foreign = rpc(&f.state, "listProjects", &other, json!({"cursor": cursor})).await;
    assert_eq!(foreign.status, StatusCode::OK);
    assert!(
        ids(foreign.body["projects"].as_array().unwrap())
            .iter()
            .all(|id| !expected.contains(id))
    );

    for query in [
        json!({"limit": 0}),
        json!({"limit": 101}),
        json!({"limit": -1}),
        json!({"limit": "abc"}),
        json!({"cursor": "not-a-cursor"}),
        json!({"cursor": "AAAA"}),
        json!({"page": 2}),
    ] {
        let reply = rpc(&f.state, "listProjects", &owner, query.clone()).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{query}");
    }
}

#[sqlx::test]
async fn stale_snapshot_clients_must_upgrade_without_writing(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    let id = new_id();
    create(&f.state, &session, register(id)).await;
    for cookies in [&session[..], ""] {
        for method in ["GET", "PUT"] {
            let reply = send(
                &f.state,
                method,
                "/api/projects",
                cookies,
                None,
                Some(json!({"name": "Ideas", "state": {"version": 1, "nodes": []}})),
            )
            .await;
            assert_eq!(reply.status, StatusCode::UPGRADE_REQUIRED);
            assert_eq!(error_code(&reply), "legacy_client_upgrade_required");
            assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
            assert_eq!(reply.body["storageGeneration"], 1);
        }
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM project")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        ids(&list_all(&f.state, &session, 50).await),
        vec![id.to_string()]
    );
    super::cutover::reset_legacy_projects(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(
        send(&f.state, "GET", "/api/projects", &session, None, None)
            .await
            .status,
        StatusCode::UPGRADE_REQUIRED
    );
}

#[sqlx::test]
async fn account_expectations_reject_changed_cookies_before_reads_registration_or_updates(
    pool: PgPool,
) {
    let f = fixture(pool).await;
    sign_in(&f).await;
    let b = session_for(&f, "user_other").await;
    let owner_a: i64 = sqlx::query_scalar("SELECT id FROM users WHERE external_id = 'user_test'")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    let owner_b = user_id(&f.state.pool, "user_other").await;
    let id = new_id();
    for (path, body) in [
        (CREATE_PROJECT.to_owned(), register(id).to_string()),
        ("/api/listProjects".to_owned(), "{}".into()),
        (
            "/api/getProject".to_owned(),
            json!({"projectId": id}).to_string(),
        ),
        (
            "/api/getProjectBaseline".to_owned(),
            json!({"projectId": id}).to_string(),
        ),
        (
            "/api/getProjectStatus".to_owned(),
            json!({"projectId": id}).to_string(),
        ),
        (
            "/api/getProjectState".to_owned(),
            json!({"projectId": id}).to_string(),
        ),
        (
            "/api/getProjectUpdates".to_owned(),
            json!({"projectId": id}).to_string(),
        ),
        (
            format!(
                "/api/submitProjectUpdate?projectId={id}&updateId={}",
                new_id()
            ),
            String::new(),
        ),
    ] {
        let response = crate::router(f.state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri(path)
                    .header(header::COOKIE, &b)
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-mindgrab-account", owner_a.to_string())
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "account_changed");
    }
    assert!(catalog_rows(&f.state.pool, id).await.is_empty());
    let response = crate::router(f.state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri(CREATE_PROJECT)
                .header(header::COOKIE, b)
                .header(header::ORIGIN, ORIGIN)
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-mindgrab-account", owner_b.to_string())
                .body(Body::from(register(id).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(catalog_rows(&f.state.pool, id).await, vec![owner_b]);
}
