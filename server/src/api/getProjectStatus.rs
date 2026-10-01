use std::sync::Arc;

use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
};
use serde_json::json;

use super::ProjectRequest;
use crate::{
    auth::{AppState, User},
    project::{ApiError, parse_project_id, updates::ProjectState},
};

pub(super) async fn get_project_status(
    State(state): State<Arc<AppState>>,
    Extension(owner): Extension<User>,
    body: Result<Json<ProjectRequest>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Json(args) = body.map_err(|_| ApiError::InvalidRequest)?;
    let id = parse_project_id(&args.project_id)?;
    let project: ProjectState = sqlx::query_as("SELECT schema_version, protocol_version, last_sequence, validation FROM crdt_project WHERE id = $1 AND owner_id = $2")
        .bind(id).bind(owner.id).fetch_optional(&state.pool).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(
        json!({"schemaVersion": project.schema_version, "lastSequence": project.last_sequence.to_string(), "validation": project.validation}),
    ))
}
