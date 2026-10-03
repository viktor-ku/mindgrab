use async_trait::async_trait;
use axum_login::tower_sessions::{
    ExpiredDeletion, SessionStore,
    session::{Id, Record},
    session_store::{self, Error},
};
use sqlx::{PgPool, types::Json};

use super::{AUTH_DATA, token_hash};

pub(super) const PROVIDER: &str = "provider";
pub(super) const REPLACE: &str = "replace";

/// Generic session writes never contain or overwrite WorkOS tokens. Only hashes
/// of browser IDs are stored; provider authority remains in the row-locked table.
#[derive(Clone, Debug)]
pub(crate) struct Store(pub PgPool);

fn unavailable(_: sqlx::Error) -> Error {
    // SQL errors may contain credentials or data. Keep library tracing safe too.
    Error::Backend("Session storage unavailable".into())
}

fn provider(record: &Record) -> session_store::Result<&str> {
    record
        .data
        .get(PROVIDER)
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::Backend("Session requires committed provider authority".into()))
}

fn active(rows: u64) -> session_store::Result<()> {
    if rows == 1 {
        Ok(())
    } else {
        Err(Error::Backend("Session expired or revoked".into()))
    }
}

#[async_trait]
impl SessionStore for Store {
    async fn create(&self, record: &mut Record) -> session_store::Result<()> {
        let previous = record
            .data
            .get(REPLACE)
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        let previous: Vec<String> = serde_json::from_value(previous)
            .map_err(|_| Error::Backend("Invalid session rotation".into()))?;
        let mut tx = self.0.begin().await.map_err(unavailable)?;
        let mut data = record.data.clone();
        data.remove(REPLACE);
        // The UNIQUE constraint rejects collisions without replacing authority.
        let rows = sqlx::query("UPDATE auth_sessions SET browser_hash = $1, session_data = $2, expires_at = LEAST(expires_at, $3) WHERE token_hash = $4 AND browser_hash IS NULL AND expires_at > NOW()")
            .bind(token_hash(&record.id.to_string())).bind(Json(data))
            .bind(record.expiry_date).bind(provider(record)?)
            .execute(&mut *tx).await.map_err(unavailable)?.rows_affected();
        active(rows)?;
        // Rotation and the new local credential commit together. A failed create
        // leaves the previous browser session usable.
        sqlx::query("DELETE FROM auth_sessions WHERE browser_hash = ANY($1) AND token_hash <> $2")
            .bind(previous)
            .bind(provider(record)?)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        record.data.remove(REPLACE);
        Ok(())
    }

    async fn save(&self, record: &Record) -> session_store::Result<()> {
        let rows = sqlx::query("UPDATE auth_sessions SET session_data = $1, expires_at = LEAST(expires_at, $2) WHERE browser_hash = $3 AND token_hash = $4 AND expires_at > NOW()")
            .bind(Json(&record.data)).bind(record.expiry_date)
            .bind(token_hash(&record.id.to_string())).bind(provider(record)?)
            .execute(&self.0).await.map_err(unavailable)?.rows_affected();
        active(rows)
    }

    async fn load(&self, id: &Id) -> session_store::Result<Option<Record>> {
        let row = sqlx::query_as::<_, (String, Json<serde_json::Map<String, serde_json::Value>>, _)>("SELECT token_hash, session_data, expires_at FROM auth_sessions WHERE browser_hash = $1 AND expires_at > NOW()")
            .bind(token_hash(&id.to_string())).fetch_optional(&self.0).await.map_err(unavailable)?;
        let Some((provider, Json(data), expiry_date)) = row else {
            return Ok(None);
        };
        let identity = serde_json::json!({"user_id": provider, "auth_hash": provider.as_bytes()});
        // Bind cached identity to this row, never another user's provider session.
        if data.get(PROVIDER).and_then(|v| v.as_str()) != Some(provider.as_str())
            || data.get(AUTH_DATA) != Some(&identity)
        {
            return Ok(None);
        }
        Ok(Some(Record {
            id: *id,
            data: data.into_iter().collect(),
            expiry_date,
        }))
    }

    async fn delete(&self, id: &Id) -> session_store::Result<()> {
        sqlx::query("DELETE FROM auth_sessions WHERE browser_hash = $1")
            .bind(token_hash(&id.to_string()))
            .execute(&self.0)
            .await
            .map_err(unavailable)?;
        Ok(())
    }
}

#[async_trait]
impl ExpiredDeletion for Store {
    async fn delete_expired(&self) -> session_store::Result<()> {
        sqlx::query("DELETE FROM auth_sessions WHERE expires_at <= NOW()")
            .execute(&self.0)
            .await
            .map_err(unavailable)?;
        Ok(())
    }
}
