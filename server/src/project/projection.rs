//! Pure canonical DTO and tree projection shared with the JS/Rust fixture worker.
//! Never repair the CRDT: deleted/missing parents promote children, and the
//! bytewise smallest ID in each cycle becomes a root.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Content {
    pub schema_version: u8,
    pub metadata: Metadata,
    pub nodes: BTreeMap<String, Node>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub text: String,
    pub placement: Placement,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
    pub color: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    pub parent: Option<String>,
    pub rank: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePlacement {
    pub parent: Option<String>,
    pub sibling_order: i32,
}

/// Flat output stays bounded even for a 10,000-node chain. Ordering is ASCII
/// rank, then canonical UUID; SQL collation and hash iteration never decide it.
pub fn project(content: &Content) -> BTreeMap<String, EffectivePlacement> {
    let mut parents: BTreeMap<String, Option<String>> = content
        .nodes
        .iter()
        .filter(|(_, node)| !node.deleted)
        .map(|(id, node)| {
            (
                id.clone(),
                node.placement
                    .parent
                    .clone()
                    .filter(|parent| content.nodes.get(parent).is_some_and(|node| !node.deleted)),
            )
        })
        .collect();
    let mut done = BTreeSet::new();
    for start in parents.keys().cloned().collect::<Vec<_>>() {
        let mut path: Vec<String> = Vec::new();
        let mut seen = BTreeMap::new();
        let mut cursor = Some(start);
        while let Some(id) = cursor {
            if done.contains(&id) {
                break;
            }
            if let Some(&index) = seen.get(&id) {
                let smallest = path[index..].iter().min().unwrap().clone();
                parents.insert(smallest, None);
                break;
            }
            seen.insert(id.clone(), path.len());
            path.push(id.clone());
            cursor = parents[&id].clone();
        }
        done.extend(path);
    }
    let mut groups: BTreeMap<Option<String>, Vec<String>> = BTreeMap::new();
    for (id, parent) in parents {
        groups.entry(parent).or_default().push(id);
    }
    let mut result = BTreeMap::new();
    for (parent, mut ids) in groups {
        ids.sort_by(|a, b| {
            content.nodes[a]
                .placement
                .rank
                .cmp(&content.nodes[b].placement.rank)
                .then(a.cmp(b))
        });
        for (order, id) in ids.into_iter().enumerate() {
            result.insert(
                id,
                EffectivePlacement {
                    parent: parent.clone(),
                    sibling_order: order as i32,
                },
            );
        }
    }
    result
}
