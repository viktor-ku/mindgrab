use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Redirect, Response},
};
use axum_extra::extract::cookie::CookieJar;

use crate::{
    auth::{AppState, STATE_COOKIE, cookie, random_token, token_hash},
    workos::AuthError,
};

pub(super) async fn start_login(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Response, AuthError> {
    let nonce = random_token();
    let verifier = random_token();
    // Replace the previous attempt for this browser when restarting sign-in.
    if let Some(previous) = jar.get(STATE_COOKIE) {
        sqlx::query("DELETE FROM auth_login_attempts WHERE state_hash = $1")
            .bind(token_hash(previous.value()))
            .execute(&state.pool)
            .await?;
    }
    sqlx::query("INSERT INTO auth_login_attempts (state_hash, code_verifier) VALUES ($1, $2)")
        .bind(token_hash(&nonce))
        .bind(&verifier)
        .execute(&state.pool)
        .await?;
    let url =
        state
            .workos
            .authorization_url(&state.config.redirect_uri, &nonce, &token_hash(&verifier));
    let jar = jar.add(cookie(&state.config, STATE_COOKIE, nonce, 600));
    Ok((jar, Redirect::to(url.as_str())).into_response())
}
