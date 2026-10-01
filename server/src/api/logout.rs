use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
};
use axum_extra::extract::cookie::CookieJar;

use crate::{
    auth::{AppState, SESSION_COOKIE, STATE_COOKIE, clear_cookie, token_hash},
    workos::AuthError,
};

pub(super) async fn logout(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
) -> Result<Response, AuthError> {
    // A same-origin POST is required; SameSite alone does not protect sibling domains.
    if headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        != Some(state.config.origin().as_str())
    {
        return Ok((StatusCode::FORBIDDEN, "Invalid request origin").into_response());
    }
    let mut destination = state.config.app_url.clone();
    if let Some(token) = jar.get(SESSION_COOKIE) {
        let sid: Option<String> = sqlx::query_scalar(
            "DELETE FROM auth_sessions WHERE token_hash = $1 RETURNING workos_session_id",
        )
        .bind(token_hash(token.value()))
        .fetch_optional(&state.pool)
        .await?;
        if let Some(sid) = sid {
            destination = state
                .workos
                .logout_url(&sid, &state.config.app_url)
                .to_string();
        }
    }
    if let Some(nonce) = jar.get(STATE_COOKIE) {
        sqlx::query("DELETE FROM auth_login_attempts WHERE state_hash = $1")
            .bind(token_hash(nonce.value()))
            .execute(&state.pool)
            .await?;
    }
    let jar = clear_cookie(
        clear_cookie(jar, &state.config, SESSION_COOKIE),
        &state.config,
        STATE_COOKIE,
    );
    Ok((jar, Redirect::to(&destination)).into_response())
}
