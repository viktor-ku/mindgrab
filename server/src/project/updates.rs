//! Shared HTTP/WebSocket durable ingestion boundary. A returned receipt always
//! follows PostgreSQL COMMIT; no live room is mutated during candidate validation.
pub(crate) mod backup;
mod document;
pub(crate) mod maintenance;
mod wire;

use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use super::ApiError;

pub(crate) const MAX_UPDATE_BYTES: usize = 1_048_576;
const MAX_DOCUMENT_BYTES: usize = 10_485_760;
pub(crate) const MAX_PAGE_BYTES: usize = 2_097_152;
// Hard reconstruction budgets; maintenance triggers well below these limits.
const MAX_TAIL_ROWS: i64 = 10_000;

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

pub(super) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(sqlx::FromRow)]
pub(crate) struct ProjectState {
    pub(crate) schema_version: i16,
    pub(crate) protocol_version: i16,
    pub(crate) last_sequence: i64,
    pub(crate) validation: String,
}

pub(crate) async fn lock_project(
    connection: &mut PgConnection,
    id: Uuid,
    owner: i64,
) -> Result<ProjectState, ApiError> {
    sqlx::query_as("SELECT schema_version, protocol_version, last_sequence, validation FROM crdt_project WHERE id = $1 AND owner_id = $2 FOR UPDATE")
        .bind(id).bind(owner).fetch_optional(connection).await?.ok_or(ApiError::NotFound)
}

/// Read checkpoint and tail under the same project lock used by submission and
/// checkpoint workers. Never discard originals on the basis of a vector.
pub(super) async fn load(
    connection: &mut PgConnection,
    id: Uuid,
    last: i64,
) -> Result<Vec<Vec<u8>>, ApiError> {
    let checkpoint: Option<(i64, Vec<u8>, String, i16, String)> = sqlx::query_as(
        "SELECT covered_sequence, data, sha256, checkpoint_version, encoding FROM crdt_checkpoint WHERE project_id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *connection)
    .await?;
    let mut updates = Vec::new();
    let covered = match checkpoint {
        Some((covered, bytes, sha256, 1, encoding))
            if covered <= last && encoding == "yjs-v1" && digest(&bytes) == sha256 =>
        {
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

/// HTTP and socket ingestion use this boundary, then broadcast
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
    let previous: Option<(i32, i64, String, String)> = sqlx::query_as("SELECT byte_length, sequence, sha256, validation FROM crdt_receipt WHERE project_id = $1 AND update_id = $2")
        .bind(id).bind(update_id).fetch_optional(&mut *transaction).await?;
    if let Some((stored, sequence, sha256, validation)) = previous {
        if stored as usize != bytes.len() || sha256 != digest(&bytes) {
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

pub(crate) struct SynchronizationBaseline {
    pub(crate) sequence: i64,
    pub(crate) bytes: Vec<u8>,
    pub(crate) state_vector: Vec<u8>,
    pub(crate) validation: &'static str,
}

/// Shared reconstruction entry point for socket bootstrap and read-model
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
pub(super) mod tests;

/// Validated canonical content, absent while causal dependencies are unresolved.
pub(super) async fn materialized(
    updates: Vec<Vec<u8>>,
) -> Result<Option<super::projection::Content>, ApiError> {
    Ok(document::candidate(updates).await?.content)
}
