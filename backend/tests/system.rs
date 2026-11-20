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
    let node = |text: String| Command::CreateNode {
        parent: None,
        index: None,
        text,
        color: Color::BLUE,
        fill: None,
    };
    let mut project = Project::new("Large").unwrap();
    for n in 0..48 {
        let text = (0..6_000).map(|i| format!("{n}-{i} ")).collect();
        project.apply(node(text)).unwrap();
    }
    let snapshot = project.snapshot().unwrap();
    assert!(snapshot.len() > 2 * 1024 * 1024, "{}", snapshot.len());
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
