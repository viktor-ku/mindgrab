use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use yrs::updates::decoder::Decode;

use super::*;
use crate::{
    auth::tests::{fixture, sign_in},
    project::{
        read_model,
        updates::{
            self, backup, digest,
            tests::{
                INITIAL, assert_baseline, binary, get, javascript, new_id, process_baseline, put,
                register,
            },
        },
    },
};

async fn identity(pool: &PgPool, id: Uuid) -> (i64, String) {
    sqlx::query_as("SELECT p.owner_id, u.external_id FROM crdt_project p JOIN users u ON u.id = p.owner_id WHERE p.id = $1")
        .bind(id).fetch_one(pool).await.unwrap()
}

async fn rows(pool: &PgPool, id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM crdt_update WHERE project_id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Entirely separate database, containing an explicitly mapped user and no caches.
async fn isolated(pool: &PgPool, external: &str) -> (PgPool, String, i64) {
    let name = format!("backup_restore_{}", new_id().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(pool)
        .await
        .unwrap();
    let options = pool.connect_options().as_ref().clone().database(&name);
    let target = PgPoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::migrate!().run(&target).await.unwrap();
    let owner = sqlx::query_scalar("INSERT INTO users (name, email, external_id) VALUES ('Restore user', 'restore@example.test', $1) RETURNING id")
        .bind(external).fetch_one(&target).await.unwrap();
    (target, name, owner)
}

async fn remove_database(pool: &PgPool, target: PgPool, name: String) {
    target.close().await;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE {name} WITH (FORCE)"
    )))
    .execute(pool)
    .await
    .unwrap();
}

async fn content(pool: &PgPool, owner: i64, id: Uuid, expected: &Value) {
    let baseline = updates::synchronization_baseline(pool, owner, id)
        .await
        .unwrap();
    assert_eq!(baseline.validation, "valid");
    assert_eq!(
        javascript(json!({"verify": true, "updates": [baseline.bytes]}))["content"],
        *expected
    );
    let state =
        serde_json::to_value(read_model::current_state(pool, owner, id).await.unwrap()).unwrap();
    let actual: crate::project::projection::Content =
        serde_json::from_value(state["content"].clone()).unwrap();
    let expected: crate::project::projection::Content =
        serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(actual, expected);
    assert_eq!(state["current"], true);
}

#[sqlx::test]
async fn compaction_prunes_bytes_preserves_receipts_and_requires_stale_replay_to_rebootstrap(
    pool: PgPool,
) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let update = new_id();
    let receipt = put(&f.state, &cookie, id, update, INITIAL).await.1;
    let (owner, _) = identity(&f.state.pool, id).await;
    let before = get(&f.state, &cookie, id, "getProjectBaseline").await.1;
    let metrics = compact(&f.state.pool, owner, id).await.unwrap();
    assert!(metrics.coverage);
    assert_eq!(metrics.pruned_rows, 1);
    assert_eq!(rows(&f.state.pool, id).await, 0);
    assert_eq!(put(&f.state, &cookie, id, update, INITIAL).await.1, receipt);
    assert_eq!(
        put(&f.state, &cookie, id, update, &[0, 0]).await.0.as_u16(),
        409
    );
    assert_eq!(
        crate::project::updates::tests::rpc(
            &f.state,
            &cookie,
            "getProjectUpdates",
            json!({"projectId": id, "after": "0"})
        )
        .await
        .1["error"]["code"],
        "baseline_required"
    );
    assert_eq!(
        crate::project::updates::tests::rpc(
            &f.state,
            &cookie,
            "getProjectUpdates",
            json!({"projectId": id, "after": "1"})
        )
        .await
        .1["updates"],
        json!([])
    );
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectBaseline").await.1["stateVector"],
        before["stateVector"]
    );
    assert_eq!(
        compact(&f.state.pool, owner, id).await.unwrap().pruned_rows,
        0
    );
    let probe = process_baseline(&f.state.pool, id).await;
    assert_eq!(probe["validation"], "valid");
    assert!(matches!(
        compact(&f.state.pool, owner + 1, id).await,
        Err(ApiError::NotFound)
    ));
}

#[sqlx::test]
async fn failure_at_publication_pruning_or_commit_rolls_back_every_canonical_write(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(&f.state, &cookie, id, new_id(), INITIAL).await;
    let (owner, _) = identity(&f.state.pool, id).await;
    sqlx::raw_sql("CREATE FUNCTION fail_maintenance() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected storage failure'; END; $$ LANGUAGE plpgsql;")
        .execute(&f.state.pool).await.unwrap();
    for trigger in [
        "CREATE TRIGGER fail BEFORE INSERT ON crdt_checkpoint FOR EACH ROW EXECUTE FUNCTION fail_maintenance()",
        "CREATE TRIGGER fail BEFORE DELETE ON crdt_update FOR EACH ROW EXECUTE FUNCTION fail_maintenance()",
        "CREATE CONSTRAINT TRIGGER fail AFTER INSERT ON crdt_checkpoint DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_maintenance()",
    ] {
        sqlx::query(trigger).execute(&f.state.pool).await.unwrap();
        assert!(compact(&f.state.pool, owner, id).await.is_err());
        assert_eq!(rows(&f.state.pool, id).await, 1);
        let cp: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM crdt_checkpoint WHERE project_id = $1")
                .bind(id)
                .fetch_one(&f.state.pool)
                .await
                .unwrap();
        assert_eq!(cp, 0);
        assert_eq!(
            process_baseline(&f.state.pool, id).await["validation"],
            "valid"
        );
        sqlx::raw_sql("DROP TRIGGER IF EXISTS fail ON crdt_checkpoint; DROP TRIGGER IF EXISTS fail ON crdt_update")
            .execute(&f.state.pool).await.unwrap();
    }
    assert_eq!(
        compact(&f.state.pool, owner, id).await.unwrap().pruned_rows,
        1
    );
    assert_eq!(
        process_baseline(&f.state.pool, id).await["validation"],
        "valid"
    );
}

#[sqlx::test]
async fn concurrent_appends_and_compactors_keep_gapless_receipts_and_reconstruct_all_acks(
    pool: PgPool,
) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(&f.state, &cookie, id, new_id(), INITIAL).await;
    let (owner, _) = identity(&f.state.pool, id).await;
    let mut jobs = Vec::new();
    for _ in 0..60 {
        let pool = f.state.pool.clone();
        jobs.push(tokio::spawn(async move {
            let (_, receipt) = updates::ingest(&pool, owner, id, new_id(), INITIAL.to_vec())
                .await
                .unwrap();
            compact(&pool, owner, id).await.unwrap();
            receipt.sequence
        }));
    }
    let mut sequences = Vec::new();
    for job in jobs {
        sequences.push(job.await.unwrap());
    }
    sequences.sort();
    assert_eq!(sequences, (2..=61).collect::<Vec<_>>());
    compact(&f.state.pool, owner, id).await.unwrap();
    assert_eq!(rows(&f.state.pool, id).await, 0);
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM crdt_receipt WHERE project_id = $1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(total, 61);
    let expected = javascript(json!({"verify": true, "updates": [INITIAL]}))["content"].clone();
    content(&f.state.pool, owner, id, &expected).await;
}

#[sqlx::test]
async fn every_670_gap_is_retained_and_backup_restores_before_missing_updates_arrive(pool: PgPool) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let id = register(&f.state, &cookie).await;
        put(&f.state, &cookie, id, new_id(), &binary(&data["initial"])).await;
        let (owner, external) = identity(&f.state.pool, id).await;
        compact(&f.state.pool, owner, id).await.unwrap();
        for (position, index) in order.iter().enumerate() {
            put(
                &f.state,
                &cookie,
                id,
                new_id(),
                &binary(&data["causal"][index]),
            )
            .await;
            let before = rows(&f.state.pool, id).await;
            let result = compact(&f.state.pool, owner, id).await.unwrap();
            if !result.coverage {
                assert_eq!(rows(&f.state.pool, id).await, before);
            }
            assert_eq!(
                compact(&f.state.pool, owner, id).await.unwrap().coverage,
                result.coverage
            );
            let baseline = updates::synchronization_baseline(&f.state.pool, owner, id)
                .await
                .unwrap();
            let archive = backup::export(&f.state.pool, id, &external).await.unwrap();
            let (target, name, destination) = isolated(&f.state.pool, "restore_owner").await;
            backup::restore(&target, id, &external, "restore_owner", archive)
                .await
                .unwrap();
            let restored = updates::synchronization_baseline(&target, destination, id)
                .await
                .unwrap();
            assert_eq!(restored.validation, baseline.validation);
            let mut js_inputs = vec![baseline.bytes];
            for missing in order.iter().skip(position + 1) {
                let bytes = binary(&data["causal"][missing]);
                js_inputs.push(bytes.clone());
                updates::ingest(&target, destination, id, new_id(), bytes)
                    .await
                    .unwrap();
                compact(&target, destination, id).await.unwrap();
            }
            assert_eq!(
                javascript(json!({"verify": true, "updates": js_inputs}))["content"],
                data["causalExpected"]
            );
            content(&target, destination, id, &data["causalExpected"]).await;
            remove_database(&f.state.pool, target, name).await;
        }
        assert_baseline(&f.state, &cookie, id, &data["causalExpected"]).await;
    }
}

#[sqlx::test]
async fn skip_673_and_unresolved_delete_only_updates_never_get_pruned(pool: PgPool) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    for (base, pending, missing, expected) in [
        ("gapBase", "gapped", "predecessor", "gapExpected"),
        ("deleteBase", "deletion", "deleteBase", "deleteExpected"),
    ] {
        let id = register(&f.state, &cookie).await;
        if pending == "gapped" {
            put(&f.state, &cookie, id, new_id(), &binary(&data[base])).await;
        }
        let (owner, external) = identity(&f.state.pool, id).await;
        compact(&f.state.pool, owner, id).await.unwrap();
        put(&f.state, &cookie, id, new_id(), &binary(&data[pending])).await;
        for _ in 0..3 {
            assert!(!compact(&f.state.pool, owner, id).await.unwrap().coverage);
        }
        assert_eq!(rows(&f.state.pool, id).await, 1);
        let baseline = updates::synchronization_baseline(&f.state.pool, owner, id)
            .await
            .unwrap();
        let archive = backup::export(&f.state.pool, id, &external).await.unwrap();
        let (target, name, destination) = isolated(&f.state.pool, "restore_owner").await;
        backup::restore(&target, id, &external, "restore_owner", archive)
            .await
            .unwrap();
        let bytes = binary(&data[missing]);
        assert_eq!(
            javascript(json!({"verify": true, "updates": [baseline.bytes, bytes]}))["content"],
            data[expected]
        );
        updates::ingest(&target, destination, id, new_id(), bytes)
            .await
            .unwrap();
        assert!(compact(&target, destination, id).await.unwrap().coverage);
        content(&target, destination, id, &data[expected]).await;
        remove_database(&f.state.pool, target, name).await;
    }
}

struct Replicas {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Replicas {
    fn new() -> Self {
        let mut child = Command::new("bun")
            .args(["--bun", "server-maintenance.ts"])
            .current_dir(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../webapp/tests/fixtures"
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
        }
    }
    fn request(&mut self, input: Value) -> Value {
        writeln!(self.input, "{input}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        serde_json::from_str(&line).unwrap()
    }
}
impl Drop for Replicas {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[sqlx::test]
async fn long_offline_moves_deletes_and_active_session_undo_redo_survive_multiple_compactions_and_restore(
    pool: PgPool,
) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let (owner, external) = identity(&f.state.pool, id).await;
    let mut replicas = Replicas::new();
    let start = replicas.request(json!({"command": "start"}));
    put(&f.state, &cookie, id, new_id(), &binary(&start["initial"])).await;
    for bytes in start["updates"].as_array().unwrap() {
        put(&f.state, &cookie, id, new_id(), &binary(bytes)).await;
    }
    for _ in 0..3 {
        assert!(compact(&f.state.pool, owner, id).await.unwrap().coverage);
    }
    let baseline = updates::synchronization_baseline(&f.state.pool, owner, id)
        .await
        .unwrap();
    // Backup into a separate database, then reconnect the pre-backup replicas.
    let archive = backup::export(&f.state.pool, id, &external).await.unwrap();
    let (target, name, destination) = isolated(&f.state.pool, "restore_owner").await;
    backup::restore(&target, id, &external, "restore_owner", archive)
        .await
        .unwrap();
    let reconnected =
        replicas.request(json!({"command": "reconnect", "checkpoint": baseline.bytes}));
    assert_eq!(reconnected["undoCount"], 1);
    for (index, bytes) in reconnected["updates"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let raw = binary(bytes);
        assert!(
            updates::wire::preflight(&raw).is_ok(),
            "preflight update {index}: {bytes}"
        );
        assert!(
            yrs::Update::decode_v1(&raw).is_ok(),
            "decode update {index}: {bytes}"
        );
        let latest = updates::synchronization_baseline(&target, destination, id)
            .await
            .unwrap();
        assert!(
            updates::wire::preflight(&latest.bytes).is_ok(),
            "checkpoint preflight"
        );
        updates::ingest(&target, destination, id, new_id(), raw)
            .await
            .unwrap_or_else(|error| panic!("update {index}: {error:?}: {bytes}"));
        let result = compact(&target, destination, id).await.unwrap();
        // This fixture splits a UTF-16 surrogate boundary on the offline peer.
        // The pinned encoder's output falls outside production preflight. Keep
        // the old checkpoint + originals, and still permit undo/redo and backup.
        assert!(!result.coverage);
        assert_eq!(result.pruned_rows, 0);
        backup::export(&target, id, "restore_owner").await.unwrap();
    }
    content(&target, destination, id, &reconnected["expected"]).await;
    let baseline = updates::synchronization_baseline(&target, destination, id)
        .await
        .unwrap();
    let redo = replicas.request(json!({"command": "redo", "checkpoint": baseline.bytes}));
    assert_eq!(redo["updates"].as_array().unwrap().len(), 1);
    for bytes in redo["updates"].as_array().unwrap() {
        updates::ingest(&target, destination, id, new_id(), binary(bytes))
            .await
            .unwrap();
    }
    assert_eq!(redo["expected"], redo["offline"]);
    content(&target, destination, id, &redo["expected"]).await;
    remove_database(&f.state.pool, target, name).await;
}

#[sqlx::test]
async fn worker_triggers_retries_and_corrupt_source_are_conservative(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let (owner, _) = identity(&f.state.pool, id).await;
    put(&f.state, &cookie, id, new_id(), INITIAL).await;
    sweep(&f.state.pool, None).await.unwrap();
    assert_eq!(rows(&f.state.pool, id).await, 1);
    sqlx::query("UPDATE crdt_project SET compaction_failures = 1, compaction_retry_at = NOW() - INTERVAL '1 second' WHERE id = $1").bind(id).execute(&f.state.pool).await.unwrap();
    sqlx::query("INSERT INTO crdt_checkpoint (project_id, covered_sequence, data, sha256) VALUES ($1, 0, $2, $3)")
        .bind(id).bind(vec![0u8, 0]).bind(digest(INITIAL)).execute(&f.state.pool).await.unwrap();
    assert!(compact(&f.state.pool, owner, id).await.is_err());
    // Age trigger with corrupt storage fails and backs off, keeping rows.
    sqlx::raw_sql("ALTER TABLE crdt_update DISABLE TRIGGER crdt_update_is_immutable; UPDATE crdt_update SET committed_at = NOW() - INTERVAL '2 hours'; ALTER TABLE crdt_update ENABLE TRIGGER crdt_update_is_immutable")
        .execute(&f.state.pool).await.unwrap();
    sweep(&f.state.pool, None).await.unwrap();
    let backed_off: bool = sqlx::query_scalar("SELECT compaction_failures = 2 AND compaction_retry_at > NOW() FROM crdt_project WHERE id = $1")
        .bind(id).fetch_one(&f.state.pool).await.unwrap();
    assert!(backed_off);
    assert_eq!(rows(&f.state.pool, id).await, 1);
    sqlx::query("DELETE FROM crdt_checkpoint WHERE project_id = $1")
        .bind(id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE crdt_project SET compaction_retry_at = NOW() WHERE id = $1")
        .bind(id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    sweep(&f.state.pool, None).await.unwrap();
    assert_eq!(rows(&f.state.pool, id).await, 0);
}

#[sqlx::test]
async fn count_trigger_compacts_idempotent_deliveries(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    // Performance budgets are exercised by the production release gate.
    // Keep the worker row-count threshold covered independently of payload size.
    let another = register(&f.state, &cookie).await;
    let (owner, _) = identity(&f.state.pool, another).await;
    for _ in 0..COUNT_TRIGGER {
        updates::ingest(&f.state.pool, owner, another, new_id(), INITIAL.to_vec())
            .await
            .unwrap();
    }
    sweep(&f.state.pool, None).await.unwrap();
    assert_eq!(rows(&f.state.pool, another).await, 0);
}

#[test]
#[ignore = "subprocess fault-injection entry point"]
fn crash_probe() {
    use std::io::Read;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let input: Value = serde_json::from_str(&input).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let pool = PgPool::connect(input["databaseUrl"].as_str().unwrap()).await.unwrap();
        let owner = input["owner"].as_i64().unwrap();
        let id = Uuid::parse_str(input["projectId"].as_str().unwrap()).unwrap();
        let phase = input["phase"].as_u64().unwrap();
        let mut transaction = pool.begin().await.unwrap();
        let state = updates::lock_project(&mut transaction, id, owner).await.unwrap();
        let bytes = updates::document::checkpoint_candidate(updates::load(&mut transaction, id, state.last_sequence).await.unwrap()).await.unwrap().checkpoint.unwrap();
        if phase == 0 { std::process::exit(0); }
        sqlx::query("INSERT INTO crdt_checkpoint (project_id, covered_sequence, data, sha256) VALUES ($1, $2, $3, $4)")
            .bind(id).bind(state.last_sequence).bind(&bytes).bind(digest(&bytes)).execute(&mut *transaction).await.unwrap();
        if phase == 1 { std::process::exit(0); }
        sqlx::query("DELETE FROM crdt_update WHERE project_id = $1").bind(id).execute(&mut *transaction).await.unwrap();
        if phase == 2 { std::process::exit(0); }
        transaction.commit().await.unwrap();
        std::process::exit(0);
    });
}

#[sqlx::test]
async fn process_death_at_every_publication_pruning_boundary_preserves_acks(pool: PgPool) {
    use sqlx::ConnectOptions;
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    for phase in 0..4 {
        let id = register(&f.state, &cookie).await;
        let update = new_id();
        let receipt = put(&f.state, &cookie, id, update, INITIAL).await.1;
        let (owner, _) = identity(&f.state.pool, id).await;
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "project::updates::maintenance::tests::crash_probe",
                "--nocapture",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let input = json!({"databaseUrl": f.state.pool.connect_options().to_url_lossy().as_str(), "projectId": id, "owner": owner, "phase": phase});
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(
            rows(&f.state.pool, id).await,
            if phase == 3 { 0 } else { 1 }
        );
        assert_eq!(put(&f.state, &cookie, id, update, INITIAL).await.1, receipt);
        assert_eq!(
            process_baseline(&f.state.pool, id).await["validation"],
            "valid"
        );
        compact(&f.state.pool, owner, id).await.unwrap();
    }
}

#[sqlx::test]
async fn byte_trigger_compacts_below_the_row_count_threshold(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let (owner, _) = identity(&f.state.pool, id).await;
    let data = Replicas::new().request(json!({"command": "byte-trigger"}));
    let bytes = binary(&data["initial"]);
    assert!(bytes.len() < updates::MAX_UPDATE_BYTES);
    assert!(bytes.len() * 2 > BYTE_TRIGGER as usize);
    for _ in 0..2 {
        updates::ingest(&f.state.pool, owner, id, new_id(), bytes.clone())
            .await
            .unwrap();
    }
    assert_eq!(rows(&f.state.pool, id).await, 2);
    sweep(&f.state.pool, None).await.unwrap();
    assert_eq!(rows(&f.state.pool, id).await, 0);
}
