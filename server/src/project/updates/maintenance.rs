//! Atomic checkpoint publication and pruning, serialized with every writer.
use std::time::{Duration, Instant};

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use super::{document, load, lock_project};
use crate::project::ApiError;

pub(super) const VERSION: i16 = 1;
pub(super) const COUNT_TRIGGER: i64 = 1_000;
pub(super) const BYTE_TRIGGER: i64 = 1_048_576;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metrics {
    pub sequence: i64,
    pub pruned_rows: u64,
    pub log_rows: i64,
    pub log_bytes: i64,
    pub checkpoint_bytes: usize,
    pub replay_micros: u128,
    pub elapsed_micros: u128,
    pub coverage: bool,
}

pub(crate) async fn compact(pool: &PgPool, owner: i64, id: Uuid) -> Result<Metrics, ApiError> {
    let started = Instant::now();
    let mut transaction = pool.begin().await?;
    for statement in [
        "SET LOCAL synchronous_commit = on",
        "SET LOCAL lock_timeout = '5s'",
    ] {
        sqlx::query(statement).execute(&mut *transaction).await?;
    }
    let project = lock_project(&mut transaction, id, owner).await?;
    if project.protocol_version != 1 || project.schema_version != 1 {
        return Err(ApiError::UnsupportedSchema);
    }
    let (log_rows, log_bytes): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(octet_length(data)), 0)::BIGINT FROM crdt_update WHERE project_id = $1")
        .bind(id).fetch_one(&mut *transaction).await?;
    let checkpoint_bytes: i32 = sqlx::query_scalar("SELECT COALESCE((SELECT octet_length(data) FROM crdt_checkpoint WHERE project_id = $1), 0)")
        .bind(id).fetch_one(&mut *transaction).await?;
    let mut metrics = Metrics {
        sequence: project.last_sequence,
        pruned_rows: 0,
        log_rows,
        log_bytes,
        checkpoint_bytes: checkpoint_bytes as usize,
        replay_micros: 0,
        elapsed_micros: 0,
        coverage: false,
    };
    if project.last_sequence > 0 && project.validation != "quarantined" {
        let replay = Instant::now();
        let candidate = document::checkpoint_candidate(
            load(&mut transaction, id, project.last_sequence).await?,
        )
        .await?;
        metrics.replay_micros = replay.elapsed().as_micros();
        if let Some(bytes) = candidate.checkpoint {
            // Missing receipts are never papered over by deleting source rows.
            let receipts: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM crdt_receipt WHERE project_id = $1 AND sequence <= $2",
            )
            .bind(id)
            .bind(project.last_sequence)
            .fetch_one(&mut *transaction)
            .await?;
            if receipts != project.last_sequence {
                return Err(ApiError::Unavailable);
            }
            metrics.checkpoint_bytes = bytes.len();
            sqlx::query("INSERT INTO crdt_checkpoint (project_id, covered_sequence, data, sha256, checkpoint_version, encoding) VALUES ($1, $2, $3, $4, $5, 'yjs-v1') ON CONFLICT (project_id) DO UPDATE SET covered_sequence = EXCLUDED.covered_sequence, data = EXCLUDED.data, sha256 = EXCLUDED.sha256, checkpoint_version = EXCLUDED.checkpoint_version, encoding = EXCLUDED.encoding, created_at = NOW()")
                .bind(id).bind(project.last_sequence).bind(&bytes).bind(super::digest(&bytes)).bind(VERSION).execute(&mut *transaction).await?;
            metrics.pruned_rows =
                sqlx::query("DELETE FROM crdt_update WHERE project_id = $1 AND sequence <= $2")
                    .bind(id)
                    .bind(project.last_sequence)
                    .execute(&mut *transaction)
                    .await?
                    .rows_affected();
            metrics.coverage = true;
        }
    }
    // A gap is retried only when more bytes arrive, avoiding expensive idle loops.
    sqlx::query("UPDATE crdt_project SET compaction_attempt_sequence = $2, compaction_failures = 0, compaction_retry_at = NOW() WHERE id = $1")
        .bind(id).bind(project.last_sequence).execute(&mut *transaction).await?;
    transaction.commit().await?;
    metrics.elapsed_micros = started.elapsed().as_micros();
    eprintln!(
        "crdt_compaction project={id} {}",
        serde_json::to_string(&metrics).unwrap()
    );
    Ok(metrics)
}

/// Bounded keyset scan; one project at a time per process, globally bounded CPU
/// decoding through document's semaphore. Database row locks serialize processes.
pub(crate) async fn sweep(pool: &PgPool, after: Option<Uuid>) -> Result<Option<Uuid>, ApiError> {
    let projects: Vec<(Uuid, i64)> = sqlx::query_as("SELECT id, owner_id FROM crdt_project WHERE ($1::UUID IS NULL OR id > $1) AND last_sequence > 0 AND compaction_retry_at <= NOW() AND (last_sequence > compaction_attempt_sequence OR compaction_failures > 0) ORDER BY id LIMIT 50")
        .bind(after).fetch_all(pool).await?;
    let next = projects.last().map(|(id, _)| *id);
    for (id, owner) in projects {
        let due: bool = sqlx::query_scalar("SELECT COUNT(*) >= $2 OR COALESCE(SUM(octet_length(data)), 0) >= $3 OR COALESCE(MIN(committed_at) <= NOW() - INTERVAL '1 hour', FALSE) FROM crdt_update WHERE project_id = $1")
            .bind(id).bind(COUNT_TRIGGER).bind(BYTE_TRIGGER).fetch_one(pool).await?;
        if !due {
            continue;
        }
        if let Err(error) = compact(pool, owner, id).await {
            // Scheduling metadata is disposable. If this write also fails the
            // next 5-second sweep retries; no canonical source was modified.
            let _ = sqlx::query("UPDATE crdt_project SET compaction_failures = LEAST(compaction_failures + 1, 10), compaction_retry_at = NOW() + make_interval(secs => LEAST(1800, 30 * (1 << LEAST(compaction_failures, 6)))) WHERE id = $1")
                .bind(id).execute(pool).await;
            eprintln!("crdt_compaction_failure project={id} error={error:?}");
        }
    }
    Ok(next)
}

pub(crate) fn start_worker(pool: PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut after = None;
        loop {
            interval.tick().await;
            match sweep(&pool, after).await {
                Ok(next) => after = next,
                Err(error) => eprintln!("crdt_compaction_sweep_failure error={error:?}"),
            }
        }
    });
}

#[cfg(test)]
mod tests;
