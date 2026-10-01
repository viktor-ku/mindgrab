use std::sync::Arc;

use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::get,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use tower_sessions::Session;

use crate::{
    config::Config,
    response_headers::private_headers,
    workos::{AuthError, WorkOs, WorkOsUser},
};

pub(crate) mod store;

pub(crate) const SESSION_COOKIE: &str = "mindgrab_session_v2";
pub(crate) const LEGACY_SESSION_COOKIE: &str = "mindgrab_session";
pub(crate) const STATE_COOKIE: &str = "mindgrab_login";

pub struct AppState {
    pub config: Config,
    pub pool: PgPool,
    pub workos: WorkOs,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/auth/callback", get(callback))
        .layer(private_headers())
        .with_state(state)
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
    session: Session,
    Query(query): Query<Callback>,
) -> Response {
    let result = async {
        let provider = finish_login(&state, query, &jar).await?;
        let previous: Vec<_> = [SESSION_COOKIE, LEGACY_SESSION_COOKIE]
            .into_iter()
            .filter_map(|name| jar.get(name))
            .map(|cookie| token_hash(cookie.value()))
            .collect();
        session.insert(store::PROVIDER, provider).await?;
        session.insert(store::REPLACE, previous).await?;
        // Do not publish login success before the credential/rotation COMMIT.
        session.save().await?;
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
            session.clear().await;
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
) -> Result<String, AuthError> {
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
    let user = upsert_user(&mut tx, &authentication.user).await?;
    sqlx::query("INSERT INTO auth_sessions (token_hash, user_id, workos_session_id, access_token, refresh_token) VALUES ($1, $2, $3, $4, $5)")
        .bind(&hash).bind(user.id).bind(claims.sid)
        .bind(authentication.access_token).bind(authentication.refresh_token)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(hash)
}

#[derive(Serialize, sqlx::FromRow)]
pub(crate) struct User {
    pub(crate) id: i64,
    name: String,
    email: String,
    external_id: String,
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

pub(crate) async fn authenticated_user(
    state: &AppState,
    jar: &CookieJar,
) -> Result<User, AuthError> {
    let hash = browser_credential(jar).ok_or(AuthError::Unauthorized)?;
    let mut tx = state.pool.begin().await?;
    // Lock this session during refresh so concurrent requests never race rotation.
    let session: Option<ProviderSession> = sqlx::query_as("SELECT user_id, workos_session_id, access_token, refresh_token FROM auth_sessions WHERE (browser_hash = $1 OR (browser_hash IS NULL AND token_hash = $1)) AND expires_at > NOW() FOR UPDATE")
        .bind(&hash).fetch_optional(&mut *tx).await?;
    let session = session.ok_or(AuthError::Unauthorized)?;
    let result = validate_session(state, &mut tx, &hash, session).await;
    if matches!(result, Err(AuthError::Unauthorized)) {
        sqlx::query("DELETE FROM auth_sessions WHERE browser_hash = $1 OR token_hash = $1")
            .bind(hash)
            .execute(&mut *tx)
            .await?;
    }
    // Preserve sessions on transient provider failures; no stale token is accepted.
    tx.commit().await?;
    result
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
        "UPDATE auth_sessions SET access_token = $1, refresh_token = $2 WHERE browser_hash = $3 OR token_hash = $3",
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
