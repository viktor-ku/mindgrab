use axum::{
    body::{Body, to_bytes},
    http::{StatusCode, header},
    response::Response,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

use crate::auth::tests::{Fixture, fixture, session_for, sign_in};

async fn request(f: &Fixture, method: &str, path: &str, cookies: &str) -> Response {
    request_body(f, method, path, cookies, Body::empty()).await
}

async fn request_json(
    f: &Fixture,
    method: &str,
    path: &str,
    cookies: &str,
    body: Value,
) -> Response {
    request_body(f, method, path, cookies, Body::from(body.to_string())).await
}

async fn request_body(
    f: &Fixture,
    method: &str,
    path: &str,
    cookies: &str,
    body: Body,
) -> Response {
    crate::project::router(f.state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method(method)
                .uri(path)
                .header(header::COOKIE, cookies)
                .header(header::CONTENT_TYPE, "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap()
}

#[sqlx::test]
async fn project_api_requires_authentication_and_scopes_records_to_each_user(pool: PgPool) {
    let f = fixture(pool).await;
    let project_payload = std::env::var("PROJECT_SYNC_PAYLOAD_B64")
        .ok()
        .and_then(|value| STANDARD.decode(value).ok())
        .and_then(|value| serde_json::from_slice::<Value>(&value).ok())
        .unwrap_or_else(|| {
            let mut node = Value::Null;
            for depth in (1..=10).rev() {
                let mut current =
                    json!({"id":format!("node-{depth}"), "text":format!("Depth {depth}")});
                if !node.is_null() {
                    current["next"] = json!([node]);
                }
                node = current;
            }
            json!({
                "name":"Ten deep",
                "state":{"version":1, "nodes":[node], "view":{"left":0, "top":0, "zoom":1}}
            })
        });
    let project_name = project_payload["name"].as_str().unwrap();
    let mut project_state = project_payload["state"].clone();
    fn assign_test_uuids(nodes: &mut Value, next_id: &mut u128) {
        let Some(nodes) = nodes.as_array_mut() else {
            return;
        };
        for node in nodes {
            *next_id += 1;
            node["id"] = json!(format!("00000000-0000-4000-8000-{:012x}", *next_id));
            let has_children = node
                .get("next")
                .and_then(Value::as_array)
                .is_some_and(|children| !children.is_empty());
            if has_children {
                assign_test_uuids(&mut node["next"], next_id);
            } else if let Some(object) = node.as_object_mut() {
                object.remove("next");
            }
        }
    }
    let mut next_node_id = 0;
    assign_test_uuids(&mut project_state["nodes"], &mut next_node_id);
    project_state["nodes"][0]["color"] = json!("rose");
    project_state["nodes"][0]["next"][0]["color"] = json!("teal");
    project_state["anchor"] = json!({"id":project_state["nodes"][0]["id"], "centerY":20});
    let mut depth = 0;
    let mut node = &project_state["nodes"][0];
    while !node.is_null() {
        depth += 1;
        node = &node["next"][0];
    }
    assert_eq!(depth, 10);
    fn has_node_id(nodes: &Value, id: &str) -> bool {
        nodes.as_array().is_some_and(|nodes| {
            nodes
                .iter()
                .any(|node| node["id"].as_str() == Some(id) || has_node_id(&node["next"], id))
        })
    }
    let mut sibling_counter = next_node_id + 1;
    let mut sibling_id = format!("00000000-0000-4000-8000-{sibling_counter:012x}");
    while has_node_id(&project_state["nodes"], &sibling_id) {
        sibling_counter += 1;
        sibling_id = format!("00000000-0000-4000-8000-{sibling_counter:012x}");
    }
    project_state["nodes"][0]["position"] = json!({"x":-24, "y":16});
    let sibling_order = project_state["nodes"][0]["next"].as_array().unwrap().len() as i64;
    project_state["nodes"][0]["next"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":sibling_id.clone(), "text":"Round trip sibling"}));
    fn add_default_colors(nodes: &mut Value) {
        let Some(nodes) = nodes.as_array_mut() else {
            return;
        };
        for node in nodes {
            node.as_object_mut()
                .unwrap()
                .entry("color")
                .or_insert_with(|| json!("blue"));
            if let Some(children) = node.get_mut("next") {
                add_default_colors(children);
            }
        }
    }
    let mut expected_project_state = project_state.clone();
    add_default_colors(&mut expected_project_state["nodes"]);
    fn count_nodes(nodes: &Value) -> usize {
        nodes.as_array().map_or(0, |nodes| {
            nodes
                .iter()
                .map(|node| 1 + count_nodes(&node["next"]))
                .sum()
        })
    }
    let expected_node_count = count_nodes(&project_state["nodes"]);
    let root_id = project_state["nodes"][0]["id"].as_str().unwrap();
    let child_id = project_state["nodes"][0]["next"][0]["id"].as_str().unwrap();
    let sibling_id = project_state["nodes"][0]["next"][sibling_order as usize]["id"]
        .as_str()
        .unwrap();

    let anonymous_read = request(&f, "GET", "/api/projects", "").await;
    assert_eq!(anonymous_read.status(), StatusCode::UNAUTHORIZED);
    let anonymous_write = request_json(
        &f,
        "PUT",
        "/api/projects",
        "",
        json!({"name":"Private", "state":{"value":"anonymous"}}),
    )
    .await;
    assert_eq!(anonymous_write.status(), StatusCode::UNAUTHORIZED);

    let first_cookie = sign_in(&f).await;
    let invalid_write = request_json(
        &f,
        "PUT",
        "/api/projects",
        &first_cookie,
        json!({"name":"  ", "state":{}}),
    )
    .await;
    assert_eq!(invalid_write.status(), StatusCode::BAD_REQUEST);
    let malformed_write = request_json(
        &f,
        "PUT",
        "/api/projects",
        &first_cookie,
        json!({"name":"Malformed", "state":{"version":1, "nodes":[], "view":{"left":0, "top":0, "zoom":0}}}),
    )
    .await;
    assert_eq!(malformed_write.status(), StatusCode::BAD_REQUEST);
    let invalid_node_id_write = request_json(
        &f,
        "PUT",
        "/api/projects",
        &first_cookie,
        json!({"name":"Invalid ID", "state":{"version":1, "nodes":[{"id":"not-a-uuid", "text":"Idea"}], "view":{"left":0, "top":0, "zoom":1}}}),
    )
    .await;
    assert_eq!(invalid_node_id_write.status(), StatusCode::BAD_REQUEST);
    let mut invalid_color_state = project_state.clone();
    invalid_color_state["nodes"][0]["color"] = json!("magenta");
    let invalid_node_color_write = request_json(
        &f,
        "PUT",
        "/api/projects",
        &first_cookie,
        json!({"name":"Invalid color", "state":invalid_color_state}),
    )
    .await;
    assert_eq!(invalid_node_color_write.status(), StatusCode::BAD_REQUEST);
    let first_write = request_json(
        &f,
        "PUT",
        "/api/projects",
        &first_cookie,
        json!({"name":project_name, "state":project_state}),
    )
    .await;
    assert_eq!(first_write.status(), StatusCode::OK);

    let second_cookie = session_for(&f, "other_user").await;

    let first_projects = request(&f, "GET", "/api/projects", &first_cookie).await;
    assert_eq!(first_projects.status(), StatusCode::OK);
    let first_body = to_bytes(first_projects.into_body(), usize::MAX)
        .await
        .unwrap();
    let first_projects: Value = serde_json::from_slice(&first_body).unwrap();
    assert_eq!(first_projects.as_array().unwrap().len(), 1);
    assert_eq!(first_projects[0]["name"], project_name);
    assert_eq!(first_projects[0]["state"], expected_project_state);
    assert!(first_projects[0]["updated_at"].as_str().is_some());

    let database_node_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pnode WHERE project_id = (SELECT id FROM project WHERE name = $1 AND user_id = (SELECT id FROM users WHERE external_id = 'user_test'))",
    )
    .bind(project_name)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(database_node_count as usize, expected_node_count);
    let (database_root_color, database_child_color): (String, String) =
        sqlx::query_as(
            "SELECT (SELECT color FROM pnode WHERE project_id = project.id AND id::TEXT = $2), (SELECT color FROM pnode WHERE project_id = project.id AND id::TEXT = $3) FROM project WHERE name = $1 AND user_id = (SELECT id FROM users WHERE external_id = 'user_test')",
        )
        .bind(project_name)
        .bind(root_id)
        .bind(child_id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(database_root_color, "rose");
    assert_eq!(database_child_color, "teal");
    let database_default_color: String = sqlx::query_scalar(
        "SELECT color FROM pnode WHERE project_id = (SELECT id FROM project WHERE name = $1 AND user_id = (SELECT id FROM users WHERE external_id = 'user_test')) AND id::TEXT = $2",
    )
    .bind(project_name)
    .bind(sibling_id)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(database_default_color, "blue");
    let database_parent: Option<String> = sqlx::query_scalar(
        "SELECT parent.id::TEXT FROM pnode AS child LEFT JOIN pnode AS parent ON parent.project_id = child.project_id AND parent.id = child.parent_pnode_id WHERE child.project_id = (SELECT id FROM project WHERE name = $1 AND user_id = (SELECT id FROM users WHERE external_id = 'user_test')) AND child.id::TEXT = $2",
    )
    .bind(project_name)
    .bind(child_id)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(database_parent.as_deref(), Some(root_id));
    let database_root_parent: Option<String> = sqlx::query_scalar(
        "SELECT parent_pnode_id::TEXT FROM pnode WHERE project_id = (SELECT id FROM project WHERE name = $1 AND user_id = (SELECT id FROM users WHERE external_id = 'user_test')) AND id::TEXT = $2",
    )
    .bind(project_name)
    .bind(root_id)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(database_root_parent, None);
    let database_node_id: String = sqlx::query_scalar(
        "SELECT id::TEXT FROM pnode WHERE project_id = (SELECT id FROM project WHERE name = $1 AND user_id = (SELECT id FROM users WHERE external_id = 'user_test')) AND id::TEXT = $2",
    )
    .bind(project_name)
    .bind(root_id)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(database_node_id, root_id);
    let (position_x, position_y): (Option<f64>, Option<f64>) = sqlx::query_as(
        "SELECT position_x, position_y FROM pnode WHERE project_id = (SELECT id FROM project WHERE name = $1 AND user_id = (SELECT id FROM users WHERE external_id = 'user_test')) AND id::TEXT = $2",
    )
    .bind(project_name)
    .bind(root_id)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!((position_x, position_y), (Some(-24.0), Some(16.0)));
    let (sibling_parent, stored_sibling_order): (Option<String>, i64) = sqlx::query_as(
        "SELECT parent.id::TEXT, child.sort_order FROM pnode AS child LEFT JOIN pnode AS parent ON parent.project_id = child.project_id AND parent.id = child.parent_pnode_id WHERE child.project_id = (SELECT id FROM project WHERE name = $1 AND user_id = (SELECT id FROM users WHERE external_id = 'user_test')) AND child.id::TEXT = $2",
    )
    .bind(project_name)
    .bind(sibling_id)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(sibling_parent.as_deref(), Some(root_id));
    assert_eq!(stored_sibling_order, sibling_order);
    let state_column_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'project' AND column_name = 'state')",
    )
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert!(state_column_exists);
    let stored_state: Value = sqlx::query_scalar(
        "SELECT state FROM project WHERE name = $1 AND user_id = (SELECT id FROM users WHERE external_id = 'user_test')",
    )
    .bind(project_name)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    let mut expected_metadata = project_state.clone();
    expected_metadata.as_object_mut().unwrap().remove("nodes");
    assert_eq!(stored_state, expected_metadata);

    let second_read = request(&f, "GET", "/api/projects", &second_cookie).await;
    assert_eq!(second_read.status(), StatusCode::OK);
    let second_body = to_bytes(second_read.into_body(), usize::MAX).await.unwrap();
    let second_projects: Value = serde_json::from_slice(&second_body).unwrap();
    assert_eq!(second_projects, json!([]));

    let second_write = request_json(
        &f,
        "PUT",
        "/api/projects",
        &second_cookie,
        json!({"name":project_name, "state":{"version":1, "nodes":[], "view":{"left":0, "top":0, "zoom":1}}}),
    )
    .await;
    assert_eq!(second_write.status(), StatusCode::OK);

    let first_projects = request(&f, "GET", "/api/projects", &first_cookie).await;
    let first_body = to_bytes(first_projects.into_body(), usize::MAX)
        .await
        .unwrap();
    let first_projects: Value = serde_json::from_slice(&first_body).unwrap();
    assert_eq!(first_projects[0]["state"], expected_project_state);
}

#[sqlx::test]
async fn pnode_migrations_preserve_existing_state_without_backfill(pool: PgPool) {
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query("CREATE SCHEMA min25_migration_test")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("SET search_path TO min25_migration_test")
        .execute(&mut *connection)
        .await
        .unwrap();

    sqlx::raw_sql(include_str!("../../../migrations/0001_create_users.sql"))
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../../../migrations/0003_projects.sql"))
        .execute(&mut *connection)
        .await
        .unwrap();

    let user_id: i64 = sqlx::query_scalar(
        "INSERT INTO users (name, email, external_id) VALUES ('Migration', 'migration@example.com', 'migration_user') RETURNING id",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    sqlx::query("INSERT INTO project (user_id, name, state) VALUES ($1, 'Existing map', $2)")
        .bind(user_id)
        .bind(json!({
            "version": 1,
            "nodes": [
                {"id":"root-z", "text":"Root", "position":{"x":4, "y":8}, "next":[
                    {"id":"child-z", "text":"First child"},
                    {"id":"child-a", "text":"Second child"}
                ]},
                {"id":"root-a", "text":"Second root"}
            ],
            "anchor":{"id":"root-z", "centerY":20},
            "view":{"left":12, "top":-7, "zoom":1.5}
        }))
        .execute(&mut *connection)
        .await
        .unwrap();

    sqlx::raw_sql(include_str!("../../../migrations/0004_pnodes.sql"))
        .execute(&mut *connection)
        .await
        .unwrap();

    sqlx::raw_sql(include_str!("../../../migrations/0005_pnode_colors.sql"))
        .execute(&mut *connection)
        .await
        .unwrap();

    let pnode_id_types: Vec<(String, String)> = sqlx::query_as(
        "SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'pnode' AND column_name IN ('color', 'id', 'parent_pnode_id') ORDER BY column_name",
    )
    .fetch_all(&mut *connection)
    .await
    .unwrap();
    assert_eq!(
        pnode_id_types,
        vec![
            ("color".into(), "text".into()),
            ("id".into(), "uuid".into()),
            ("parent_pnode_id".into(), "uuid".into())
        ]
    );
    let color_is_nullable: String = sqlx::query_scalar(
        "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'pnode' AND column_name = 'color'",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert_eq!(color_is_nullable, "NO");

    let migrated_state: Value =
        sqlx::query_scalar("SELECT state FROM project WHERE name = 'Existing map'")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
    assert_eq!(
        migrated_state,
        json!({
            "version": 1,
            "nodes": [
                {"id":"root-z", "text":"Root", "position":{"x":4, "y":8}, "next":[
                    {"id":"child-z", "text":"First child"},
                    {"id":"child-a", "text":"Second child"}
                ]},
                {"id":"root-a", "text":"Second root"}
            ],
            "anchor":{"id":"root-z", "centerY":20},
            "view":{"left":12, "top":-7, "zoom":1.5}
        })
    );
    let pnode_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pnode WHERE project_id = (SELECT id FROM project WHERE name = 'Existing map')",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert_eq!(pnode_count, 0);
    let state_column_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'project' AND column_name = 'state')",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert!(state_column_exists);

    sqlx::query("DROP SCHEMA min25_migration_test CASCADE")
        .execute(&mut *connection)
        .await
        .unwrap();
}
