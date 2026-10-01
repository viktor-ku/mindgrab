use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use axum_extra::extract::cookie::CookieJar;

use crate::{
    auth::{AppState, SESSION_COOKIE, authenticated_user, clear_cookie},
    workos::AuthError,
};

pub(super) async fn get_me(State(state): State<Arc<AppState>>, jar: CookieJar) -> Response {
    match authenticated_user(&state, &jar).await {
        Ok(user) => Json(user).into_response(),
        Err(AuthError::Unauthorized) => (
            clear_cookie(jar, &state.config, SESSION_COOKIE),
            AuthError::Unauthorized,
        )
            .into_response(),
        Err(error) => error.into_response(),
    }
}
