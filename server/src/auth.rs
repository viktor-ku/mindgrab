use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::get,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};

use crate::{
    config::Config,
    workos::{AuthError, WorkOs, WorkOsUser},
};

pub(crate) const SESSION_COOKIE: &str = "mindgrab_session";
pub(crate) const STATE_COOKIE: &str = "mindgrab_login";
const SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;

pub struct AppState {
    pub config: Config,
    pub pool: PgPool,
    pub workos: WorkOs,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/auth/callback", get(callback))
        .layer(middleware::from_fn(private_response))
        .with_state(state)
}

pub(crate) async fn private_response(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
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
    jar: CookieJar,
    Query(query): Query<Callback>,
) -> Response {
    let result = finish_login(&state, &jar, query).await;
    let jar = clear_cookie(jar, &state.config, STATE_COOKIE);
    match result {
        Ok(token) => (
            jar.add(cookie(
                &state.config,
                SESSION_COOKIE,
                token,
                SESSION_SECONDS,
            )),
            Redirect::to(&state.config.app_url),
        )
            .into_response(),
        Err(error) => {
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
    jar: &CookieJar,
    query: Callback,
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
    let token = random_token();
    let mut tx = state.pool.begin().await?;
    let user = upsert_user(&mut tx, &authentication.user).await?;
    // Rotate the local session credential on every successful login.
    if let Some(previous) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM auth_sessions WHERE token_hash = $1")
            .bind(token_hash(previous.value()))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO auth_sessions (token_hash, user_id, workos_session_id, access_token, refresh_token) VALUES ($1, $2, $3, $4, $5)")
        .bind(token_hash(&token)).bind(user.id).bind(claims.sid)
        .bind(authentication.access_token).bind(authentication.refresh_token)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(token)
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
struct Session {
    user_id: i64,
    workos_session_id: String,
    access_token: String,
    refresh_token: String,
}

pub(crate) async fn authenticated_user(
    state: &AppState,
    jar: &CookieJar,
) -> Result<User, AuthError> {
    let token = jar.get(SESSION_COOKIE).ok_or(AuthError::Unauthorized)?;
    let hash = token_hash(token.value());
    let mut tx = state.pool.begin().await?;
    // Lock this session during refresh so concurrent requests never race rotation.
    let session: Option<Session> = sqlx::query_as("SELECT user_id, workos_session_id, access_token, refresh_token FROM auth_sessions WHERE token_hash = $1 AND expires_at > NOW() FOR UPDATE")
        .bind(&hash).fetch_optional(&mut *tx).await?;
    let session = session.ok_or(AuthError::Unauthorized)?;
    let result = validate_session(state, &mut tx, &hash, session).await;
    if matches!(result, Err(AuthError::Unauthorized)) {
        sqlx::query("DELETE FROM auth_sessions WHERE token_hash = $1")
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
    session: Session,
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
