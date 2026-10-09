use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
}
impl ApiError {
    pub fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized")
    }
    pub fn unavailable() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    }
    pub fn invalid() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request")
    }
    pub fn missing() -> Self {
        Self::new(StatusCode::NOT_FOUND, "project_not_found")
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error":{"code":self.code}}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        Self::unavailable()
    }
}
impl From<mindgrab_state::StateError> for ApiError {
    fn from(error: mindgrab_state::StateError) -> Self {
        let code = match error {
            mindgrab_state::StateError::ResourceLimit => "resource_limit",
            mindgrab_state::StateError::MissingDependencies => "missing_dependencies",
            _ => "invalid_document",
        };
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, code)
    }
}
pub type Result<T> = std::result::Result<T, ApiError>;
