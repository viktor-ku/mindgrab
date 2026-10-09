use crate::{
    config::Config,
    error::{ApiError, Result},
};
use axum::{
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

pub const SESSION_COOKIE: &str = "mindgrab_session_loro";
const STATE_COOKIE: &str = "mindgrab_login_loro";
pub fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value))
}
fn token() -> String {
    let mut bytes = [0; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut values = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|field| field.trim().split_once('='))
        .filter(|(key, _)| *key == name);
    let value = values.next()?.1.to_string();
    if values.next().is_some() || value.is_empty() {
        None
    } else {
        Some(value)
    }
}
fn cookie(config: &Config, name: &str, value: &str, age: u32) -> String {
    format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}{}",
        if config.secure_cookies {
            "; Secure"
        } else {
            ""
        }
    )
}
fn redirect(url: &str, cookies: Vec<String>) -> Response {
    let mut response = StatusCode::SEE_OTHER.into_response();
    response
        .headers_mut()
        .insert(header::LOCATION, url.parse().unwrap());
    for cookie in cookies {
        response
            .headers_mut()
            .append(header::SET_COOKIE, cookie.parse().unwrap());
    }
    response
}
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub external_id: String,
}
#[derive(Deserialize)]
pub struct ProviderUser {
    pub id: String,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}
#[derive(Deserialize)]
struct Authentication {
    user: ProviderUser,
    access_token: String,
    refresh_token: String,
}
#[derive(Deserialize)]
struct Claims {
    sub: String,
    sid: String,
    exp: u64,
    client_id: String,
}
#[derive(FromRow)]
struct Session {
    user_id: i64,
    provider_session: String,
    access_token: String,
    refresh_token: String,
}
#[derive(Clone)]
pub struct Auth {
    pool: PgPool,
    config: Config,
    client: reqwest::Client,
    keys: Arc<Mutex<Option<(std::time::Instant, JwkSet)>>>,
}
impl Auth {
    pub fn new(pool: PgPool, config: Config) -> Self {
        Self {
            pool,
            config,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            keys: Arc::new(Mutex::new(None)),
        }
    }
    fn url(&self, path: &str) -> reqwest::Url {
        reqwest::Url::parse(&format!("{}{path}", self.config.provider_url)).unwrap()
    }
    async fn verify(&self, token: &str) -> Result<Claims> {
        let header = decode_header(token).map_err(|_| ApiError::unauthorized())?;
        if header.alg != Algorithm::RS256 {
            return Err(ApiError::unauthorized());
        }
        let kid = header.kid.ok_or_else(ApiError::unauthorized)?;
        let mut cached = self.keys.lock().await;
        if cached.as_ref().is_none_or(|(time, keys)| {
            time.elapsed() > Duration::from_secs(3600) || keys.find(&kid).is_none()
        }) {
            let response = self
                .client
                .get(self.url(&format!("/sso/jwks/{}", self.config.client_id)))
                .send()
                .await
                .map_err(|_| ApiError::unavailable())?;
            if !response.status().is_success() {
                return Err(ApiError::unavailable());
            }
            *cached = Some((
                std::time::Instant::now(),
                response.json().await.map_err(|_| ApiError::unavailable())?,
            ));
        }
        let key = cached
            .as_ref()
            .unwrap()
            .1
            .find(&kid)
            .ok_or_else(ApiError::unauthorized)?;
        let key = DecodingKey::from_jwk(key).map_err(|_| ApiError::unauthorized())?;
        let mut validation = Validation::new(Algorithm::RS256);
        // A signed expired token is usable only to rotate its refresh token.
        validation.validate_exp = false;
        validation.validate_nbf = true;
        validation.set_issuer(&[
            self.config.issuer.trim_end_matches('/'),
            &format!("{}/", self.config.issuer.trim_end_matches('/')),
        ]);
        validation.set_audience(&[&self.config.client_id]);
        validation.required_spec_claims = ["exp", "sub", "iss"]
            .into_iter()
            .map(String::from)
            .collect();
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| ApiError::unauthorized())?
            .claims;
        if claims.client_id != self.config.client_id
            || claims.sub.is_empty()
            || claims.sid.is_empty()
        {
            return Err(ApiError::unauthorized());
        }
        Ok(claims)
    }
    async fn authenticate(&self, grant: serde_json::Value) -> Result<Authentication> {
        let mut body = grant;
        body["client_id"] = self.config.client_id.clone().into();
        body["client_secret"] = self.config.api_key.clone().into();
        let response = self
            .client
            .post(self.url("/user_management/authenticate"))
            .json(&body)
            .send()
            .await
            .map_err(|_| ApiError::unavailable())?;
        if !response.status().is_success() {
            let status = response.status();
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            return Err(
                if status.as_u16() == 400 && body["error"] == "invalid_grant" {
                    ApiError::unauthorized()
                } else {
                    ApiError::unavailable()
                },
            );
        }
        response.json().await.map_err(|_| ApiError::unavailable())
    }
    pub async fn start(&self, headers: &HeaderMap) -> Result<Response> {
        self.config.same_origin(headers)?;
        let nonce = token();
        let verifier = token();
        let mut tx = self.pool.begin().await?;
        if let Some(previous) = cookie_value(headers, STATE_COOKIE) {
            sqlx::query("DELETE FROM mindgrab_loro.login_attempts WHERE state_hash=$1")
                .bind(hash(&previous))
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("DELETE FROM mindgrab_loro.login_attempts WHERE expires_at<=now()")
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO mindgrab_loro.login_attempts(state_hash,verifier) VALUES($1,$2)")
            .bind(hash(&nonce))
            .bind(&verifier)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let mut url = self.url("/user_management/authorize");
        url.query_pairs_mut().extend_pairs([
            ("client_id", self.config.client_id.as_str()),
            ("redirect_uri", &self.config.redirect_uri),
            ("response_type", "code"),
            ("provider", "authkit"),
            ("state", &nonce),
            ("code_challenge", &hash(&verifier)),
            ("code_challenge_method", "S256"),
        ]);
        Ok(redirect(
            url.as_str(),
            vec![cookie(&self.config, STATE_COOKIE, &nonce, 600)],
        ))
    }
    async fn callback_inner(&self, headers: &HeaderMap, query: &str) -> Result<String> {
        let pairs: Vec<_> = reqwest::Url::parse(&format!("http://localhost/?{query}"))
            .map_err(|_| ApiError::invalid())?
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        for key in ["code", "state", "error"] {
            if pairs.iter().filter(|(k, _)| k == key).count() > 1 {
                return Err(ApiError::invalid());
            }
        }
        let get = |key: &str| {
            pairs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        let nonce = get("state").ok_or_else(ApiError::unauthorized)?;
        // SHA-256 hashes are fixed-size; equality does not compare nonce prefixes.
        if cookie_value(headers, STATE_COOKIE).is_none_or(|v| hash(&v) != hash(nonce)) {
            return Err(ApiError::unauthorized());
        }
        let verifier: Option<String> = sqlx::query_scalar("DELETE FROM mindgrab_loro.login_attempts WHERE state_hash=$1 AND expires_at>now() RETURNING verifier").bind(hash(nonce)).fetch_optional(&self.pool).await?;
        let verifier = verifier.ok_or_else(ApiError::unauthorized)?;
        if get("error").is_some() {
            return Err(ApiError::unauthorized());
        }
        let auth = self.authenticate(serde_json::json!({"grant_type":"authorization_code","code":get("code").ok_or_else(ApiError::unauthorized)?,"code_verifier":verifier})).await?;
        let claims = self.verify(&auth.access_token).await?;
        if claims.exp <= now() || claims.sub != auth.user.id {
            return Err(ApiError::unauthorized());
        }
        let credential = token();
        let mut tx = self.pool.begin().await?;
        let user = upsert(&mut tx, &auth.user).await?;
        sqlx::query("INSERT INTO mindgrab_loro.sessions(browser_hash,user_id,provider_session,access_token,refresh_token) VALUES($1,$2,$3,$4,$5)").bind(hash(&credential)).bind(user.id).bind(claims.sid).bind(auth.access_token).bind(auth.refresh_token).execute(&mut *tx).await?;
        if let Some(previous) = cookie_value(headers, SESSION_COOKIE) {
            sqlx::query("DELETE FROM mindgrab_loro.sessions WHERE browser_hash=$1")
                .bind(hash(&previous))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(credential)
    }
    pub async fn callback(&self, headers: &HeaderMap, query: &str) -> Response {
        let mut cookies = vec![cookie(&self.config, STATE_COOKIE, "", 0)];
        let destination = match self.callback_inner(headers, query).await {
            Ok(credential) => {
                cookies.push(cookie(&self.config, SESSION_COOKIE, &credential, 2592000));
                self.config.app_url.clone()
            }
            Err(error) => format!(
                "{}?auth_error={}",
                self.config.app_url,
                if error.status == StatusCode::UNAUTHORIZED {
                    "sign_in_failed"
                } else {
                    "unavailable"
                }
            ),
        };
        redirect(&destination, cookies)
    }
    pub async fn identify(&self, headers: &HeaderMap) -> Result<User> {
        let browser = cookie_value(headers, SESSION_COOKIE).ok_or_else(ApiError::unauthorized)?;
        let browser_hash = hash(&browser);
        let mut tx = self.pool.begin().await?;
        let session: Option<Session> = sqlx::query_as("SELECT user_id,provider_session,access_token,refresh_token FROM mindgrab_loro.sessions WHERE browser_hash=$1 AND expires_at>now() FOR UPDATE").bind(&browser_hash).fetch_optional(&mut *tx).await?;
        let session = session.ok_or_else(ApiError::unauthorized)?;
        let result: Result<User> = async {
            let user: User = sqlx::query_as("SELECT id,name,email,external_id FROM mindgrab_loro.users WHERE id=$1").bind(session.user_id).fetch_one(&mut *tx).await?;
            let claims = self.verify(&session.access_token).await?;
            if claims.sub!=user.external_id || claims.sid!=session.provider_session { return Err(ApiError::unauthorized()); }
            if claims.exp>now()+30 { return Ok(user); }
            let auth = self.authenticate(serde_json::json!({"grant_type":"refresh_token","refresh_token":session.refresh_token})).await?;
            let claims = self.verify(&auth.access_token).await?;
            if claims.exp<=now() || claims.sub!=user.external_id || claims.sid!=session.provider_session || auth.user.id!=user.external_id { return Err(ApiError::unauthorized()); }
            sqlx::query("UPDATE mindgrab_loro.sessions SET access_token=$2,refresh_token=$3 WHERE browser_hash=$1").bind(&browser_hash).bind(auth.access_token).bind(auth.refresh_token).execute(&mut *tx).await?;
            upsert(&mut tx,&auth.user).await
        }.await;
        if result
            .as_ref()
            .is_err_and(|e| e.status == StatusCode::UNAUTHORIZED)
        {
            sqlx::query("DELETE FROM mindgrab_loro.sessions WHERE browser_hash=$1")
                .bind(browser_hash)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        let user = result?;
        if let Some(expected) = headers.get("x-mindgrab-account") {
            let value = expected
                .to_str()
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .filter(|v| *v > 0)
                .ok_or_else(ApiError::invalid)?;
            if value != user.id {
                return Err(ApiError::new(StatusCode::CONFLICT, "account_changed"));
            }
        }
        Ok(user)
    }
    pub async fn logout(&self, headers: &HeaderMap) -> Result<Response> {
        self.config.same_origin(headers)?;
        let mut destination = self.config.app_url.clone();
        if let Some(browser) = cookie_value(headers, SESSION_COOKIE) {
            let sid: Option<String> = sqlx::query_scalar("DELETE FROM mindgrab_loro.sessions WHERE browser_hash=$1 RETURNING provider_session").bind(hash(&browser)).fetch_optional(&self.pool).await?;
            if let Some(sid) = sid {
                let mut url = self.url("/user_management/sessions/logout");
                url.query_pairs_mut().extend_pairs([
                    ("session_id", sid.as_str()),
                    ("return_to", &self.config.app_url),
                ]);
                destination = url.to_string();
            }
        }
        if let Some(nonce) = cookie_value(headers, STATE_COOKIE) {
            sqlx::query("DELETE FROM mindgrab_loro.login_attempts WHERE state_hash=$1")
                .bind(hash(&nonce))
                .execute(&self.pool)
                .await?;
        }
        Ok(redirect(
            &destination,
            vec![
                cookie(&self.config, SESSION_COOKIE, "", 0),
                cookie(&self.config, STATE_COOKIE, "", 0),
            ],
        ))
    }
}
async fn upsert(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: &ProviderUser,
) -> Result<User> {
    let name = [
        user.first_name.as_deref().unwrap_or_default(),
        user.last_name.as_deref().unwrap_or_default(),
    ]
    .join(" ")
    .trim()
    .to_string();
    let name = if name.is_empty() { &user.email } else { &name };
    Ok(sqlx::query_as("INSERT INTO mindgrab_loro.users(external_id,name,email) VALUES($1,$2,$3) ON CONFLICT(external_id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email RETURNING id,name,email,external_id").bind(&user.id).bind(name).bind(&user.email).fetch_one(&mut **tx).await?)
}
