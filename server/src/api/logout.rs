use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Redirect, Response},
};
use axum_extra::extract::cookie::CookieJar;

use crate::{
    auth::{
        AppState, AuthSession, LEGACY_SESSION_COOKIE, STATE_COOKIE, browser_credential,
        clear_cookie, token_hash,
    },
    workos::AuthError,
};

pub(super) async fn logout(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    mut auth: AuthSession,
) -> Result<Response, AuthError> {
    let mut destination = state.config.app_url.clone();
    if let Some(hash) = browser_credential(&jar) {
        let sid: Option<String> = sqlx::query_scalar(
            "DELETE FROM auth_sessions WHERE browser_hash = $1 OR (browser_hash IS NULL AND token_hash = $1) RETURNING workos_session_id",
        )
        .bind(hash)
        .fetch_optional(&state.pool)
        .await?;
        if let Some(sid) = sid {
            destination = state
                .workos
                .logout_url(&sid, &state.config.app_url)
                .to_string();
        }
    }
    auth.logout().await?;
    if let Some(nonce) = jar.get(STATE_COOKIE) {
        sqlx::query("DELETE FROM auth_login_attempts WHERE state_hash = $1")
            .bind(token_hash(nonce.value()))
            .execute(&state.pool)
            .await?;
    }
    let jar = clear_cookie(
        clear_cookie(jar, &state.config, LEGACY_SESSION_COOKIE),
        &state.config,
        STATE_COOKIE,
    );
    Ok((jar, Redirect::to(&destination)).into_response())
}
