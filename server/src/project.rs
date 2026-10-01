//! UUID-identified, owner-scoped project catalog for Yjs protocol v1.
//!
//! The owner always comes from the authenticated session. Catalog records hold
//! identity and rebuildable summaries only, never document bodies.

pub(crate) mod cutover;
mod projection;
pub(crate) mod read_model;
#[cfg(test)]
mod release_tests;
mod sync;
pub(crate) mod updates;

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::Request,
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{MethodRouter, get},
};
use axum_extra::extract::cookie::CookieJar;
use serde::{Serialize, Serializer};
use serde_json::json;
use sqlx::PgPool;
use uuid::{Uuid, Variant, Version};

use crate::{
    auth::{self, AppState, AuthSession, User},
    response_headers::private_headers,
    workos::AuthError,
};

pub(crate) const PROTOCOL_VERSION: i16 = 1;
pub(crate) const SCHEMA_VERSION: i16 = 1;
pub(crate) const DEFAULT_PAGE_SIZE: u32 = 50;
pub(crate) const MAX_PAGE_SIZE: u32 = 100;

macro_rules! project_columns {
    () => {
        "id, protocol_version, schema_version, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, \
         COALESCE(name_utf8, convert_to(name, 'UTF8')) AS name, node_count, projection_sequence, projection_version, projection_status, last_sequence, \
         to_char(content_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS content_updated_at, \
         (EXTRACT(EPOCH FROM created_at) * 1000000)::BIGINT AS created_at_micros"
    };
}

pub(crate) use project_columns;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .merge(sync::router(state.clone()))
        // Retired snapshot clients must still receive an explicit upgrade error.
        .route(
            "/api/projects",
            get(cutover::upgrade_required).put(cutover::upgrade_required),
        )
        .layer(private_headers())
        .with_state(state)
}

#[derive(Debug)]
pub(crate) enum ApiError {
    InvalidRequest,
    InvalidProjectId,
    InvalidCursor,
    InvalidOrigin,
    Unauthenticated,
    AccountChanged,
    NotFound,
    ProjectIdConflict,
    UnsupportedSchema,
    InvalidUpdate,
    InvalidSchema,
    ResourceLimit,
    UpdateIdConflict,
    BaselineRequired,
    Quarantined,
    Unavailable,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::InvalidRequest => (
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "The request is malformed.",
            ),
            Self::InvalidProjectId => (
                StatusCode::BAD_REQUEST,
                "invalid_project_id",
                "Project IDs must be canonical lowercase UUIDs.",
            ),
            Self::InvalidCursor => (
                StatusCode::BAD_REQUEST,
                "invalid_cursor",
                "The page cursor is invalid.",
            ),
            Self::InvalidOrigin => (
                StatusCode::FORBIDDEN,
                "invalid_origin",
                "Invalid request origin.",
            ),
            Self::Unauthenticated => (
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Sign in to continue.",
            ),
            Self::AccountChanged => (
                StatusCode::CONFLICT,
                "account_changed",
                "The active account changed. Check your session before syncing.",
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "project_not_found",
                "Project not found.",
            ),
            Self::ProjectIdConflict => (
                StatusCode::CONFLICT,
                "project_id_conflict",
                "This project ID is unavailable.",
            ),
            Self::UnsupportedSchema => (
                StatusCode::UPGRADE_REQUIRED,
                "unsupported_schema",
                "This project schema version is not supported.",
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "Projects are temporarily unavailable. Please retry.",
            ),
            Self::InvalidUpdate => (
                StatusCode::BAD_REQUEST,
                "invalid_update",
                "Expected a complete Yjs V1 binary update.",
            ),
            Self::InvalidSchema => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_schema",
                "The document does not match schema v1.",
            ),
            Self::ResourceLimit => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "resource_limit",
                "The update or document exceeds a resource limit.",
            ),
            Self::BaselineRequired => (
                StatusCode::CONFLICT,
                "baseline_required",
                "The replay cursor was compacted. Persist a fresh baseline before continuing.",
            ),
            Self::UpdateIdConflict => (
                StatusCode::CONFLICT,
                "update_id_conflict",
                "This update ID already identifies different bytes.",
            ),
            Self::Quarantined => (
                StatusCode::CONFLICT,
                "project_quarantined",
                "This document requires recovery before further editing.",
            ),
        };
        (
            status,
            Json(json!({"error": {"code": code, "message": message}})),
        )
            .into_response()
    }
}

impl From<AuthError> for ApiError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Unauthorized => Self::Unauthenticated,
            AuthError::Unavailable => Self::Unavailable,
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        eprintln!("Project catalog database operation failed");
        Self::Unavailable
    }
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogProject {
    #[serde(rename = "projectId")]
    pub(crate) id: Uuid,
    pub(crate) protocol_version: i16,
    pub(crate) schema_version: i16,
    pub(crate) created_at: String,
    pub(crate) name: Option<read_model::Utf8Text>,
    pub(crate) node_count: Option<i32>,
    #[serde(serialize_with = "read_model::optional_sequence")]
    pub(crate) projection_sequence: Option<i64>,
    pub(crate) projection_version: Option<i16>,
    pub(crate) projection_status: String,
    #[serde(serialize_with = "decimal_string")]
    pub(crate) last_sequence: i64,
    pub(crate) content_updated_at: Option<String>,
    #[serde(skip)]
    pub(crate) created_at_micros: i64,
}

fn decimal_string<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_str(value)
}

pub(crate) fn parse_project_id(value: &str) -> Result<Uuid, ApiError> {
    Uuid::try_parse(value)
        .ok()
        .filter(|id| !id.is_nil() && id.hyphenated().to_string() == value)
        .ok_or(ApiError::InvalidProjectId)
}

pub(crate) fn parse_new_project_id(value: &str) -> Result<Uuid, ApiError> {
    let id = parse_project_id(value)?;
    if id.get_version() == Some(Version::Random) && id.get_variant() == Variant::RFC4122 {
        Ok(id)
    } else {
        Err(ApiError::InvalidProjectId)
    }
}

// An expectation is a fence, never an ownership selector. The session remains
// the authority even when cookies rotate while a previous workspace is active.
pub(crate) fn protect(
    route: MethodRouter<Arc<AppState>>,
    state: Arc<AppState>,
) -> MethodRouter<Arc<AppState>> {
    auth::manage(
        route.route_layer(middleware::from_fn(require_user)),
        state,
        auth::AUTH_DATA,
        |error| ApiError::from(error).into_response(),
    )
}

async fn require_user(
    auth: AuthSession,
    jar: CookieJar,
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let user = auth::identified_user(&auth, &jar).await?;
    if let Some(expected) = headers.get("x-mindgrab-account") {
        require_account(
            &user,
            expected.to_str().map_err(|_| ApiError::InvalidRequest)?,
        )?;
    }
    request.extensions_mut().insert(user);
    Ok(next.run(request).await)
}

pub(crate) fn require_account(user: &User, expected: &str) -> Result<(), ApiError> {
    let id = expected
        .parse::<i64>()
        .map_err(|_| ApiError::InvalidRequest)?;
    if id <= 0 || id.to_string() != expected {
        return Err(ApiError::InvalidRequest);
    }
    if id != user.id {
        return Err(ApiError::AccountChanged);
    }
    Ok(())
}

pub(crate) async fn owned_project(
    pool: &PgPool,
    id: Uuid,
    owner_id: i64,
) -> Result<Option<CatalogProject>, ApiError> {
    Ok(sqlx::query_as(concat!(
        "SELECT ",
        project_columns!(),
        " FROM crdt_project WHERE id = $1 AND owner_id = $2"
    ))
    .bind(id)
    .bind(owner_id)
    .fetch_optional(pool)
    .await?)
}

#[cfg(test)]
mod tests;
