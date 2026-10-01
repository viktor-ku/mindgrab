use std::sync::Arc;

use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::{AppState, User},
    project::{ApiError, CatalogProject, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, project_columns},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ListProjects {
    limit: Option<u32>,
    cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectPage {
    projects: Vec<CatalogProject>,
    next_cursor: Option<String>,
}

fn encode_cursor(project: &CatalogProject) -> String {
    let mut bytes = [0; 24];
    bytes[..8].copy_from_slice(&project.created_at_micros.to_be_bytes());
    bytes[8..].copy_from_slice(project.id.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_cursor(value: &str) -> Result<(i64, Uuid), ApiError> {
    let bytes: [u8; 24] = URL_SAFE_NO_PAD
        .decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(ApiError::InvalidCursor)?;
    let micros = i64::from_be_bytes(bytes[..8].try_into().unwrap());
    let id = Uuid::from_slice(&bytes[8..]).map_err(|_| ApiError::InvalidCursor)?;
    Ok((micros, id))
}

pub(super) async fn list_projects(
    State(state): State<Arc<AppState>>,
    Extension(owner): Extension<User>,
    body: Result<Json<ListProjects>, JsonRejection>,
) -> Result<Json<ProjectPage>, ApiError> {
    let Json(args) = body.map_err(|_| ApiError::InvalidRequest)?;
    let limit = args.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(ApiError::InvalidRequest);
    }
    let after = args.cursor.as_deref().map(decode_cursor).transpose()?;
    let mut projects: Vec<CatalogProject> = sqlx::query_as(concat!(
        "SELECT ",
        project_columns!(),
        " FROM crdt_project WHERE owner_id = $1 \
         AND ($2::BIGINT IS NULL OR (created_at, id) < \
             (TIMESTAMPTZ 'epoch' + $2::BIGINT * INTERVAL '1 microsecond', $3::UUID)) \
         ORDER BY created_at DESC, id DESC LIMIT $4"
    ))
    .bind(owner.id)
    .bind(after.map(|(micros, _)| micros))
    .bind(after.map(|(_, id)| id))
    .bind(i64::from(limit) + 1)
    .fetch_all(&state.pool)
    .await?;
    let has_more = projects.len() > limit as usize;
    projects.truncate(limit as usize);
    let next_cursor = has_more
        .then(|| projects.last().map(encode_cursor))
        .flatten();
    Ok(Json(ProjectPage {
        projects,
        next_cursor,
    }))
}
