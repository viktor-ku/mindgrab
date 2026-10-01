use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use axum_extra::extract::cookie::CookieJar;

use crate::{
    auth::{AppState, AuthSession, LEGACY_SESSION_COOKIE, clear_cookie, identified_user},
    workos::AuthError,
};

pub(super) async fn get_me(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    mut auth: AuthSession,
) -> Response {
    match identified_user(&auth, &jar).await {
        Ok(user) => Json(user).into_response(),
        Err(AuthError::Unauthorized) => {
            if let Err(error) = auth.logout().await {
                return AuthError::from(error).into_response();
            }
            (
                clear_cookie(jar, &state.config, LEGACY_SESSION_COOKIE),
                AuthError::Unauthorized,
            )
                .into_response()
        }
        Err(error) => error.into_response(),
    }
}
