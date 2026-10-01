use std::sync::Arc;

use super::ProjectRequest;
use crate::{
    auth::AppState,
    project::{
        ApiError, parse_project_id, project_user,
        read_model::{CurrentState, current_state},
    },
};
use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
};
use axum_extra::extract::cookie::CookieJar;

pub(super) async fn get_project_state(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    body: Result<Json<ProjectRequest>, JsonRejection>,
) -> Result<Json<CurrentState>, ApiError> {
    let owner = project_user(&state, &jar, &headers).await?;
    let Json(args) = body.map_err(|_| ApiError::InvalidRequest)?;
    let id = parse_project_id(&args.project_id)?;
    Ok(Json(current_state(&state.pool, owner.id, id).await?))
}
