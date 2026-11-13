use serde::{Deserialize, Serialize};

pub const FORMAT: &str = "mindgrab-loro-v1";
pub const SCHEMA_VERSION: i64 = 1;
pub const MAX_NODES: usize = 10_000;
pub const MAX_TEXT_UTF16: usize = 65_536;
pub const MAX_NAME_BYTES: usize = 200;
pub const MAX_SNAPSHOT_BYTES: usize = 10 * 1024 * 1024;

/// Tailwind's hue families, in the order of its palette.
pub const COLOR_FAMILIES: [&str; 26] = [
    "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
    "indigo", "violet", "purple", "fuchsia", "pink", "rose", "slate", "gray", "zinc", "neutral",
    "stone", "mauve", "olive", "mist", "taupe",
];
/// Tailwind's shades of each family, lightest first.
pub const COLOR_SHADES: [u16; 11] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
/// The colors ideas had before Tailwind shades. Each keeps its own look: a
/// light card, and a strong fill on a central idea.
pub const NAMED_COLORS: [&str; 8] = [
    "blue", "teal", "green", "amber", "orange", "rose", "violet", "slate",
];

/// An idea's color: one of the named colors, or one Tailwind shade such as
/// `sky-400` that fills the card exactly. Stored as that text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum Color {
    Named(u8),
    Shade { family: u8, shade: u8 },
}

impl Color {
    pub const BLUE: Self = Self::Named(0);
    pub const TEAL: Self = Self::Named(1);
    pub const GREEN: Self = Self::Named(2);
    pub const AMBER: Self = Self::Named(3);
    pub const ORANGE: Self = Self::Named(4);
    pub const ROSE: Self = Self::Named(5);
    pub const VIOLET: Self = Self::Named(6);
    pub const SLATE: Self = Self::Named(7);

    /// A Tailwind shade, such as `Color::shade("sky", 400)`.
    pub fn shade(family: &str, shade: u16) -> Option<Self> {
        Some(Self::Shade {
            family: COLOR_FAMILIES.iter().position(|f| *f == family)? as u8,
            shade: COLOR_SHADES.iter().position(|s| *s == shade)? as u8,
        })
    }
}

impl Color {
    /// Whether a person can choose it now: white (the `slate` card) or a
    /// shade. The other named colors only stay on ideas that already have
    /// them.
    pub fn is_pickable(self) -> bool {
        self == Self::SLATE || matches!(self, Self::Shade { .. })
    }
}

/// The colors a map offers at once in its style panel, before any are chosen:
/// white, then light red, green, blue and yellow.
pub const DEFAULT_QUICK_COLORS: [&str; 5] =
    ["slate", "red-200", "green-200", "blue-200", "yellow-200"];

/// A map's color choices: the quick colors in their order, and the color new
/// ideas start with. Maps that never set them use the defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColorPreferences {
    #[cfg_attr(feature = "bindings", ts(type = "Array<Color>"))]
    pub quick: Vec<Color>,
    #[cfg_attr(feature = "bindings", ts(type = "Color"))]
    pub new_ideas: Color,
}

impl Default for ColorPreferences {
    fn default() -> Self {
        Self {
            quick: DEFAULT_QUICK_COLORS
                .iter()
                .map(|color| color.parse().expect("default colors are valid"))
                .collect(),
            new_ideas: Color::SLATE,
        }
    }
}

impl Default for Color {
    fn default() -> Self {
        Self::BLUE
    }
}

impl std::fmt::Display for Color {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match *self {
            Self::Named(index) => f.write_str(NAMED_COLORS[index as usize]),
            Self::Shade { family, shade } => write!(
                f,
                "{}-{}",
                COLOR_FAMILIES[family as usize], COLOR_SHADES[shade as usize]
            ),
        }
    }
}

impl std::str::FromStr for Color {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        let invalid = || format!("Invalid node color: {value}");
        if let Some(index) = NAMED_COLORS.iter().position(|name| *name == value) {
            return Ok(Self::Named(index as u8));
        }
        let (family, shade) = value.rsplit_once('-').ok_or_else(invalid)?;
        // Digits only, so "+400" or "0400" are not another spelling.
        if shade.is_empty() || shade.starts_with('0') || !shade.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(invalid());
        }
        let shade = shade.parse().map_err(|_| invalid())?;
        Self::shade(family, shade).ok_or_else(invalid)
    }
}

impl TryFrom<String> for Color {
    type Error = String;

    fn try_from(value: String) -> std::result::Result<Self, Self::Error> {
        value.parse()
    }
}

impl From<Color> for String {
    fn from(color: Color) -> Self {
        color.to_string()
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
    pub note: String,
    #[cfg_attr(feature = "bindings", ts(type = "Color"))]
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
    pub colors: ColorPreferences,
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
        #[cfg_attr(feature = "bindings", ts(type = "Color"))]
        color: Color,
    },
    CreateSibling {
        id: String,
        text: String,
        #[cfg_attr(feature = "bindings", ts(type = "Color"))]
        color: Color,
    },
    ReorderNode {
        id: String,
        direction: i32,
    },
    ColorBranch {
        id: String,
        #[cfg_attr(feature = "bindings", ts(type = "Color"))]
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
    SetNote {
        id: String,
        note: String,
    },
    EditNote {
        id: String,
        index: usize,
        delete_count: usize,
        insert: String,
    },
    SetColor {
        id: String,
        #[cfg_attr(feature = "bindings", ts(type = "Color"))]
        color: Color,
    },
    SetPosition {
        id: String,
        position: Option<Position>,
    },
    /// Not an edit: excluded from undo, like saving preferences.
    SetColors {
        #[cfg_attr(feature = "bindings", ts(type = "Array<Color>"))]
        quick: Vec<Color>,
        #[cfg_attr(feature = "bindings", ts(type = "Color"))]
        new_ideas: Color,
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
