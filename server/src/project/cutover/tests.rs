use sqlx::PgPool;

use super::reset_legacy_projects;
use crate::{
    auth::tests::{fixture, sign_in},
    project::updates::{
        self,
        tests::{INITIAL, new_id, put, register},
    },
};

#[sqlx::test]
async fn reset_discards_only_snapshots_and_is_safe_to_repeat(pool: PgPool) {
    let f = fixture(pool).await;
    let session = sign_in(&f).await;
    let id = register(&f.state, &session).await;
    let update = new_id();
    let original = put(&f.state, &session, id, update, INITIAL).await;
    let owner: i64 = sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    let before = updates::synchronization_baseline(&f.state.pool, owner, id)
        .await
        .unwrap();
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO project (user_id, name, state) SELECT id, 'obsolete', '{}' FROM users",
    )
    .execute(&f.state.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO pnode (id, user_id, project_id, text) SELECT $1, user_id, id, 'obsolete node' FROM project LIMIT 1")
        .bind(new_id()).execute(&f.state.pool).await.unwrap();
    sqlx::raw_sql("CREATE TABLE unrelated_fixture (value TEXT); INSERT INTO unrelated_fixture VALUES ('retain')")
        .execute(&f.state.pool).await.unwrap();

    let (a, b) = tokio::join!(
        reset_legacy_projects(&f.state.pool),
        reset_legacy_projects(&f.state.pool)
    );
    a.unwrap();
    b.unwrap();
    reset_legacy_projects(&f.state.pool).await.unwrap();
    let absent: bool = sqlx::query_scalar(
        "SELECT to_regclass('project') IS NULL AND to_regclass('pnode') IS NULL",
    )
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert!(absent);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
            .fetch_one(&f.state.pool)
            .await
            .unwrap(),
        users
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM auth_sessions")
            .fetch_one(&f.state.pool)
            .await
            .unwrap(),
        sessions
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT value FROM unrelated_fixture")
            .fetch_one(&f.state.pool)
            .await
            .unwrap(),
        "retain"
    );
    // The same session still reads binary state and retries its exact receipt.
    let user: i64 = sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    let loaded = updates::synchronization_baseline(&f.state.pool, user, id)
        .await
        .unwrap();
    assert_eq!(loaded.sequence, before.sequence);
    // Re-encoding map values can change their key order; compare original
    // durable update bytes rather than assuming a canonical binary encoding.
    let raw: Vec<u8> =
        sqlx::query_scalar("SELECT data FROM crdt_update WHERE project_id = $1 AND update_id = $2")
            .bind(id)
            .bind(update)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(raw, INITIAL);
    assert_eq!(loaded.state_vector, before.state_vector);
    assert_eq!(loaded.validation, before.validation);
    let retry = put(&f.state, &session, id, update, INITIAL).await;
    assert_eq!(retry.0, axum::http::StatusCode::OK);
    assert_eq!(retry.1, original.1);
}

#[sqlx::test]
async fn unexpected_dependencies_roll_back_the_reset(pool: PgPool) {
    sqlx::query("CREATE VIEW keep_project_dependency AS SELECT id FROM project")
        .execute(&pool)
        .await
        .unwrap();
    assert!(reset_legacy_projects(&pool).await.is_err());
    let retained: bool = sqlx::query_scalar(
        "SELECT to_regclass('project') IS NOT NULL AND to_regclass('pnode') IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(retained);
}
