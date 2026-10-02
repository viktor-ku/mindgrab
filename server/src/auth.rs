use std::sync::Arc;

use axum::{
    Extension, Json, Router,
    extract::{Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{MethodRouter, get},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
// Match axum-login's session types even when the direct dependency is newer.
use axum_login::tower_sessions::{self, Expiry, SessionManagerLayer};
use axum_login::{AuthManagerLayerBuilder, AuthUser, AuthnBackend};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};

use crate::{
    config::Config,
    response_headers::private_headers,
    workos::{AuthError, WorkOs, WorkOsUser},
};

pub(crate) mod store;

pub(crate) const SESSION_COOKIE: &str = "mindgrab_session_v2";
pub(crate) const LEGACY_SESSION_COOKIE: &str = "mindgrab_session";
pub(crate) const AUTH_DATA: &str = "axum-login.data";
pub(crate) const STATE_COOKIE: &str = "mindgrab_login";

pub struct AppState {
    pub config: Config,
    pub pool: PgPool,
    pub workos: WorkOs,
}

pub fn router(state: Arc<AppState>, limits: &crate::rate_limits::RateLimits) -> Router {
    Router::new()
        .route(
            "/api/auth/callback",
            manage(
                get(callback),
                state.clone(),
                AUTH_DATA,
                AuthError::into_response,
            )
            .route_layer(middleware::from_fn(fresh_login_session))
            .route_layer(crate::rate_limits::RateLimits::layer(&limits.login)),
        )
        .layer(private_headers())
        .with_state(state)
}

pub(crate) type AuthSession = axum_login::AuthSession<Backend>;

#[derive(Clone)]
pub(crate) struct Backend(pub Arc<AppState>);

// axum-login traces both Display IDs and Debug users. Never expose credentials.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(transparent)]
pub(crate) struct SessionKey(String);

impl std::fmt::Debug for SessionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[session]")
    }
}

impl std::fmt::Display for SessionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(self, f)
    }
}

impl AuthUser for User {
    type Id = SessionKey;

    fn id(&self) -> SessionKey {
        self.session.clone()
    }

    fn session_auth_hash(&self) -> &[u8] {
        self.session.0.as_bytes()
    }
}

pub(crate) struct Credentials {
    query: Callback,
    jar: CookieJar,
}

impl AuthnBackend for Backend {
    type User = User;
    type Credentials = Credentials;
    type Error = AuthError;

    async fn authenticate(&self, credentials: Credentials) -> Result<Option<User>, AuthError> {
        optional_user(finish_login(&self.0, credentials.query, &credentials.jar).await)
    }

    async fn get_user(&self, session: &SessionKey) -> Result<Option<User>, AuthError> {
        optional_user(self.validate(session, false).await)
    }
}

fn optional_user(result: Result<User, AuthError>) -> Result<Option<User>, AuthError> {
    match result {
        Ok(user) => Ok(Some(user)),
        Err(AuthError::Unauthorized) => Ok(None),
        Err(error) => Err(error),
    }
}

// Mark responses that made it through AuthManager. Its backend/store errors are
// otherwise empty 500s; translate only those, preserving each API's JSON contract.
#[derive(Clone)]
struct Managed;

pub(crate) fn manage(
    route: MethodRouter<Arc<AppState>>,
    state: Arc<AppState>,
    data_key: &'static str,
    error_response: fn(AuthError) -> Response,
) -> MethodRouter<Arc<AppState>> {
    let sessions = SessionManagerLayer::new(store::Store(state.pool.clone()))
        .with_name(SESSION_COOKIE)
        .with_http_only(true)
        .with_secure(state.config.secure_cookies)
        .with_same_site(SameSite::Lax)
        .with_path("/")
        .with_expiry(Expiry::OnInactivity(time::Duration::days(30)));
    route
        .route_layer(middleware::map_response(|mut response: Response| async {
            response.extensions_mut().insert(Managed);
            response
        }))
        .route_layer(
            AuthManagerLayerBuilder::new(Backend(state), sessions)
                .with_data_key(data_key)
                .build(),
        )
        .route_layer(middleware::map_response(
            move |mut response: Response| async move {
                if response.extensions_mut().remove::<Managed>().is_none()
                    && response.status() == StatusCode::INTERNAL_SERVER_ERROR
                {
                    error_response(AuthError::Unavailable)
                } else {
                    response
                }
            },
        ))
}

async fn fresh_login_session(mut request: Request, next: Next) -> Response {
    // A fresh ID keeps failed login/rotation from flushing previous authority.
    let jar = CookieJar::from_headers(request.headers());
    request.extensions_mut().insert(jar);
    request.headers_mut().remove(header::COOKIE);
    next.run(request).await
}

pub(crate) async fn identified_user(
    auth: &AuthSession,
    jar: &CookieJar,
) -> Result<User, AuthError> {
    if let Some(user) = &auth.user {
        return Ok(user.clone());
    }
    // Old tabs retain their credential until rotation, with no downgrade when
    // the new cookie is also present. Do not seed or rewrite old session records.
    if jar.get(SESSION_COOKIE).is_none()
        && let Some(hash) = browser_credential(jar)
    {
        return auth.backend.validate(&SessionKey(hash), true).await;
    }
    Err(AuthError::Unauthorized)
}

impl From<axum_login::Error<Backend>> for AuthError {
    fn from(error: axum_login::Error<Backend>) -> Self {
        match error {
            axum_login::Error::Backend(error) => error,
            axum_login::Error::Session(_) => Self::Unavailable,
        }
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "Sign in to continue."),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "Authentication is temporarily unavailable. Please retry.",
            ),
        };
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

impl From<sqlx::Error> for AuthError {
    fn from(_: sqlx::Error) -> Self {
        // Do not log queries, token payloads, credentials, or provider responses.
        eprintln!("Authentication database operation failed");
        Self::Unavailable
    }
}

impl From<tower_sessions::session::Error> for AuthError {
    fn from(_: tower_sessions::session::Error) -> Self {
        Self::Unavailable
    }
}

// Prefer the new credential even if invalid: never fall back to older authority
// when both cookies are present. Legacy tabs can keep using their issued cookie.
pub(crate) fn browser_credential(jar: &CookieJar) -> Option<String> {
    jar.get(SESSION_COOKIE)
        .or_else(|| jar.get(LEGACY_SESSION_COOKIE))
        .map(|cookie| token_hash(cookie.value()))
}

pub(crate) fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

pub(crate) fn token_hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

pub(crate) fn cookie(
    config: &Config,
    name: &'static str,
    value: String,
    seconds: i64,
) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(config.secure_cookies)
        .max_age(time::Duration::seconds(seconds))
        .build()
}

pub(crate) fn clear_cookie(jar: CookieJar, config: &Config, name: &'static str) -> CookieJar {
    jar.add(cookie(config, name, String::new(), 0))
}

#[derive(Deserialize)]
struct Callback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn callback(
    State(state): State<Arc<AppState>>,
    Extension(jar): Extension<CookieJar>,
    mut auth: AuthSession,
    Query(query): Query<Callback>,
) -> Response {
    let result = async {
        let user = auth
            .authenticate(Credentials {
                query,
                jar: jar.clone(),
            })
            .await?
            .ok_or(AuthError::Unauthorized)?;
        let previous: Vec<_> = [SESSION_COOKIE, LEGACY_SESSION_COOKIE]
            .into_iter()
            .filter_map(|name| jar.get(name))
            .map(|cookie| token_hash(cookie.value()))
            .collect();
        auth.login(&user).await?;
        auth.session
            .insert(store::PROVIDER, &user.session.0)
            .await?;
        auth.session.insert(store::REPLACE, previous).await?;
        // Do not publish login success before the credential/rotation COMMIT.
        auth.session.save().await?;
        Ok::<_, AuthError>(())
    }
    .await;
    let jar = clear_cookie(jar, &state.config, STATE_COOKIE);
    match result {
        Ok(()) => (
            clear_cookie(jar, &state.config, LEGACY_SESSION_COOKIE),
            Redirect::to(&state.config.app_url),
        )
            .into_response(),
        Err(error) => {
            // Avoid a second creation attempt by response middleware after a
            // failed explicit save. Previous credentials remain untouched.
            auth.session.clear().await;
            let code = match error {
                AuthError::Unauthorized => "sign_in_failed",
                AuthError::Unavailable => "unavailable",
            };
            (
                jar,
                Redirect::to(&format!("{}?auth_error={code}", state.config.app_url)),
            )
                .into_response()
        }
    }
}

async fn finish_login(
    state: &AppState,
    query: Callback,
    jar: &CookieJar,
) -> Result<User, AuthError> {
    let nonce = query
        .state
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            eprintln!("Auth callback rejected: missing state");
            AuthError::Unauthorized
        })?;
    let browser_nonce = jar.get(STATE_COOKIE).ok_or_else(|| {
        eprintln!("Auth callback rejected: missing login cookie");
        AuthError::Unauthorized
    })?;
    if token_hash(&nonce) != token_hash(browser_nonce.value()) {
        eprintln!("Auth callback rejected: state does not match login cookie");
        return Err(AuthError::Unauthorized);
    }
    // DELETE ... RETURNING makes attempts one-use, even for concurrent callbacks.
    let verifier: Option<String> = sqlx::query_scalar(
        "DELETE FROM auth_login_attempts WHERE state_hash = $1 AND expires_at > NOW() RETURNING code_verifier",
    ).bind(token_hash(&nonce)).fetch_optional(&state.pool).await?;
    let verifier = verifier.ok_or_else(|| {
        eprintln!("Auth callback rejected: login attempt expired or already consumed");
        AuthError::Unauthorized
    })?;
    if query.error.is_some() {
        eprintln!("Auth callback rejected: provider returned an error");
        return Err(AuthError::Unauthorized);
    }
    let code = query
        .code
        .filter(|value| !value.is_empty())
        .ok_or(AuthError::Unauthorized)?;
    let authentication = state
        .workos
        .exchange(&code, &verifier)
        .await
        .inspect_err(|_| {
            eprintln!("Auth callback failed during code exchange");
        })?;
    let claims = state
        .workos
        .verify(&authentication.access_token)
        .await
        .inspect_err(|_| {
            eprintln!("Auth callback failed during access token validation");
        })?;
    if claims.exp <= jsonwebtoken::get_current_timestamp() || claims.sub != authentication.user.id {
        return Err(AuthError::Unauthorized);
    }
    let hash = token_hash(&random_token());
    let mut tx = state.pool.begin().await?;
    let mut user = upsert_user(&mut tx, &authentication.user).await?;
    sqlx::query("INSERT INTO auth_sessions (token_hash, user_id, workos_session_id, access_token, refresh_token) VALUES ($1, $2, $3, $4, $5)")
        .bind(&hash).bind(user.id).bind(claims.sid)
        .bind(authentication.access_token).bind(authentication.refresh_token)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    user.session = SessionKey(hash);
    Ok(user)
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub(crate) struct User {
    pub(crate) id: i64,
    name: String,
    email: String,
    external_id: String,
    #[serde(skip)]
    #[sqlx(skip)]
    pub(crate) session: SessionKey,
}

async fn upsert_user(
    tx: &mut Transaction<'_, Postgres>,
    user: &WorkOsUser,
) -> Result<User, AuthError> {
    Ok(sqlx::query_as("INSERT INTO users (name, email, external_id) VALUES ($1, $2, $3) ON CONFLICT (external_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email RETURNING id, name, email, external_id")
        .bind(user.name()).bind(&user.email).bind(&user.id).fetch_one(&mut **tx).await?)
}

#[derive(sqlx::FromRow)]
struct ProviderSession {
    user_id: i64,
    workos_session_id: String,
    access_token: String,
    refresh_token: String,
}

impl Backend {
    async fn validate(&self, key: &SessionKey, legacy: bool) -> Result<User, AuthError> {
        let state = &self.0;
        let hash = &key.0;
        let mut tx = state.pool.begin().await?;
        // Lock the exact provider/local session so refresh rotation is serialized.
        let session: Option<ProviderSession> = sqlx::query_as("SELECT user_id, workos_session_id, access_token, refresh_token FROM auth_sessions WHERE token_hash = $1 AND (NOT $2 OR browser_hash IS NULL) AND expires_at > NOW() FOR UPDATE")
            .bind(hash).bind(legacy).fetch_optional(&mut *tx).await?;
        let session = session.ok_or(AuthError::Unauthorized)?;
        let result = validate_session(state, &mut tx, hash, session).await;
        if matches!(result, Err(AuthError::Unauthorized)) {
            sqlx::query("DELETE FROM auth_sessions WHERE token_hash = $1")
                .bind(hash)
                .execute(&mut *tx)
                .await?;
        }
        // Transient failures retain authority; no cached identity bypasses WorkOS.
        tx.commit().await?;
        result.map(|mut user| {
            user.session = key.clone();
            user
        })
    }
}

async fn validate_session(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    hash: &str,
    session: ProviderSession,
) -> Result<User, AuthError> {
    let claims = state.workos.verify(&session.access_token).await?;
    let user: User = sqlx::query_as("SELECT id, name, email, external_id FROM users WHERE id = $1")
        .bind(session.user_id)
        .fetch_one(&mut **tx)
        .await?;
    if claims.sub != user.external_id || claims.sid != session.workos_session_id {
        return Err(AuthError::Unauthorized);
    }
    if claims.exp > jsonwebtoken::get_current_timestamp() + 30 {
        return Ok(user);
    }
    let authentication = state.workos.refresh(&session.refresh_token).await?;
    let refreshed = state.workos.verify(&authentication.access_token).await?;
    if refreshed.exp <= jsonwebtoken::get_current_timestamp()
        || refreshed.sub != user.external_id
        || refreshed.sid != session.workos_session_id
        || authentication.user.id != user.external_id
    {
        return Err(AuthError::Unauthorized);
    }
    sqlx::query(
        "UPDATE auth_sessions SET access_token = $1, refresh_token = $2 WHERE token_hash = $3",
    )
    .bind(authentication.access_token)
    .bind(authentication.refresh_token)
    .bind(hash)
    .execute(&mut **tx)
    .await?;
    upsert_user(tx, &authentication.user).await
}

#[cfg(test)]
pub(crate) mod tests;
