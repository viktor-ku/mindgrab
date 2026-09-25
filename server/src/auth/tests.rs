use super::*;
use axum::body::{Body, to_bytes};
use base64::{Engine, engine::general_purpose::STANDARD};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde_json::{Value, json};
use std::sync::{
    Mutex,
    atomic::{AtomicU16, AtomicUsize, Ordering},
};
use tower::ServiceExt;

// This key is generated solely for tests and is never used by the application.
const TEST_KEY: &[u8] = include_bytes!("fixtures/test-private.pem");

fn signed_token(exp: u64, overrides: Value) -> String {
    let mut claims = json!({
        "iss": "https://api.workos.com/user_management/client_test", "client_id": "client_test",
        "sub": "user_test", "sid": "session_test", "exp": exp,
    });
    for (key, value) in overrides.as_object().unwrap() {
        claims[key] = value.clone();
    }
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("test-key".into());
    encode(
        &header,
        &claims,
        &EncodingKey::from_rsa_pem(TEST_KEY).unwrap(),
    )
    .unwrap()
}

#[derive(Default)]
struct Mock {
    refresh_status: AtomicU16,
    refresh_calls: AtomicUsize,
    requests: Mutex<Vec<Value>>,
}

struct Fixture {
    state: Arc<AppState>,
    mock: Arc<Mock>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn fixture(pool: PgPool) -> Fixture {
    let mock = Arc::new(Mock::default());
    let service = Router::new()
        .route("/sso/jwks/client_test", get(|| async {
            Json(serde_json::from_str::<Value>(include_str!("fixtures/jwks.json")).unwrap())
        }))
        .route("/user_management/authenticate", post(
            |State(mock): State<Arc<Mock>>, Json(body): Json<Value>| async move {
                mock.requests.lock().unwrap().push(body.clone());
                let refresh = body["grant_type"] == "refresh_token";
                if refresh {
                    mock.refresh_calls.fetch_add(1, Ordering::SeqCst);
                    let status = mock.refresh_status.load(Ordering::SeqCst);
                    if status != 0 {
                        return (StatusCode::from_u16(status).unwrap(), Json(json!({
                            "error": if status == 400 { "invalid_grant" } else { "server_error" }
                        }))).into_response();
                    }
                }
                Json(json!({
                    "user": {"id":"user_test", "email":"test@example.com", "first_name":"Test", "last_name":"User"},
                    "access_token": signed_token(jsonwebtoken::get_current_timestamp()+3600, json!({})),
                    "refresh_token": if refresh { "rotated-refresh" } else { "initial-refresh" },
                })).into_response()
            }
        )).with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, service).await.unwrap();
    });
    let config = Config {
        database_url: String::new(),
        client_id: "client_test".into(),
        api_key: "test-secret".into(),
        redirect_uri: "http://localhost:5173/api/auth/callback".into(),
        app_url: "http://localhost:5173/".into(),
        issuer: crate::config::default_issuer("client_test"),
        secure_cookies: false,
    };
    let workos = WorkOs::new(&config).unwrap().with_test_endpoint(endpoint);
    Fixture {
        state: Arc::new(AppState {
            config,
            pool,
            workos,
        }),
        mock,
        task,
    }
}

async fn request(
    f: &Fixture,
    method: &str,
    path: &str,
    cookies: &str,
    origin: Option<&str>,
) -> Response {
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header(header::COOKIE, cookies);
    if let Some(origin) = origin {
        builder = builder.header(header::ORIGIN, origin);
    }
    router(f.state.clone())
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn request_json(
    f: &Fixture,
    method: &str,
    path: &str,
    cookies: &str,
    body: Value,
) -> Response {
    router(f.state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method(method)
                .uri(path)
                .header(header::COOKIE, cookies)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

fn response_cookie(response: &Response, name: &str) -> String {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|header| header.to_str().unwrap())
        .find(|header| header.starts_with(&format!("{name}=")))
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

async fn start_login(f: &Fixture) -> (String, String) {
    let response = request(f, "GET", "/api/auth/login", "", None).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let cookie = response_cookie(&response, STATE_COOKIE);
    let url = reqwest::Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["provider"], "authkit");
    assert_eq!(params["redirect_uri"], f.state.config.redirect_uri);
    assert_eq!(params["code_challenge_method"], "S256");
    assert!(!url.as_str().contains("test-secret"));
    let verifier: String =
        sqlx::query_scalar("SELECT code_verifier FROM auth_login_attempts WHERE state_hash = $1")
            .bind(token_hash(&params["state"]))
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(params["code_challenge"], token_hash(&verifier));
    (
        cookie,
        format!(
            "/api/auth/callback?code=valid-code&state={}",
            params["state"]
        ),
    )
}

async fn sign_in(f: &Fixture) -> String {
    let (cookie, callback) = start_login(f).await;
    let response = request(f, "GET", &callback, &cookie, None).await;
    assert_eq!(
        response.headers()[header::LOCATION],
        "http://localhost:5173/"
    );
    let raw_cookie = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|h| h.to_str().unwrap())
        .find(|h| h.starts_with("mindgrab_session="))
        .unwrap();
    assert!(raw_cookie.contains("HttpOnly"));
    assert!(raw_cookie.contains("SameSite=Lax"));
    assert!(raw_cookie.contains("Path=/"));
    response_cookie(&response, SESSION_COOKIE)
}

async fn session_count(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM auth_sessions")
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}

async fn expire_access_token(f: &Fixture) {
    sqlx::query("UPDATE auth_sessions SET access_token = $1")
        .bind(signed_token(
            jsonwebtoken::get_current_timestamp() - 60,
            json!({}),
        ))
        .execute(&f.state.pool)
        .await
        .unwrap();
}

#[sqlx::test]
async fn anonymous_and_forged_sessions_are_rejected(pool: PgPool) {
    let f = fixture(pool).await;
    for cookies in ["", "mindgrab_session=forged"] {
        let response = request(&f, "GET", "/api/me", cookies, None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
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
    let project_state = project_payload["state"].clone();
    let mut depth = 0;
    let mut node = &project_state["nodes"][0];
    while !node.is_null() {
        depth += 1;
        node = &node["next"][0];
    }
    assert_eq!(depth, 10);

    let anonymous_read = request(&f, "GET", "/api/projects", "", None).await;
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
    let first_write = request_json(
        &f,
        "PUT",
        "/api/projects",
        &first_cookie,
        json!({"name":project_name, "state":project_state}),
    )
    .await;
    assert_eq!(first_write.status(), StatusCode::OK);

    let second_user_id: i64 = sqlx::query_scalar(
        "INSERT INTO users (name, email, external_id) VALUES ('Other', 'other@example.com', 'other_user') RETURNING id",
    )
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    let second_token = "second-user-session";
    let second_access = signed_token(
        jsonwebtoken::get_current_timestamp() + 3600,
        json!({"sub":"other_user", "sid":"other_session"}),
    );
    sqlx::query("INSERT INTO auth_sessions (token_hash, user_id, workos_session_id, access_token, refresh_token) VALUES ($1, $2, $3, $4, 'refresh')")
        .bind(token_hash(second_token))
        .bind(second_user_id)
        .bind("other_session")
        .bind(second_access)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let second_cookie = format!("{SESSION_COOKIE}={second_token}");

    let first_projects = request(&f, "GET", "/api/projects", &first_cookie, None).await;
    assert_eq!(first_projects.status(), StatusCode::OK);
    let first_body = to_bytes(first_projects.into_body(), usize::MAX)
        .await
        .unwrap();
    let first_projects: Value = serde_json::from_slice(&first_body).unwrap();
    assert_eq!(first_projects.as_array().unwrap().len(), 1);
    assert_eq!(first_projects[0]["name"], project_name);
    assert_eq!(first_projects[0]["state"], project_state);
    assert!(first_projects[0]["updated_at"].as_str().is_some());

    let database_state: Value = sqlx::query_scalar(
        "SELECT state FROM project WHERE name = $1 AND user_id = (SELECT id FROM users WHERE external_id = 'user_test')",
    )
    .bind(project_name)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(database_state, project_state);

    let second_read = request(&f, "GET", "/api/projects", &second_cookie, None).await;
    assert_eq!(second_read.status(), StatusCode::OK);
    let second_body = to_bytes(second_read.into_body(), usize::MAX).await.unwrap();
    let second_projects: Value = serde_json::from_slice(&second_body).unwrap();
    assert_eq!(second_projects, json!([]));

    let second_write = request_json(
        &f,
        "PUT",
        "/api/projects",
        &second_cookie,
        json!({"name":project_name, "state":{"value":"second user"}}),
    )
    .await;
    assert_eq!(second_write.status(), StatusCode::OK);

    let first_projects = request(&f, "GET", "/api/projects", &first_cookie, None).await;
    let first_body = to_bytes(first_projects.into_body(), usize::MAX)
        .await
        .unwrap();
    let first_projects: Value = serde_json::from_slice(&first_body).unwrap();
    assert_eq!(first_projects[0]["state"], project_state);
}

#[sqlx::test]
async fn callback_is_bound_to_browser_expiring_and_one_use(pool: PgPool) {
    let f = fixture(pool).await;
    let (cookie, callback) = start_login(&f).await;
    for cookies in ["", "mindgrab_login=attacker"] {
        let response = request(&f, "GET", &callback, cookies, None).await;
        assert!(
            response.headers()[header::LOCATION]
                .to_str()
                .unwrap()
                .contains("auth_error=sign_in_failed")
        );
    }
    assert!(f.mock.requests.lock().unwrap().is_empty());
    assert_eq!(session_count(&f).await, 0);
    let response = request(&f, "GET", &callback, &cookie, None).await;
    assert_eq!(
        response.headers()[header::LOCATION],
        "http://localhost:5173/"
    );
    let replay = request(&f, "GET", &callback, &cookie, None).await;
    assert!(
        replay.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("auth_error=")
    );
    assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
    let (cookie, callback) = start_login(&f).await;
    sqlx::query("UPDATE auth_login_attempts SET expires_at = NOW() - INTERVAL '1 second'")
        .execute(&f.state.pool)
        .await
        .unwrap();
    let expired = request(&f, "GET", &callback, &cookie, None).await;
    assert!(
        expired.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("auth_error=")
    );
    assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
}

#[sqlx::test]
async fn cancellation_consumes_state_without_authentication(pool: PgPool) {
    let f = fixture(pool).await;
    let (cookie, callback) = start_login(&f).await;
    let response = request(
        &f,
        "GET",
        &callback.replace("code=valid-code", "error=access_denied"),
        &cookie,
        None,
    )
    .await;
    assert!(
        response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("auth_error=")
    );
    assert!(f.mock.requests.lock().unwrap().is_empty());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_login_attempts")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test]
async fn login_persists_user_rotates_cookie_and_survives_router_recreation(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    let response = request(&f, "GET", "/api/me", &session, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let user: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(user["name"], "Test User");
    assert_eq!(user["external_id"], "user_test");
    assert!(user.get("access_token").is_none());
    assert!(user.get("refresh_token").is_none());
    let (cookie, callback) = start_login(&f).await;
    let response = request(&f, "GET", &callback, &format!("{cookie}; {session}"), None).await;
    assert_ne!(response_cookie(&response, SESSION_COOKIE), session);
    assert_eq!(session_count(&f).await, 1);
    assert_eq!(
        request(&f, "GET", "/api/me", &session, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let requests = f.mock.requests.lock().unwrap();
    assert_eq!(requests[0]["client_id"], "client_test");
    assert_eq!(requests[0]["client_secret"], "test-secret");
    assert!(requests[0]["code_verifier"].as_str().unwrap().len() >= 43);
}

#[sqlx::test]
async fn refresh_is_serialized_and_rotated_tokens_are_persisted(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    expire_access_token(&f).await;
    let (a, b) = tokio::join!(
        request(&f, "GET", "/api/me", &session, None),
        request(&f, "GET", "/api/me", &session, None)
    );
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    assert_eq!(f.mock.refresh_calls.load(Ordering::SeqCst), 1);
    let token: String = sqlx::query_scalar("SELECT refresh_token FROM auth_sessions")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(token, "rotated-refresh");
}

#[sqlx::test]
async fn transient_refresh_failure_preserves_session_and_terminal_failure_removes_it(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    expire_access_token(&f).await;
    f.mock.refresh_status.store(503, Ordering::SeqCst);
    let response = request(&f, "GET", "/api/me", &session, None).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert_eq!(session_count(&f).await, 1);
    assert_eq!(f.mock.refresh_calls.load(Ordering::SeqCst), 2);
    f.mock.refresh_status.store(400, Ordering::SeqCst);
    assert_eq!(
        request(&f, "GET", "/api/me", &session, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(session_count(&f).await, 0);
}

#[sqlx::test]
async fn invalid_tokens_and_expired_local_sessions_cannot_authenticate(pool: PgPool) {
    let f = fixture(pool).await;
    for overrides in [
        json!({"iss":"https://attacker.example"}),
        json!({"iss":"https://api.workos.com"}),
        json!({"iss":"https://api.workos.com/user_management/client_other"}),
        json!({"client_id":"client_other"}),
        json!({"sub":"other_user"}),
        json!({"sid":"other_session"}),
        json!({"aud":"other_client"}),
    ] {
        let session = sign_in(&f).await;
        let token = signed_token(jsonwebtoken::get_current_timestamp() + 3600, overrides);
        sqlx::query("UPDATE auth_sessions SET access_token = $1")
            .bind(token)
            .execute(&f.state.pool)
            .await
            .unwrap();
        assert_eq!(
            request(&f, "GET", "/api/me", &session, None).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(session_count(&f).await, 0);
    }
    let session = sign_in(&f).await;
    sqlx::query("UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 second'")
        .execute(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(
        request(&f, "GET", "/api/me", &session, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(f.mock.refresh_calls.load(Ordering::SeqCst), 0);
}

#[sqlx::test]
async fn logout_requires_same_origin_post_and_removes_the_session(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    assert_eq!(
        request(&f, "GET", "/api/auth/logout", &session, None)
            .await
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    for origin in [None, Some("https://attacker.example"), Some("null")] {
        assert_eq!(
            request(&f, "POST", "/api/auth/logout", &session, origin)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(session_count(&f).await, 1);
    }
    let response = request(
        &f,
        "POST",
        "/api/auth/logout",
        &session,
        Some("http://localhost:5173"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let url = reqwest::Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["session_id"], "session_test");
    assert_eq!(params["return_to"], "http://localhost:5173/");
    assert_eq!(session_count(&f).await, 0);
    assert_eq!(
        response_cookie(&response, SESSION_COOKIE),
        "mindgrab_session="
    );
}

#[sqlx::test]
async fn production_cookie_is_secure_and_signature_tampering_is_rejected(pool: PgPool) {
    let mut f = fixture(pool).await;
    Arc::get_mut(&mut f.state).unwrap().config.secure_cookies = true;
    let response = request(&f, "GET", "/api/auth/login", "", None).await;
    assert!(
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Secure")
    );
    let token = signed_token(jsonwebtoken::get_current_timestamp() + 3600, json!({}));
    let mut parts: Vec<_> = token.split('.').map(str::to_owned).collect();
    parts[1] = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"sub":"attacker"})).unwrap());
    assert!(matches!(
        f.state.workos.verify(&parts.join(".")).await,
        Err(AuthError::Unauthorized)
    ));
}
