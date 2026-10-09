mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use mindgrab_backend::auth::{SESSION_COOKIE, hash};
use mindgrab_state::{Color, Command, Project};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use uuid::Uuid;

async fn baseline(f: &Fixture, browser: &str, id: Uuid) -> (Project, String) {
    let response = f
        .rpc("getProjectSnapshot", browser, json!({"projectId":id}))
        .await;
    assert_eq!(response.status(), 200);
    let value: Value = response.json().await.unwrap();
    assert_eq!(value["encoding"], "loro-snapshot");
    assert_eq!(value["durable"], true);
    (
        Project::from_snapshot(&STANDARD.decode(value["data"].as_str().unwrap()).unwrap()).unwrap(),
        value["revision"].as_str().unwrap().into(),
    )
}
async fn upload(f: &Fixture, browser: &str, id: Uuid, project: &Project) -> reqwest::Response {
    f.post(&format!("mergeProject?projectId={id}"), browser)
        .header("content-type", "application/octet-stream")
        .body(project.snapshot().unwrap())
        .send()
        .await
        .unwrap()
}
#[tokio::test]
async fn authkit_state_pkce_callback_refresh_and_logout() {
    let f = Fixture::new("http://localhost:5173").await;
    assert_eq!(f.rpc("getMe", "", json!({})).await.status(), 401);
    let started = f.post("startLogin", "").send().await.unwrap();
    assert_eq!(started.status(), 303);
    let jar = cookies(started.headers());
    let location = reqwest::Url::parse(started.headers()["location"].to_str().unwrap()).unwrap();
    let args: std::collections::HashMap<_, _> = location.query_pairs().into_owned().collect();
    assert_eq!(args["code_challenge_method"], "S256");
    assert!(!args.contains_key("code_verifier"));
    let callback = format!(
        "{}/api/auth/callback?state={}&code=alice",
        f.url, args["state"]
    );
    let invalid = f
        .client
        .get(&callback)
        .header("cookie", "mindgrab_login_loro=wrong")
        .send()
        .await
        .unwrap();
    assert!(
        invalid.headers()["location"]
            .to_str()
            .unwrap()
            .contains("auth_error")
    );
    let response = f
        .client
        .get(&callback)
        .header("cookie", jar.join("; "))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 303);
    let jar = cookies(response.headers());
    let browser = jar
        .iter()
        .find_map(|cookie| cookie.strip_prefix(&format!("{SESSION_COOKIE}=")))
        .unwrap();
    let user: Value = f
        .rpc("getMe", browser, json!({}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(user["external_id"], "alice");
    let repeated = f
        .client
        .get(&callback)
        .header("cookie", jar.join("; "))
        .send()
        .await
        .unwrap();
    assert!(
        repeated.headers()["location"]
            .to_str()
            .unwrap()
            .contains("auth_error")
    );
    sqlx::query("UPDATE mindgrab_loro.sessions SET access_token=$1 WHERE browser_hash=$2")
        .bind(signed("alice", now() - 1))
        .bind(hash(browser))
        .execute(&f.backend.pool)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        f.rpc("getMe", browser, json!({})),
        f.rpc("getMe", browser, json!({}))
    );
    assert_eq!(a.status(), 200);
    assert_eq!(b.status(), 200);
    assert_eq!(f.provider.refreshes.load(Ordering::SeqCst), 1);
    let expected = f
        .post("getMe", browser)
        .header("x-mindgrab-account", "999")
        .send()
        .await
        .unwrap();
    assert_eq!(expected.status(), 409);
    let logout = f.post("logout", browser).send().await.unwrap();
    assert_eq!(logout.status(), 303);
    assert!(cookies(logout.headers()).contains(&format!("{SESSION_COOKIE}=")));
    assert_eq!(f.rpc("getMe", browser, json!({})).await.status(), 401);
    let browser = f.credential("alice").await;
    sqlx::query("UPDATE mindgrab_loro.sessions SET access_token=$1 WHERE browser_hash=$2")
        .bind(signed("alice", now() - 1))
        .bind(hash(&browser))
        .execute(&f.backend.pool)
        .await
        .unwrap();
    f.provider.rejected.store(1, Ordering::SeqCst);
    assert_eq!(f.rpc("getMe", &browser, json!({})).await.status(), 401);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mindgrab_loro.sessions WHERE browser_hash=$1")
            .bind(hash(&browser))
            .fetch_one(&f.backend.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    f.close().await;
}
#[tokio::test]
async fn persistent_merge_concurrency_ownership_validation_deletion_and_native_commands() {
    let f = Fixture::new("http://localhost:5173").await;
    let alice = f.credential("alice").await;
    let bob = f.credential("bob").await;
    let id = Uuid::new_v4();
    assert_eq!(
        f.rpc(
            "createProject",
            &alice,
            json!({"projectId":id,"schemaVersion":1})
        )
        .await
        .status(),
        200
    );
    let mut original = Project::new("Planning").unwrap();
    let root = original
        .apply(Command::CreateNode {
            parent: None,
            index: None,
            text: "Shared 🌲".into(),
            color: Color::Blue,
        })
        .unwrap()
        .created_node
        .unwrap();
    assert_eq!(upload(&f, &alice, id, &original).await.status(), 200);
    let (committed, revision) = baseline(&f, &alice, id).await;
    assert_eq!(revision, "1");
    assert_eq!(committed.view().unwrap(), original.view().unwrap());
    let duplicate = upload(&f, &alice, id, &original).await;
    assert_eq!(duplicate.json::<Value>().await.unwrap()["revision"], "1");
    let mut a = Project::from_snapshot(&original.snapshot().unwrap()).unwrap();
    let mut b = Project::from_snapshot(&original.snapshot().unwrap()).unwrap();
    a.apply(Command::EditText {
        id: root.clone(),
        index: 0,
        delete_count: 0,
        insert: "Alice ".into(),
    })
    .unwrap();
    b.apply(Command::EditText {
        id: root.clone(),
        index: 9,
        delete_count: 0,
        insert: " Bob".into(),
    })
    .unwrap();
    let (left, right) = tokio::join!(upload(&f, &alice, id, &a), upload(&f, &alice, id, &b));
    assert_eq!(left.status(), 200);
    assert_eq!(right.status(), 200);
    let (committed, revision) = baseline(&f, &alice, id).await;
    assert_eq!(revision, "3");
    assert_eq!(
        committed.view().unwrap().nodes[0].text,
        "Alice Shared 🌲 Bob"
    );
    let malformed = f
        .post(&format!("mergeProject?projectId={id}"), &alice)
        .header("content-type", "application/octet-stream")
        .body("bad bytes")
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), 422);
    assert_eq!(baseline(&f, &alice, id).await.1, "3");
    assert_eq!(
        f.rpc("getProjectSnapshot", &bob, json!({"projectId":id}))
            .await
            .status(),
        404
    );
    assert_eq!(upload(&f, &bob, id, &a).await.status(), 404);
    assert_eq!(
        f.rpc(
            "createProject",
            &bob,
            json!({"projectId":id,"schemaVersion":1})
        )
        .await
        .status(),
        409
    );
    assert_eq!(
        f.post("deleteProject", &alice)
            .header("origin", "https://evil.example")
            .json(&json!({"projectId":id}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let list: Value = f
        .rpc("listProjects", &alice, json!({"limit":100}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list["projects"][0]["name"], "Planning");
    let response=f.rpc("commandProject",&alice,json!({"projectId":id,"command":{"type":"createNode","parent":root,"index":null,"text":"Native Rust node","color":"teal"}})).await;
    assert_eq!(response.status(), 200);
    let (committed, _) = baseline(&f, &alice, id).await;
    assert_eq!(committed.view().unwrap().nodes[1].text, "Native Rust node");
    let restarted = mindgrab_backend::Backend::connect(f.backend.config.clone())
        .await
        .unwrap();
    let snapshot: Vec<u8> =
        sqlx::query_scalar("SELECT snapshot FROM mindgrab_loro.projects WHERE id=$1")
            .bind(id)
            .fetch_one(&restarted.pool)
            .await
            .unwrap();
    assert_eq!(
        Project::from_snapshot(&snapshot).unwrap().view().unwrap(),
        committed.view().unwrap()
    );
    restarted.pool.close().await;
    assert_eq!(
        f.rpc("deleteProject", &alice, json!({"projectId":id}))
            .await
            .status(),
        200
    );
    assert_eq!(upload(&f, &alice, id, &a).await.status(), 404);
    assert_eq!(
        f.rpc("getProjectSnapshot", &alice, json!({"projectId":id}))
            .await
            .status(),
        404
    );
    let list: Value = f
        .rpc("listProjects", &alice, json!({"limit":100}))
        .await
        .json()
        .await
        .unwrap();
    assert!(list["projects"].as_array().unwrap().is_empty());
    assert_eq!(
        f.rpc(
            "createProject",
            &alice,
            json!({"projectId":id,"schemaVersion":1})
        )
        .await
        .status(),
        200
    );
    assert_eq!(upload(&f, &alice, id, &committed).await.status(), 200);
    f.close().await;
}
