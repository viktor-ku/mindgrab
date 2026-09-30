use super::*;
use crate::{
    auth::tests::{fixture, sign_in},
    project::updates::{
        ingest,
        tests::{INITIAL, binary, javascript, new_id, put, register},
    },
};
use serde_json::json;

async fn source(pool: PgPool) -> (ArcState, Uuid, i64, String) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(&f.state, &cookie, id, new_id(), INITIAL).await;
    let (owner, external) = sqlx::query_as("SELECT p.owner_id, u.external_id FROM crdt_project p JOIN users u ON u.id = p.owner_id WHERE p.id = $1")
        .bind(id).fetch_one(&f.state.pool).await.unwrap();
    (f.state.clone(), id, owner, external)
}
type ArcState = std::sync::Arc<crate::auth::AppState>;

#[sqlx::test]
async fn archive_file_checks_integrity_truncation_and_exclusive_creation(pool: PgPool) {
    let (state, id, _, external) = source(pool).await;
    let archive = export(&state.pool, id, &external).await.unwrap();
    let path = std::env::temp_dir().join(format!("backup-{}.mgb", new_id()));
    archive.write(&path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(archive.write(&path).is_err());
    Archive::read(&path)
        .unwrap()
        .validate(id, &external)
        .await
        .unwrap();
    let original = std::fs::read(&path).unwrap();
    for bytes in [&original[..7], &original[..original.len() - 1]] {
        std::fs::write(&path, bytes).unwrap();
        match Archive::read(&path) {
            Err(_) => {}
            Ok(archive) => assert!(archive.validate(id, &external).await.is_err()),
        }
    }
    let mut corrupt = original.clone();
    corrupt[44] ^= 1;
    std::fs::write(&path, &corrupt).unwrap();
    assert!(Archive::read(&path).is_err());
    let mut corrupt = original;
    let last = corrupt.len() - 1;
    corrupt[last] ^= 1;
    std::fs::write(&path, &corrupt).unwrap();
    assert!(
        Archive::read(&path)
            .unwrap()
            .validate(id, &external)
            .await
            .is_err()
    );
    std::fs::remove_file(path).unwrap();
}

#[sqlx::test]
async fn manifest_identity_versions_sequences_receipts_and_checksums_are_explicitly_validated(
    pool: PgPool,
) {
    let (state, id, _, external) = source(pool).await;
    assert!(matches!(
        export(&state.pool, id, "unknown-owner").await,
        Err(ApiError::NotFound)
    ));
    let archive = export(&state.pool, id, &external).await.unwrap();
    assert!(matches!(
        archive.validate(new_id(), &external).await,
        Err(ApiError::ProjectIdConflict)
    ));
    assert!(matches!(
        archive.validate(id, "wrong-source").await,
        Err(ApiError::ProjectIdConflict)
    ));
    let manifest = serde_json::to_value(&archive.manifest).unwrap();
    for (field, value) in [
        ("formatVersion", json!(2)),
        ("schemaVersion", json!(2)),
        ("checkpointVersion", json!(2)),
        ("encoding", json!("yjs-v2")),
        ("coveredSequence", json!("2")),
        ("lastSequence", json!("0")),
        ("checkpointLength", json!(0)),
        ("payloadSha256", json!("bad")),
        ("validation", json!("quarantined")),
        ("receipts", json!([])),
    ] {
        let mut changed = manifest.clone();
        changed[field] = value;
        let tampered = Archive {
            manifest: serde_json::from_value(changed).unwrap(),
            payload: archive.payload.clone(),
        };
        assert!(tampered.validate(id, &external).await.is_err(), "{field}");
    }
    let mut changed = manifest;
    changed["extra"] = json!(true);
    assert!(serde_json::from_value::<Manifest>(changed).is_err());
}

#[sqlx::test]
async fn restore_refuses_existing_uuid_or_missing_owner_without_any_writes(pool: PgPool) {
    let (state, id, _, external) = source(pool).await;
    let archive = export(&state.pool, id, &external).await.unwrap();
    assert!(matches!(
        restore(&state.pool, id, &external, &external, archive).await,
        Err(ApiError::ProjectIdConflict)
    ));
    let archive = export(&state.pool, id, &external).await.unwrap();
    assert!(matches!(
        restore(&state.pool, id, &external, "missing-owner", archive).await,
        Err(ApiError::NotFound)
    ));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM crdt_project")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test]
async fn quarantine_backup_retains_every_source_row_for_admin_recovery(pool: PgPool) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let (owner, external): (i64, String) = sqlx::query_as("SELECT p.owner_id, u.external_id FROM crdt_project p JOIN users u ON u.id = p.owner_id WHERE p.id = $1")
        .bind(id).fetch_one(&f.state.pool).await.unwrap();
    for field in ["invalidBase", "invalidPending", "withheld"] {
        ingest(&f.state.pool, owner, id, new_id(), binary(&data[field]))
            .await
            .unwrap();
    }
    let archive = export(&f.state.pool, id, &external).await.unwrap();
    assert_eq!(archive.manifest.validation, "quarantined");
    assert_eq!(archive.manifest.covered_sequence, 0);
    assert_eq!(archive.manifest.tail.len(), 3);
    assert!(
        !maintenance::compact(&f.state.pool, owner, id)
            .await
            .unwrap()
            .coverage
    );
    // Restore after removing only this isolated test project's original identity.
    sqlx::query("DELETE FROM crdt_project WHERE id = $1")
        .bind(id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    restore(&f.state.pool, id, &external, &external, archive)
        .await
        .unwrap();
    let status: String = sqlx::query_scalar("SELECT validation FROM crdt_project WHERE id = $1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(status, "quarantined");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM crdt_update WHERE project_id = $1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 3);
}

#[sqlx::test]
async fn restore_failure_at_commit_leaves_no_project_checkpoint_or_receipts(pool: PgPool) {
    let (state, id, _, external) = source(pool).await;
    let archive = export(&state.pool, id, &external).await.unwrap();
    sqlx::query("DELETE FROM crdt_project WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION fail_restore() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END; $$ LANGUAGE plpgsql; CREATE CONSTRAINT TRIGGER fail_restore AFTER INSERT ON crdt_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_restore()")
        .execute(&state.pool).await.unwrap();
    assert!(
        restore(&state.pool, id, &external, &external, archive)
            .await
            .is_err()
    );
    for table in [
        "crdt_project",
        "crdt_checkpoint",
        "crdt_receipt",
        "crdt_update",
    ] {
        let count: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(count, 0, "{table}");
    }
}
