//! Single-file admin archive: bounded manifest + binary full-state update/tail.
//! This format preserves UUID/clocks/receipts; it is never a JSON import.
use std::{
    collections::HashSet,
    fs::OpenOptions,
    io::{Read, Write},
    path::Path,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use super::{digest, document, load, lock_project, maintenance};
use crate::project::ApiError;

const MAGIC: &[u8; 8] = b"MGBK0001";
const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_RECEIPTS: usize = 1_000_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Manifest {
    format_version: u8,
    schema_version: i16,
    protocol_version: i16,
    checkpoint_version: i16,
    encoding: String,
    project_id: Uuid,
    source_owner_external_id: String,
    created_at: String,
    content_updated_at: Option<String>,
    #[serde(with = "decimal")]
    covered_sequence: i64,
    #[serde(with = "decimal")]
    last_sequence: i64,
    validation: String,
    checkpoint_length: usize,
    checkpoint_sha256: String,
    payload_sha256: String,
    receipts: Vec<ArchivedReceipt>,
    tail: Vec<Tail>,
}

mod decimal {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        let value = String::deserialize(deserializer)?;
        value
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 0 && n.to_string() == value)
            .ok_or_else(|| serde::de::Error::custom("Invalid sequence"))
    }
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ArchivedReceipt {
    #[serde(with = "decimal")]
    sequence: i64,
    update_id: Uuid,
    sha256: String,
    byte_length: i32,
    validation: String,
    committed_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Tail {
    #[serde(with = "decimal")]
    sequence: i64,
    byte_length: usize,
    sha256: String,
}

pub(crate) struct Archive {
    manifest: Manifest,
    payload: Vec<u8>,
}

pub(crate) async fn owner(pool: &PgPool, external_id: &str) -> Result<i64, ApiError> {
    sqlx::query_scalar("SELECT id FROM users WHERE external_id = $1")
        .bind(external_id)
        .fetch_optional(pool)
        .await?
        .ok_or(ApiError::NotFound)
}

pub(crate) async fn export(
    pool: &PgPool,
    id: Uuid,
    expected_owner: &str,
) -> Result<Archive, ApiError> {
    let owner = owner(pool, expected_owner).await?;
    let mut transaction = pool.begin().await?;
    let project = lock_project(&mut transaction, id, owner).await?;
    if project.schema_version != 1 || project.protocol_version != 1 {
        return Err(ApiError::UnsupportedSchema);
    }
    let inputs = load(&mut transaction, id, project.last_sequence).await?;
    let candidate = if project.last_sequence > 0 && project.validation != "quarantined" {
        Some(document::checkpoint_candidate(inputs).await?)
    } else {
        None
    };
    let checkpoint = candidate.and_then(|c| c.checkpoint);
    let (covered, checkpoint) = if let Some(bytes) = checkpoint {
        (project.last_sequence, bytes)
    } else {
        sqlx::query_as::<_, (i64, Vec<u8>)>(
            "SELECT covered_sequence, data FROM crdt_checkpoint WHERE project_id = $1",
        )
        .bind(id)
        .fetch_optional(&mut *transaction)
        .await?
        .unwrap_or((0, vec![0, 0]))
    };
    let (created_at, content_updated_at): (String, Option<String>) = sqlx::query_as(
        "SELECT created_at::TEXT, content_updated_at::TEXT FROM crdt_project WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&mut *transaction)
    .await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM crdt_receipt WHERE project_id = $1")
        .bind(id)
        .fetch_one(&mut *transaction)
        .await?;
    if count != project.last_sequence || count > MAX_RECEIPTS as i64 {
        return Err(ApiError::ResourceLimit);
    }
    let receipts = sqlx::query_as("SELECT sequence, update_id, sha256, byte_length, validation, committed_at::TEXT FROM crdt_receipt WHERE project_id = $1 ORDER BY sequence")
        .bind(id).fetch_all(&mut *transaction).await?;
    let rows: Vec<(i64, Vec<u8>, String)> = sqlx::query_as("SELECT sequence, data, sha256 FROM crdt_update WHERE project_id = $1 AND sequence > $2 ORDER BY sequence")
        .bind(id).bind(covered).fetch_all(&mut *transaction).await?;
    let mut payload = checkpoint.clone();
    let mut tail = Vec::new();
    for (sequence, bytes, sha256) in rows {
        tail.push(Tail {
            sequence,
            byte_length: bytes.len(),
            sha256,
        });
        payload.extend_from_slice(&bytes);
    }
    let archive = Archive {
        manifest: Manifest {
            format_version: 1,
            schema_version: 1,
            protocol_version: 1,
            checkpoint_version: maintenance::VERSION,
            encoding: "yjs-v1".into(),
            project_id: id,
            source_owner_external_id: expected_owner.into(),
            created_at,
            content_updated_at,
            covered_sequence: covered,
            last_sequence: project.last_sequence,
            validation: project.validation,
            checkpoint_length: checkpoint.len(),
            checkpoint_sha256: digest(&checkpoint),
            payload_sha256: digest(&payload),
            receipts,
            tail,
        },
        payload,
    };
    transaction.commit().await?;
    archive.validate(id, expected_owner).await?;
    Ok(archive)
}

impl Archive {
    /// create_new prevents overwriting a previous backup; fsync file and parent.
    pub(crate) fn write(&self, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let manifest = serde_json::to_vec(&self.manifest)?;
        if manifest.len() as u64 + self.payload.len() as u64 + 44 > MAX_ARCHIVE {
            return Err("Archive too large".into());
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        file.write_all(MAGIC)?;
        file.write_all(&(manifest.len() as u32).to_le_bytes())?;
        file.write_all(&Sha256::digest(&manifest))?;
        file.write_all(&manifest)?;
        file.write_all(&self.payload)?;
        file.sync_all()?;
        std::fs::File::open(
            path.parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?
        .sync_all()?;
        Ok(())
    }

    pub(crate) fn read(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let mut file = std::fs::File::open(path)?;
        if file.metadata()?.len() > MAX_ARCHIVE {
            return Err("Archive too large".into());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_ARCHIVE + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_ARCHIVE || bytes.get(..8) != Some(MAGIC) {
            return Err("Invalid archive".into());
        }
        let length =
            u32::from_le_bytes(bytes.get(8..12).ok_or("Truncated archive")?.try_into()?) as usize;
        let json = bytes.get(44..44 + length).ok_or("Truncated manifest")?;
        if bytes.get(12..44) != Some(Sha256::digest(json).as_slice()) {
            return Err("Manifest checksum mismatch".into());
        }
        Ok(Self {
            manifest: serde_json::from_slice(json)?,
            payload: bytes[44 + length..].to_vec(),
        })
    }

    async fn validate(&self, id: Uuid, source_owner: &str) -> Result<Vec<Vec<u8>>, ApiError> {
        let m = &self.manifest;
        if m.project_id != id || m.source_owner_external_id != source_owner {
            return Err(ApiError::ProjectIdConflict);
        }
        if m.format_version != 1
            || m.schema_version != 1
            || m.protocol_version != 1
            || m.checkpoint_version != maintenance::VERSION
            || m.encoding != "yjs-v1"
        {
            return Err(ApiError::UnsupportedSchema);
        }
        if crate::project::parse_new_project_id(&id.to_string()).is_err()
            || m.covered_sequence < 0
            || m.covered_sequence > m.last_sequence
            || m.receipts.len() > MAX_RECEIPTS
            || m.receipts.len() as i64 != m.last_sequence
            || m.tail.len() as i64 != m.last_sequence - m.covered_sequence
            || !["valid", "pending_dependencies", "quarantined"].contains(&m.validation.as_str())
            || digest(&self.payload) != m.payload_sha256
        {
            return Err(ApiError::InvalidRequest);
        }
        let mut ids = HashSet::new();
        for (index, receipt) in m.receipts.iter().enumerate() {
            if receipt.sequence != index as i64 + 1
                || !ids.insert(receipt.update_id)
                || crate::project::parse_new_project_id(&receipt.update_id.to_string()).is_err()
                || !(2..=super::MAX_UPDATE_BYTES as i32).contains(&receipt.byte_length)
                || receipt.sha256.len() != 64
                || !receipt
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !["valid", "pending_dependencies", "quarantined"]
                    .contains(&receipt.validation.as_str())
            {
                return Err(ApiError::InvalidRequest);
            }
        }
        let checkpoint = self
            .payload
            .get(..m.checkpoint_length)
            .ok_or(ApiError::InvalidRequest)?;
        if checkpoint.len() < 2
            || checkpoint.len() > super::MAX_DOCUMENT_BYTES
            || digest(checkpoint) != m.checkpoint_sha256
            || (m.covered_sequence == 0 && checkpoint != [0, 0])
        {
            return Err(ApiError::InvalidRequest);
        }
        let mut inputs = vec![checkpoint.to_vec()];
        let mut offset = m.checkpoint_length;
        for (index, tail) in m.tail.iter().enumerate() {
            let end = offset
                .checked_add(tail.byte_length)
                .ok_or(ApiError::InvalidRequest)?;
            let bytes = self
                .payload
                .get(offset..end)
                .ok_or(ApiError::InvalidRequest)?;
            let sequence = m.covered_sequence + index as i64 + 1;
            let receipt = &m.receipts[sequence as usize - 1];
            if tail.sequence != sequence
                || tail.byte_length != receipt.byte_length as usize
                || tail.sha256 != receipt.sha256
                || digest(bytes) != tail.sha256
            {
                return Err(ApiError::InvalidRequest);
            }
            inputs.push(bytes.to_vec());
            offset = end;
        }
        if offset != self.payload.len()
            || offset > super::MAX_DOCUMENT_BYTES
            || m.tail.len() > super::MAX_TAIL_ROWS as usize
        {
            return Err(ApiError::ResourceLimit);
        }
        // Validate a standalone checkpoint separately: required tail must never
        // be used to conceal an incomplete supposedly-covered prefix.
        if m.covered_sequence > 0
            && document::checkpoint_candidate(vec![checkpoint.to_vec()])
                .await?
                .checkpoint
                .is_none()
        {
            return Err(ApiError::InvalidUpdate);
        }
        for bytes in &inputs {
            super::wire::preflight(bytes)?;
        }
        if m.last_sequence > 0 {
            match document::candidate(inputs.clone()).await {
                Ok(candidate) if candidate.validation == m.validation => {}
                Err(
                    ApiError::InvalidSchema | ApiError::UnsupportedSchema | ApiError::ResourceLimit,
                ) if m.validation == "quarantined" => {}
                _ => return Err(ApiError::InvalidUpdate),
            }
        } else if m.validation != "pending_dependencies" {
            return Err(ApiError::InvalidRequest);
        }
        Ok(inputs)
    }
}

/// UUID must be absent. No replace/reset mode: old replicas keep the same identity.
/// Destination owner must already exist, resolved by explicit external identity.
pub(crate) async fn restore(
    pool: &PgPool,
    id: Uuid,
    source_owner: &str,
    destination_owner: &str,
    archive: Archive,
) -> Result<(), ApiError> {
    let inputs = archive.validate(id, source_owner).await?;
    let owner = owner(pool, destination_owner).await?;
    let m = archive.manifest;
    let mut transaction = pool.begin().await?;
    sqlx::query("SET LOCAL synchronous_commit = on")
        .execute(&mut *transaction)
        .await?;
    let inserted = sqlx::query("INSERT INTO crdt_project (id, owner_id, schema_version, protocol_version, created_at, last_sequence, validation, content_updated_at) VALUES ($1, $2, 1, 1, $3::TEXT::TIMESTAMPTZ, $4, $5, $6::TEXT::TIMESTAMPTZ) ON CONFLICT (id) DO NOTHING")
        .bind(id).bind(owner).bind(&m.created_at).bind(m.last_sequence).bind(&m.validation).bind(&m.content_updated_at).execute(&mut *transaction).await?;
    if inserted.rows_affected() != 1 {
        return Err(ApiError::ProjectIdConflict);
    }
    if m.covered_sequence > 0 {
        sqlx::query("INSERT INTO crdt_checkpoint (project_id, covered_sequence, data, sha256) VALUES ($1, $2, $3, $4)")
            .bind(id).bind(m.covered_sequence).bind(&inputs[0]).bind(m.checkpoint_sha256).execute(&mut *transaction).await?;
    }
    for receipt in m.receipts {
        if receipt.sequence <= m.covered_sequence {
            sqlx::query("INSERT INTO crdt_receipt (project_id, sequence, update_id, sha256, byte_length, validation, committed_at) VALUES ($1, $2, $3, $4, $5, $6, $7::TEXT::TIMESTAMPTZ)")
                .bind(id).bind(receipt.sequence).bind(receipt.update_id).bind(receipt.sha256).bind(receipt.byte_length).bind(receipt.validation).bind(receipt.committed_at).execute(&mut *transaction).await?;
        } else {
            let bytes = &inputs[(receipt.sequence - m.covered_sequence) as usize];
            sqlx::query("INSERT INTO crdt_update (project_id, sequence, update_id, data, sha256, validation, committed_at) VALUES ($1, $2, $3, $4, $5, $6, $7::TEXT::TIMESTAMPTZ)")
                .bind(id).bind(receipt.sequence).bind(receipt.update_id).bind(bytes).bind(receipt.sha256).bind(receipt.validation).bind(receipt.committed_at).execute(&mut *transaction).await?;
        }
    }
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests;
