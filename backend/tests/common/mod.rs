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
    config::Config,
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
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
        body["refresh_token"]
            .as_str()
            .unwrap()
            .trim_start_matches("refresh_")
    } else {
        body["code"].as_str().unwrap_or("alice")
    };
    Json(json!({"user":{"id":sub,"email":format!("{sub}@test.example"),"first_name":sub,"last_name":"Test"},"access_token":signed(sub,now()+3600),"refresh_token":format!("refresh_{sub}")})).into_response()
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
            database_url: database.to_string(),
            client_id: "client_test".into(),
            api_key: "test-secret".into(),
            redirect_uri: format!("{origin}/api/auth/callback"),
            app_url: format!("{origin}/"),
            issuer: ISSUER.into(),
            provider_url,
            secure_cookies: false,
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
        sqlx::query("INSERT INTO mindgrab_loro.sessions(browser_hash,user_id,provider_session,access_token,refresh_token) VALUES($1,$2,$3,$4,$5)").bind(hash(&browser)).bind(user_id).bind(format!("session_{sub}")).bind(signed(sub,now()+3600)).bind(format!("refresh_{sub}")).execute(&self.backend.pool).await.unwrap();
        browser
    }
    pub fn post(&self, method: &str, browser: &str) -> reqwest::RequestBuilder {
        self.client
            .post(format!("{}/api/{method}", self.url))
            .header("origin", &self.origin)
            .header("cookie", format!("{SESSION_COOKIE}={browser}"))
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
