use std::sync::Arc;

use axum::{
    Json,
    body::Bytes,
    extract::{
        DefaultBodyLimit, Extension, Query, Request, State,
        rejection::{BytesRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{MethodRouter, post},
};
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use tower_http::limit::RequestBodyLimitLayer;
use uuid::Uuid;

use crate::{
    auth::AppState,
    project::{
        ApiError, parse_new_project_id, parse_project_id, project_user,
        updates::{MAX_UPDATE_BYTES, ingest},
    },
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SubmitProjectUpdate {
    project_id: String,
    update_id: String,
}

#[derive(Clone)]
struct Submission {
    owner: i64,
    project: Uuid,
    update: Uuid,
}

pub(super) fn route(state: Arc<AppState>) -> MethodRouter<Arc<AppState>> {
    post(submit_project_update)
        .route_layer(DefaultBodyLimit::max(MAX_UPDATE_BYTES))
        .route_layer(RequestBodyLimitLayer::new(MAX_UPDATE_BYTES))
        .route_layer(middleware::map_response(|response: Response| async {
            if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
                ApiError::ResourceLimit.into_response()
            } else {
                response
            }
        }))
        // Origin is checked outside this route. Validate metadata before even
        // Content-Length rejection to preserve authentication/account precedence.
        .route_layer(middleware::from_fn_with_state(state, validate_submission))
}

async fn validate_submission(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    query: Result<Query<SubmitProjectUpdate>, QueryRejection>,
    mut request: Request,
    next: Next,
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
    request.extensions_mut().insert(Submission {
        owner: owner.id,
        project: id,
        update: update_id,
    });
    Ok(next.run(request).await)
}

async fn submit_project_update(
    State(state): State<Arc<AppState>>,
    Extension(submission): Extension<Submission>,
    bytes: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    // Preserve the existing resource_limit contract for read failures as well
    // as streamed overflows. The extractor remains bounded independently.
    let bytes = bytes.map_err(|_| ApiError::ResourceLimit)?;
    let (created, receipt) = ingest(
        &state.pool,
        submission.owner,
        submission.project,
        submission.update,
        bytes.to_vec(),
    )
    .await?;
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
