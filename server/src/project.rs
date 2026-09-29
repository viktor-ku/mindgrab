//! UUID-identified, owner-scoped project catalog for Yjs protocol v1.
//!
//! The owner always comes from the authenticated session. Catalog records hold
//! identity and rebuildable summaries only, never document bodies.

mod legacy;

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, PathRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
};
use axum_extra::extract::cookie::CookieJar;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::json;
use sqlx::PgPool;
use uuid::{Uuid, Variant, Version};

use crate::{
    auth::{AppState, authenticated_user, private_response},
    workos::AuthError,
};

const PROTOCOL_VERSION: i16 = 1;
const SCHEMA_VERSION: i16 = 1;
const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 100;

macro_rules! project_columns {
    () => {
        "id, protocol_version, schema_version, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, \
         name, last_sequence, \
         to_char(content_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS content_updated_at, \
         (EXTRACT(EPOCH FROM created_at) * 1000000)::BIGINT AS created_at_micros"
    };
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route(
            "/api/crdt/v1/projects",
            get(list_projects).post(create_project),
        )
        .route("/api/crdt/v1/projects/{project_id}", get(get_project))
        .merge(legacy::router())
        .layer(middleware::from_fn(private_response))
        .with_state(state)
}

#[derive(Debug)]
enum ApiError {
    InvalidRequest,
    InvalidProjectId,
    InvalidCursor,
    InvalidOrigin,
    Unauthenticated,
    NotFound,
    ProjectIdConflict,
    UnsupportedSchema,
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
            AuthError::BadRequest => Self::InvalidRequest,
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
struct CatalogProject {
    #[serde(rename = "projectId")]
    id: Uuid,
    protocol_version: i16,
    schema_version: i16,
    created_at: String,
    name: Option<String>,
    #[serde(serialize_with = "decimal_string")]
    last_sequence: i64,
    content_updated_at: Option<String>,
    #[serde(skip)]
    created_at_micros: i64,
}

fn decimal_string<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_str(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateProject {
    project_id: String,
    schema_version: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPage {
    projects: Vec<CatalogProject>,
    next_cursor: Option<String>,
}

fn parse_project_id(value: &str) -> Result<Uuid, ApiError> {
    Uuid::try_parse(value)
        .ok()
        .filter(|id| !id.is_nil() && id.hyphenated().to_string() == value)
        .ok_or(ApiError::InvalidProjectId)
}

fn parse_new_project_id(value: &str) -> Result<Uuid, ApiError> {
    let id = parse_project_id(value)?;
    if id.get_version() == Some(Version::Random) && id.get_variant() == Variant::RFC4122 {
        Ok(id)
    } else {
        Err(ApiError::InvalidProjectId)
    }
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

fn require_same_origin(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    if headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        == Some(state.config.origin().as_str())
    {
        Ok(())
    } else {
        Err(ApiError::InvalidOrigin)
    }
}

async fn owned_project(
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

async fn create_project(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    body: Result<Json<CreateProject>, JsonRejection>,
) -> Result<Response, ApiError> {
    require_same_origin(&state, &headers)?;
    let owner = authenticated_user(&state, &jar).await?;
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
        let location = format!("/api/crdt/v1/projects/{id}");
        return Ok((
            StatusCode::CREATED,
            [(header::LOCATION, location)],
            Json(project),
        )
            .into_response());
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

async fn get_project(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<CatalogProject>, ApiError> {
    let owner = authenticated_user(&state, &jar).await?;
    let Path(project_id) = path.map_err(|_| ApiError::InvalidProjectId)?;
    let id = parse_project_id(&project_id)?;
    owned_project(&state.pool, id, owner.id)
        .await?
        .map(Json)
        .ok_or(ApiError::NotFound)
}

async fn list_projects(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<ProjectPage>, ApiError> {
    let owner = authenticated_user(&state, &jar).await?;
    let Query(query) = query.map_err(|_| ApiError::InvalidRequest)?;
    let limit = query.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(ApiError::InvalidRequest);
    }
    let after = query.cursor.as_deref().map(decode_cursor).transpose()?;
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

#[cfg(test)]
mod tests;
