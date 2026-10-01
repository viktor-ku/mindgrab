//! Rebuildable inspection indexes. Binary checkpoint/tail is the sole input.
use std::{collections::BTreeMap, time::Duration};

use serde::Serialize;
use sqlx::{PgConnection, PgPool, Postgres, QueryBuilder};
use uuid::Uuid;

use super::{
    ApiError, decimal_string,
    projection::{self, Content, EffectivePlacement, Metadata, Node, Placement, Position},
    updates,
};

// PostgreSQL TEXT cannot hold NUL; canonical names/text can. Decode BYTEA
// strictly instead of silently escaping or replacing user content.
#[derive(Clone, Serialize)]
#[serde(transparent)]
pub(crate) struct Utf8Text(pub String);

impl sqlx::Type<Postgres> for Utf8Text {
    fn type_info() -> sqlx::postgres::PgTypeInfo {
        <Vec<u8> as sqlx::Type<Postgres>>::type_info()
    }
}
impl<'r> sqlx::Decode<'r, Postgres> for Utf8Text {
    fn decode(value: sqlx::postgres::PgValueRef<'r>) -> Result<Self, sqlx::error::BoxDynError> {
        let bytes = <Vec<u8> as sqlx::Decode<Postgres>>::decode(value)?;
        Ok(Self(String::from_utf8(bytes)?))
    }
}

pub(super) const VERSION: i16 = 1;

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Freshness {
    #[serde(serialize_with = "decimal_string")]
    last_sequence: i64,
    #[serde(serialize_with = "optional_sequence")]
    source_sequence: Option<i64>,
    #[serde(serialize_with = "decimal_string")]
    attempted_sequence: i64,
    projection_version: Option<i16>,
    status: String,
    name: Option<Utf8Text>,
    node_count: Option<i32>,
    content_updated_at: Option<String>,
}

pub(super) fn optional_sequence<S: serde::Serializer>(
    value: &Option<i64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(sequence) => serializer.serialize_some(&sequence.to_string()),
        None => serializer.serialize_none(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CurrentState {
    project_id: Uuid,
    schema_version: i16,
    current: bool,
    freshness: Freshness,
    content: Option<Content>,
    placements: BTreeMap<String, EffectivePlacement>,
}

/// All jobs lock BEFORE reading source bytes and hold the lock through publish.
/// Competing jobs therefore reconstruct the latest committed sequence rather
/// than letting an old snapshot replace a newer projection. Failure rolls back
/// only these derived writes; update receipts already committed independently.
async fn refresh(
    connection: &mut PgConnection,
    owner: i64,
    id: Uuid,
    force: bool,
) -> Result<(), ApiError> {
    let project = updates::lock_project(connection, id, owner).await?;
    if project.schema_version != 1 || project.protocol_version != 1 {
        return Err(ApiError::UnsupportedSchema);
    }
    let (attempted, version): (i64, Option<i16>) = sqlx::query_as(
        "SELECT projection_attempt_sequence, projection_version FROM crdt_project WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&mut *connection)
    .await?;
    if !force && attempted == project.last_sequence && version == Some(VERSION) {
        return Ok(());
    }
    let status;
    let content = if project.validation == "quarantined" {
        status = "quarantined";
        None
    } else if project.last_sequence == 0 {
        status = "uninitialized";
        None
    } else {
        let bytes = updates::load(connection, id, project.last_sequence).await?;
        let content = updates::materialized(bytes).await?;
        status = if content.is_some() {
            "ready"
        } else {
            "pending_dependencies"
        };
        content
    };
    if let Some(content) = content {
        publish(connection, id, project.last_sequence, &content).await?;
    } else if force {
        // A repair cannot trust an older derived view when binary state is
        // incomplete. Clear caches only; every canonical byte stays intact.
        sqlx::query("DELETE FROM crdt_node_read WHERE project_id = $1")
            .bind(id)
            .execute(&mut *connection)
            .await?;
        sqlx::query("UPDATE crdt_project SET name = NULL, name_utf8 = NULL, node_count = NULL, projection_sequence = NULL WHERE id = $1")
            .bind(id).execute(&mut *connection).await?;
    }
    sqlx::query("UPDATE crdt_project SET projection_attempt_sequence = $2, projection_version = $3, projection_status = $4 WHERE id = $1")
        .bind(id).bind(project.last_sequence).bind(VERSION).bind(status).execute(connection).await?;
    Ok(())
}

async fn publish(
    connection: &mut PgConnection,
    id: Uuid,
    sequence: i64,
    content: &Content,
) -> Result<(), ApiError> {
    let placements = projection::project(content);
    sqlx::query("DELETE FROM crdt_node_read WHERE project_id = $1")
        .bind(id)
        .execute(&mut *connection)
        .await?;
    // 500 rows * 12 bindings stays below PostgreSQL's parameter limit.
    let nodes: Vec<_> = content.nodes.iter().collect();
    for chunk in nodes.chunks(500) {
        let mut query = QueryBuilder::<Postgres>::new(
            "INSERT INTO crdt_node_read (project_id, node_id, source_sequence, text, color, deleted, stored_parent, rank, position_x, position_y, effective_parent, sibling_order) ",
        );
        query.push_values(chunk, |mut row, (node_id, node)| {
            let effective = placements.get(*node_id);
            row.push_bind(id)
                .push_bind(Uuid::parse_str(node_id).unwrap())
                .push_bind(sequence)
                .push_bind(node.text.as_bytes())
                .push_bind(&node.color)
                .push_bind(node.deleted)
                .push_bind(
                    node.placement
                        .parent
                        .as_deref()
                        .map(|parent| Uuid::parse_str(parent).unwrap()),
                )
                .push_bind(&node.placement.rank)
                .push_bind(node.position.as_ref().map(|p| p.x))
                .push_bind(node.position.as_ref().map(|p| p.y))
                .push_bind(
                    effective
                        .and_then(|p| p.parent.as_deref())
                        .map(|parent| Uuid::parse_str(parent).unwrap()),
                )
                .push_bind(effective.map(|p| p.sibling_order));
        });
        query.build().execute(&mut *connection).await?;
    }
    sqlx::query("UPDATE crdt_project SET name = $2, node_count = $3, projection_sequence = $4, name_utf8 = $5 WHERE id = $1")
        .bind(id).bind((!content.metadata.name.contains('\0')).then_some(&content.metadata.name)).bind(placements.len() as i32).bind(sequence).bind(content.metadata.name.as_bytes()).execute(connection).await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct StoredNode {
    node_id: Uuid,
    text: Utf8Text,
    color: String,
    deleted: bool,
    stored_parent: Option<Uuid>,
    rank: String,
    position_x: Option<f64>,
    position_y: Option<f64>,
    effective_parent: Option<Uuid>,
    sibling_order: Option<i32>,
}

/// Catch up synchronously, then read summary and nodes in the same lock/snapshot.
/// A gapped document returns the last complete content with current=false.
pub(crate) async fn current_state(
    pool: &PgPool,
    owner: i64,
    id: Uuid,
) -> Result<CurrentState, ApiError> {
    let mut transaction = pool.begin().await?;
    refresh(&mut transaction, owner, id, false).await?;
    let freshness: Freshness = sqlx::query_as("SELECT last_sequence, projection_sequence AS source_sequence, projection_attempt_sequence AS attempted_sequence, projection_version, projection_status AS status, COALESCE(name_utf8, convert_to(name, 'UTF8')) AS name, node_count, to_char(content_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS content_updated_at FROM crdt_project WHERE id = $1")
        .bind(id).fetch_one(&mut *transaction).await?;
    let rows: Vec<StoredNode> = sqlx::query_as("SELECT node_id, text, color, deleted, stored_parent, rank, position_x, position_y, effective_parent, sibling_order FROM crdt_node_read WHERE project_id = $1")
        .bind(id).fetch_all(&mut *transaction).await?;
    let mut nodes = BTreeMap::new();
    let mut placements = BTreeMap::new();
    for node in rows {
        let id = node.node_id.to_string();
        if let Some(sibling_order) = node.sibling_order {
            placements.insert(
                id.clone(),
                EffectivePlacement {
                    parent: node.effective_parent.map(|p| p.to_string()),
                    sibling_order,
                },
            );
        }
        nodes.insert(
            id,
            Node {
                text: node.text.0,
                color: node.color,
                deleted: node.deleted,
                placement: Placement {
                    parent: node.stored_parent.map(|p| p.to_string()),
                    rank: node.rank,
                },
                position: node
                    .position_x
                    .zip(node.position_y)
                    .map(|(x, y)| Position { x, y }),
            },
        );
    }
    let content = freshness
        .source_sequence
        .and_then(|_| freshness.name.clone())
        .map(|name| Content {
            schema_version: 1,
            metadata: Metadata { name: name.0 },
            nodes,
        });
    let current =
        freshness.status == "ready" && freshness.source_sequence == Some(freshness.last_sequence);
    transaction.commit().await?;
    Ok(CurrentState {
        project_id: id,
        schema_version: 1,
        current,
        freshness,
        content,
        placements,
    })
}

pub(crate) async fn rebuild_project(pool: &PgPool, owner: i64, id: Uuid) -> Result<(), ApiError> {
    let mut transaction = pool.begin().await?;
    refresh(&mut transaction, owner, id, true).await?;
    transaction.commit().await?;
    Ok(())
}

/// Keyset pagination bounds memory and lets the repair command continue across
/// failures. Re-run safely; each project is an independent atomic publication.
pub(crate) async fn rebuild_all(pool: &PgPool) -> Result<(), ApiError> {
    let mut after: Option<Uuid> = None;
    let mut failed = false;
    loop {
        let projects: Vec<(Uuid, i64)> = sqlx::query_as("SELECT id, owner_id FROM crdt_project WHERE ($1::UUID IS NULL OR id > $1) ORDER BY id LIMIT 50")
            .bind(after).fetch_all(pool).await?;
        if projects.is_empty() {
            break;
        }
        for (id, owner) in projects {
            after = Some(id);
            if let Err(error) = rebuild_project(pool, owner, id).await {
                eprintln!("Read-model rebuild failed for project {id}: {error:?}");
                failed = true;
            }
        }
    }
    if failed {
        Err(ApiError::Unavailable)
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) async fn catch_up(pool: &PgPool) -> Result<(), ApiError> {
    catch_up_page(pool, None).await.map(|_| ())
}

async fn catch_up_page(pool: &PgPool, after: Option<Uuid>) -> Result<Option<Uuid>, ApiError> {
    let projects: Vec<(Uuid, i64)> = sqlx::query_as("SELECT id, owner_id FROM crdt_project WHERE last_sequence > 0 AND (projection_attempt_sequence < last_sequence OR projection_version IS DISTINCT FROM $1) AND ($2::UUID IS NULL OR id > $2) ORDER BY id LIMIT 50")
        .bind(VERSION).bind(after).fetch_all(pool).await?;
    let next = projects.last().map(|(id, _)| *id);
    for (id, owner) in projects {
        let mut transaction = pool.begin().await?;
        match refresh(&mut transaction, owner, id, false).await {
            Ok(()) => {
                if transaction.commit().await.is_err() {
                    eprintln!(
                        "Read-model publication failed for project {id}; retrying next sweep"
                    );
                }
            }
            Err(error) => {
                eprintln!("Read-model catch-up failed for project {id}: {error:?}");
            }
        }
    }
    Ok(next)
}

pub(crate) fn start_worker(pool: PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut after = None;
        loop {
            interval.tick().await;
            match catch_up_page(&pool, after).await {
                Ok(next) => after = next,
                Err(_) => eprintln!("Read-model worker unavailable; retrying next poll"),
            }
        }
    });
}

#[cfg(test)]
mod tests;
