//! How a person wants Mindgrab to work: how their maps look, where they are
//! saved, and whether usage is counted. Preferences belong to an account, not
//! to a map's document: each one is set for all of the account's maps or for
//! one map, and a map's own value wins over the one for all maps.

use crate::{Color, ColorPreferences, LinkStyle, Result, StateError};
use serde::{Deserialize, Serialize};

/// Which maps a preference applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PreferenceScope {
    /// Every map that does not set its own value.
    Global,
    /// One map, named by its project id.
    Map,
}

/// Every preference there is. Each has one type of value, in [`Preference`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PreferenceName {
    QuickColors,
    NewIdeaColor,
    LinkStyle,
    SaveLocally,
    SaveInCloud,
    AnalyticsConsent,
}

impl PreferenceName {
    pub const ALL: [Self; 6] = [
        Self::QuickColors,
        Self::NewIdeaColor,
        Self::LinkStyle,
        Self::SaveLocally,
        Self::SaveInCloud,
        Self::AnalyticsConsent,
    ];

    /// Whether a map can set it for itself. Consent to analytics is the
    /// person's, never one map's.
    pub fn per_map(self) -> bool {
        self != Self::AnalyticsConsent
    }
}

/// The answer to counting usage with cookies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum AnalyticsConsent {
    Granted,
    Denied,
}

/// A preference and its value, typed by its name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(tag = "name", content = "value", rename_all = "camelCase")]
pub enum Preference {
    /// The colors the style panel offers at once, in their order.
    QuickColors(#[cfg_attr(feature = "bindings", ts(type = "Array<Color>"))] Vec<Color>),
    /// The color a new idea starts with.
    NewIdeaColor(#[cfg_attr(feature = "bindings", ts(type = "Color"))] Color),
    /// How lines run from an idea to its children.
    LinkStyle(LinkStyle),
    /// Whether this browser keeps a copy of the map.
    SaveLocally(bool),
    /// Whether the account keeps the map in Mindgrab Cloud.
    SaveInCloud(bool),
    /// Whether usage may be counted with cookies.
    AnalyticsConsent(AnalyticsConsent),
}

impl Preference {
    pub fn name(&self) -> PreferenceName {
        match self {
            Self::QuickColors(_) => PreferenceName::QuickColors,
            Self::NewIdeaColor(_) => PreferenceName::NewIdeaColor,
            Self::LinkStyle(_) => PreferenceName::LinkStyle,
            Self::SaveLocally(_) => PreferenceName::SaveLocally,
            Self::SaveInCloud(_) => PreferenceName::SaveInCloud,
            Self::AnalyticsConsent(_) => PreferenceName::AnalyticsConsent,
        }
    }

    /// Colors are white or shades, and the quick colors each appear once.
    pub fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::QuickColors(colors) => {
                let mut seen = std::collections::HashSet::new();
                colors
                    .iter()
                    .all(|color| color.is_pickable() && seen.insert(*color))
            }
            Self::NewIdeaColor(color) => color.is_pickable(),
            Self::LinkStyle(_)
            | Self::SaveLocally(_)
            | Self::SaveInCloud(_)
            | Self::AnalyticsConsent(_) => true,
        };
        if valid {
            Ok(())
        } else {
            Err(StateError::Invalid("Invalid preference value".into()))
        }
    }
}

/// Which stored preference: its scope, the map for a map preference, and its
/// name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferenceTarget {
    pub scope: PreferenceScope,
    /// Set exactly when the scope is `map`.
    pub project_id: Option<String>,
    pub name: PreferenceName,
}

impl PreferenceTarget {
    /// A map preference names its map; a global one names none. Only
    /// preferences a map can set for itself are set for one.
    pub fn validate(&self) -> Result<()> {
        if (self.scope == PreferenceScope::Map) != self.project_id.is_some() {
            return Err(StateError::Invalid(
                "A map preference needs its map, and only it".into(),
            ));
        }
        if self.scope == PreferenceScope::Map && !self.name.per_map() {
            return Err(StateError::Invalid(
                "This preference is not set per map".into(),
            ));
        }
        Ok(())
    }
}

/// One stored preference with its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PreferenceRow {
    pub scope: PreferenceScope,
    pub project_id: Option<String>,
    #[serde(flatten)]
    pub preference: Preference,
}

impl PreferenceRow {
    pub fn target(&self) -> PreferenceTarget {
        PreferenceTarget {
            scope: self.scope,
            project_id: self.project_id.clone(),
            name: self.preference.name(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        self.target().validate()?;
        self.preference.validate()
    }
}

/// Colors and the connection style that a map from before preferences kept
/// in its document. They are read once, to become the map's preferences, and
/// then removed with `Command::ForgetLegacyPreferences`, along with where it
/// was saved, which every map now takes from its preferences instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LegacyPreferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "bindings", ts(optional))]
    pub colors: Option<ColorPreferences>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "bindings", ts(optional))]
    pub links: Option<LinkStyle>,
}
