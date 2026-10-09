use serde::{Deserialize, Serialize};

pub const FORMAT: &str = "mindgrab-loro-v1";
pub const SCHEMA_VERSION: i64 = 1;
pub const MAX_NODES: usize = 10_000;
pub const MAX_TEXT_UTF16: usize = 65_536;
pub const MAX_NAME_BYTES: usize = 200;
pub const MAX_SNAPSHOT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Color {
    #[default]
    Blue,
    Teal,
    Green,
    Amber,
    Orange,
    Rose,
    Violet,
    Slate,
}

impl Color {
    pub fn as_str(self) -> &'static str {
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

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct SavingPreferences {
    pub local: bool,
    pub cloud: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub parent: Option<String>,
    pub children: Vec<String>,
    pub text: String,
    pub color: Color,
    pub position: Option<Position>,
    pub depth: usize,
}

/// A flat, ordered projection avoids recursion even for very deep documents.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub format: String,
    #[cfg_attr(feature = "bindings", ts(type = "number"))]
    pub schema_version: i64,
    pub name: String,
    pub saving: SavingPreferences,
    pub roots: Vec<String>,
    pub nodes: Vec<Node>,
}

/// Commands are the shared application API. UI code sends intent to Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Rename {
        name: String,
    },
    CreateNode {
        parent: Option<String>,
        index: Option<usize>,
        text: String,
        #[serde(default)]
        color: Color,
    },
    CreateSibling {
        id: String,
        text: String,
        color: Color,
    },
    ReorderNode {
        id: String,
        direction: i32,
    },
    ColorBranch {
        id: String,
        color: Color,
    },
    TranslateSubtree {
        id: String,
        positions: std::collections::BTreeMap<String, Position>,
        delta: Position,
    },
    MoveNode {
        id: String,
        parent: Option<String>,
        index: usize,
    },
    DeleteNode {
        id: String,
    },
    SetText {
        id: String,
        text: String,
    },
    EditText {
        id: String,
        index: usize,
        delete_count: usize,
        insert: String,
    },
    SetColor {
        id: String,
        color: Color,
    },
    SetPosition {
        id: String,
        position: Option<Position>,
    },
    SetSaving {
        local: bool,
        cloud: bool,
    },
    Undo,
    Redo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub created_node: Option<String>,
    pub changed: bool,
}
