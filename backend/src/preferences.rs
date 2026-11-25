//! An account's preferences: how its maps look and where they are saved, for
//! all of them or for one, and its answer about analytics.
//! Values are typed by `mindgrab_state::Preference`; Postgres keeps them as
//! JSON beside their scope, map and name.

use crate::{
    auth::User,
    error::{ApiError, Result},
};
use mindgrab_state::{PreferenceName, PreferenceRow, PreferenceScope, PreferenceTarget};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

/// The most changes one request carries; browsers send at most a hundred.
const MAX_CHANGES: usize = 1000;
/// The most preferences one account keeps: five for each of ten thousand
/// maps, the most maps anyone has had by far.
const MAX_ROWS: i64 = 50_000;

/// Changes to an account's preferences, applied together.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Changes {
    #[serde(default)]
    set: Vec<PreferenceRow>,
    #[serde(default)]
    clear: Vec<PreferenceTarget>,
}

fn scope_text(scope: PreferenceScope) -> &'static str {
    match scope {
        PreferenceScope::Global => "global",
        PreferenceScope::Map => "map",
    }
}
fn name_text(name: PreferenceName) -> &'static str {
    match name {
        PreferenceName::QuickColors => "quick_colors",
        PreferenceName::NewIdeaColor => "new_idea_color",
        PreferenceName::LinkStyle => "link_style",
        PreferenceName::SaveLocally => "save_locally",
        PreferenceName::SaveInCloud => "save_in_cloud",
        PreferenceName::AnalyticsConsent => "analytics_consent",
    }
}
fn scope_from(text: &str) -> Option<PreferenceScope> {
    [PreferenceScope::Global, PreferenceScope::Map]
        .into_iter()
        .find(|scope| scope_text(*scope) == text)
}
fn name_from(text: &str) -> Option<PreferenceName> {
    PreferenceName::ALL
        .into_iter()
        .find(|name| name_text(*name) == text)
}

/// The map a target names, which must be a UUID exactly when it is a map's.
fn project(target: &PreferenceTarget) -> Result<Option<Uuid>> {
    target.validate().map_err(|_| ApiError::invalid())?;
    target
        .project_id
        .as_deref()
        .map(|id| Uuid::parse_str(id).map_err(|_| ApiError::invalid()))
        .transpose()
}

/// Every preference the account has set.
pub async fn list(pool: &PgPool, user: &User) -> Result<Value> {
    let rows: Vec<(String, Option<Uuid>, String, Value)> = sqlx::query_as(
        "SELECT scope::text,project_id,name::text,value FROM mindgrab_loro.preferences WHERE user_id=$1 ORDER BY id",
    )
    .bind(user.id)
    .fetch_all(pool)
    .await?;
    let preferences: Vec<PreferenceRow> = rows
        .into_iter()
        .filter_map(|(scope, project_id, name, value)| {
            // Only checked values are stored; one this version cannot read,
            // from a newer one, is left out rather than failing the rest.
            let name = serde_json::to_value(name_from(&name)?).ok()?;
            Some(PreferenceRow {
                scope: scope_from(&scope)?,
                project_id: project_id.map(|id| id.to_string()),
                preference: serde_json::from_value(json!({"name": name, "value": value})).ok()?,
            })
        })
        .collect();
    Ok(json!({ "preferences": preferences }))
}

/// Sets and clears preferences in one transaction, after checking all of them.
pub async fn change(pool: &PgPool, user: &User, changes: Changes) -> Result<()> {
    if changes.set.len() + changes.clear.len() > MAX_CHANGES {
        return Err(ApiError::invalid());
    }
    let mut set = Vec::with_capacity(changes.set.len());
    for row in &changes.set {
        row.validate().map_err(|_| ApiError::invalid())?;
        let mut value = serde_json::to_value(&row.preference).map_err(|_| ApiError::invalid())?;
        let value = value["value"].take();
        set.push((row.target(), project(&row.target())?, value));
    }
    let mut clear = Vec::with_capacity(changes.clear.len());
    for target in &changes.clear {
        clear.push((target, project(target)?));
    }
    let mut tx = pool.begin().await?;
    for (target, project_id) in clear {
        sqlx::query("DELETE FROM mindgrab_loro.preferences WHERE user_id=$1 AND scope=$2::text::mindgrab_loro.preference_scope AND project_id IS NOT DISTINCT FROM $3 AND name=$4::text::mindgrab_loro.preference_name")
            .bind(user.id)
            .bind(scope_text(target.scope))
            .bind(project_id)
            .bind(name_text(target.name))
            .execute(&mut *tx)
            .await?;
    }
    for (target, project_id, value) in set {
        sqlx::query("INSERT INTO mindgrab_loro.preferences(user_id,scope,project_id,name,value) VALUES($1,$2::text::mindgrab_loro.preference_scope,$3,$4::text::mindgrab_loro.preference_name,$5) ON CONFLICT (user_id,scope,project_id,name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()")
            .bind(user.id)
            .bind(scope_text(target.scope))
            .bind(project_id)
            .bind(name_text(target.name))
            .bind(value)
            .execute(&mut *tx)
            .await?;
    }
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mindgrab_loro.preferences WHERE user_id=$1")
            .bind(user.id)
            .fetch_one(&mut *tx)
            .await?;
    if rows > MAX_ROWS {
        return Err(ApiError::new(
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            "preference_limit",
        ));
    }
    tx.commit().await?;
    Ok(())
}

/// What one of the owner's maps uses for a preference: its own value, else the
/// one for all of their maps, else none.
pub async fn resolve<T: serde::de::DeserializeOwned>(
    pool: &PgPool,
    owner: i64,
    project_id: Uuid,
    name: PreferenceName,
) -> Result<Option<T>> {
    let (own, global) = levels(pool, owner, project_id, name).await?;
    Ok(own.or(global))
}

/// The map's own value for a preference and the one for all of the owner's
/// maps, each if set and readable.
pub async fn levels<T: serde::de::DeserializeOwned>(
    pool: &PgPool,
    owner: i64,
    project_id: Uuid,
    name: PreferenceName,
) -> Result<(Option<T>, Option<T>)> {
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT scope::text, value FROM mindgrab_loro.preferences WHERE user_id=$1 AND name=$3::text::mindgrab_loro.preference_name AND (scope='global' OR project_id=$2)",
    )
    .bind(owner)
    .bind(project_id)
    .bind(name_text(name))
    .fetch_all(pool)
    .await?;
    let value = |scope: &str| {
        rows.iter()
            .find(|(row, _)| row == scope)
            .and_then(|(_, value)| serde_json::from_value(value.clone()).ok())
    };
    Ok((value("map"), value("global")))
}
