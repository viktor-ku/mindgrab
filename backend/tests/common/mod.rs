#![allow(dead_code)]
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use mindgrab_backend::{
    Backend,
    auth::{SESSION_COOKIE, hash},
    config::{AuthMode, Config, Quota},
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const ISSUER: &str = "https://api.workos.com/user_management/client_test";
pub fn signed(sub: &str, expiry: u64) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("test-key".into());
    encode(&header,&json!({"iss":ISSUER,"sub":sub,"sid":format!("session_{sub}"),"exp":expiry,"client_id":"client_test"}),&EncodingKey::from_rsa_pem(include_bytes!("../fixtures/test-private.pem")).unwrap()).unwrap()
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
#[derive(Default)]
pub struct Provider {
    pub refreshes: AtomicUsize,
    pub rejected: AtomicUsize,
    /// Milliseconds a refresh takes to answer once it has retired its token.
    pub delay: AtomicU64,
    spent: Mutex<HashSet<String>>,
}
fn refresh_token(sub: &str) -> String {
    format!("refresh_{sub}.{}", Uuid::new_v4().simple())
}
async fn keys() -> Json<Value> {
    Json(serde_json::from_str(include_str!("../fixtures/jwks.json")).unwrap())
}
async fn authenticate(State(provider): State<Arc<Provider>>, Json(body): Json<Value>) -> Response {
    let refresh = body["grant_type"] == "refresh_token";
    if refresh {
        provider.refreshes.fetch_add(1, Ordering::SeqCst);
    }
    if refresh && provider.rejected.load(Ordering::SeqCst) > 0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response();
    }
    let sub = if refresh {
        let token = body["refresh_token"].as_str().unwrap();
        // Like WorkOS, a refresh token works once, and is retired even if the
        // answer never arrives.
        if !provider.spent.lock().unwrap().insert(token.into()) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_grant"})),
            )
                .into_response();
        }
        tokio::time::sleep(Duration::from_millis(provider.delay.load(Ordering::SeqCst))).await;
        let sub = token.trim_start_matches("refresh_");
        sub.split('.').next().unwrap()
    } else {
        body["code"].as_str().unwrap_or("alice")
    };
    Json(json!({"user":{"id":sub,"email":format!("{sub}@test.example"),"first_name":sub,"last_name":"Test"},"access_token":signed(sub,now()+3600),"refresh_token":refresh_token(sub)})).into_response()
}
async fn authorize(Query(args): Query<std::collections::HashMap<String, String>>) -> Response {
    let mut callback = reqwest::Url::parse(&args["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .extend_pairs([("code", "alice"), ("state", args["state"].as_str())]);
    (
        StatusCode::SEE_OTHER,
        [(header::LOCATION, callback.to_string())],
    )
        .into_response()
}
pub struct Fixture {
    pub backend: Arc<Backend>,
    pub url: String,
    pub origin: String,
    pub provider: Arc<Provider>,
    pub client: reqwest::Client,
    admin: PgPool,
    name: String,
    http: tokio::task::JoinHandle<()>,
    mock: tokio::task::JoinHandle<()>,
    changes: tokio::task::JoinHandle<()>,
}
impl Fixture {
    pub async fn new(origin: &str) -> Self {
        Self::with_posthog(origin, AuthMode::WorkOs, None).await
    }
    pub async fn with_posthog(
        origin: &str,
        auth_mode: AuthMode,
        posthog: Option<mindgrab_backend::config::PostHogConfig>,
    ) -> Self {
        Self::build(origin, auth_mode, posthog, Quota::default()).await
    }
    /// A backend whose accounts may store only `quota`.
    pub async fn with_quota(origin: &str, quota: Quota) -> Self {
        Self::build(origin, AuthMode::WorkOs, None, quota).await
    }
    async fn build(
        origin: &str,
        auth_mode: AuthMode,
        posthog: Option<mindgrab_backend::config::PostHogConfig>,
        quota: Quota,
    ) -> Self {
        let database = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres@localhost:5432/mindgrab".into());
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database)
            .await
            .expect("Start local Postgres with mise run db");
        let name = format!("mindgrab_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
        let mut database = reqwest::Url::parse(&database).unwrap();
        database.set_path(&format!("/{name}"));
        let provider = Arc::new(Provider::default());
        let routes = Router::new()
            .route("/sso/jwks/client_test", get(keys))
            .route("/user_management/authenticate", post(authenticate))
            .route("/user_management/authorize", get(authorize))
            .route(
                "/user_management/sessions/logout",
                get({
                    let origin = origin.to_string();
                    move || async move { (StatusCode::SEE_OTHER, [(header::LOCATION, origin)]) }
                }),
            )
            .with_state(provider.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider_url = format!("http://{}", listener.local_addr().unwrap());
        let mock = tokio::spawn(async move { axum::serve(listener, routes).await.unwrap() });
        let config = Config {
            auth_mode,
            database_url: database.to_string(),
            client_id: "client_test".into(),
            api_key: "test-secret".into(),
            redirect_uri: format!("{origin}/api/auth/callback.php"),
            app_url: format!("{origin}/"),
            issuer: ISSUER.into(),
            // Local mode must work even when no identity provider is reachable.
            provider_url: if auth_mode == AuthMode::Local {
                "http://127.0.0.1:1".into()
            } else {
                provider_url
            },
            secure_cookies: false,
            posthog,
            token_keys: mindgrab_backend::sealing::Keys::parse(
                "test:bWluZGdyYWItdGVzdC1rZXktMzItYnl0ZXMtbG9uZyE=",
            )
            .unwrap(),
            quota,
        };
        let backend = Backend::connect(config).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = backend.router();
        let http = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap()
        });
        let changes = tokio::spawn(backend.clone().listen_changes());
        Self {
            backend,
            url,
            origin: origin.to_string(),
            provider,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            admin,
            name,
            http,
            mock,
            changes,
        }
    }
    pub async fn credential(&self, sub: &str) -> String {
        let user_id:i64=sqlx::query_scalar("INSERT INTO mindgrab_loro.users(external_id,name,email) VALUES($1,$1,$2) ON CONFLICT(external_id) DO UPDATE SET name=EXCLUDED.name RETURNING id").bind(sub).bind(format!("{sub}@test.example")).fetch_one(&self.backend.pool).await.unwrap();
        let browser = Uuid::new_v4().to_string();
        let browser_hash = hash(&browser);
        let access = self.seal_access_token(&browser_hash, &signed(sub, now() + 3600));
        let refresh =
            self.backend
                .auth
                .seal("sealed_refresh_token", &browser_hash, &refresh_token(sub));
        sqlx::query("INSERT INTO mindgrab_loro.sealed_sessions(browser_hash,user_id,provider_session,sealed_access_token,sealed_refresh_token) VALUES($1,$2,$3,$4,$5)").bind(&browser_hash).bind(user_id).bind(format!("session_{sub}")).bind(access).bind(refresh).execute(&self.backend.pool).await.unwrap();
        browser
    }
    pub fn seal_access_token(&self, browser_hash: &str, token: &str) -> String {
        self.backend
            .auth
            .seal("sealed_access_token", browser_hash, token)
    }
    /// Replaces the session's access token with one that expired.
    pub async fn expire(&self, browser: &str, sub: &str) {
        let browser_hash = hash(browser);
        sqlx::query(
            "UPDATE mindgrab_loro.sealed_sessions SET sealed_access_token=$1 WHERE browser_hash=$2",
        )
        .bind(self.seal_access_token(&browser_hash, &signed(sub, now() - 1)))
        .bind(&browser_hash)
        .execute(&self.backend.pool)
        .await
        .unwrap();
    }
    pub fn post(&self, method: &str, browser: &str) -> reqwest::RequestBuilder {
        self.client
            .post(format!("{}/api/{method}.php", self.url))
            .header("origin", &self.origin)
            .header(
                "cookie",
                format!(
                    "{}={browser}",
                    self.backend.config.cookie_name(SESSION_COOKIE)
                ),
            )
    }
    pub async fn rpc(&self, method: &str, browser: &str, args: Value) -> reqwest::Response {
        self.post(method, browser).json(&args).send().await.unwrap()
    }
    pub async fn close(self) {
        self.http.abort();
        self.mock.abort();
        self.changes.abort();
        let _ = self.http.await;
        let _ = self.mock.await;
        let _ = self.changes.await;
        self.backend.pool.close().await;
        sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}
pub fn cookies(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|value| {
            value
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap()
                .to_string()
        })
        .collect()
}
