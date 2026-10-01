use std::sync::Arc;

use super::ProjectRequest;
use crate::{
    auth::{AppState, User},
    project::{ApiError, CatalogProject, owned_project, parse_project_id},
};
use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
};

pub(super) async fn get_project(
    State(state): State<Arc<AppState>>,
    Extension(owner): Extension<User>,
    body: Result<Json<ProjectRequest>, JsonRejection>,
) -> Result<Json<CatalogProject>, ApiError> {
    let Json(request) = body.map_err(|_| ApiError::InvalidRequest)?;
    let id = parse_project_id(&request.project_id)?;
    owned_project(&state.pool, id, owner.id)
        .await?
        .map(Json)
        .ok_or(ApiError::NotFound)
}
