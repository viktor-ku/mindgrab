//! The legacy API is a permanent fence; resetting development snapshots is an
//! explicit operator action and never part of API startup or Yjs migrations.
use axum::{Json, http::StatusCode, response::IntoResponse};
use serde_json::json;
use sqlx::PgPool;

pub(super) async fn upgrade_required() -> impl IntoResponse {
    (
        StatusCode::UPGRADE_REQUIRED,
        [("Upgrade", "mindgrab-yjs-v1")],
        Json(json!({
            "error": {
                "code": "legacy_client_upgrade_required",
                "message": "Snapshot projects are no longer supported. Reconnect, close all Mindgrab tabs and reopen with the current application."
            },
            "protocolVersion": 1,
            "schemaVersion": 1,
            "storageGeneration": 1,
            "action": "reload"
        })),
    )
}

pub(crate) async fn reset_legacy_projects(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    // Serialize concurrent reset commands. No CASCADE: unexpected dependents
    // must fail and roll back rather than extend the deletion scope.
    sqlx::query("SELECT pg_advisory_xact_lock(43, 1)")
        .execute(&mut *tx)
        .await?;
    sqlx::raw_sql("DROP TABLE IF EXISTS pnode; DROP TABLE IF EXISTS project;")
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

#[cfg(test)]
mod tests;
