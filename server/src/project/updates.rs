//! Shared HTTP/WebSocket durable ingestion boundary. A returned receipt always
//! follows PostgreSQL COMMIT; no live room is mutated during candidate validation.
mod document;
mod wire;

use std::sync::Arc;

use axum::{
    Json, Router,
    body::to_bytes,
    extract::{
        Path, Query, Request, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use axum_extra::extract::cookie::CookieJar;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use super::{ApiError, parse_new_project_id, parse_project_id, require_same_origin};
use crate::auth::{AppState, authenticated_user};

pub(crate) const MAX_UPDATE_BYTES: usize = 1_048_576;
const MAX_DOCUMENT_BYTES: usize = 10_485_760;
const MAX_PAGE_BYTES: usize = 2_097_152;
// Bound reconstruction work until MIN-39 supplies checkpoint maintenance.
const MAX_TAIL_ROWS: i64 = 10_000;

pub(super) fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/crdt/v1/projects/{project_id}/updates/{update_id}",
            put(submit),
        )
        .route("/api/crdt/v1/projects/{project_id}/updates", get(replay))
        .route("/api/crdt/v1/projects/{project_id}/status", get(status))
        .route("/api/crdt/v1/projects/{project_id}/baseline", get(baseline))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    protocol_version: i16,
    project_id: Uuid,
    update_id: Uuid,
    #[serde(serialize_with = "super::decimal_string")]
    pub(crate) sequence: i64,
    sha256: String,
    durable: bool,
    validation: String,
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(sqlx::FromRow)]
struct ProjectState {
    schema_version: i16,
    protocol_version: i16,
    last_sequence: i64,
    validation: String,
}

async fn lock_project(
    connection: &mut PgConnection,
    id: Uuid,
    owner: i64,
) -> Result<ProjectState, ApiError> {
    sqlx::query_as("SELECT schema_version, protocol_version, last_sequence, validation FROM crdt_project WHERE id = $1 AND owner_id = $2 FOR UPDATE")
        .bind(id).bind(owner).fetch_optional(connection).await?.ok_or(ApiError::NotFound)
}

/// Read checkpoint and tail under the same project lock used by submission and
/// future checkpoint workers. Never discard originals on the basis of a vector.
async fn load(
    connection: &mut PgConnection,
    id: Uuid,
    last: i64,
) -> Result<Vec<Vec<u8>>, ApiError> {
    let checkpoint: Option<(i64, Vec<u8>, String)> = sqlx::query_as(
        "SELECT covered_sequence, data, sha256 FROM crdt_checkpoint WHERE project_id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *connection)
    .await?;
    let mut updates = Vec::new();
    let covered = match checkpoint {
        Some((covered, bytes, sha256)) if covered <= last && digest(&bytes) == sha256 => {
            updates.push(bytes);
            covered
        }
        Some(_) => return Err(ApiError::Unavailable),
        None => 0,
    };
    let (count, size): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(octet_length(data)), 0)::BIGINT FROM crdt_update WHERE project_id = $1 AND sequence > $2 AND sequence <= $3")
        .bind(id).bind(covered).bind(last).fetch_one(&mut *connection).await?;
    let checkpoint_size: usize = updates.iter().map(Vec::len).sum();
    if count > MAX_TAIL_ROWS || size as usize + checkpoint_size > MAX_DOCUMENT_BYTES {
        return Err(ApiError::ResourceLimit);
    }
    // Every sequence after a checkpoint must be retained, including delete-only updates.
    if count != last - covered {
        return Err(ApiError::Unavailable);
    }
    let tail: Vec<(Vec<u8>, String)> = sqlx::query_as("SELECT data, sha256 FROM crdt_update WHERE project_id = $1 AND sequence > $2 AND sequence <= $3 ORDER BY sequence")
        .bind(id).bind(covered).bind(last).fetch_all(connection).await?;
    for (bytes, sha256) in tail {
        if digest(&bytes) != sha256 {
            return Err(ApiError::Unavailable);
        }
        updates.push(bytes);
    }
    Ok(updates)
}

/// MIN-36 must call this boundary for binary socket ingestion, then broadcast
/// the original committed bytes. Socket sync is not a durability receipt.
pub(crate) async fn ingest(
    pool: &PgPool,
    owner: i64,
    id: Uuid,
    update_id: Uuid,
    bytes: Vec<u8>,
) -> Result<(bool, Receipt), ApiError> {
    if bytes.len() > MAX_UPDATE_BYTES {
        return Err(ApiError::ResourceLimit);
    }
    let mut transaction = pool.begin().await?;
    // Ensure receipts remain durable even on installations that relax the default.
    sqlx::query("SET LOCAL synchronous_commit = on")
        .execute(&mut *transaction)
        .await?;
    let project = lock_project(&mut transaction, id, owner).await?;
    if project.schema_version != 1 || project.protocol_version != 1 {
        return Err(ApiError::UnsupportedSchema);
    }
    let previous: Option<(Vec<u8>, i64, String, String)> = sqlx::query_as("SELECT data, sequence, sha256, validation FROM crdt_update WHERE project_id = $1 AND update_id = $2")
        .bind(id).bind(update_id).fetch_optional(&mut *transaction).await?;
    if let Some((stored, sequence, sha256, validation)) = previous {
        if stored != bytes {
            return Err(ApiError::UpdateIdConflict);
        }
        transaction.commit().await?;
        return Ok((
            false,
            Receipt {
                protocol_version: 1,
                project_id: id,
                update_id,
                sequence,
                sha256,
                durable: true,
                validation,
            },
        ));
    }
    if project.validation == "quarantined" {
        return Err(ApiError::Quarantined);
    }
    wire::preflight(&bytes)?;
    let mut updates = load(&mut transaction, id, project.last_sequence).await?;
    if updates.len() >= MAX_TAIL_ROWS as usize
        || updates.iter().map(Vec::len).sum::<usize>() + bytes.len() > MAX_DOCUMENT_BYTES
    {
        return Err(ApiError::ResourceLimit);
    }
    updates.push(bytes.clone());
    let validation = match document::candidate(updates).await {
        Ok(candidate) => candidate.validation,
        // The incoming predecessor may expose invalid *previously accepted*
        // pending content. Retain both for recovery, fence future mutations.
        Err(ApiError::InvalidSchema | ApiError::UnsupportedSchema | ApiError::ResourceLimit)
            if project.last_sequence > 0 && project.validation == "pending_dependencies" =>
        {
            "quarantined"
        }
        Err(error) => return Err(error),
    };
    let sequence = project
        .last_sequence
        .checked_add(1)
        .ok_or(ApiError::ResourceLimit)?;
    let sha256 = digest(&bytes);
    sqlx::query("INSERT INTO crdt_update (project_id, sequence, update_id, data, sha256, validation) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(id).bind(sequence).bind(update_id).bind(&bytes).bind(&sha256).bind(validation).execute(&mut *transaction).await?;
    sqlx::query("UPDATE crdt_project SET last_sequence = $2, validation = $3, content_updated_at = NOW() WHERE id = $1")
        .bind(id).bind(sequence).bind(validation).execute(&mut *transaction).await?;
    transaction.commit().await?;
    Ok((
        true,
        Receipt {
            protocol_version: 1,
            project_id: id,
            update_id,
            sequence,
            sha256,
            durable: true,
            validation: validation.into(),
        },
    ))
}

async fn submit(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    path: Result<Path<(String, String)>, PathRejection>,
    request: Request,
) -> Result<Response, ApiError> {
    require_same_origin(&state, &headers)?;
    let owner = authenticated_user(&state, &jar).await?;
    let Path((project, update)) = path.map_err(|_| ApiError::InvalidProjectId)?;
    let id = parse_project_id(&project)?;
    let update_id = parse_new_project_id(&update)?;
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplayQuery {
    after: Option<String>,
    limit: Option<u32>,
}

fn sequence(value: Option<&str>) -> Result<i64, ApiError> {
    let value = value.unwrap_or("0");
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 0 && n.to_string() == value)
        .ok_or(ApiError::InvalidCursor)
}

async fn replay(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<ReplayQuery>, QueryRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let owner = authenticated_user(&state, &jar).await?;
    let id = parse_project_id(&path.map_err(|_| ApiError::InvalidProjectId)?.0)?;
    let Query(query) = query.map_err(|_| ApiError::InvalidRequest)?;
    let after = sequence(query.after.as_deref())?;
    let limit = query.limit.unwrap_or(100);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::InvalidRequest);
    }
    if super::owned_project(&state.pool, id, owner.id)
        .await?
        .is_none()
    {
        return Err(ApiError::NotFound);
    }
    // Select a bounded byte window in SQL so a page never allocates 100 MiB.
    let rows: Vec<(i64, Uuid, String, Vec<u8>)> = sqlx::query_as(
        "WITH page AS (SELECT sequence, update_id, sha256, octet_length(data) AS size FROM crdt_update WHERE project_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3), sized AS (SELECT *, SUM(size) OVER (ORDER BY sequence) AS total FROM page) SELECT u.sequence, u.update_id, u.sha256, u.data FROM sized p JOIN crdt_update u ON u.project_id = $1 AND u.sequence = p.sequence WHERE p.total <= $4 ORDER BY u.sequence")
        .bind(id).bind(after).bind(i64::from(limit)).bind(MAX_PAGE_BYTES as i64).fetch_all(&state.pool).await?;
    let next = rows.last().map_or(after, |row| row.0);
    let has_more: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM crdt_update WHERE project_id = $1 AND sequence > $2)",
    )
    .bind(id)
    .bind(next)
    .fetch_one(&state.pool)
    .await?;
    let updates: Vec<_> = rows.into_iter().map(|(seq, update, sha256, bytes)| json!({"sequence": seq.to_string(), "updateId": update, "sha256": sha256, "encoding": "yjs-v1", "data": STANDARD.encode(bytes)})).collect();
    Ok(Json(
        json!({"updates": updates, "nextAfter": next.to_string(), "hasMore": has_more}),
    ))
}

async fn status(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let owner = authenticated_user(&state, &jar).await?;
    let id = parse_project_id(&path.map_err(|_| ApiError::InvalidProjectId)?.0)?;
    let project: ProjectState = sqlx::query_as("SELECT schema_version, protocol_version, last_sequence, validation FROM crdt_project WHERE id = $1 AND owner_id = $2")
        .bind(id).bind(owner.id).fetch_optional(&state.pool).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(
        json!({"schemaVersion": project.schema_version, "lastSequence": project.last_sequence.to_string(), "validation": project.validation}),
    ))
}

async fn baseline(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let owner = authenticated_user(&state, &jar).await?;
    let id = parse_project_id(&path.map_err(|_| ApiError::InvalidProjectId)?.0)?;
    let baseline = synchronization_baseline(&state.pool, owner.id, id).await?;
    Ok(Json(
        json!({"schemaVersion": 1, "lastSequence": baseline.sequence.to_string(), "validation": baseline.validation, "encoding": "yjs-v1", "data": STANDARD.encode(baseline.bytes), "stateVector": STANDARD.encode(baseline.state_vector)}),
    ))
}

pub(crate) struct SynchronizationBaseline {
    pub(crate) sequence: i64,
    pub(crate) bytes: Vec<u8>,
    pub(crate) state_vector: Vec<u8>,
    pub(crate) validation: &'static str,
}

/// Shared reconstruction entry point for MIN-36 socket bootstrap and MIN-38
/// projection. Bytes include pending structures/deletes, not just visible state.
pub(crate) async fn synchronization_baseline(
    pool: &PgPool,
    owner: i64,
    id: Uuid,
) -> Result<SynchronizationBaseline, ApiError> {
    let mut transaction = pool.begin().await?;
    let project = lock_project(&mut transaction, id, owner).await?;
    if project.protocol_version != 1 || project.schema_version != 1 {
        return Err(ApiError::UnsupportedSchema);
    }
    if project.validation == "quarantined" {
        return Err(ApiError::Quarantined);
    }
    if project.last_sequence == 0 {
        transaction.commit().await?;
        return Ok(SynchronizationBaseline {
            sequence: 0,
            bytes: vec![0, 0],
            state_vector: vec![0],
            validation: "pending_dependencies",
        });
    }
    let candidate =
        document::candidate(load(&mut transaction, id, project.last_sequence).await?).await?;
    transaction.commit().await?;
    Ok(SynchronizationBaseline {
        sequence: project.last_sequence,
        bytes: candidate.bytes,
        state_vector: candidate.state_vector,
        validation: candidate.validation,
    })
}

#[cfg(test)]
mod tests;
