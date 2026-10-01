use std::sync::Arc;

use super::ProjectRequest;
use crate::{
    auth::AppState,
    project::{ApiError, CatalogProject, owned_project, parse_project_id, project_user},
};
use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
};
use axum_extra::extract::cookie::CookieJar;

pub(super) async fn get_project(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    body: Result<Json<ProjectRequest>, JsonRejection>,
) -> Result<Json<CatalogProject>, ApiError> {
    let owner = project_user(&state, &jar, &headers).await?;
    let Json(request) = body.map_err(|_| ApiError::InvalidRequest)?;
    let id = parse_project_id(&request.project_id)?;
    owned_project(&state.pool, id, owner.id)
        .await?
        .map(Json)
        .ok_or(ApiError::NotFound)
}
