use std::sync::Arc;

use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
};
use axum_extra::extract::cookie::CookieJar;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::AppState,
    project::{
        ApiError, owned_project, parse_project_id, project_user,
        updates::{MAX_PAGE_BYTES, lock_project},
    },
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct GetProjectUpdates {
    project_id: String,
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

pub(super) async fn get_project_updates(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    body: Result<Json<GetProjectUpdates>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let owner = project_user(&state, &jar, &headers).await?;
    let Json(args) = body.map_err(|_| ApiError::InvalidRequest)?;
    let id = parse_project_id(&args.project_id)?;
    let after = sequence(args.after.as_deref())?;
    let limit = args.limit.unwrap_or(100);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::InvalidRequest);
    }
    if owned_project(&state.pool, id, owner.id).await?.is_none() {
        return Err(ApiError::NotFound);
    }
    let mut transaction = state.pool.begin().await?;
    lock_project(&mut transaction, id, owner.id).await?;
    let covered: i64 = sqlx::query_scalar(
        "SELECT COALESCE((SELECT covered_sequence FROM crdt_checkpoint WHERE project_id = $1), 0)",
    )
    .bind(id)
    .fetch_one(&mut *transaction)
    .await?;
    if after < covered {
        return Err(ApiError::BaselineRequired);
    }
    // Select a bounded byte window in SQL so a page never allocates 100 MiB.
    let rows: Vec<(i64, Uuid, String, Vec<u8>)> = sqlx::query_as(
        "WITH page AS (SELECT sequence, update_id, sha256, octet_length(data) AS size FROM crdt_update WHERE project_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3), sized AS (SELECT *, SUM(size) OVER (ORDER BY sequence) AS total FROM page) SELECT u.sequence, u.update_id, u.sha256, u.data FROM sized p JOIN crdt_update u ON u.project_id = $1 AND u.sequence = p.sequence WHERE p.total <= $4 ORDER BY u.sequence")
        .bind(id).bind(after).bind(i64::from(limit)).bind(MAX_PAGE_BYTES as i64).fetch_all(&mut *transaction).await?;
    let next = rows.last().map_or(after, |row| row.0);
    let has_more: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM crdt_update WHERE project_id = $1 AND sequence > $2)",
    )
    .bind(id)
    .bind(next)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let updates: Vec<_> = rows.into_iter().map(|(seq, update, sha256, bytes)| json!({"sequence": seq.to_string(), "updateId": update, "sha256": sha256, "encoding": "yjs-v1", "data": STANDARD.encode(bytes)})).collect();
    Ok(Json(
        json!({"updates": updates, "nextAfter": next.to_string(), "hasMore": has_more}),
    ))
}
