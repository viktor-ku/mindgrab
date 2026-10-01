use std::sync::Arc;

use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
};
use axum_extra::extract::cookie::CookieJar;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;

use super::ProjectRequest;
use crate::{
    auth::AppState,
    project::{ApiError, parse_project_id, project_user, updates::synchronization_baseline},
};

pub(super) async fn get_project_baseline(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    body: Result<Json<ProjectRequest>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let owner = project_user(&state, &jar, &headers).await?;
    let Json(args) = body.map_err(|_| ApiError::InvalidRequest)?;
    let id = parse_project_id(&args.project_id)?;
    let baseline = synchronization_baseline(&state.pool, owner.id, id).await?;
    Ok(Json(
        json!({"schemaVersion": 1, "lastSequence": baseline.sequence.to_string(), "validation": baseline.validation, "encoding": "yjs-v1", "data": STANDARD.encode(baseline.bytes), "stateVector": STANDARD.encode(baseline.state_vector)}),
    ))
}
