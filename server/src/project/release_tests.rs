//! Release-only orchestration. Fault controls never exist in the production binary.
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{Json, Router, extract::State, routing::post};
use serde_json::{Value, json};
use sqlx::{ConnectOptions, PgPool, postgres::PgPoolOptions};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{
    read_model,
    updates::{self, backup, maintenance, tests::new_id},
};
use crate::auth::tests::{fixture, session_for, sign_in};

struct ApiProcess {
    child: Child,
    url: String,
}
impl Drop for ApiProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
async fn api_process(pool: &PgPool, origin: &str) -> ApiProcess {
    let input =
        json!({"database": pool.connect_options().to_url_lossy().to_string(), "origin": origin});
    tokio::task::spawn_blocking(move || {
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "project::release_tests::release_api_process",
                "--nocapture",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut process = ApiProcess {
            child,
            url: String::new(),
        };
        process
            .child
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        let stdout = process.child.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(url) = line.strip_prefix("release-api:") {
                    let _ = sender.send(url.to_owned());
                }
            }
        });
        process.url = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("API startup budget exceeded");
        process
    })
    .await
    .unwrap()
}

#[test]
#[ignore = "subprocess entry point; invoked only by the release fixture"]
fn release_api_process() {
    use std::io::Read;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let input: Value = serde_json::from_str(&input).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let pool = PgPool::connect(input["database"].as_str().unwrap())
            .await
            .unwrap();
        let mut f = fixture(pool).await;
        let state = Arc::get_mut(&mut f.state).unwrap();
        state.config.app_url = format!("{}/", input["origin"].as_str().unwrap());
        let app = crate::auth::router(f.state.clone()).merge(super::router(f.state.clone()));
        // Exercise the real deployment's background workers in both processes.
        read_model::start_worker(f.state.pool.clone());
        maintenance::start_worker(f.state.pool.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        println!("release-api:http://{}", listener.local_addr().unwrap());
        std::io::stdout().flush().unwrap();
        axum::serve(listener, app).await.unwrap();
    });
}

struct Rig {
    pool: PgPool,
    apis: Mutex<Vec<ApiProcess>>,
    restored: Mutex<Option<(PgPool, String)>>,
}

async fn control(State(rig): State<Arc<Rig>>, Json(input): Json<Value>) -> Json<Value> {
    let action = input["action"].as_str().unwrap();
    if action == "stop" {
        rig.apis.lock().await.clear();
        return Json(json!({"ok": true}));
    }
    if action == "start" || action == "restart" {
        let origin = input["origin"].as_str().unwrap();
        let mut apis = rig.apis.lock().await;
        if action == "start" {
            assert!(apis.is_empty());
            apis.push(api_process(&rig.pool, origin).await);
            apis.push(api_process(&rig.pool, origin).await);
        } else {
            // SIGKILL + wait, then a brand new process. No room or decoder survives.
            apis.remove(0);
            apis.insert(0, api_process(&rig.pool, origin).await);
        }
        return Json(json!({"urls": apis.iter().map(|p| &p.url).collect::<Vec<_>>() }));
    }
    if action == "commit-failure" {
        if input["enabled"] == true {
            sqlx::raw_sql("CREATE FUNCTION release_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'MIN42 injected COMMIT failure'; END; $$; CREATE CONSTRAINT TRIGGER release_fail_commit AFTER INSERT ON crdt_update DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION release_fail_commit();")
                .execute(&rig.pool).await.unwrap();
        } else {
            sqlx::raw_sql("DROP TRIGGER release_fail_commit ON crdt_update; DROP FUNCTION release_fail_commit();")
                .execute(&rig.pool).await.unwrap();
        }
        return Json(json!({"ok": true}));
    }
    let id: Uuid = input["projectId"].as_str().unwrap().parse().unwrap();
    let owner: i64 = sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
        .bind(id)
        .fetch_one(&rig.pool)
        .await
        .unwrap();
    match action {
        "compact" => Json(
            serde_json::to_value(maintenance::compact(&rig.pool, owner, id).await.unwrap())
                .unwrap(),
        ),
        "inspect" => {
            let start = Instant::now();
            let mut bytes = 0;
            for _ in 0..5 {
                let baseline = updates::synchronization_baseline(&rig.pool, owner, id)
                    .await
                    .unwrap();
                assert_eq!(baseline.validation, "valid");
                bytes = baseline.bytes.len();
            }
            let replay_ms = start.elapsed().as_secs_f64() * 1000.0 / 5.0;
            let state = read_model::current_state(&rig.pool, owner, id)
                .await
                .unwrap();
            let (rows, log_bytes): (i64, i64) = sqlx::query_as("SELECT count(*), COALESCE(sum(octet_length(data)), 0)::bigint FROM crdt_update WHERE project_id = $1")
                .bind(id).fetch_one(&rig.pool).await.unwrap();
            let checkpoint_bytes: Option<i32> = sqlx::query_scalar(
                "SELECT octet_length(data) FROM crdt_checkpoint WHERE project_id = $1",
            )
            .bind(id)
            .fetch_optional(&rig.pool)
            .await
            .unwrap();
            let receipts: i64 =
                sqlx::query_scalar("SELECT count(*) FROM crdt_receipt WHERE project_id = $1")
                    .bind(id)
                    .fetch_one(&rig.pool)
                    .await
                    .unwrap();
            Json(
                json!({"state": state, "rows": rows, "logBytes": log_bytes, "checkpointBytes": checkpoint_bytes.unwrap_or(0), "baselineBytes": bytes, "receipts": receipts, "replayMs": replay_ms}),
            )
        }
        "restore" => {
            let name = format!("min42_restore_{}", new_id().simple());
            sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
                .execute(&rig.pool)
                .await
                .unwrap();
            let target = PgPoolOptions::new()
                .max_connections(5)
                .connect_with(rig.pool.connect_options().as_ref().clone().database(&name))
                .await
                .unwrap();
            // Register cleanup before doing anything that can fail.
            *rig.restored.lock().await = Some((target.clone(), name));
            sqlx::migrate!().run(&target).await.unwrap();
            let f = fixture(target.clone()).await;
            let cookie = session_for(&f, "user_restored").await;
            let archive = backup::export(&rig.pool, id, "user_test").await.unwrap();
            let path = std::env::temp_dir().join(format!("min42-{}.mgb", new_id()));
            archive.write(&path).unwrap();
            let archive = backup::Archive::read(&path).unwrap();
            std::fs::remove_file(path).unwrap();
            backup::restore(&target, id, "user_test", "user_restored", archive)
                .await
                .unwrap();
            let restored_owner = backup::owner(&target, "user_restored").await.unwrap();
            read_model::rebuild_project(&target, restored_owner, id)
                .await
                .unwrap();
            let state = read_model::current_state(&target, restored_owner, id)
                .await
                .unwrap();
            let api = api_process(&target, input["origin"].as_str().unwrap()).await;
            let url = api.url.clone();
            rig.apis.lock().await.push(api);
            Json(json!({"url": url, "cookie": cookie, "state": state}))
        }
        _ => panic!("Unknown release control: {action}"),
    }
}

#[sqlx::test]
#[ignore = "Run mise run test:release; requires Chromium and the release build"]
async fn release_stack_recovers_and_converges(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let other_cookie = session_for(&f, "user_other").await;
    let rig = Arc::new(Rig {
        pool: f.state.pool.clone(),
        apis: Mutex::new(Vec::new()),
        restored: Mutex::new(None),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let control_url = format!("http://{}/control", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/control", post(control))
        .with_state(rig.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let postgres_version: String = sqlx::query_scalar("SELECT version()")
        .fetch_one(&rig.pool)
        .await
        .unwrap();
    let rust_version = Command::new("rustc").arg("--version").output().unwrap();
    assert!(rust_version.status.success());
    let input = json!({"controlUrl": control_url, "cookie": cookie, "otherCookie": other_cookie, "postgresVersion": postgres_version, "rustVersion": String::from_utf8(rust_version.stdout).unwrap().trim()});
    let output = tokio::task::spawn_blocking(move || {
        let mut child = Command::new("bun")
            .args(["--bun", "tests/browser/release.integration.ts"])
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../webapp"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    })
    .await
    .unwrap();
    task.abort();
    rig.apis.lock().await.clear();
    if let Some((target, name)) = rig.restored.lock().await.take() {
        target.close().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE {name} WITH (FORCE)"
        )))
        .execute(&rig.pool)
        .await
        .unwrap();
    }
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(output.status.success(), "Release browser suite failed");
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["converged"], true);
}
