use std::sync::Arc;

use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;

use crate::{
    auth::AppState,
    project::{
        ApiError, CatalogProject, PROTOCOL_VERSION, SCHEMA_VERSION, owned_project,
        parse_new_project_id, project_columns, project_user,
    },
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct CreateProject {
    project_id: String,
    schema_version: i64,
}

pub(super) async fn create_project(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    body: Result<Json<CreateProject>, JsonRejection>,
) -> Result<Response, ApiError> {
    let owner = project_user(&state, &jar, &headers).await?;
    let Json(request) = body.map_err(|_| ApiError::InvalidRequest)?;
    let id = parse_new_project_id(&request.project_id)?;
    if request.schema_version != i64::from(SCHEMA_VERSION) {
        return Err(ApiError::UnsupportedSchema);
    }
    // A concurrent claim of the same UUID waits for the other transaction; the
    // follow-up read then observes whichever registration committed first.
    let created: Option<CatalogProject> = sqlx::query_as(concat!(
        "INSERT INTO crdt_project (id, owner_id, protocol_version, schema_version) \
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING ",
        project_columns!()
    ))
    .bind(id)
    .bind(owner.id)
    .bind(PROTOCOL_VERSION)
    .bind(SCHEMA_VERSION)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(project) = created {
        return Ok((StatusCode::CREATED, Json(project)).into_response());
    }
    // Another owner's claim is indistinguishable from a mismatched retry.
    match owned_project(&state.pool, id, owner.id).await? {
        Some(project)
            if project.protocol_version == PROTOCOL_VERSION
                && project.schema_version == SCHEMA_VERSION =>
        {
            Ok((StatusCode::OK, Json(project)).into_response())
        }
        _ => Err(ApiError::ProjectIdConflict),
    }
}
