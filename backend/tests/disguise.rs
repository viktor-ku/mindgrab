mod common;

use common::*;
use mindgrab_state::Project;
use reqwest::{Method, Response, Upgraded, header::HeaderMap};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use uuid::Uuid;

fn php_error(status: &str) -> String {
    format!(
        "<br />\n<b>Fatal error</b>:  Uncaught Exception: {status} in /var/www/html/index.php:42\nStack trace:\n#0 {{main}}\n  thrown in <b>/var/www/html/index.php</b> on line <b>42</b><br />\n"
    )
}
const RPC_METHODS: [(&str, u16); 14] = [
    ("getHealth", 200),
    ("startLogin", 303),
    ("logout", 303),
    ("getMe", 401),
    ("getSharedProject", 400),
    ("createProject", 401),
    ("deleteProject", 401),
    ("mergeProject", 401),
    ("commandProject", 401),
    ("setShareLink", 401),
    ("listProjects", 401),
    ("getProjectSnapshot", 401),
    ("getProjectState", 401),
    ("getShareLink", 401),
];

fn assert_disguised(headers: &HeaderMap) {
    assert_eq!(headers["server"], "Apache/2.4.62 (Debian)");
    assert_eq!(headers["x-powered-by"], "PHP/8.3.14");
    assert_eq!(headers["x-powered-by.php"], "PHP/8.3.14");
}
async fn assert_php_404(response: Response, label: &str) {
    assert_eq!(response.status(), 404, "{label}");
    assert_disguised(response.headers());
    assert_eq!(response.headers()["cache-control"], "no-store", "{label}");
    assert!(
        response
            .headers()
            .contains_key("access-control-allow-origin"),
        "{label}"
    );
    assert_eq!(
        response.headers()["content-type"],
        "text/html; charset=UTF-8",
        "{label}"
    );
    assert_eq!(
        response.text().await.unwrap(),
        php_error("404 Not Found"),
        "{label}"
    );
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
async fn frame(socket: &mut Upgraded) -> Frame {
    // Longer than the socket's 20 second reconciliation timer.
    tokio::time::timeout(Duration::from_secs(30), async {
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
fn revision(number: u32) -> Frame {
    Frame::Text(json!({"revision":number.to_string()}).to_string())
}
async fn project(f: &Fixture, browser: &str) -> (Uuid, Project) {
    let id = Uuid::new_v4();
    let created = f
        .rpc(
            "createProject",
            browser,
            json!({"projectId":id,"schemaVersion":1}),
        )
        .await;
    assert_eq!(created.status(), 200);
    (id, Project::new("Plan").unwrap())
}
async fn upload(f: &Fixture, browser: &str, id: Uuid, project: &Project) {
    let response = f
        .post("mergeProject", browser)
        .query(&[("projectId", id)])
        .header("content-type", "application/octet-stream")
        .body(project.snapshot().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}
async fn share_token(f: &Fixture, browser: &str, id: Uuid, enabled: bool) -> Value {
    let response = f
        .rpc(
            "setShareLink",
            browser,
            json!({"projectId":id,"enabled":enabled}),
        )
        .await;
    assert_eq!(response.status(), 200);
    response.json::<Value>().await.unwrap()["token"].clone()
}

#[tokio::test]
async fn retired_paths_and_unknown_scripts_get_a_php_error() {
    let f = Fixture::new("http://localhost:5173").await;
    let id = Uuid::new_v4();
    let token = "x".repeat(43);
    let mut requests = vec![
        (Method::GET, "/index.php".to_owned()),
        (Method::GET, "/checkhealth".to_owned()),
        (Method::GET, "/checkhealth.php".to_owned()),
        (Method::GET, "/api/auth/callback".to_owned()),
        (Method::POST, format!("/api/mergeProject?projectId={id}")),
        (Method::POST, "/api/unknownMethod.php".to_owned()),
        (Method::POST, "/api/getMe.php/extra".to_owned()),
        (Method::GET, "/ingest/e/".to_owned()),
        (Method::POST, "/ingest/e/".to_owned()),
        (Method::GET, "/ingest.php".to_owned()),
        (Method::PUT, "/nowhere".to_owned()),
    ];
    requests.extend(RPC_METHODS.map(|(method, _)| (Method::POST, format!("/api/{method}"))));
    for (method, path) in requests {
        let response = f
            .client
            .request(method.clone(), format!("{}{path}", f.url))
            .header("origin", &f.origin)
            .send()
            .await
            .unwrap();
        assert_php_404(response, &format!("{method} {path}")).await;
    }
    for path in [format!("/sync/loro/{id}"), format!("/sync/share/{token}")] {
        let response = websocket(&f, &f.origin, &path).send().await.unwrap();
        assert_php_404(response, &path).await;
    }
    f.close().await;
}

#[tokio::test]
async fn framework_errors_read_as_php_without_echoing_the_request() {
    let f = Fixture::new("http://localhost:5173").await;
    let id = Uuid::new_v4();
    let cases = [
        (
            Method::GET,
            "/api/getMe.php".to_owned(),
            "405 Method Not Allowed",
        ),
        (Method::POST, "/".to_owned(), "405 Method Not Allowed"),
        (
            Method::GET,
            "/ws/project/%3Cscript%3E?ownerId=1".to_owned(),
            "400 Bad Request",
        ),
        (Method::GET, format!("/ws/project/{id}"), "400 Bad Request"),
    ];
    for (method, path, status) in cases {
        let response = f
            .client
            .request(method.clone(), format!("{}{path}", f.url))
            .send()
            .await
            .unwrap();
        let label = format!("{method} {path}");
        assert_eq!(
            response.status().as_u16().to_string(),
            status[..3],
            "{label}"
        );
        assert_disguised(response.headers());
        assert_eq!(
            response.headers()["content-type"],
            "text/html; charset=UTF-8",
            "{label}"
        );
        assert_eq!(response.text().await.unwrap(), php_error(status), "{label}");
    }
    let oversized = f
        .client
        .post(format!("{}/api/getMe.php", f.url))
        .body(vec![0; mindgrab_state::MAX_SNAPSHOT_BYTES + 8192])
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), 413);
    assert_eq!(
        oversized.text().await.unwrap(),
        php_error("413 Payload Too Large")
    );
    f.close().await;
}

#[tokio::test]
async fn the_webapps_json_errors_stay_json() {
    let f = Fixture::new("http://localhost:5173").await;
    let response = f
        .client
        .post(format!("{}/api/getMe.php", f.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert_disguised(response.headers());
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "unauthorized");
    f.close().await;
}

#[tokio::test]
async fn the_analytics_proxy_is_a_404_until_it_is_configured() {
    let f = Fixture::new("http://localhost:5173").await;
    let response = f
        .client
        .get(format!("{}/ingest.php/static/array.js", f.url))
        .send()
        .await
        .unwrap();
    assert_php_404(response, "unconfigured proxy").await;
    f.close().await;
}

#[tokio::test]
async fn every_rpc_answers_at_its_php_script_and_only_there() {
    let f = Fixture::new("http://localhost:5173").await;
    for (method, status) in RPC_METHODS {
        let response = f.rpc(method, "", json!({})).await;
        assert_eq!(response.status(), status, "{method}");
        assert_disguised(response.headers());
        let wrong_verb = f
            .client
            .get(format!("{}/api/{method}.php", f.url))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_verb.status(), 405, "{method}");
        assert_disguised(wrong_verb.headers());
    }
    f.close().await;
}

#[tokio::test]
async fn the_callback_checks_login_state_at_its_php_script() {
    let f = Fixture::new("http://localhost:5173").await;
    let response = f
        .client
        .get(format!("{}/api/auth/callback.php?state=a&code=b", f.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 303);
    assert_eq!(
        response.headers()["location"],
        format!("{}/?auth_error=sign_in_failed", f.origin)
    );
    assert_disguised(response.headers());
    f.close().await;
}

#[tokio::test]
async fn preflights_allow_the_account_header_and_expose_server_timing() {
    let f = Fixture::new("http://localhost:5173").await;
    let response = f
        .client
        .request(Method::OPTIONS, format!("{}/api/getMe.php", f.url))
        .header("origin", &f.origin)
        .header("access-control-request-method", "POST")
        .header(
            "access-control-request-headers",
            "content-type,x-mindgrab-account.php",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_disguised(response.headers());
    let headers = response.headers();
    assert_eq!(headers["access-control-allow-origin"], f.origin);
    let allowed = headers["access-control-allow-headers"].to_str().unwrap();
    assert!(
        allowed
            .split(',')
            .any(|name| name.trim() == "x-mindgrab-account.php"),
        "{allowed}"
    );
    assert!(
        !allowed
            .split(',')
            .any(|name| name.trim() == "x-mindgrab-account")
    );

    let response = f
        .client
        .get(format!("{}/", f.url))
        .header("origin", &f.origin)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_disguised(response.headers());
    assert_eq!(
        response.headers()["access-control-expose-headers"],
        "server-timing.php"
    );
    f.close().await;
}

#[tokio::test]
async fn project_sockets_follow_commits_at_the_ws_path() {
    let f = Fixture::new("http://localhost:5173").await;
    let alice = f.credential("alice").await;
    let (id, snapshot) = project(&f, &alice).await;
    let user: Value = f
        .rpc("getMe", &alice, json!({}))
        .await
        .json()
        .await
        .unwrap();
    let path = format!("/ws/project/{id}?ownerId={}", user["id"]);
    let session = format!(
        "{}={alice}",
        f.backend
            .config
            .cookie_name(mindgrab_backend::auth::SESSION_COOKIE)
    );

    let foreign = websocket(&f, "https://evil.example", &path)
        .header("cookie", &session)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), 403);
    assert_disguised(foreign.headers());

    let response = websocket(&f, &f.origin, &path)
        .header("cookie", &session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 101);
    assert_disguised(response.headers());
    assert_eq!(response.headers()["upgrade"], "websocket");
    let mut socket = response.upgrade().await.unwrap();
    assert_eq!(frame(&mut socket).await, revision(0));
    upload(&f, &alice, id, &snapshot).await;
    assert_eq!(frame(&mut socket).await, revision(1));
    f.close().await;
}

#[tokio::test]
async fn share_sockets_need_no_session_and_close_when_the_link_is_revoked() {
    let f = Fixture::new("http://localhost:5173").await;
    let alice = f.credential("alice").await;
    let (id, snapshot) = project(&f, &alice).await;
    upload(&f, &alice, id, &snapshot).await;
    let token = share_token(&f, &alice, id, true).await;
    let path = format!("/ws/share/{}", token.as_str().unwrap());
    let foreign = websocket(&f, "https://evil.example", &path)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), 403);
    assert_disguised(foreign.headers());

    let response = websocket(&f, &f.origin, &path).send().await.unwrap();
    assert_eq!(response.status(), 101);
    assert_disguised(response.headers());
    let mut socket = response.upgrade().await.unwrap();
    assert_eq!(frame(&mut socket).await, revision(1));

    assert!(share_token(&f, &alice, id, false).await.is_null());
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
        404,
        "a revoked link cannot reconnect"
    );
    f.close().await;
}

#[tokio::test]
async fn phpmyadmin_is_served_through_the_full_router() {
    let f = Fixture::new("http://localhost:5173").await;
    for path in ["/phpmyadmin", "/phpmyadmin/"] {
        let response = f
            .client
            .get(format!("{}{path}", f.url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 302, "{path}");
        assert_eq!(response.headers()["location"], "/phpmyadmin/index.php");
        assert_disguised(response.headers());
    }
    let index = format!("{}/phpmyadmin/index.php", f.url);
    let response = f.client.get(&index).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_disguised(response.headers());
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(
        response
            .text()
            .await
            .unwrap()
            .contains("Welcome to <bdo dir=\"ltr\" lang=\"en\">phpMyAdmin</bdo>")
    );

    // Larger than the login form's limit, smaller than the router's.
    let response = f
        .client
        .post(&index)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(format!(
            "pma_username=root&padding={}",
            "a".repeat(64 * 1024)
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_disguised(response.headers());
    assert!(
        response
            .text()
            .await
            .unwrap()
            .contains("Access denied for user ''@'localhost' (using password: NO)")
    );
    f.close().await;
}
