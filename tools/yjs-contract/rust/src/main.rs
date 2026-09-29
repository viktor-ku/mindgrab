//! Line-oriented fixture worker, not an HTTP server or an untrusted-input gateway.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, BufRead, Write};
use yrs::types::ToJson;
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{Doc, Map, OffsetKind, Options, Out, ReadTxn, StateVector, Text, Transact, Update};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    updates: Vec<Vec<u8>>,
    #[serde(default)]
    batch: bool,
    edit: Option<Edit>,
    state_vector: Option<Vec<u8>>,
}
#[derive(Deserialize)]
struct Edit {
    node: String,
    index: u32,
    delete: u32,
    insert: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Content {
    schema_version: u8,
    metadata: Metadata,
    nodes: BTreeMap<String, Node>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    name: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Node {
    text: String,
    placement: Placement,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<Position>,
    color: String,
    deleted: bool,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Position {
    x: f64,
    y: f64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Placement {
    parent: Option<String>,
    rank: String,
}
#[derive(Serialize)]
struct ForestNode {
    id: String,
    text: String,
    color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<Position>,
    children: Vec<ForestNode>,
}
fn project(content: &Content) -> Vec<ForestNode> {
    let mut parents: BTreeMap<String, Option<String>> = content
        .nodes
        .iter()
        .filter(|(_, n)| !n.deleted)
        .map(|(id, n)| {
            (
                id.clone(),
                n.placement
                    .parent
                    .clone()
                    .filter(|p| content.nodes.get(p).is_some_and(|n| !n.deleted)),
            )
        })
        .collect();
    let mut done = BTreeSet::new();
    for start in parents.keys().cloned().collect::<Vec<_>>() {
        let mut path: Vec<String> = Vec::new();
        let mut seen: BTreeMap<String, usize> = BTreeMap::new();
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
    let mut children: BTreeMap<Option<String>, Vec<String>> = BTreeMap::new();
    for (id, parent) in parents {
        children.entry(parent).or_default().push(id);
    }
    for ids in children.values_mut() {
        ids.sort_by(|a, b| {
            content.nodes[a]
                .placement
                .rank
                .cmp(&content.nodes[b].placement.rank)
                .then(a.cmp(b))
        });
    }
    fn build(
        id: &str,
        content: &Content,
        children: &BTreeMap<Option<String>, Vec<String>>,
    ) -> ForestNode {
        let node = &content.nodes[id];
        ForestNode {
            id: id.into(),
            text: node.text.clone(),
            color: node.color.clone(),
            position: node.position.clone(),
            children: children
                .get(&Some(id.into()))
                .into_iter()
                .flatten()
                .map(|child| build(child, content, children))
                .collect(),
        }
    }
    children
        .get(&None)
        .into_iter()
        .flatten()
        .map(|id| build(id, content, &children))
        .collect()
}
fn run(request: Request) -> Result<Value, Box<dyn std::error::Error>> {
    let doc = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    // Bind the root type without creating/replacing nested content.
    let root = doc.get_or_insert_map("project");
    if request.batch {
        let mut txn = doc.transact_mut();
        for bytes in &request.updates {
            txn.apply_update(Update::decode_v1(bytes)?)?;
        }
    } else {
        for bytes in &request.updates {
            doc.transact_mut().apply_update(Update::decode_v1(bytes)?)?;
        }
    }
    if let Some(edit) = request.edit {
        let mut txn = doc.transact_mut();
        let Some(Out::YMap(nodes)) = root.get(&txn, "nodes") else {
            return Err("missing nodes".into());
        };
        let Some(Out::YMap(node)) = nodes.get(&txn, &edit.node) else {
            return Err("missing node".into());
        };
        let Some(Out::YText(text)) = node.get(&txn, "text") else {
            return Err("missing text".into());
        };
        if edit.index > text.len(&txn) || edit.delete > text.len(&txn) - edit.index {
            return Err("invalid text offset".into());
        }
        if edit.delete > 0 {
            text.remove_range(&mut txn, edit.index, edit.delete);
        }
        if !edit.insert.is_empty() {
            text.insert(&mut txn, edit.index, &edit.insert);
        }
    }
    let txn = doc.transact();
    let mut json = String::new();
    root.to_json(&txn).to_json(&mut json);
    let content: Content = serde_json::from_str(&json)?;
    if content.schema_version != 1 {
        return Err("unsupported schema".into());
    }
    let diff = match request.state_vector {
        Some(bytes) => Some(txn.encode_state_as_update_v1(&StateVector::decode_v1(&bytes)?)),
        None => None,
    };
    Ok(json!({
        "forest": project(&content), "content": content,
        "update": txn.encode_state_as_update_v1(&StateVector::default()),
        "stateVector": txn.state_vector().encode_v1(),
        "diff": diff, "pending": txn.has_missing_updates()
    }))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let response = match serde_json::from_str::<Request>(&line?) {
            Ok(request) => {
                run(request).unwrap_or_else(|error| json!({ "error": error.to_string() }))
            }
            Err(error) => json!({ "error": error.to_string() }),
        };
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}
