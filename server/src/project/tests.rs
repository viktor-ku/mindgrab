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

/// Stands in for the content projection that accepted Yjs updates will drive.
async fn project_summary(pool: &PgPool, id: Uuid, name: &str, sequence: i64) {
    sqlx::query(
        "UPDATE crdt_project SET name = $2, last_sequence = $3, content_updated_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .bind(name)
    .bind(sequence)
    .execute(pool)
    .await
    .unwrap();
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
async fn catalog_rejects_unauthenticated_and_forged_sessions(pool: PgPool) {
    let f = fixture(pool).await;
    let id = new_id();
    for cookies in ["", "mindgrab_session=forged"] {
        for reply in [
            rpc(&f.state, "listProjects", cookies, json!({})).await,
            rpc(&f.state, "getProject", cookies, json!({"projectId": id})).await,
            create(&f.state, cookies, register(id)).await,
        ] {
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
            assert_eq!(error_code(&reply), "unauthenticated");
            assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
        }
    }
    assert!(catalog_rows(&f.state.pool, id).await.is_empty());
}

#[sqlx::test]
async fn creation_requires_the_app_origin(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    let id = new_id();
    for origin in [None, Some("https://attacker.example"), Some("null")] {
        let reply = send(
            &f.state,
            "POST",
            CREATE_PROJECT,
            &session,
            origin,
            Some(register(id)),
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert_eq!(error_code(&reply), "invalid_origin");
    }
    assert!(catalog_rows(&f.state.pool, id).await.is_empty());
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
async fn a_claimed_uuid_cannot_be_overwritten_or_read_by_another_user(pool: PgPool) {
    let f = fixture(pool).await;
    let owner = sign_in(&f).await;
    let other = session_for(&f, "other_user").await;
    let id = new_id();
    let created = create(&f.state, &owner, register(id)).await;
    assert_eq!(created.status, StatusCode::CREATED);
    project_summary(&f.state.pool, id, "Owner's secret", 4).await;

    let collision = create(&f.state, &other, register(id)).await;
    assert_eq!(collision.status, StatusCode::CONFLICT);
    assert_eq!(error_code(&collision), "project_id_conflict");
    assert!(!collision.body.to_string().contains("secret"));

    let read = rpc(&f.state, "getProject", &other, json!({"projectId": id})).await;
    assert_eq!(read.status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&read), "project_not_found");
    let missing = rpc(
        &f.state,
        "getProject",
        &other,
        json!({"projectId": new_id()}),
    )
    .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(read.body, missing.body);

    let listed = rpc(&f.state, "listProjects", &other, json!({})).await;
    assert_eq!(listed.body, json!({"projects": [], "nextCursor": null}));
    assert_eq!(
        catalog_rows(&f.state.pool, id).await,
        vec![user_id(&f.state.pool, "user_test").await]
    );
    let owned = rpc(&f.state, "getProject", &owner, json!({"projectId": id})).await;
    assert_eq!(owned.body["name"], "Owner's secret");
    assert_eq!(owned.body["lastSequence"], "4");
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
async fn forged_owner_metadata_cannot_grant_access(pool: PgPool) {
    let f = fixture(pool).await;
    let owner = sign_in(&f).await;
    let other = session_for(&f, "other_user").await;
    let owner_id = user_id(&f.state.pool, "user_test").await;
    let owned = new_id();
    assert_eq!(
        create(&f.state, &owner, register(owned)).await.status,
        StatusCode::CREATED
    );

    let forged = new_id();
    for field in ["ownerId", "owner_id", "owner", "userId"] {
        let mut body = register(forged);
        body[field] = json!(owner_id);
        let reply = create(&f.state, &other, body).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(error_code(&reply), "invalid_request");
    }
    assert!(catalog_rows(&f.state.pool, forged).await.is_empty());

    let forged_list = rpc(
        &f.state,
        "listProjects",
        &other,
        json!({"ownerId": owner_id}),
    )
    .await;
    assert_eq!(forged_list.status, StatusCode::BAD_REQUEST);
    let forged_read = rpc(
        &f.state,
        "getProject",
        &other,
        json!({"projectId": owned, "ownerId": owner_id}),
    )
    .await;
    assert_eq!(forged_read.status, StatusCode::BAD_REQUEST);

    let other_project = new_id();
    assert_eq!(
        create(&f.state, &other, register(other_project))
            .await
            .status,
        StatusCode::CREATED
    );
    assert_eq!(
        catalog_rows(&f.state.pool, other_project).await,
        vec![user_id(&f.state.pool, "other_user").await]
    );
}

#[sqlx::test]
async fn malformed_project_ids_and_requests_are_rejected(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    let valid = new_id().to_string();
    for project_id in [
        "not-a-uuid".to_owned(),
        valid.to_uppercase(),
        format!("{{{valid}}}"),
        format!("urn:uuid:{valid}"),
        valid.replace('-', ""),
        format!(" {valid}"),
        Uuid::nil().to_string(),
        Uuid::max().to_string(),
        "10000000-0000-1000-8000-000000000000".to_owned(),
        "10000000-0000-4000-c000-000000000000".to_owned(),
    ] {
        let reply = create(
            &f.state,
            &session,
            json!({"projectId": project_id, "schemaVersion": 1}),
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{project_id}");
        assert_eq!(error_code(&reply), "invalid_project_id");
    }
    for body in [
        json!({"projectId": 7, "schemaVersion": 1}),
        json!({"schemaVersion": 1}),
        json!({"projectId": valid}),
        json!({"projectId": valid, "schemaVersion": "1"}),
        json!([valid]),
    ] {
        let reply = create(&f.state, &session, body).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(error_code(&reply), "invalid_request");
    }
    let unsupported = create(
        &f.state,
        &session,
        json!({"projectId": valid, "schemaVersion": 0}),
    )
    .await;
    assert_eq!(unsupported.status, StatusCode::UPGRADE_REQUIRED);

    for path in ["not-a-uuid", &valid.to_uppercase(), &valid.replace('-', "")] {
        let reply = rpc(&f.state, "getProject", &session, json!({"projectId": path})).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(error_code(&reply), "invalid_project_id");
    }
    let v1 = rpc(
        &f.state,
        "getProject",
        &session,
        json!({"projectId": "10000000-0000-1000-8000-000000000000"}),
    )
    .await;
    assert_eq!(v1.status, StatusCode::NOT_FOUND);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM crdt_project")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test]
async fn duplicate_names_are_allowed_and_renames_keep_identity(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    let (first, second) = (new_id(), new_id());
    for id in [first, second] {
        assert_eq!(
            create(&f.state, &session, register(id)).await.status,
            StatusCode::CREATED
        );
        project_summary(&f.state.pool, id, "Ideas", 1).await;
    }
    let listed = list_all(&f.state, &session, 50).await;
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().all(|project| project["name"] == "Ideas"));
    assert_eq!(
        ids(&listed).into_iter().collect::<HashSet<_>>(),
        HashSet::from([first.to_string(), second.to_string()])
    );

    let before = rpc(
        &f.state,
        "getProject",
        &session,
        json!({"projectId": first}),
    )
    .await
    .body;
    project_summary(&f.state.pool, first, "Plans", 2).await;
    let after = rpc(
        &f.state,
        "getProject",
        &session,
        json!({"projectId": first}),
    )
    .await
    .body;
    assert_eq!(after["projectId"], before["projectId"]);
    assert_eq!(after["createdAt"], before["createdAt"]);
    assert_eq!(after["name"], "Plans");
    assert_eq!(after["lastSequence"], "2");
    assert!(after["contentUpdatedAt"].is_string());
    let retry = create(&f.state, &session, register(first)).await;
    assert_eq!(retry.status, StatusCode::OK);
    assert_eq!(retry.body, after);
    assert_eq!(list_all(&f.state, &session, 50).await.len(), 2);

    let other_owner: i64 = sqlx::query_scalar(
        "INSERT INTO users (name, email, external_id) VALUES ('Thief', 'thief@example.com', 'thief') RETURNING id",
    )
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    for statement in [
        "UPDATE crdt_project SET owner_id = $2 WHERE id = $1",
        "UPDATE crdt_project SET id = gen_random_uuid() WHERE id = $1 AND $2 > 0",
        "UPDATE crdt_project SET created_at = NOW() - INTERVAL '1 day' WHERE id = $1 AND $2 > 0",
    ] {
        let result = sqlx::query(statement)
            .bind(first)
            .bind(other_owner)
            .execute(&f.state.pool)
            .await;
        assert!(result.is_err(), "{statement}");
    }
    assert_eq!(
        rpc(
            &f.state,
            "getProject",
            &session,
            json!({"projectId": first})
        )
        .await
        .body,
        after
    );
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
async fn current_catalog_schema_enforces_identity_and_content_constraints(pool: PgPool) {
    let mut connection = pool.acquire().await.unwrap();
    let owner: i64 = sqlx::query_scalar(
        "INSERT INTO users (name, email, external_id) VALUES ('Clean', 'clean@example.com', 'clean') RETURNING id",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    let inserted = sqlx::query(
        "INSERT INTO crdt_project (id, owner_id, protocol_version, schema_version, name) \
         VALUES (gen_random_uuid(), $1, 1, 1, 'Same'), (gen_random_uuid(), $1, 1, 1, 'Same')",
    )
    .bind(owner)
    .execute(&mut *connection)
    .await
    .unwrap();
    assert_eq!(inserted.rows_affected(), 2);
    for invalid in [
        "INSERT INTO crdt_project (id, owner_id, protocol_version, schema_version) VALUES (gen_random_uuid(), $1, 2, 1)",
        "INSERT INTO crdt_project (id, owner_id, protocol_version, schema_version) VALUES (gen_random_uuid(), $1, 1, 0)",
        "INSERT INTO crdt_project (id, owner_id, protocol_version, schema_version, name) VALUES (gen_random_uuid(), $1, 1, 1, '  ')",
        "INSERT INTO crdt_project (id, owner_id, protocol_version, schema_version, name) VALUES (gen_random_uuid(), $1, 1, 1, repeat('é', 101))",
        "INSERT INTO crdt_project (id, owner_id, protocol_version, schema_version, last_sequence) VALUES (gen_random_uuid(), $1, 1, 1, -1)",
    ] {
        let result = sqlx::query(invalid)
            .bind(owner)
            .execute(&mut *connection)
            .await;
        assert!(result.is_err(), "{invalid}");
    }
    let project_unique_indexes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'crdt_project' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%name%'",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert_eq!(project_unique_indexes, 0);
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
