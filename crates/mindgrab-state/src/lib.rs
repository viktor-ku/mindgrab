//! Shared Mindgrab document behavior, compiled natively and to WebAssembly.
#![doc = include_str!("../README.md")]

mod model;
#[cfg(target_arch = "wasm32")]
mod wasm;

use loro::{
    CommitOptions, Container, ContainerTrait, ExportMode, LoroDoc, LoroMap, LoroText, LoroTree,
    ToJson, TreeID, UndoManager, ValueOrContainer,
};
use loro_internal::cursor::{Cursor, Side};
pub use model::*;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StateError {
    #[error("{0}")]
    Invalid(String),
    #[error("Unknown or deleted node: {0}")]
    MissingNode(String),
    #[error("The document exceeds a resource limit")]
    ResourceLimit,
    #[error("The update needs missing dependencies; send a complete snapshot")]
    MissingDependencies,
    #[error(transparent)]
    Loro(#[from] loro::LoroError),
    #[error(transparent)]
    Encode(#[from] loro::LoroEncodeError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, StateError>;

/// Owns the CRDT and all document rules. No DOM, HTTP, or storage dependencies.
pub struct Project {
    doc: LoroDoc,
    undo: UndoManager,
}

impl Project {
    pub fn new(name: &str) -> Result<Self> {
        validate_name(name)?;
        let doc = LoroDoc::new();
        let meta = doc.get_map("project");
        meta.insert("format", FORMAT)?;
        meta.insert("schemaVersion", SCHEMA_VERSION)?;
        meta.insert("name", name)?;
        meta.insert("saving", loro::loro_value!({"local": true, "cloud": true}))?;
        doc.commit();
        Self::bind(doc)
    }

    pub fn from_snapshot(bytes: &[u8]) -> Result<Self> {
        check_size(bytes)?;
        let doc = LoroDoc::new();
        let status = doc.import(bytes)?;
        if status.pending.is_some() {
            return Err(StateError::MissingDependencies);
        }
        let project = Self::bind(doc)?;
        project.view()?;
        Ok(project)
    }

    fn bind(doc: LoroDoc) -> Result<Self> {
        // Jitter is configuration, not a document edit. Both targets enable it.
        doc.get_tree("nodes").enable_fractional_index(8);
        let mut undo = UndoManager::new(&doc);
        undo.add_exclude_origin_prefix("preferences");
        Ok(Self { doc, undo })
    }

    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let bytes = self.doc.export(ExportMode::Snapshot)?;
        check_size(&bytes)?;
        Ok(bytes)
    }

    /// Validate on a disposable replica first, so rejected input cannot mutate
    /// the accepted document or its local undo history.
    pub fn merge(&mut self, bytes: &[u8]) -> Result<()> {
        check_size(bytes)?;
        let candidate = Self::from_snapshot(&self.snapshot()?)?;
        let status = candidate.doc.import(bytes)?;
        if status.pending.is_some() {
            return Err(StateError::MissingDependencies);
        }
        candidate.view()?;
        candidate.snapshot()?;
        self.doc.import(bytes)?;
        Ok(())
    }

    pub fn version(&self) -> Vec<u8> {
        let ordered: std::collections::BTreeMap<_, _> = self
            .doc
            .oplog_vv()
            .iter()
            .map(|(peer, counter)| (*peer, *counter))
            .collect();
        serde_json::to_vec(&ordered).expect("integer version vector")
    }
    pub fn start_group(&mut self) -> Result<()> {
        self.undo.group_start()?;
        Ok(())
    }
    pub fn stop_group(&mut self) {
        self.undo.group_end();
    }
    pub fn clear_history(&mut self) {
        self.undo.clear();
    }
    pub fn undo_count(&self) -> usize {
        self.undo.undo_count()
    }
    pub fn redo_count(&self) -> usize {
        self.undo.redo_count()
    }

    pub fn cursor(&self, id: &str, index: usize, after: bool) -> Result<Vec<u8>> {
        let text = self.text(id)?;
        let value = text.to_string();
        let index = cursor_index(&value, index)?;
        let cursor = if after {
            text.get_cursor(index, Side::Left)
        } else if index == 0 {
            Some(Cursor::new(None, text.id(), Side::Left, 0))
        } else {
            text.get_cursor(index - 1, Side::Right)
        };
        cursor
            .map(|c| c.encode())
            .ok_or_else(|| StateError::Invalid("Invalid cursor".into()))
    }
    pub fn resolve_cursor(&self, id: &str, bytes: &[u8]) -> Result<usize> {
        let cursor =
            Cursor::decode(bytes).map_err(|_| StateError::Invalid("Invalid cursor".into()))?;
        let text = self.text(id)?;
        let position = self
            .doc
            .get_cursor_pos(&cursor)
            .map_err(|_| StateError::Invalid("Cursor no longer exists".into()))?;
        // Our Rust crate uses Loro's Unicode event indexing on both targets.
        let index = position.current.pos + usize::from(position.current.side == Side::Right);
        Ok(text
            .to_string()
            .chars()
            .take(index)
            .map(char::len_utf16)
            .sum())
    }
    /// Apply a textarea edit against the exact document the user saw. Stable
    /// cursors rebase an IME draft over remote changes received while composing.
    pub fn edit_draft(&mut self, id: &str, base: &[u8], next: &str, caret: usize) -> Result<usize> {
        let source = Self::from_snapshot(base)?;
        let old = source.text(id)?.to_string();
        let (index, delete, insert) = text_diff(&old, next, Some(caret));
        let start = self.resolve_cursor(id, &source.cursor(id, index, true)?)?;
        let end = if delete == 0 {
            start
        } else {
            self.resolve_cursor(id, &source.cursor(id, index + delete, false)?)?
        };
        let inserted = insert.encode_utf16().count();
        self.apply(Command::EditText {
            id: id.into(),
            index: start,
            delete_count: end.saturating_sub(start),
            insert,
        })?;
        Ok(start + inserted)
    }

    pub fn can_undo(&self) -> bool {
        self.undo.can_undo()
    }
    pub fn can_redo(&self) -> bool {
        self.undo.can_redo()
    }

    pub fn apply_json(&mut self, command: &str) -> Result<CommandResult> {
        self.apply(serde_json::from_str(command)?)
    }

    pub fn apply(&mut self, command: Command) -> Result<CommandResult> {
        let before = self.doc.oplog_vv();
        let tree = self.tree();
        let mut created_node = None;
        let mut origin = "command";
        match command {
            Command::Rename { name } => {
                validate_name(&name)?;
                let meta = self.doc.get_map("project");
                if meta.get_deep_value().to_json_value()["name"] != name {
                    meta.insert("name", name)?;
                }
            }
            Command::CreateNode {
                parent,
                index,
                text,
                color,
            } => {
                validate_text(&text)?;
                if tree.nodes().len() >= MAX_NODES {
                    return Err(StateError::ResourceLimit);
                }
                let parent = self.parent(parent.as_deref())?;
                let count = tree.children(parent).unwrap_or_default().len();
                let index = index.unwrap_or(count);
                if index > count {
                    return invalid("The insertion index is outside the siblings");
                }
                let id = tree.create_at(parent, index)?;
                let meta = tree.get_meta(id)?;
                meta.insert("id", id.to_string())?;
                meta.insert("color", color.as_str())?;
                meta.insert_container("text", LoroText::new())?
                    .insert(0, &text)?;
                created_node = Some(id.to_string());
            }
            Command::CreateSibling { id, text, color } => {
                let id = self.node(&id)?;
                let parent = tree.parent(id).and_then(|p| p.tree_id());
                let siblings = tree.children(parent).unwrap_or_default();
                let index = siblings.iter().position(|n| *n == id).unwrap() + 1;
                return self.apply(Command::CreateNode {
                    parent: parent.map(|p| self.stable_id(p)).transpose()?,
                    index: Some(index),
                    text,
                    color,
                });
            }
            Command::ReorderNode { id, direction } => {
                if direction != -1 && direction != 1 {
                    return invalid("Invalid reorder direction");
                }
                let node = self.node(&id)?;
                let parent = tree.parent(node).and_then(|p| p.tree_id());
                let siblings = tree.children(parent).unwrap_or_default();
                let index =
                    siblings.iter().position(|n| *n == node).unwrap() as i64 + i64::from(direction);
                if index < 0 || index >= siblings.len() as i64 {
                    return Ok(CommandResult {
                        created_node: None,
                        changed: false,
                    });
                }
                return self.apply(Command::MoveNode {
                    id,
                    parent: parent.map(|p| self.stable_id(p)).transpose()?,
                    index: index as usize,
                });
            }
            Command::ColorBranch { id, color } => {
                for node in self.subtree(&id)? {
                    if self.node_data(node)?.1 != color {
                        tree.get_meta(node)?.insert("color", color.as_str())?;
                    }
                }
            }
            Command::TranslateSubtree {
                id,
                positions,
                delta,
            } => {
                validate_position(delta)?;
                let changes: Vec<_> = self
                    .subtree(&id)?
                    .into_iter()
                    .filter_map(|node| {
                        positions.get(&self.stable_id(node).unwrap()).map(|p| {
                            (
                                node,
                                Position {
                                    x: p.x + delta.x,
                                    y: p.y + delta.y,
                                },
                            )
                        })
                    })
                    .collect();
                for (_, position) in &changes {
                    validate_position(*position)?;
                }
                for (node, position) in changes {
                    tree.get_meta(node)?.insert(
                        "position",
                        loro::loro_value!({"x": position.x, "y": position.y}),
                    )?;
                }
            }
            Command::MoveNode { id, parent, index } => {
                let id = self.node(&id)?;
                let parent = self.parent(parent.as_deref())?;
                let mut cursor = parent;
                while let Some(ancestor) = cursor {
                    if ancestor == id {
                        return invalid("A node cannot move beneath itself or its descendants");
                    }
                    cursor = tree.parent(ancestor).and_then(|p| p.tree_id());
                }
                let siblings = tree.children(parent).unwrap_or_default();
                let remaining = siblings.iter().filter(|sibling| **sibling != id).count();
                if index > remaining {
                    return invalid("The move index is outside the siblings");
                }
                if tree.parent(id).and_then(|p| p.tree_id()) != parent
                    || siblings.iter().position(|n| *n == id) != Some(index)
                {
                    tree.mov_to(id, parent, index)?;
                }
            }
            Command::DeleteNode { id } => {
                tree.delete(self.node(&id)?)?;
            }
            Command::SetText { id, text } => {
                validate_text(&text)?;
                let shared = self.text(&id)?;
                // Compute the smallest contiguous replacement in Rust. Unicode
                // scalar boundaries prevent splitting a browser UTF-16 surrogate.
                let current = shared.to_string();
                let (start, delete, insert) = text_diff(&current, &text, None);
                edit_text(&shared, start, delete, &insert)?;
            }
            Command::EditText {
                id,
                index,
                delete_count,
                insert,
            } => {
                edit_text(&self.text(&id)?, index, delete_count, &insert)?;
            }
            Command::SetColor { id, color } => {
                let node = self.node(&id)?;
                if self.node_data(node)?.1 != color {
                    tree.get_meta(node)?.insert("color", color.as_str())?;
                }
            }
            Command::SetPosition { id, position } => {
                let meta = tree.get_meta(self.node(&id)?)?;
                if let Some(position) = position {
                    validate_position(position)?;
                    meta.insert(
                        "position",
                        loro::loro_value!({"x": position.x, "y": position.y}),
                    )?;
                } else {
                    meta.delete("position")?;
                }
            }
            Command::SetSaving { local, cloud } => {
                origin = "preferences";
                let meta = self.doc.get_map("project");
                let next = loro::loro_value!({"local": local, "cloud": cloud});
                if meta.get_deep_value().to_json_value()["saving"] != next.to_json_value() {
                    meta.insert("saving", next)?;
                }
            }
            Command::Undo => {
                self.undo.undo()?;
            }
            Command::Redo => {
                self.undo.redo()?;
            }
        }
        self.doc.commit_with(CommitOptions::new().origin(origin));
        Ok(CommandResult {
            created_node,
            changed: before != self.doc.oplog_vv(),
        })
    }

    /// Validate stored types, including hidden/deleted nodes, then produce the
    /// visible tree in sibling order. Loro owns concurrent move/cycle resolution.
    pub fn view(&self) -> Result<ProjectView> {
        let roots = self.doc.get_value().to_json_value();
        let root = roots
            .as_object()
            .ok_or_else(|| StateError::Invalid("Expected document roots".into()))?;
        if root.keys().any(|key| key != "project" && key != "nodes") {
            return invalid("Unexpected document root");
        }
        if !matches!(
            self.doc.get_by_str_path("project"),
            Some(ValueOrContainer::Container(Container::Map(_)))
        ) {
            return invalid("Expected project metadata map");
        }
        if root.contains_key("nodes")
            && !matches!(
                self.doc.get_by_str_path("nodes"),
                Some(ValueOrContainer::Container(Container::Tree(_)))
            )
        {
            return invalid("Expected a movable node tree");
        }
        let meta = self.doc.get_map("project").get_deep_value().to_json_value();
        let fields = meta
            .as_object()
            .ok_or_else(|| StateError::Invalid("Expected metadata".into()))?;
        if fields.len() != 4
            || fields
                .keys()
                .any(|key| !["format", "schemaVersion", "name", "saving"].contains(&key.as_str()))
        {
            return invalid("Unexpected project metadata");
        }
        if meta["format"] != FORMAT || meta["schemaVersion"] != SCHEMA_VERSION {
            return invalid("Unsupported document format or schema version");
        }
        let name = meta["name"]
            .as_str()
            .ok_or_else(|| StateError::Invalid("Expected project name".into()))?;
        validate_name(name)?;
        let saving: SavingPreferences = serde_json::from_value(meta["saving"].clone())?;
        let tree = self.tree();
        let all = tree.nodes();
        if all.len() > MAX_NODES {
            return Err(StateError::ResourceLimit);
        }
        for id in all {
            self.node_data(id)?;
        }
        let root_ids = tree.roots();
        let mut pending: Vec<(TreeID, usize)> = root_ids.iter().rev().map(|id| (*id, 0)).collect();
        let mut nodes = Vec::new();
        let mut seen = std::collections::HashSet::new();
        while let Some((id, depth)) = pending.pop() {
            let stable = self.stable_id(id)?;
            // Concurrent undo can recreate the same application node twice.
            // Choose the first visible branch in Loro's deterministic order.
            if !seen.insert(stable.clone()) {
                continue;
            }
            let (text, color, position) = self.node_data(id)?;
            let children = tree.children(id).unwrap_or_default();
            pending.extend(children.iter().rev().map(|child| (*child, depth + 1)));
            nodes.push(Node {
                id: stable,
                parent: tree
                    .parent(id)
                    .and_then(|p| p.tree_id())
                    .map(|id| self.stable_id(id))
                    .transpose()?,
                children: Vec::new(),
                text,
                color,
                position,
                depth,
            });
        }
        let indices: std::collections::HashMap<_, _> = nodes
            .iter()
            .enumerate()
            .map(|(index, node)| (node.id.clone(), index))
            .collect();
        let edges: Vec<_> = nodes
            .iter()
            .filter_map(|node| {
                node.parent
                    .as_ref()
                    .map(|parent| (parent.clone(), node.id.clone()))
            })
            .collect();
        for (parent, child) in edges {
            if let Some(index) = indices.get(&parent) {
                nodes[*index].children.push(child);
            }
        }
        let roots = nodes
            .iter()
            .filter(|node| node.parent.is_none())
            .map(|node| node.id.clone())
            .collect();
        Ok(ProjectView {
            format: FORMAT.into(),
            schema_version: SCHEMA_VERSION,
            name: name.into(),
            saving,
            roots,
            nodes,
        })
    }

    fn node_data(&self, id: TreeID) -> Result<(String, Color, Option<Position>)> {
        let meta = self.tree().get_meta(id)?;
        let value = meta.get_deep_value().to_json_value();
        let fields = value
            .as_object()
            .ok_or_else(|| StateError::Invalid("Expected node metadata".into()))?;
        if fields
            .keys()
            .any(|key| !["id", "text", "color", "position"].contains(&key.as_str()))
        {
            return invalid("Unexpected node metadata");
        }
        self.stable_id(id)?;
        let text = shared_text(&meta)?.to_string();
        validate_text(&text)?;
        let color: Color = serde_json::from_value(value["color"].clone())?;
        let position: Option<Position> = value
            .get("position")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?;
        if let Some(position) = position {
            validate_position(position)?;
        }
        Ok((text, color, position))
    }

    fn subtree(&self, id: &str) -> Result<Vec<TreeID>> {
        let mut nodes = vec![self.node(id)?];
        let mut index = 0;
        while index < nodes.len() {
            nodes.extend(self.tree().children(nodes[index]).unwrap_or_default());
            index += 1;
        }
        Ok(nodes)
    }

    fn tree(&self) -> LoroTree {
        self.doc.get_tree("nodes")
    }
    fn stable_id(&self, id: TreeID) -> Result<String> {
        let value = self.tree().get_meta(id)?.get_deep_value().to_json_value();
        let stable = value["id"]
            .as_str()
            .ok_or_else(|| StateError::Invalid("Missing stable node ID".into()))?;
        TreeID::try_from(stable)
            .map_err(|_| StateError::Invalid("Invalid stable node ID".into()))?;
        Ok(stable.into())
    }
    fn node(&self, value: &str) -> Result<TreeID> {
        let tree = self.tree();
        let mut pending = tree.roots();
        pending.reverse();
        let mut seen = std::collections::HashSet::new();
        while let Some(node) = pending.pop() {
            let stable = self.stable_id(node)?;
            if !seen.insert(stable.clone()) {
                continue;
            }
            if stable == value {
                return Ok(node);
            }
            pending.extend(tree.children(node).unwrap_or_default().iter().rev());
        }
        Err(StateError::MissingNode(value.into()))
    }
    fn parent(&self, value: Option<&str>) -> Result<Option<TreeID>> {
        value.map(|value| self.node(value)).transpose()
    }
    fn text(&self, value: &str) -> Result<LoroText> {
        shared_text(&self.tree().get_meta(self.node(value)?)?)
    }
}

fn shared_text(meta: &LoroMap) -> Result<LoroText> {
    match meta.get("text") {
        Some(ValueOrContainer::Container(Container::Text(text))) => Ok(text),
        _ => invalid("Expected shared node text"),
    }
}
fn invalid<T>(message: &str) -> Result<T> {
    Err(StateError::Invalid(message.into()))
}
fn check_size(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        Err(StateError::ResourceLimit)
    } else {
        Ok(())
    }
}
fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        return invalid("Project name cannot be blank");
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(StateError::ResourceLimit);
    }
    Ok(())
}
fn validate_text(text: &str) -> Result<()> {
    if text.encode_utf16().count() > MAX_TEXT_UTF16 {
        Err(StateError::ResourceLimit)
    } else {
        Ok(())
    }
}
fn validate_position(position: Position) -> Result<()> {
    if position.x.is_finite() && position.y.is_finite() {
        Ok(())
    } else {
        invalid("Position must contain finite coordinates")
    }
}
fn edit_text(text: &LoroText, index: usize, delete: usize, insert: &str) -> Result<()> {
    let end = index
        .checked_add(delete)
        .ok_or_else(|| StateError::Invalid("Invalid text range".into()))?;
    let current = text.to_string();
    let mut boundaries = std::collections::HashSet::from([0]);
    let mut length = 0;
    for ch in current.chars() {
        length += ch.len_utf16();
        boundaries.insert(length);
    }
    if !boundaries.contains(&index) || !boundaries.contains(&end) {
        return invalid("Text range must be on UTF-16 character boundaries");
    }
    if length - delete + insert.encode_utf16().count() > MAX_TEXT_UTF16 {
        return Err(StateError::ResourceLimit);
    }
    if current
        .encode_utf16()
        .skip(index)
        .take(delete)
        .eq(insert.encode_utf16())
    {
        return Ok(());
    }
    if delete > 0 {
        text.delete_utf16(index, delete)?;
    }
    if !insert.is_empty() {
        text.insert_utf16(index, insert)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;

fn cursor_index(value: &str, index: usize) -> Result<usize> {
    let mut offset = 0;
    let mut scalars = 0;
    for character in value.chars() {
        if offset == index {
            break;
        }
        offset += character.len_utf16();
        scalars += 1;
    }
    if offset != index {
        return invalid("Cursor splits a surrogate or exceeds the text");
    }
    Ok(scalars)
}

fn text_diff(old: &str, new: &str, caret: Option<usize>) -> (usize, usize, String) {
    let old: Vec<char> = old.chars().collect();
    let new: Vec<char> = new.chars().collect();
    let mut prefix = 0;
    let mut suffix = 0;
    if let Some(caret) = caret {
        let limit = new
            .iter()
            .map(|c| c.len_utf16())
            .sum::<usize>()
            .saturating_sub(caret);
        let mut units = 0;
        while suffix < old.len().min(new.len())
            && old[old.len() - suffix - 1] == new[new.len() - suffix - 1]
            && units + new[new.len() - suffix - 1].len_utf16() <= limit
        {
            units += new[new.len() - suffix - 1].len_utf16();
            suffix += 1;
        }
    }
    while prefix < old.len().min(new.len()) - suffix && old[prefix] == new[prefix] {
        prefix += 1;
    }
    if caret.is_none() {
        while suffix < old.len().min(new.len()) - prefix
            && old[old.len() - suffix - 1] == new[new.len() - suffix - 1]
        {
            suffix += 1;
        }
    }
    (
        old[..prefix].iter().map(|c| c.len_utf16()).sum(),
        old[prefix..old.len() - suffix]
            .iter()
            .map(|c| c.len_utf16())
            .sum(),
        new[prefix..new.len() - suffix].iter().collect(),
    )
}
