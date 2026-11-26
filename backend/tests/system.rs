mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use mindgrab_backend::auth::{SESSION_COOKIE, hash};
use mindgrab_state::{Color, Command, Project};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tokio::io::AsyncReadExt;
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
    f.post("mergeProject", browser)
        .query(&[("projectId", id)])
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
    assert!(jar[0].starts_with("PHPLOGINID="));
    let location = reqwest::Url::parse(started.headers()["location"].to_str().unwrap()).unwrap();
    let args: std::collections::HashMap<_, _> = location.query_pairs().into_owned().collect();
    assert_eq!(args["code_challenge_method"], "S256");
    assert!(!args.contains_key("code_verifier"));
    let callback = format!(
        "{}/api/auth/callback.php?state={}&code=alice",
        f.url, args["state"]
    );
    let invalid = f
        .client
        .get(&callback)
        .header("cookie", "PHPLOGINID=wrong")
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
    assert_eq!(SESSION_COOKIE, "PHPSESSID");
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
    // A request that goes away mid-refresh still stores the replacement
    // tokens: the provider has retired the old ones by then.
    sqlx::query("UPDATE mindgrab_loro.sessions SET access_token=$1 WHERE browser_hash=$2")
        .bind(signed("alice", now() - 1))
        .bind(hash(browser))
        .execute(&f.backend.pool)
        .await
        .unwrap();
    f.provider.delay.store(300, Ordering::SeqCst);
    let abandoned = f
        .post("getMe", browser)
        .json(&json!({}))
        .timeout(std::time::Duration::from_millis(100))
        .send()
        .await;
    assert!(abandoned.is_err());
    assert_eq!(f.rpc("getMe", browser, json!({})).await.status(), 200);
    assert_eq!(f.provider.refreshes.load(Ordering::SeqCst), 2);
    f.provider.delay.store(0, Ordering::SeqCst);
    let expected = f
        .post("getMe", browser)
        .header("x-mindgrab-account", "999")
        .send()
        .await
        .unwrap();
    assert_eq!(expected.status(), 409);
    let logout = f.post("logout", browser).send().await.unwrap();
    assert_eq!(logout.status(), 303);
    assert!(cookies(logout.headers()).contains(&format!("{SESSION_COOKIE}=deleted")));
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
            color: Color::BLUE,
            fill: None,
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
        .post("mergeProject", &alice)
        .query(&[("projectId", id)])
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
    let updated_at = list["projects"][0]["updatedAt"].as_str().unwrap();
    assert!(
        updated_at.ends_with('Z') && updated_at.len() == 27,
        "{updated_at}"
    );
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

async fn shared(f: &Fixture, token: &str) -> reqwest::Response {
    // Viewers carry no session cookie and may come from any origin.
    f.client
        .post(format!("{}/api/getSharedProject.php", f.url))
        .json(&json!({ "token": token }))
        .send()
        .await
        .unwrap()
}
async fn share(f: &Fixture, browser: &str, id: Uuid, enabled: bool) -> Value {
    let response = f
        .rpc(
            "setShareLink",
            browser,
            json!({"projectId":id,"enabled":enabled}),
        )
        .await;
    assert_eq!(response.status(), 200);
    response.json().await.unwrap()
}
fn websocket(f: &Fixture, origin: &str, path: &str) -> reqwest::RequestBuilder {
    f.client
        .get(format!("{}{path}", f.url))
        .header("origin", origin)
        .header("connection", "upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
}
#[derive(Debug, PartialEq)]
enum Frame {
    Text(String),
    Close(u16, String),
}
/// Server frames are never masked, and these are all short.
async fn frame(socket: &mut reqwest::Upgraded) -> Frame {
    // Longer than the socket's 20 second reconciliation timer.
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let mut head = [0; 2];
        socket.read_exact(&mut head).await.unwrap();
        assert!(head[1] < 126, "unexpected frame length");
        let mut payload = vec![0; head[1] as usize];
        socket.read_exact(&mut payload).await.unwrap();
        match head[0] & 0x0f {
            1 => Frame::Text(String::from_utf8(payload).unwrap()),
            8 => Frame::Close(
                u16::from_be_bytes([payload[0], payload[1]]),
                String::from_utf8(payload[2..].to_vec()).unwrap(),
            ),
            opcode => panic!("unexpected opcode {opcode}"),
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn project_sockets_reject_foreign_origins_and_follow_commits() {
    let f = Fixture::new("http://localhost:5173").await;
    let alice = f.credential("alice").await;
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
    let user: Value = f
        .rpc("getMe", &alice, json!({}))
        .await
        .json()
        .await
        .unwrap();
    let path = format!("/ws/project/{id}?ownerId={}", user["id"]);
    let session = format!("{}={alice}", f.backend.config.cookie_name(SESSION_COOKIE));

    let foreign = websocket(&f, "https://evil.example", &path)
        .header("cookie", &session)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), 403);

    let response = websocket(&f, &f.origin, &path)
        .header("cookie", &session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 101);
    let mut socket = response.upgrade().await.unwrap();
    assert_eq!(
        frame(&mut socket).await,
        Frame::Text(json!({"revision":"0"}).to_string())
    );
    let project = Project::new("Plan").unwrap();
    assert_eq!(upload(&f, &alice, id, &project).await.status(), 200);
    assert_eq!(
        frame(&mut socket).await,
        Frame::Text(json!({"revision":"1"}).to_string())
    );
    f.close().await;
}

#[tokio::test]
async fn share_links_grant_anonymous_read_only_access_until_revoked() {
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
    let mut project = Project::new("Shared plan").unwrap();
    project
        .apply(Command::CreateNode {
            parent: None,
            index: None,
            text: "Idea".into(),
            color: Color::BLUE,
            fill: None,
        })
        .unwrap();
    assert_eq!(upload(&f, &alice, id, &project).await.status(), 200);

    // Private by default.
    let link: Value = f
        .rpc("getShareLink", &alice, json!({"projectId":id}))
        .await
        .json()
        .await
        .unwrap();
    assert!(link["token"].is_null());
    // Only the owner sees or changes the link, and only from the app origin.
    for method in ["getShareLink", "setShareLink"] {
        let args = if method == "getShareLink" {
            json!({"projectId":id})
        } else {
            json!({"projectId":id,"enabled":true})
        };
        assert_eq!(f.rpc(method, &bob, args.clone()).await.status(), 404);
        assert_eq!(f.rpc(method, "", args).await.status(), 401);
    }
    assert_eq!(
        f.post("setShareLink", &alice)
            .header("origin", "https://evil.example")
            .json(&json!({"projectId":id,"enabled":true}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );

    let token = share(&f, &alice, id, true).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(token.len(), 43);
    // Enabling again keeps the one link.
    assert_eq!(share(&f, &alice, id, true).await["token"], token.as_str());
    let link: Value = f
        .rpc("getShareLink", &alice, json!({"projectId":id}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(link["token"], token.as_str());

    let response = shared(&f, &token).await;
    assert_eq!(response.status(), 200);
    let value: Value = response.json().await.unwrap();
    assert_eq!(value["name"], "Shared plan");
    assert_eq!(value["projectId"], id.to_string());
    let viewed =
        Project::from_snapshot(&STANDARD.decode(value["data"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(viewed.view().unwrap(), project.view().unwrap());
    // The link reads; it never writes or reaches the owner's other APIs.
    assert_eq!(
        f.rpc("getProjectSnapshot", "", json!({"projectId":id}))
            .await
            .status(),
        401
    );
    for bad in ["", "short", &"x".repeat(43), &format!("{token}x")] {
        assert_eq!(shared(&f, bad).await.status(), 404, "{bad}");
    }

    // A viewer's socket needs no session and follows commits.
    let path = format!("/ws/share/{token}");
    let response = websocket(&f, &f.origin, &path).send().await.unwrap();
    assert_eq!(response.status(), 101);
    let mut socket = response.upgrade().await.unwrap();
    assert_eq!(
        frame(&mut socket).await,
        Frame::Text(json!({"revision":"1"}).to_string())
    );

    // Disabling revokes the link, closes its sockets and stops reconnects;
    // re-enabling issues a different one.
    assert!(share(&f, &alice, id, false).await["token"].is_null());
    assert_eq!(shared(&f, &token).await.status(), 404);
    assert_eq!(
        frame(&mut socket).await,
        Frame::Close(1008, "Link disabled".into())
    );
    assert_eq!(
        websocket(&f, &f.origin, &path)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    let renewed = share(&f, &alice, id, true).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(renewed, token);
    assert_eq!(shared(&f, &renewed).await.status(), 200);

    // Deleting the cloud copy revokes the link, also after re-creating it.
    assert_eq!(
        f.rpc("deleteProject", &alice, json!({"projectId":id}))
            .await
            .status(),
        200
    );
    assert_eq!(shared(&f, &renewed).await.status(), 404);
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
    assert_eq!(upload(&f, &alice, id, &project).await.status(), 200);
    assert_eq!(shared(&f, &renewed).await.status(), 404);
    let link: Value = f
        .rpc("getShareLink", &alice, json!({"projectId":id}))
        .await
        .json()
        .await
        .unwrap();
    assert!(link["token"].is_null());
    f.close().await;
}

/// Every op in a document's history and its whole state, deleted tree nodes
/// and their metadata included, as text.
fn everything(bytes: &[u8]) -> String {
    let doc = loro::LoroDoc::new();
    doc.import(bytes).unwrap();
    let history =
        serde_json::to_string(&doc.export_json_updates(&Default::default(), &doc.oplog_vv()))
            .unwrap();
    let tree = doc.get_tree("nodes");
    let metas: Vec<_> = tree
        .nodes()
        .into_iter()
        .map(|id| {
            use loro::ToJson;
            tree.get_meta(id).unwrap().get_deep_value().to_json_value()
        })
        .collect();
    format!(
        "{history}{}{}",
        loro::ToJson::to_json_value(&doc.get_deep_value()),
        Value::from(metas)
    )
}
async fn viewed(f: &Fixture, token: &str) -> (Vec<u8>, String) {
    let response = shared(f, token).await;
    assert_eq!(response.status(), 200);
    let value: Value = response.json().await.unwrap();
    (
        STANDARD.decode(value["data"].as_str().unwrap()).unwrap(),
        value["revision"].as_str().unwrap().into(),
    )
}

/// Viewers get the map as it is now, without the edit history that still
/// holds what the owner deleted. The owner keeps that history.
#[tokio::test]
async fn share_links_never_reveal_deleted_ideas_or_notes() {
    let f = Fixture::new("http://localhost:5173").await;
    let alice = f.credential("alice").await;
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
    let mut project = Project::new("Canary draft").unwrap();
    let create = |project: &mut Project, text: &str| {
        project
            .apply(Command::CreateNode {
                parent: None,
                index: None,
                text: text.into(),
                color: Color::BLUE,
                fill: None,
            })
            .unwrap()
            .created_node
            .unwrap()
    };
    let kept = create(&mut project, "Kept");
    let secret = create(&mut project, "Canary idea");
    project
        .apply(Command::SetNote {
            id: secret.clone(),
            note: "Canary note: hunter2".into(),
        })
        .unwrap();
    project
        .apply(Command::DeleteNode {
            id: secret,
            gap: None,
        })
        .unwrap();
    project
        .apply(Command::Rename {
            name: "Plan".into(),
        })
        .unwrap();
    assert_eq!(upload(&f, &alice, id, &project).await.status(), 200);
    let token = share(&f, &alice, id, true).await["token"]
        .as_str()
        .unwrap()
        .to_owned();

    let (bytes, revision) = viewed(&f, &token).await;
    assert_eq!(revision, "1");
    assert!(!everything(&bytes).contains("Canary"));
    assert!(!bytes.windows(6).any(|window| window == b"Canary"));
    assert_eq!(
        Project::from_snapshot(&bytes).unwrap().view().unwrap(),
        project.view().unwrap()
    );
    // The same revision is served again as it was built.
    assert_eq!(viewed(&f, &token).await, (bytes, revision));
    // The owner still has every past edit to go back to.
    let (owned, _) = baseline(&f, &alice, id).await;
    assert!(everything(&owned.snapshot().unwrap()).contains("Canary note: hunter2"));

    // Viewers follow the owner's edits.
    let response = f
        .rpc(
            "commandProject",
            &alice,
            json!({"projectId":id,"command":{"type":"setText","id":kept,"text":"Edited"}}),
        )
        .await;
    assert_eq!(response.status(), 200);
    let (owned, _) = baseline(&f, &alice, id).await;
    let (bytes, revision) = viewed(&f, &token).await;
    assert_eq!(revision, "2");
    assert!(!everything(&bytes).contains("Canary"));
    let view = Project::from_snapshot(&bytes).unwrap().view().unwrap();
    assert_eq!(view.nodes[0].text, "Edited");
    assert_eq!(view, owned.view().unwrap());

    // Viewers arriving together at a new revision share one build.
    let response = f
        .rpc(
            "commandProject",
            &alice,
            json!({"projectId":id,"command":{"type":"setText","id":kept,"text":"Together"}}),
        )
        .await;
    assert_eq!(response.status(), 200);
    let views = futures_util::future::join_all((0..8).map(|_| viewed(&f, &token))).await;
    for view in &views {
        assert_eq!(view, &views[0]);
    }
    assert_eq!(views[0].1, "3");

    // Turning the link off, or deleting the project, discards viewers' copy.
    let stored = |id: Uuid| {
        sqlx::query_scalar::<_, bool>("SELECT shared_snapshot IS NOT NULL OR shared_revision IS NOT NULL FROM mindgrab_loro.projects WHERE id=$1")
            .bind(id)
            .fetch_one(&f.backend.pool)
    };
    assert!(stored(id).await.unwrap());
    share(&f, &alice, id, false).await;
    assert!(!stored(id).await.unwrap());
    let token = share(&f, &alice, id, true).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    viewed(&f, &token).await;
    assert!(stored(id).await.unwrap());
    assert_eq!(
        f.rpc("deleteProject", &alice, json!({"projectId":id}))
            .await
            .status(),
        200
    );
    assert!(!stored(id).await.unwrap());
    f.close().await;
}

fn node(text: String) -> Command {
    Command::CreateNode {
        parent: None,
        index: None,
        text,
        color: Color::BLUE,
        fill: None,
    }
}
/// A map whose snapshot is over 2 MiB, with the snapshot.
fn large() -> (Project, Vec<u8>) {
    let mut project = Project::new("Large").unwrap();
    for n in 0..48 {
        let text = (0..6_000).map(|i| format!("{n}-{i} ")).collect();
        project.apply(node(text)).unwrap();
    }
    let snapshot = project.snapshot().unwrap();
    assert!(snapshot.len() > 2 * 1024 * 1024, "{}", snapshot.len());
    (project, snapshot)
}

/// Merges compute without a pool connection or a row lock, so one account's
/// burst of merges on a large map cannot keep other accounts from the database.
#[tokio::test]
async fn concurrent_large_merges_leave_other_accounts_responsive() {
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
    let (project, snapshot) = large();
    assert_eq!(upload(&f, &alice, id, &project).await.status(), 200);
    // Each device sends only its own edit, as the webapp does after a first save.
    let version = project.version();
    let edits: Vec<Vec<u8>> = (0..32)
        .map(|n| {
            let mut device = Project::from_snapshot(&snapshot).unwrap();
            device.apply(node(format!("Edit {n}"))).unwrap();
            device.updates_since(&version).unwrap()
        })
        .collect();
    let merging = std::sync::atomic::AtomicBool::new(true);
    let merges = async {
        let statuses = futures_util::future::join_all(edits.into_iter().map(|edit| async {
            f.post("mergeProject", &alice)
                .query(&[("projectId", id)])
                .header("content-type", "application/octet-stream")
                .body(edit)
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        }))
        .await;
        merging.store(false, Ordering::SeqCst);
        statuses
    };
    let others = async {
        let mut calls = 0;
        while merging.load(Ordering::SeqCst) {
            let started = std::time::Instant::now();
            let response = f.rpc("listProjects", &bob, json!({"limit":100})).await;
            assert_eq!(response.status(), 200);
            assert!(
                started.elapsed() < std::time::Duration::from_secs(2),
                "listProjects took {:?} during merges",
                started.elapsed()
            );
            calls += 1;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        calls
    };
    let (statuses, calls) = tokio::join!(merges, others);
    assert!(calls > 1, "{calls}");
    // Merges over the account's limit are refused, never left holding a connection.
    assert!(
        statuses.iter().all(|status| [200, 429].contains(status)),
        "{statuses:?}"
    );
    let merged: Vec<usize> = (0..32).filter(|n| statuses[*n] == 200).collect();
    assert!(!merged.is_empty());
    let (committed, revision) = baseline(&f, &alice, id).await;
    assert_eq!(revision, (1 + merged.len()).to_string());
    let texts: Vec<String> = committed
        .view()
        .unwrap()
        .nodes
        .into_iter()
        .map(|node| node.text)
        .collect();
    for n in 0..32 {
        assert_eq!(
            texts.contains(&format!("Edit {n}")),
            merged.contains(&n),
            "Edit {n}"
        );
    }
    f.close().await;
}

const RECEIPT: &str = "application/vnd.mindgrab.receipt+json";
const MIB: usize = 1024 * 1024;
/// One request and its answer, with the bytes each body took on the wire.
struct Exchange {
    sent: usize,
    status: u16,
    received: Vec<u8>,
}
impl Exchange {
    async fn new(request: reqwest::RequestBuilder, kind: &str, body: Vec<u8>) -> Self {
        let sent = body.len();
        let response = request
            .header("content-type", kind)
            .body(body)
            .send()
            .await
            .unwrap();
        Self {
            sent,
            status: response.status().as_u16(),
            received: response.bytes().await.unwrap().to_vec(),
        }
    }
    /// The answer of a request that succeeded.
    fn json(&self) -> Value {
        assert_eq!(self.status, 200);
        serde_json::from_slice(&self.received).unwrap()
    }
    fn keys(&self) -> Vec<String> {
        self.json().as_object().unwrap().keys().cloned().collect()
    }
}
async fn call(f: &Fixture, method: &str, browser: &str, args: Value) -> Exchange {
    Exchange::new(
        f.post(method, browser),
        "application/json",
        serde_json::to_vec(&args).unwrap(),
    )
    .await
}
/// A merge that sends `accept`, or no `Accept` at all.
async fn save(
    f: &Fixture,
    browser: &str,
    id: Uuid,
    accept: Option<&str>,
    body: Vec<u8>,
) -> Exchange {
    let mut request = f.post("mergeProject", browser).query(&[("projectId", id)]);
    if let Some(accept) = accept {
        request = request.header("accept", accept);
    }
    Exchange::new(request, "application/octet-stream", body).await
}

/// Saving and polling a large map moves only what changed, while callers that
/// do not ask for that still get the complete snapshot they always got.
#[tokio::test]
async fn saves_and_reads_of_a_large_map_carry_only_what_changed() {
    let f = Fixture::new("http://localhost:5173").await;
    let alice = f.credential("alice").await;
    let bob = f.credential("bob").await;
    let id = Uuid::new_v4();
    let create = || {
        f.rpc(
            "createProject",
            &alice,
            json!({"projectId":id,"schemaVersion":1}),
        )
    };
    assert_eq!(create().await.status(), 200);
    let (project, snapshot) = large();
    let stored = async || {
        sqlx::query_scalar::<_, Vec<u8>>("SELECT snapshot FROM mindgrab_loro.projects WHERE id=$1")
            .bind(id)
            .fetch_one(&f.backend.pool)
            .await
            .unwrap()
    };
    // What a caller that asks for nothing new has always been answered.
    let complete = |snapshot: &[u8], revision: &str| {
        serde_json::to_vec(&json!({"projectId":id,"encoding":"loro-snapshot","data":STANDARD.encode(snapshot),"revision":revision,"durable":true})).unwrap()
    };
    let today = ["data", "durable", "encoding", "projectId", "revision"];
    let read = async |args: Value| {
        let mut body = json!({"projectId":id});
        body.as_object_mut()
            .unwrap()
            .extend(args.as_object().unwrap().clone());
        call(&f, "getProjectSnapshot", &alice, body).await
    };
    // Another account learns nothing of the map, whatever it says it holds.
    let foreign = async |args: Value| {
        let mut body = json!({"projectId":id});
        body.as_object_mut()
            .unwrap()
            .extend(args.as_object().unwrap().clone());
        let refused = call(&f, "getProjectSnapshot", &bob, body).await;
        assert_eq!(refused.status, 404, "{args}");
        assert_eq!(
            serde_json::from_slice::<Value>(&refused.received).unwrap(),
            json!({"error":{"code":"project_not_found"}}),
            "{args}"
        );
    };
    // Not while the map is registered and holds no snapshot yet.
    foreign(json!({"since":""})).await;

    // The first save sends the whole map and gets a receipt back, not the map.
    let first = save(&f, &alice, id, Some(RECEIPT), snapshot.clone()).await;
    assert!(first.received.len() < 1024, "{}", first.received.len());
    let head = project.head().unwrap();
    assert_eq!(
        first.json(),
        json!({"projectId":id,"encoding":"loro-update","data":"","head":head,"revision":"1","durable":true})
    );

    let listing = call(&f, "listProjects", &alice, json!({"limit":100})).await;
    assert!(listing.received.len() < 1024, "{}", listing.received.len());
    assert_eq!(listing.json()["projects"][0]["revision"], "1");
    let recent = call(&f, "listProjects", &alice, json!({"recent":true})).await;
    assert_eq!(recent.json()["projects"][0]["revision"], "1");

    // An idle poll of an unchanged map carries no document bytes.
    let idle = read(json!({"revision":"1","since":head})).await;
    assert!(idle.received.len() < 512, "{}", idle.received.len());
    assert_eq!(
        idle.json(),
        json!({"projectId":id,"encoding":"loro-update","data":"","revision":"1","durable":true})
    );
    // Nor does one from a client that holds the map but no revision for it.
    let held = read(json!({"since":head})).await;
    assert!(held.received.len() < 512, "{}", held.received.len());
    assert_eq!(
        held.json(),
        json!({"projectId":id,"encoding":"loro-update","data":"","head":head,"revision":"1","durable":true})
    );
    // Naming the revision the map is at tells another account nothing either.
    foreign(json!({"revision":"1","since":head})).await;

    // One typed character goes up as that change and comes back as a receipt.
    let mut device = Project::from_snapshot(&snapshot).unwrap();
    let idea = device.view().unwrap().nodes[0].id.clone();
    device
        .apply(Command::EditText {
            id: idea,
            index: 0,
            delete_count: 0,
            insert: "x".into(),
        })
        .unwrap();
    let edit = device.updates_since(&project.version()).unwrap();
    let edited = device.head().unwrap();
    assert_ne!(edited, head);
    let second = save(&f, &alice, id, Some(RECEIPT), edit.clone()).await;
    assert!(second.sent < 2 * 1024, "{}", second.sent);
    assert!(second.received.len() < 1024, "{}", second.received.len());
    assert_eq!(
        second.json(),
        json!({"projectId":id,"encoding":"loro-update","data":"","head":edited,"revision":"2","durable":true})
    );
    // The whole save, with the read before it, stays small both ways.
    assert!(idle.sent + second.sent < 4 * 1024);
    assert!(idle.received.len() + second.received.len() < 4 * 1024);

    // Another device at the earlier version gets that one change.
    let behind = read(json!({"revision":"1","since":head})).await;
    assert!(
        behind.received.len() < 2 * 1024,
        "{}",
        behind.received.len()
    );
    let value = behind.json();
    assert_eq!(value["encoding"], "loro-update");
    assert_eq!(value["head"], edited.as_str());
    assert_eq!(value["revision"], "2");
    let mut replica = Project::from_snapshot(&snapshot).unwrap();
    replica
        .merge(&STANDARD.decode(value["data"].as_str().unwrap()).unwrap())
        .unwrap();
    assert_eq!(replica.view().unwrap(), device.view().unwrap());
    assert_eq!(replica.head().unwrap(), edited);

    // A client that holds nothing of the cloud copy gets the complete map. A
    // head that is malformed or too long counts as holding nothing; it is
    // never an error.
    let mut elsewhere = Project::from_snapshot(&snapshot).unwrap();
    elsewhere.apply(node("Never saved".into())).unwrap();
    let long = vec![head.as_str(); 4096 / head.len() + 1].join(",");
    assert!(
        long.len() > 4096 && long.len() < 12 * 1024,
        "{}",
        long.len()
    );
    let saved = stored().await;
    for since in ["", &elsewhere.head().unwrap(), "not a head", "-1@5", &long] {
        let everything = read(json!({"since":since})).await;
        assert_eq!(everything.status, 200, "{since}");
        assert!(everything.received.len() > 2 * MIB, "{since}");
        let value = everything.json();
        assert_eq!(value["encoding"], "loro-snapshot", "{since}");
        assert_eq!(value["head"], edited.as_str(), "{since}");
        assert_eq!(value["revision"], "2", "{since}");
        assert!(
            STANDARD.decode(value["data"].as_str().unwrap()).unwrap() == saved,
            "{since}"
        );
    }
    // Only a string says what a client holds.
    for args in [
        json!({"revision":1,"since":head}),
        json!({"revision":"1","since":5}),
        json!({"revision":null}),
        json!({"since":null}),
        json!({"since":head,"version":"1"}),
    ] {
        let refused = read(args.clone()).await;
        assert_eq!(refused.status, 400, "{args}");
        assert_eq!(
            serde_json::from_slice::<Value>(&refused.received).unwrap(),
            json!({"error":{"code":"invalid_request"}})
        );
    }

    // Callers that predate receipts ask for nothing, or for anything, and get
    // the snapshot in exactly the shape they always did.
    let expected = complete(&saved, "2");
    let plain = read(json!({})).await;
    assert_eq!(plain.sent, format!(r#"{{"projectId":"{id}"}}"#).len());
    assert_eq!(plain.keys(), today);
    assert!(plain.received.len() > 2 * MIB);
    assert!(plain.received == expected);
    for accept in [None, Some("*/*"), Some("application/*")] {
        let repeated = save(&f, &alice, id, accept, edit.clone()).await;
        assert_eq!(repeated.keys(), today, "{accept:?}");
        assert!(repeated.received.len() > 2 * MIB, "{accept:?}");
        assert!(repeated.received == expected, "{accept:?}");
    }
    // The receipt is found among other types, in any letter case, and a merge
    // that changes nothing keeps the revision.
    let listed = "text/html, Application/Vnd.Mindgrab.Receipt+JSON ;q=0.9";
    let repeated = save(&f, &alice, id, Some(listed), edit).await;
    assert_eq!(repeated.json(), second.json());

    // Native commands answer the same two ways.
    let command = |text: &str| json!({"projectId":id,"command":{"type":"createNode","parent":null,"index":null,"text":text,"color":"teal"}});
    let slim = Exchange::new(
        f.post("commandProject", &alice).header("accept", RECEIPT),
        "application/json",
        serde_json::to_vec(&command("Slim")).unwrap(),
    )
    .await;
    assert!(slim.received.len() < 1024, "{}", slim.received.len());
    let value = slim.json();
    assert_eq!(value["encoding"], "loro-update");
    assert_eq!(value["data"], "");
    assert_eq!(value["revision"], "3");
    let commanded = Project::from_snapshot(&stored().await).unwrap();
    assert_eq!(value["head"], commanded.head().unwrap().as_str());
    assert_eq!(commanded.view().unwrap().nodes.last().unwrap().text, "Slim");
    let full = call(&f, "commandProject", &alice, command("Full")).await;
    assert_eq!(full.keys(), today);
    assert!(full.received.len() > 2 * MIB);
    assert!(full.received == complete(&stored().await, "4"));

    // A cloud copy deleted and created again holds nothing: a client that
    // remembers the old one is told so, and then sends its map.
    let remembered = json!({"revision":"4","since":commanded.head().unwrap()});
    assert_eq!(
        f.rpc("deleteProject", &alice, json!({"projectId":id}))
            .await
            .status(),
        200
    );
    assert_eq!(read(remembered.clone()).await.status, 404);
    assert_eq!(create().await.status(), 200);
    let emptied = read(remembered).await;
    assert_eq!(
        emptied.json(),
        json!({"projectId":id,"encoding":"loro-snapshot","data":"","revision":"5","durable":true})
    );
    f.close().await;
}

/// Only a snapshot upload may be large, and only from a signed-in account: every
/// other body the server agrees to hold is a few identifiers.
#[tokio::test]
async fn a_body_is_read_only_after_the_session_and_up_to_its_methods_limit() {
    let f = Fixture::new("http://localhost:5173").await;
    let megabyte = vec![b' '; 1024 * 1024];
    let stranger = f
        .post("mergeProject", "no-such-session")
        .query(&[("projectId", Uuid::new_v4())])
        .header("content-type", "application/octet-stream")
        .body(megabyte.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(stranger.status(), 401);
    let alice = f.credential("alice").await;
    let oversized = f
        .post("listProjects", &alice)
        .header("content-type", "application/json")
        .body(megabyte)
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), 413);
    f.close().await;
}

async fn preferences(f: &Fixture, browser: &str) -> Value {
    let response = f.rpc("listPreferences", browser, json!({})).await;
    assert_eq!(response.status(), 200);
    response.json::<Value>().await.unwrap()["preferences"].clone()
}

#[tokio::test]
async fn preferences_belong_to_their_account_and_reach_shared_maps() {
    let f = Fixture::new("http://localhost:5173").await;
    let alice = f.credential("alice").await;
    let bob = f.credential("bob").await;
    let id = Uuid::new_v4();
    // A map preference needs no cloud copy of its map.
    let local = Uuid::new_v4();
    assert_eq!(preferences(&f, &alice).await, json!([]));
    let saved = f
        .rpc(
            "setPreferences",
            &alice,
            json!({"set":[
                {"scope":"global","projectId":null,"name":"linkStyle","value":"square"},
                {"scope":"global","projectId":null,"name":"quickColors","value":["slate","sky-400"]},
                {"scope":"map","projectId":id,"name":"linkStyle","value":"freeform"},
                {"scope":"map","projectId":local,"name":"newIdeaColor","value":"lime-200"},
            ]}),
        )
        .await;
    assert_eq!(saved.status(), 200);
    assert_eq!(
        preferences(&f, &alice).await,
        json!([
            {"scope":"global","projectId":null,"name":"linkStyle","value":"square"},
            {"scope":"global","projectId":null,"name":"quickColors","value":["slate","sky-400"]},
            {"scope":"map","projectId":id.to_string(),"name":"linkStyle","value":"freeform"},
            {"scope":"map","projectId":local.to_string(),"name":"newIdeaColor","value":"lime-200"},
        ])
    );
    // Setting again replaces the value; clearing removes the row.
    assert_eq!(
        f.rpc(
            "setPreferences",
            &alice,
            json!({
                "set":[{"scope":"global","projectId":null,"name":"linkStyle","value":"rounded"}],
                "clear":[{"scope":"map","projectId":local,"name":"newIdeaColor"}],
            }),
        )
        .await
        .status(),
        200
    );
    let listed = preferences(&f, &alice).await;
    assert_eq!(listed.as_array().unwrap().len(), 3);
    assert_eq!(listed[0]["value"], "rounded");
    // Another account sees none of them.
    assert_eq!(preferences(&f, &bob).await, json!([]));

    // Bad values, names, scopes and maps are refused, and nothing of a
    // refused request is kept.
    for set in [
        json!({"scope":"global","projectId":null,"name":"linkStyle","value":"zigzag"}),
        json!({"scope":"global","projectId":null,"name":"quickColors","value":["slate","slate"]}),
        json!({"scope":"global","projectId":null,"name":"newIdeaColor","value":"teal"}),
        json!({"scope":"global","projectId":null,"name":"fontSize","value":12}),
        json!({"scope":"folder","projectId":null,"name":"linkStyle","value":"square"}),
        json!({"scope":"global","projectId":id,"name":"linkStyle","value":"square"}),
        json!({"scope":"map","projectId":null,"name":"linkStyle","value":"square"}),
        json!({"scope":"map","projectId":"not-a-uuid","name":"linkStyle","value":"square"}),
    ] {
        let response = f
            .rpc(
                "setPreferences",
                &alice,
                json!({"set":[
                    {"scope":"global","projectId":null,"name":"linkStyle","value":"freeform"},
                    set,
                ]}),
            )
            .await;
        assert_eq!(response.status(), 400, "{set}");
    }
    assert_eq!(preferences(&f, &alice).await, listed);
    // Only a session may read them, and only the app's origin may change them.
    assert_eq!(f.rpc("listPreferences", "", json!({})).await.status(), 401);
    assert_eq!(
        f.post("setPreferences", &alice)
            .header("origin", "https://evil.example")
            .json(&json!({"set":[]}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );

    // A shared map draws its lines as its owner chose for it.
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
    let project = Project::new("Shared look").unwrap();
    assert_eq!(upload(&f, &alice, id, &project).await.status(), 200);
    let token = share(&f, &alice, id, true).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let style =
        async || shared(&f, &token).await.json::<Value>().await.unwrap()["linkStyle"].clone();
    assert_eq!(style().await, "freeform");
    // Without a value of its own, the map follows the owner's global one.
    f.rpc(
        "setPreferences",
        &alice,
        json!({"clear":[{"scope":"map","projectId":id,"name":"linkStyle"}]}),
    )
    .await;
    assert_eq!(style().await, "rounded");
    f.rpc(
        "setPreferences",
        &alice,
        json!({"set":[{"scope":"global","projectId":null,"name":"linkStyle","value":"square"}]}),
    )
    .await;
    assert_eq!(style().await, "square");
    // Another account's choices never reach it.
    f.rpc(
        "setPreferences",
        &bob,
        json!({"set":[{"scope":"map","projectId":id,"name":"linkStyle","value":"freeform"}]}),
    )
    .await;
    assert_eq!(style().await, "square");
    f.close().await;
}

#[tokio::test]
async fn maps_kept_out_of_the_cloud_are_not_stored_there() {
    let f = Fixture::new("http://localhost:5173").await;
    let alice = f.credential("alice").await;
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
    let project = Project::new("Kept here").unwrap();
    let set = async |rows: Value| {
        assert_eq!(
            f.rpc("setPreferences", &alice, json!({ "set": rows }))
                .await
                .status(),
            200
        );
    };
    // Off for all maps: no map without a value of its own is stored.
    set(json!([{"scope":"global","projectId":null,"name":"saveInCloud","value":false}])).await;
    let refused = upload(&f, &alice, id, &project).await;
    assert_eq!(refused.status(), 422);
    assert_eq!(
        refused.json::<Value>().await.unwrap()["error"]["code"],
        "cloud_disabled"
    );
    // A map that keeps itself in the cloud is.
    set(json!([{"scope":"map","projectId":id,"name":"saveInCloud","value":true}])).await;
    assert_eq!(upload(&f, &alice, id, &project).await.status(), 200);
    // And one turned off itself is not, whatever all maps do.
    set(json!([
        {"scope":"global","projectId":null,"name":"saveInCloud","value":true},
        {"scope":"map","projectId":id,"name":"saveInCloud","value":false},
    ]))
    .await;
    assert_eq!(upload(&f, &alice, id, &project).await.status(), 422);
    // Consent is the person's, never one map's.
    assert_eq!(
        f.rpc(
            "setPreferences",
            &alice,
            json!({"set":[{"scope":"map","projectId":id,"name":"analyticsConsent","value":"granted"}]}),
        )
        .await
        .status(),
        400
    );
    f.close().await;
}
