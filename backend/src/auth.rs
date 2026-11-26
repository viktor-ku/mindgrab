use crate::{
    analytics::Analytics,
    config::{AuthMode, Config},
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

pub const SESSION_COOKIE: &str = "PHPSESSID";
const STATE_COOKIE: &str = "PHPLOGINID";
const LOCAL_USER_ID: &str = "local_boba_tee";
const LOCAL_TOKEN: &str = "local-development";
/// How long a request waits for another one to finish refreshing its session.
const REFRESH_WAIT: Duration = Duration::from_secs(10);
/// A refresh leases its session this long, and gives up well before that: one
/// that outlived its lease could end a session the next holder had renewed.
const REFRESH_LEASE: Duration = Duration::from_secs(60);
const REFRESH_LIMIT: Duration = Duration::from_secs(45);
pub fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value))
}
pub(crate) fn token() -> String {
    let mut bytes = [0; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
/// A cookie value shaped like PHP's default session ID: 32 hex characters, which
/// is 128 random bits. Only its hash is stored.
fn session_id() -> String {
    format!("{:032x}", rand::random::<u128>())
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
/// `Set-Cookie` spelled as PHP spells it, attribute for attribute, copied from
/// PHP 8.3's `setcookie()`. An empty value deletes the cookie, PHP's way.
fn cookie(config: &Config, name: &str, value: &str, age: u32) -> String {
    let name = config.cookie_name(name);
    let secure = if config.secure_cookies {
        "; secure"
    } else {
        ""
    };
    if value.is_empty() {
        return format!(
            "{name}=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; path=/{secure}; HttpOnly; SameSite=Lax"
        );
    }
    let expires = httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(age.into()));
    format!(
        "{name}={value}; expires={expires}; Max-Age={age}; path=/{secure}; HttpOnly; SameSite=Lax"
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
/// A session row as stored: its WorkOS tokens sealed (`sealing`).
#[derive(FromRow)]
struct StoredSession {
    #[sqlx(flatten)]
    user: User,
    provider_session: String,
    sealed_access_token: String,
    sealed_refresh_token: String,
}
struct Session {
    user: User,
    provider_session: String,
    access_token: String,
    refresh_token: String,
    /// As stored, which identifies the tokens in a query: sealing the same
    /// token again gives another value.
    sealed_refresh_token: String,
}
#[derive(FromRow)]
struct Upserted {
    #[sqlx(flatten)]
    user: User,
    created: bool,
}
#[derive(Clone)]
pub struct Auth {
    pool: PgPool,
    config: Config,
    analytics: Analytics,
    client: reqwest::Client,
    keys: Arc<Mutex<Option<(std::time::Instant, JwkSet)>>>,
}
impl Auth {
    pub fn new(pool: PgPool, config: Config) -> Self {
        Self {
            pool,
            analytics: Analytics::new(config.posthog.clone()),
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
    fn browser_cookie(&self, headers: &HeaderMap, name: &str) -> Option<String> {
        cookie_value(headers, &self.config.cookie_name(name))
    }
    /// Seals a WorkOS token for `column` of the session row `browser_hash`. The
    /// sealed value opens only there, so a copy moved to another session or
    /// column is useless.
    pub fn seal(&self, column: &str, browser_hash: &str, token: &str) -> String {
        self.config
            .token_keys
            .seal(token, &format!("{column} {browser_hash}"))
    }
    fn open(&self, browser_hash: &str, stored: StoredSession) -> Option<Session> {
        let open = |column: &str, sealed: &str| {
            self.config
                .token_keys
                .open(sealed, &format!("{column} {browser_hash}"))
        };
        Some(Session {
            access_token: open("sealed_access_token", &stored.sealed_access_token)?,
            refresh_token: open("sealed_refresh_token", &stored.sealed_refresh_token)?,
            user: stored.user,
            provider_session: stored.provider_session,
            sealed_refresh_token: stored.sealed_refresh_token,
        })
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
        let nonce = session_id();
        let verifier = token();
        let mut tx = self.pool.begin().await?;
        if let Some(previous) = self.browser_cookie(headers, STATE_COOKIE) {
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
        if self.config.auth_mode == AuthMode::Local {
            let mut url = reqwest::Url::parse(&self.config.redirect_uri).unwrap();
            url.query_pairs_mut()
                .extend_pairs([("state", nonce.as_str()), ("code", &hash(&verifier))]);
            return Ok(redirect(
                url.as_str(),
                vec![cookie(&self.config, STATE_COOKIE, &nonce, 600)],
            ));
        }
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
    /// Returns the session credential, and the user when the account is new.
    async fn callback_inner(
        &self,
        headers: &HeaderMap,
        query: &str,
    ) -> Result<(String, Option<User>)> {
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
        if self
            .browser_cookie(headers, STATE_COOKIE)
            .is_none_or(|v| hash(&v) != hash(nonce))
        {
            return Err(ApiError::unauthorized());
        }
        let verifier: Option<String> = sqlx::query_scalar("DELETE FROM mindgrab_loro.login_attempts WHERE state_hash=$1 AND expires_at>now() RETURNING verifier").bind(hash(nonce)).fetch_optional(&self.pool).await?;
        let verifier = verifier.ok_or_else(ApiError::unauthorized)?;
        if get("error").is_some() {
            return Err(ApiError::unauthorized());
        }
        let code = get("code").ok_or_else(ApiError::unauthorized)?;
        let (auth, claims) = if self.config.auth_mode == AuthMode::Local {
            if code != hash(&verifier) {
                return Err(ApiError::unauthorized());
            }
            (
                Authentication {
                    user: ProviderUser {
                        id: LOCAL_USER_ID.into(),
                        email: "boba.tee@mindgrab.test".into(),
                        first_name: Some("Boba".into()),
                        last_name: Some("Tee".into()),
                    },
                    access_token: LOCAL_TOKEN.into(),
                    refresh_token: LOCAL_TOKEN.into(),
                },
                Claims {
                    sub: LOCAL_USER_ID.into(),
                    sid: format!("local_{}", token()),
                    exp: now() + 2592000,
                    client_id: String::new(),
                },
            )
        } else {
            let auth = self.authenticate(serde_json::json!({"grant_type":"authorization_code","code":code,"code_verifier":verifier})).await?;
            let claims = self.verify(&auth.access_token).await?;
            (auth, claims)
        };
        if claims.exp <= now() || claims.sub != auth.user.id {
            return Err(ApiError::unauthorized());
        }
        let credential = session_id();
        let browser_hash = hash(&credential);
        let access_token = self.seal("sealed_access_token", &browser_hash, &auth.access_token);
        let refresh_token = self.seal("sealed_refresh_token", &browser_hash, &auth.refresh_token);
        let mut tx = self.pool.begin().await?;
        let Upserted { user, created } = upsert(&mut tx, &auth.user).await?;
        sqlx::query("INSERT INTO mindgrab_loro.sessions(browser_hash,user_id,provider_session,sealed_access_token,sealed_refresh_token) VALUES($1,$2,$3,$4,$5)").bind(&browser_hash).bind(user.id).bind(claims.sid).bind(access_token).bind(refresh_token).execute(&mut *tx).await?;
        if let Some(previous) = self.browser_cookie(headers, SESSION_COOKIE) {
            sqlx::query("DELETE FROM mindgrab_loro.sessions WHERE browser_hash=$1")
                .bind(hash(&previous))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok((credential, created.then_some(user)))
    }
    pub async fn callback(&self, headers: &HeaderMap, query: &str) -> Response {
        let mut cookies = vec![cookie(&self.config, STATE_COOKIE, "", 0)];
        let destination = match self.callback_inner(headers, query).await {
            Ok((credential, created)) => {
                if let Some(user) = created {
                    self.analytics.signed_up(&user, headers);
                }
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
        // Parsed before the session is read, so the deploy check can prove without
        // signing in that the edge passes this header.
        let expected = headers
            .get("x-mindgrab-account")
            .map(|value| {
                value
                    .to_str()
                    .ok()
                    .and_then(|v| v.parse::<i64>().ok())
                    .filter(|v| *v > 0)
                    .ok_or_else(ApiError::invalid)
            })
            .transpose()?;
        let browser = self
            .browser_cookie(headers, SESSION_COOKIE)
            .ok_or_else(ApiError::unauthorized)?;
        let user = self.session_user(&hash(&browser)).await?;
        if expected.is_some_and(|id| id != user.id) {
            return Err(ApiError::new(StatusCode::CONFLICT, "account_changed"));
        }
        Ok(user)
    }
    /// The session's user, once its access token is valid. Provider calls can
    /// take seconds, so no connection or row lock is kept across one: each
    /// query here takes a pool connection for its own duration only.
    async fn session_user(&self, browser_hash: &str) -> Result<User> {
        let started = std::time::Instant::now();
        loop {
            let stored: StoredSession = sqlx::query_as("SELECT u.id,u.name,u.email,u.external_id,s.provider_session,s.sealed_access_token,s.sealed_refresh_token FROM mindgrab_loro.sessions s JOIN mindgrab_loro.users u ON u.id=s.user_id WHERE s.browser_hash=$1 AND s.expires_at>now()").bind(browser_hash).fetch_optional(&self.pool).await?.ok_or_else(ApiError::unauthorized)?;
            let (access_token, refresh_token) = (
                stored.sealed_access_token.clone(),
                stored.sealed_refresh_token.clone(),
            );
            let validated = match self.open(browser_hash, stored) {
                Some(session) => self.validate(browser_hash, session).await,
                // Sealed with a key no longer configured, or altered.
                None => {
                    tracing::warn!("Ending a session whose stored tokens do not open");
                    Err(ApiError::unauthorized())
                }
            };
            match validated {
                Ok(Some(user)) => return Ok(user),
                // Another request is refreshing this session; its tokens follow shortly.
                Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
                Err(error) if error.status == StatusCode::UNAUTHORIZED => {
                    // Only the tokens that were judged end the session: a
                    // refresh may have replaced them since they were read.
                    let ended = sqlx::query("DELETE FROM mindgrab_loro.sessions WHERE browser_hash=$1 AND sealed_access_token=$2 AND sealed_refresh_token=$3").bind(browser_hash).bind(access_token).bind(refresh_token).execute(&self.pool).await?.rows_affected();
                    if ended == 1 {
                        return Err(error);
                    }
                }
                Err(error) => return Err(error),
            }
            if started.elapsed() > REFRESH_WAIT {
                return Err(ApiError::unavailable());
            }
        }
    }
    /// `None` while another request refreshes the session.
    async fn validate(&self, browser_hash: &str, session: Session) -> Result<Option<User>> {
        if self.config.auth_mode == AuthMode::Local {
            if session.user.external_id != LOCAL_USER_ID
                || !session.provider_session.starts_with("local_")
                || session.access_token != LOCAL_TOKEN
                || session.refresh_token != LOCAL_TOKEN
            {
                return Err(ApiError::unauthorized());
            }
            return Ok(Some(session.user));
        }
        let claims = self.verify(&session.access_token).await?;
        if claims.sub != session.user.external_id || claims.sid != session.provider_session {
            return Err(ApiError::unauthorized());
        }
        if claims.exp > now() + 30 {
            return Ok(Some(session.user));
        }
        // A refresh finishes even if its request goes away: the provider has
        // then already replaced the refresh token, which must be stored.
        let (auth, browser_hash) = (self.clone(), browser_hash.to_string());
        tokio::spawn(async move { auth.refresh(&browser_hash, session).await })
            .await
            .map_err(|_| ApiError::unavailable())?
    }
    /// Refresh tokens are single use, so a lease on the session row lets one
    /// request at a time spend this one, in any process. `None` when another
    /// request holds the lease.
    async fn refresh(&self, browser_hash: &str, session: Session) -> Result<Option<User>> {
        // The lease's end time identifies it, so only its holder releases it.
        let lease: Option<String> = sqlx::query_scalar("UPDATE mindgrab_loro.sessions SET refreshing_until=now()+make_interval(secs => $3) WHERE browser_hash=$1 AND sealed_refresh_token=$2 AND (refreshing_until IS NULL OR refreshing_until<=now()) RETURNING refreshing_until::text").bind(browser_hash).bind(&session.sealed_refresh_token).bind(REFRESH_LEASE.as_secs_f64()).fetch_optional(&self.pool).await?;
        let Some(lease) = lease else {
            return Ok(None);
        };
        let refreshed: Result<User> = tokio::time::timeout(REFRESH_LIMIT, async {
            let auth = self.authenticate(serde_json::json!({"grant_type":"refresh_token","refresh_token":session.refresh_token})).await?;
            let claims = self.verify(&auth.access_token).await?;
            if claims.exp <= now()
                || claims.sub != session.user.external_id
                || claims.sid != session.provider_session
                || auth.user.id != session.user.external_id
            {
                return Err(ApiError::unauthorized());
            }
            let access_token = self.seal("sealed_access_token", browser_hash, &auth.access_token);
            let refresh_token =
                self.seal("sealed_refresh_token", browser_hash, &auth.refresh_token);
            let mut tx = self.pool.begin().await?;
            let stored = sqlx::query("UPDATE mindgrab_loro.sessions SET sealed_access_token=$2,sealed_refresh_token=$3,refreshing_until=NULL WHERE browser_hash=$1 AND sealed_refresh_token=$4").bind(browser_hash).bind(access_token).bind(refresh_token).bind(&session.sealed_refresh_token).execute(&mut *tx).await?.rows_affected();
            // Signed out while refreshing.
            if stored == 0 {
                return Err(ApiError::unauthorized());
            }
            let user = upsert(&mut tx, &auth.user).await?.user;
            tx.commit().await?;
            Ok(user)
        })
        .await
        .unwrap_or_else(|_| Err(ApiError::unavailable()));
        if refreshed.is_err() {
            // The next request may try at once rather than wait out the lease.
            let _ = sqlx::query("UPDATE mindgrab_loro.sessions SET refreshing_until=NULL WHERE browser_hash=$1 AND refreshing_until::text=$2").bind(browser_hash).bind(lease).execute(&self.pool).await;
        }
        refreshed.map(Some)
    }
    pub async fn logout(&self, headers: &HeaderMap) -> Result<Response> {
        self.config.same_origin(headers)?;
        let mut destination = self.config.app_url.clone();
        if let Some(browser) = self.browser_cookie(headers, SESSION_COOKIE) {
            let sid: Option<String> = sqlx::query_scalar("DELETE FROM mindgrab_loro.sessions WHERE browser_hash=$1 RETURNING provider_session").bind(hash(&browser)).fetch_optional(&self.pool).await?;
            if let Some(sid) = sid.filter(|_| self.config.auth_mode == AuthMode::WorkOs) {
                let mut url = self.url("/user_management/sessions/logout");
                url.query_pairs_mut().extend_pairs([
                    ("session_id", sid.as_str()),
                    ("return_to", &self.config.app_url),
                ]);
                destination = url.to_string();
            }
        }
        if let Some(nonce) = self.browser_cookie(headers, STATE_COOKIE) {
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
) -> Result<Upserted> {
    let name = [
        user.first_name.as_deref().unwrap_or_default(),
        user.last_name.as_deref().unwrap_or_default(),
    ]
    .join(" ")
    .trim()
    .to_string();
    let name = if name.is_empty() { &user.email } else { &name };
    Ok(sqlx::query_as("INSERT INTO mindgrab_loro.users(external_id,name,email) VALUES($1,$2,$3) ON CONFLICT(external_id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email RETURNING id,name,email,external_id,(xmax=0) AS created").bind(&user.id).bind(name).bind(&user.email).fetch_one(&mut **tx).await?)
}
