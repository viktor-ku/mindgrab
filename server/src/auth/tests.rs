use super::*;
use axum::body::{Body, to_bytes};
use axum::http::header;
use axum::routing::post;
use axum_login::tower_sessions::{
    ExpiredDeletion, SessionStore,
    session::{Id, Record},
};
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

pub(crate) struct Fixture {
    pub(crate) state: Arc<AppState>,
    mock: Arc<Mock>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(crate) async fn fixture(pool: PgPool) -> Fixture {
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
        .extension(crate::rate_limits::test_peer())
        .method(method)
        .uri(path)
        .header(header::COOKIE, cookies);
    if let Some(origin) = origin {
        builder = builder.header(header::ORIGIN, origin);
    }
    let response = crate::router(f.state.clone())
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    crate::response_headers::assert_private_headers(response.headers());
    response
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
    let response = request(
        f,
        "POST",
        "/api/startLogin",
        "",
        Some("http://localhost:5173"),
    )
    .await;
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

pub(crate) async fn sign_in(f: &Fixture) -> String {
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
        .find(|h| h.starts_with(&format!("{SESSION_COOKIE}=")))
        .unwrap();
    assert!(raw_cookie.contains("HttpOnly"));
    assert!(raw_cookie.contains("SameSite=Lax"));
    assert!(raw_cookie.contains("Path=/"));
    assert!(raw_cookie.contains("Max-Age=2592000"));
    assert_eq!(raw_cookie.contains("Secure"), f.state.config.secure_cookies);
    response_cookie(&response, SESSION_COOKIE)
}

/// Inserts another WorkOS user with a valid session and returns its cookie.
pub(crate) async fn session_for(f: &Fixture, external_id: &str) -> String {
    let mut record = provider_record(f, external_id).await;
    store::Store(f.state.pool.clone())
        .create(&mut record)
        .await
        .unwrap();
    format!("{SESSION_COOKIE}={}", record.id)
}

async fn provider_record(f: &Fixture, external_id: &str) -> Record {
    let user_id: i64 = sqlx::query_scalar(
        "INSERT INTO users (name, email, external_id) VALUES ('Other', $1, $2) RETURNING id",
    )
    .bind(format!("{external_id}@example.com"))
    .bind(external_id)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    let token = format!("{external_id}-session");
    let workos_session = format!("{external_id}-workos-session");
    let access = signed_token(
        jsonwebtoken::get_current_timestamp() + 3600,
        json!({"sub": external_id, "sid": workos_session}),
    );
    sqlx::query("INSERT INTO auth_sessions (token_hash, user_id, workos_session_id, access_token, refresh_token) VALUES ($1, $2, $3, $4, 'refresh')")
        .bind(token_hash(&token))
        .bind(user_id)
        .bind(workos_session)
        .bind(access)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let provider = token_hash(&token);
    Record {
        id: Id::default(),
        data: [
            (store::PROVIDER.into(), json!(provider)),
            (
                AUTH_DATA.into(),
                json!({"user_id": provider, "auth_hash": provider.as_bytes()}),
            ),
        ]
        .into(),
        expiry_date: time::OffsetDateTime::now_utc() + time::Duration::days(30),
    }
}

pub(crate) fn provider_calls(f: &Fixture) -> usize {
    f.mock.requests.lock().unwrap().len()
}

pub(crate) fn refresh_status(f: &Fixture, status: u16) {
    f.mock.refresh_status.store(status, Ordering::SeqCst);
}

async fn session_count(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM auth_sessions")
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}

pub(crate) async fn expire_access_token(f: &Fixture) {
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
    for cookies in ["", "mindgrab_session_v2=forged"] {
        let response = request(&f, "POST", "/api/getMe", cookies, None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
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
async fn callback_database_failure_redirects_and_clears_login_cookie(pool: PgPool) {
    let f = fixture(pool).await;
    let (cookie, callback) = start_login(&f).await;
    f.state.pool.close().await;
    let response = request(&f, "GET", &callback, &cookie, None).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        response.headers()[header::LOCATION],
        "http://localhost:5173/?auth_error=unavailable"
    );
    assert_eq!(response_cookie(&response, STATE_COOKIE), "mindgrab_login=");
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[sqlx::test]
async fn local_storage_failure_preserves_previous_authority_without_login_success(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    let (cookie, callback) = start_login(&f).await;
    // Fail at credential/rotation COMMIT, after provider authentication committed.
    sqlx::raw_sql("CREATE FUNCTION fail_session_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage fault'; END $$; CREATE CONSTRAINT TRIGGER fail_session_write AFTER UPDATE ON auth_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_session_write()")
        .execute(&f.state.pool).await.unwrap();
    let response = request(&f, "GET", &callback, &format!("{cookie}; {session}"), None).await;
    assert_eq!(
        response.headers()[header::LOCATION],
        "http://localhost:5173/?auth_error=unavailable"
    );
    assert!(
        !response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .any(|h| h
                .to_str()
                .unwrap()
                .starts_with(&format!("{SESSION_COOKIE}=")))
    );
    assert_eq!(
        request(&f, "POST", "/api/getMe", &session, None)
            .await
            .status(),
        StatusCode::OK
    );
    // A transient load failure returns 503 without deleting the browser cookie.
    sqlx::query("ALTER TABLE auth_sessions RENAME TO unavailable_sessions")
        .execute(&f.state.pool)
        .await
        .unwrap();
    let response = request(&f, "POST", "/api/getMe", &session, None).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    sqlx::query("ALTER TABLE unavailable_sessions RENAME TO auth_sessions")
        .execute(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(
        request(&f, "POST", "/api/getMe", &session, None)
            .await
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test]
async fn store_collisions_and_expiry_cannot_replace_or_restore_authority(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    let id: Id = session.split_once('=').unwrap().1.parse().unwrap();
    let store = store::Store(f.state.pool.clone());
    let original = store.load(&id).await.unwrap().unwrap();
    let mut record = provider_record(&f, "collision").await;
    record.id = id;
    record.expiry_date = original.expiry_date;
    assert!(store.create(&mut record).await.is_err());
    assert_eq!(store.load(&id).await.unwrap().unwrap(), original);
    record.id = Id::default();
    store.create(&mut record).await.unwrap();
    let (hash, data): (String, Value) = sqlx::query_as(
        "SELECT browser_hash, session_data FROM auth_sessions WHERE browser_hash = $1",
    )
    .bind(token_hash(&record.id.to_string()))
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_ne!(hash, record.id.to_string());
    assert!(data.get("access_token").is_none());
    assert!(data.get("refresh_token").is_none());
    let loaded = store.load(&record.id).await.unwrap().unwrap();
    assert_eq!(loaded.id, record.id);
    assert_eq!(loaded.expiry_date, record.expiry_date);
    assert_eq!(loaded.data[store::PROVIDER], record.data[store::PROVIDER]);
    sqlx::query("UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 second'")
        .execute(&f.state.pool)
        .await
        .unwrap();
    assert!(store.load(&record.id).await.unwrap().is_none());
    assert!(store.save(&record).await.is_err());
    store.delete_expired().await.unwrap();
    assert_eq!(session_count(&f).await, 0);
    // Neither stale saves nor new creates can revive the deleted provider row.
    assert!(store.create(&mut record).await.is_err());
    store.delete(&record.id).await.unwrap();
}

#[sqlx::test]
async fn cached_identity_must_match_its_provider_session(pool: PgPool) {
    let f = fixture(pool).await;
    let other = session_for(&f, "other_user").await;
    let store = store::Store(f.state.pool.clone());
    let other_id: Id = other.split_once('=').unwrap().1.parse().unwrap();
    let other_record = store.load(&other_id).await.unwrap().unwrap();
    for field in [Some(AUTH_DATA), Some(store::PROVIDER), None] {
        let session = sign_in(&f).await;
        let id: Id = session.split_once('=').unwrap().1.parse().unwrap();
        let mut record = store.load(&id).await.unwrap().unwrap();
        if let Some(field) = field {
            record
                .data
                .insert(field.into(), other_record.data[field].clone());
        } else {
            record.data.remove(AUTH_DATA);
        }
        // Simulate corrupted/stale cached identification while the row's
        // credential and WorkOS tokens still belong to the original user.
        sqlx::query("UPDATE auth_sessions SET session_data = $1 WHERE browser_hash = $2")
            .bind(sqlx::types::Json(record.data))
            .bind(token_hash(&id.to_string()))
            .execute(&f.state.pool)
            .await
            .unwrap();
        assert_eq!(
            request(&f, "POST", "/api/getMe", &session, None)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&f, "POST", "/api/getMe", &other, None)
                .await
                .status(),
            StatusCode::OK
        );
    }
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
    let response = request(&f, "POST", "/api/getMe", &session, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let user: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(user["name"], "Test User");
    assert_eq!(user["external_id"], "user_test");
    assert!(user.get("access_token").is_none());
    assert!(user.get("refresh_token").is_none());
    let other_pool = sqlx::postgres::PgPoolOptions::new()
        .connect_with((*f.state.pool.connect_options()).clone())
        .await
        .unwrap();
    let other = fixture(other_pool).await;
    assert_eq!(
        request(&other, "POST", "/api/getMe", &session, None)
            .await
            .status(),
        StatusCode::OK
    );
    let (cookie, callback) = start_login(&f).await;
    let response = request(&f, "GET", &callback, &format!("{cookie}; {session}"), None).await;
    assert_ne!(response_cookie(&response, SESSION_COOKIE), session);
    assert_eq!(session_count(&f).await, 1);
    assert_eq!(
        request(&f, "POST", "/api/getMe", &session, None)
            .await
            .status(),
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
    let store = store::Store(f.state.pool.clone());
    let id: Id = session.split_once('=').unwrap().1.parse().unwrap();
    let mut stale = store.load(&id).await.unwrap().unwrap();
    expire_access_token(&f).await;
    let (a, b) = tokio::join!(
        request(&f, "POST", "/api/getMe", &session, None),
        request(&f, "POST", "/api/getMe", &session, None)
    );
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    assert_eq!(f.mock.refresh_calls.load(Ordering::SeqCst), 1);
    stale.data.insert("ui".into(), json!(true));
    stale.expiry_date += time::Duration::days(30);
    store.save(&stale).await.unwrap();
    assert!(store.load(&id).await.unwrap().unwrap().expiry_date < stale.expiry_date);
    let token: String = sqlx::query_scalar("SELECT refresh_token FROM auth_sessions")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(token, "rotated-refresh");
    let (deleted, _) = tokio::join!(store.delete(&id), store.save(&stale));
    deleted.unwrap();
    assert!(store.save(&stale).await.is_err());
    assert!(store.load(&id).await.unwrap().is_none());
    assert_eq!(
        request(&f, "POST", "/api/getMe", &session, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test]
async fn transient_refresh_failure_preserves_session_and_terminal_failure_removes_it(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    expire_access_token(&f).await;
    f.mock.refresh_status.store(503, Ordering::SeqCst);
    let response = request(&f, "POST", "/api/getMe", &session, None).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert_eq!(session_count(&f).await, 1);
    assert_eq!(f.mock.refresh_calls.load(Ordering::SeqCst), 2);
    f.mock.refresh_status.store(400, Ordering::SeqCst);
    assert_eq!(
        request(&f, "POST", "/api/getMe", &session, None)
            .await
            .status(),
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
            request(&f, "POST", "/api/getMe", &session, None)
                .await
                .status(),
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
        request(&f, "POST", "/api/getMe", &session, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(f.mock.refresh_calls.load(Ordering::SeqCst), 0);
}

#[sqlx::test]
async fn logout_requires_same_origin_post_and_removes_the_session(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    expire_access_token(&f).await;
    refresh_status(&f, 503);
    assert_eq!(
        request(&f, "GET", "/api/logout", &session, None)
            .await
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    for &origin in crate::request_validation::REJECTED_ORIGINS {
        assert_eq!(
            request(&f, "POST", "/api/logout", &session, origin)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(session_count(&f).await, 1);
    }
    let response = request(
        &f,
        "POST",
        "/api/logout",
        &session,
        Some("http://localhost:5173"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let url = reqwest::Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["session_id"], "session_test");
    assert_eq!(params["return_to"], "http://localhost:5173/");
    assert_eq!(f.mock.refresh_calls.load(Ordering::SeqCst), 0);
    assert_eq!(session_count(&f).await, 0);
    assert_eq!(
        response_cookie(&response, SESSION_COOKIE),
        format!("{SESSION_COOKIE}=")
    );
}

#[sqlx::test]
async fn production_cookie_is_secure_and_signature_tampering_is_rejected(pool: PgPool) {
    let mut f = fixture(pool).await;
    Arc::get_mut(&mut f.state).unwrap().config.secure_cookies = true;
    let response = request(
        &f,
        "POST",
        "/api/startLogin",
        "",
        Some("http://localhost:5173"),
    )
    .await;
    assert!(
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Secure")
    );
    sign_in(&f).await;
    let token = signed_token(jsonwebtoken::get_current_timestamp() + 3600, json!({}));
    let mut parts: Vec<_> = token.split('.').map(str::to_owned).collect();
    parts[1] = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"sub":"attacker"})).unwrap());
    assert!(matches!(
        f.state.workos.verify(&parts.join(".")).await,
        Err(AuthError::Unauthorized)
    ));
}

#[sqlx::test]
async fn mutations_and_websocket_require_the_app_origin_before_authentication(pool: PgPool) {
    let f = fixture(pool).await;
    let origins = crate::request_validation::REJECTED_ORIGINS
        .iter()
        .map(|origin| {
            origin
                .iter()
                .map(|value| (*value).as_bytes())
                .collect::<Vec<_>>()
        })
        .chain([
            vec![
                b"http://localhost:5173".as_slice(),
                b"https://attacker.example".as_slice(),
            ],
            vec![b"\xff".as_slice()],
        ]);
    for origins in origins {
        for (method, path) in [
            ("POST", "/api/startLogin"),
            ("POST", "/api/createProject"),
            ("POST", "/api/submitProjectUpdate"),
            ("GET", "/sync/v1/10000000-0000-4000-8000-000000000000"),
        ] {
            let mut request = axum::http::Request::builder()
                .extension(crate::rate_limits::test_peer())
                .method(method)
                .uri(path);
            if path == "/api/submitProjectUpdate" {
                request = request.header(
                    header::CONTENT_LENGTH,
                    crate::project::updates::MAX_UPDATE_BYTES + 1,
                );
            }
            for &origin in &origins {
                request = request.header(header::ORIGIN, origin);
            }
            let response = crate::router(f.state.clone())
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
            crate::response_headers::assert_private_headers(response.headers());
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            if path == "/api/startLogin" {
                assert_eq!(body.as_ref(), b"Invalid request origin");
            } else {
                assert_eq!(
                    serde_json::from_slice::<Value>(&body).unwrap()["error"]["code"],
                    "invalid_origin"
                );
            }
        }
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_login_attempts")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(f.mock.requests.lock().unwrap().is_empty());
    let projects: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM crdt_project")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(projects, 0);
}
