use std::sync::Arc;

use super::ProjectRequest;
use crate::{
    auth::{AppState, User},
    project::{
        ApiError, parse_project_id,
        read_model::{CurrentState, current_state},
    },
};
use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
};

pub(super) async fn get_project_state(
    State(state): State<Arc<AppState>>,
    Extension(owner): Extension<User>,
    body: Result<Json<ProjectRequest>, JsonRejection>,
) -> Result<Json<CurrentState>, ApiError> {
    let Json(args) = body.map_err(|_| ApiError::InvalidRequest)?;
    let id = parse_project_id(&args.project_id)?;
    Ok(Json(current_state(&state.pool, owner.id, id).await?))
}
