use std::sync::Arc;

use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;

use super::ProjectRequest;
use crate::{
    auth::{AppState, User},
    project::{ApiError, parse_project_id, updates::synchronization_baseline},
};

pub(super) async fn get_project_baseline(
    State(state): State<Arc<AppState>>,
    Extension(owner): Extension<User>,
    body: Result<Json<ProjectRequest>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Json(args) = body.map_err(|_| ApiError::InvalidRequest)?;
    let id = parse_project_id(&args.project_id)?;
    let baseline = synchronization_baseline(&state.pool, owner.id, id).await?;
    Ok(Json(
        json!({"schemaVersion": 1, "lastSequence": baseline.sequence.to_string(), "validation": baseline.validation, "encoding": "yjs-v1", "data": STANDARD.encode(baseline.bytes), "stateVector": STANDARD.encode(baseline.state_vector)}),
    ))
}
