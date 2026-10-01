use std::sync::Arc;

use axum::{
    Json,
    body::to_bytes,
    extract::{Query, Request, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;

use crate::{
    auth::AppState,
    project::{
        ApiError, parse_new_project_id, parse_project_id, project_user,
        updates::{MAX_UPDATE_BYTES, ingest},
    },
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct SubmitProjectUpdate {
    project_id: String,
    update_id: String,
}

pub(super) async fn submit_project_update(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    query: Result<Query<SubmitProjectUpdate>, QueryRejection>,
    request: Request,
) -> Result<Response, ApiError> {
    let owner = project_user(&state, &jar, &headers).await?;
    let Query(args) = query.map_err(|_| ApiError::InvalidRequest)?;
    let id = parse_project_id(&args.project_id)?;
    let update_id = parse_new_project_id(&args.update_id)?;
    // Keep header errors after authentication, the account fence and query IDs.
    // A request-header layer here would change their error precedence.
    if headers
        .get("x-mindgrab-schema-version")
        .and_then(|v| v.to_str().ok())
        != Some("1")
    {
        return Err(ApiError::UnsupportedSchema);
    }
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some("application/octet-stream")
    {
        return Err(ApiError::InvalidRequest);
    }
    let bytes = to_bytes(request.into_body(), MAX_UPDATE_BYTES)
        .await
        .map_err(|_| ApiError::ResourceLimit)?;
    let (created, receipt) = ingest(&state.pool, owner.id, id, update_id, bytes.to_vec()).await?;
    Ok((
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(receipt),
    )
        .into_response())
}
