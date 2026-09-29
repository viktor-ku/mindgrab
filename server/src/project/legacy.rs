//! Name-keyed snapshot persistence used by the current webapp.
//!
//! Fenced from the UUID catalog: these handlers only touch `project` and
//! `pnode`, never `crdt_project`, and are removed by the Yjs cutover.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use axum::{Json, Router, extract::State, routing::get};
use axum_extra::extract::cookie::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    auth::{AppState, authenticated_user},
    workos::AuthError,
};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/projects", get(list_projects).put(save_project))
}

#[derive(Serialize)]
struct ProjectRecord {
    name: String,
    state: Value,
    updated_at: String,
}

#[derive(Deserialize)]
struct ProjectState {
    version: u8,
    nodes: Vec<ProjectNode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    anchor: Option<ProjectAnchor>,
    view: ProjectView,
}

#[derive(Deserialize)]
struct ProjectNode {
    id: Uuid,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<NodeColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    position: Option<NodePosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next: Option<Vec<ProjectNode>>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum NodeColor {
    Blue,
    Teal,
    Green,
    Amber,
    Orange,
    Rose,
    Violet,
    Slate,
}

impl NodeColor {
    fn as_str(self) -> &'static str {
        match self {
            Self::Blue => "blue",
            Self::Teal => "teal",
            Self::Green => "green",
            Self::Amber => "amber",
            Self::Orange => "orange",
            Self::Rose => "rose",
            Self::Violet => "violet",
            Self::Slate => "slate",
        }
    }
}

#[derive(Deserialize)]
struct NodePosition {
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
struct ProjectAnchor {
    id: Uuid,
    #[serde(rename = "centerY")]
    center_y: f64,
}

#[derive(Deserialize)]
struct ProjectView {
    left: f64,
    top: f64,
    zoom: f64,
}

#[derive(Deserialize)]
struct SaveProject {
    name: String,
    state: Value,
}

#[derive(sqlx::FromRow)]
struct StoredProject {
    id: i64,
    name: String,
    state: Value,
    updated_at: String,
}

#[derive(sqlx::FromRow)]
struct StoredPNode {
    project_id: i64,
    id: Uuid,
    text: String,
    color: String,
    sort_order: i64,
    position_x: Option<f64>,
    position_y: Option<f64>,
    parent_pnode_id: Option<Uuid>,
}

#[derive(sqlx::FromRow)]
struct SavedProject {
    id: i64,
    updated_at: String,
}

struct NewPNode<'a> {
    node: &'a ProjectNode,
    parent_pnode_id: Option<Uuid>,
    sort_order: i64,
}

async fn list_projects(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<ProjectRecord>>, AuthError> {
    let user = authenticated_user(&state, &jar).await?;
    Ok(Json(load_projects(&state.pool, user.id).await?))
}

async fn save_project(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(project): Json<SaveProject>,
) -> Result<Json<ProjectRecord>, AuthError> {
    let user = authenticated_user(&state, &jar).await?;
    let name = project.name.trim();
    if name.is_empty() || name.len() > 200 {
        return Err(AuthError::BadRequest);
    }
    let state_value = project.state;
    let project_state: ProjectState =
        serde_json::from_value(state_value.clone()).map_err(|_| AuthError::BadRequest)?;
    if !valid_project_state(&project_state) {
        return Err(AuthError::BadRequest);
    }
    let mut state_metadata = state_value.clone();
    state_metadata
        .as_object_mut()
        .ok_or(AuthError::BadRequest)?
        .remove("nodes");

    let mut new_nodes = Vec::new();
    flatten_pnodes(&project_state.nodes, None, &mut new_nodes);
    let node_ids = new_nodes
        .iter()
        .map(|entry| entry.node.id)
        .collect::<Vec<_>>();
    let mut tx = state.pool.begin().await?;
    let saved: SavedProject = sqlx::query_as(
        "INSERT INTO project (user_id, name, state) VALUES ($1, $2, $3) ON CONFLICT (user_id, name) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW() RETURNING id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at",
    )
    .bind(user.id)
    .bind(name)
    .bind(state_metadata)
    .fetch_one(&mut *tx)
    .await?;

    for entry in &new_nodes {
        let position_x = entry.node.position.as_ref().map(|position| position.x);
        let position_y = entry.node.position.as_ref().map(|position| position.y);
        let color = entry.node.color.unwrap_or(NodeColor::Blue).as_str();
        sqlx::query(
            "INSERT INTO pnode (id, user_id, project_id, text, color, parent_pnode_id, sort_order, position_x, position_y) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (project_id, id) DO UPDATE SET text = EXCLUDED.text, color = EXCLUDED.color, parent_pnode_id = EXCLUDED.parent_pnode_id, sort_order = EXCLUDED.sort_order, position_x = EXCLUDED.position_x, position_y = EXCLUDED.position_y, updated_at = NOW()",
        )
        .bind(entry.node.id)
        .bind(user.id)
        .bind(saved.id)
        .bind(&entry.node.text)
        .bind(color)
        .bind(entry.parent_pnode_id)
        .bind(entry.sort_order)
        .bind(position_x)
        .bind(position_y)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query("DELETE FROM pnode WHERE project_id = $1 AND id <> ALL($2)")
        .bind(saved.id)
        .bind(node_ids)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(ProjectRecord {
        name: name.to_owned(),
        state: state_value,
        updated_at: saved.updated_at,
    }))
}

async fn load_projects(pool: &PgPool, user_id: i64) -> Result<Vec<ProjectRecord>, AuthError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let projects = sqlx::query_as::<_, StoredProject>(
        "SELECT id, name, state, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at FROM project WHERE user_id = $1 ORDER BY name",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    let pnodes = sqlx::query_as::<_, StoredPNode>(
        "SELECT project_id, id, text, color, sort_order, position_x, position_y, parent_pnode_id FROM pnode WHERE user_id = $1 ORDER BY project_id, parent_pnode_id NULLS FIRST, sort_order, id",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    let mut pnodes_by_project = HashMap::<i64, Vec<StoredPNode>>::new();
    for pnode in pnodes {
        pnodes_by_project
            .entry(pnode.project_id)
            .or_default()
            .push(pnode);
    }
    Ok(projects
        .into_iter()
        .map(|project| {
            let pnodes = pnodes_by_project.remove(&project.id).unwrap_or_default();
            project_record(project, pnodes)
        })
        .collect())
}

fn project_record(project: StoredProject, pnodes: Vec<StoredPNode>) -> ProjectRecord {
    let mut children_by_parent = HashMap::<Option<Uuid>, Vec<StoredPNode>>::new();
    for pnode in pnodes {
        children_by_parent
            .entry(pnode.parent_pnode_id)
            .or_default()
            .push(pnode);
    }
    let mut roots = children_by_parent.remove(&None).unwrap_or_default();
    roots.sort_by_key(|pnode| (pnode.sort_order, pnode.id));
    let nodes: Vec<Value> = roots
        .into_iter()
        .map(|root| project_node_value(root, &mut children_by_parent))
        .collect();
    let mut state = project.state;
    state["nodes"] = Value::Array(nodes);

    ProjectRecord {
        name: project.name,
        state,
        updated_at: project.updated_at,
    }
}

fn project_node_value(
    pnode: StoredPNode,
    children_by_parent: &mut HashMap<Option<Uuid>, Vec<StoredPNode>>,
) -> Value {
    let mut children = children_by_parent
        .remove(&Some(pnode.id))
        .unwrap_or_default();
    children.sort_by_key(|pnode| (pnode.sort_order, pnode.id));
    let next = children
        .into_iter()
        .map(|child| project_node_value(child, children_by_parent))
        .collect::<Vec<_>>();
    let position = pnode
        .position_x
        .zip(pnode.position_y)
        .map(|(x, y)| json!({"x": json_number(x), "y": json_number(y)}));
    let mut node = json!({"id": pnode.id.to_string(), "text": pnode.text});
    node["color"] = json!(pnode.color);
    if let Some(position) = position {
        node["position"] = position;
    }
    if !next.is_empty() {
        node["next"] = Value::Array(next);
    }
    node
}

fn json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value < i64::MAX as f64 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

fn valid_project_state(state: &ProjectState) -> bool {
    state.version == 1
        && state.view.left.is_finite()
        && state.view.top.is_finite()
        && state.view.zoom.is_finite()
        && (0.25..=2.5).contains(&state.view.zoom)
        && state
            .anchor
            .as_ref()
            .is_none_or(|anchor| !anchor.id.is_nil() && anchor.center_y.is_finite())
        && valid_pnodes(&state.nodes, 0, &mut HashSet::new())
}

fn valid_pnodes(nodes: &[ProjectNode], depth: usize, ids: &mut HashSet<Uuid>) -> bool {
    if depth >= 100 {
        return false;
    }
    nodes.iter().all(|node| {
        ids.insert(node.id)
            && node
                .position
                .as_ref()
                .is_none_or(|position| position.x.is_finite() && position.y.is_finite())
            && valid_pnodes(node.next.as_deref().unwrap_or_default(), depth + 1, ids)
    })
}

fn flatten_pnodes<'a>(
    nodes: &'a [ProjectNode],
    parent_pnode_id: Option<Uuid>,
    flattened: &mut Vec<NewPNode<'a>>,
) {
    for (sort_order, node) in nodes.iter().enumerate() {
        flattened.push(NewPNode {
            node,
            parent_pnode_id,
            sort_order: sort_order as i64,
        });
        flatten_pnodes(
            node.next.as_deref().unwrap_or_default(),
            Some(node.id),
            flattened,
        );
    }
}

#[cfg(test)]
mod tests;
