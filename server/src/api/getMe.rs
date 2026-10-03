use axum::{
    Json,
    response::{IntoResponse, Response},
};

use crate::{
    auth::{AuthSession, identified_user},
    workos::AuthError,
};

pub(super) async fn get_me(mut auth: AuthSession) -> Response {
    match identified_user(&auth) {
        Ok(user) => Json(user).into_response(),
        Err(AuthError::Unauthorized) => {
            if let Err(error) = auth.logout().await {
                return AuthError::from(error).into_response();
            }
            AuthError::Unauthorized.into_response()
        }
        Err(error) => error.into_response(),
    }
}
