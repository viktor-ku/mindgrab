use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::Arc,
};

use crate::auth::AppState;
use axum::{
    body::{Body, Bytes, to_bytes},
    http::{Request, StatusCode, header},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::ConnectOptions;
use sqlx::PgPool;
use tower::ServiceExt;
use yrs::{Doc, Map, ReadTxn, StateVector, Text, Transact, Update, updates::decoder::Decode};

use super::*;
use crate::auth::tests::{fixture, session_for, sign_in};

pub(crate) const INITIAL: &[u8] =
    include_bytes!("../../../../webapp/tests/fixtures/yjs/unicode.0.bin");
const CREATE_PROJECT: &str = "/api/createProject";

pub(crate) fn new_id() -> Uuid {
    uuid::Builder::from_random_bytes(rand::random()).into_uuid()
}

async fn send(
    state: &Arc<AppState>,
    cookie: &str,
    method: &str,
    path: &str,
    bytes: impl Into<Body>,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::COOKIE, cookie);
    for (key, value) in headers {
        request = request.header(*key, *value);
    }
    let response = crate::router(state.clone())
        .oneshot(request.body(bytes.into()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    crate::response_headers::assert_private_headers(response.headers());
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

pub(crate) async fn register(state: &Arc<AppState>, cookie: &str) -> Uuid {
    let id = new_id();
    let response = send(
        state,
        cookie,
        "POST",
        CREATE_PROJECT,
        json!({"projectId": id, "schemaVersion": 1})
            .to_string()
            .into_bytes(),
        &[
            ("origin", "http://localhost:5173"),
            ("content-type", "application/json"),
        ],
    )
    .await;
    assert_eq!(response.0, StatusCode::CREATED);
    id
}

pub(crate) async fn put(
    state: &Arc<AppState>,
    cookie: &str,
    id: Uuid,
    update: Uuid,
    bytes: &[u8],
) -> (StatusCode, Value) {
    send(
        state,
        cookie,
        "POST",
        &format!("/api/submitProjectUpdate?projectId={id}&updateId={update}"),
        bytes.to_vec(),
        &[
            ("origin", "http://localhost:5173"),
            ("content-type", "application/octet-stream"),
            ("x-mindgrab-schema-version", "1"),
        ],
    )
    .await
}

pub(crate) async fn rpc(
    state: &Arc<AppState>,
    cookie: &str,
    method: &str,
    args: Value,
) -> (StatusCode, Value) {
    send(
        state,
        cookie,
        "POST",
        &format!("/api/{method}"),
        args.to_string().into_bytes(),
        &[("content-type", "application/json")],
    )
    .await
}

pub(crate) async fn get(
    state: &Arc<AppState>,
    cookie: &str,
    id: Uuid,
    method: &str,
) -> (StatusCode, Value) {
    rpc(state, cookie, method, json!({"projectId": id})).await
}

pub(crate) fn binary(value: &Value) -> Vec<u8> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_u64().unwrap() as u8)
        .collect()
}

pub(crate) fn javascript(input: Value) -> Value {
    let mut child = Command::new("bun")
        .args(["--bun", "server-storage.ts"])
        .current_dir(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../webapp/tests/fixtures"
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Install Bun and run mise run webapp:install");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

pub(crate) async fn process_baseline(pool: &PgPool, id: Uuid) -> Value {
    let owner: i64 = sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "project::updates::tests::restart_probe",
            "--nocapture",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = json!({"databaseUrl": pool.connect_options().to_url_lossy().as_str(), "owner": owner, "projectId": id});
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    serde_json::from_str(
        stdout
            .lines()
            .find_map(|line| line.strip_prefix("storage-probe:"))
            .unwrap(),
    )
    .unwrap()
}

#[test]
#[ignore = "subprocess entry point used by process_baseline"]
fn restart_probe() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let input: Value = serde_json::from_str(&input).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let pool = PgPool::connect(input["databaseUrl"].as_str().unwrap()).await.unwrap();
        let mut transaction = pool.begin().await.unwrap();
        let id = Uuid::parse_str(input["projectId"].as_str().unwrap()).unwrap();
        let project = lock_project(&mut transaction, id, input["owner"].as_i64().unwrap()).await.unwrap();
        let updates = load(&mut transaction, id, project.last_sequence).await.unwrap();
        let candidate = document::candidate(updates).await.unwrap();
        println!("\nstorage-probe:{}", json!({"data": STANDARD.encode(candidate.bytes), "validation": candidate.validation, "stateVector": STANDARD.encode(candidate.state_vector)}));
        std::io::stdout().flush().unwrap();
        // Exit without runtime/pool cleanup, modeling process termination.
        std::process::exit(0);
    });
}

pub(crate) async fn assert_baseline(
    state: &Arc<AppState>,
    cookie: &str,
    id: Uuid,
    expected: &Value,
) {
    let (status, baseline) = get(state, cookie, id, "getProjectBaseline").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(baseline["validation"], "valid");
    let bytes = STANDARD.decode(baseline["data"].as_str().unwrap()).unwrap();
    let js = javascript(json!({"verify": true, "updates": [bytes]}));
    assert_eq!(&js["content"], expected);
    // Also compare independent Rust materialization rather than only JS merge.
    let doc = Doc::new();
    doc.transact_mut()
        .apply_update(Update::decode_v1(&bytes).unwrap())
        .unwrap();
    let txn = doc.transact();
    let root = txn.get_map("project").unwrap();
    use yrs::types::ToJson;
    let mut json = String::new();
    root.to_json(&txn).to_json(&mut json);
    assert_eq!(&serde_json::from_str::<Value>(&json).unwrap(), expected);
    assert!(!txn.has_missing_updates());
}

#[sqlx::test]
async fn receipts_are_durable_immutable_and_idempotent_after_restart(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let update = new_id();
    let (status, receipt) = put(&f.state, &cookie, id, update, INITIAL).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        receipt,
        json!({"protocolVersion": 1, "projectId": id, "updateId": update, "sequence": "1", "sha256": digest(INITIAL), "durable": true, "validation": "valid"})
    );
    assert_eq!(
        put(&f.state, &cookie, id, update, INITIAL).await,
        (StatusCode::OK, receipt.clone())
    );
    assert_eq!(
        put(&f.state, &cookie, id, update, &[0, 0]).await.0,
        StatusCode::CONFLICT
    );
    let database = f.state.pool.connect_options();
    drop(f);
    // Fresh pool, AppState and router: reconstruction has no room/cache state.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_with((*database).clone())
        .await
        .unwrap();
    let restarted = fixture(pool).await;
    assert_eq!(
        put(&restarted.state, &cookie, id, update, INITIAL).await,
        (StatusCode::OK, receipt)
    );
    assert_eq!(
        process_baseline(&restarted.state.pool, id).await["validation"],
        "valid"
    );
    let expected: Value = serde_json::from_str(include_str!(
        "../../../../webapp/tests/fixtures/yjs/unicode.json"
    ))
    .unwrap();
    assert_baseline(&restarted.state, &cookie, id, &expected["expected"]).await;
    let forbidden = sqlx::query("UPDATE crdt_update SET data = '\\x0000' WHERE project_id = $1")
        .bind(id)
        .execute(&restarted.state.pool)
        .await;
    assert!(forbidden.is_err());
}

#[sqlx::test]
async fn rejected_updates_never_change_durable_state(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    for bytes in [
        vec![],
        vec![255],
        vec![0, 0, 9],
        vec![255, 255, 255, 255, 15],
    ] {
        let response = put(&f.state, &cookie, id, new_id(), &bytes).await;
        assert!(!response.0.is_success());
    }
    let bad = Doc::new();
    bad.get_or_insert_map("project")
        .insert(&mut bad.transact_mut(), "schemaVersion", 2);
    let response = put(
        &f.state,
        &cookie,
        id,
        new_id(),
        &bad.transact()
            .encode_state_as_update_v1(&StateVector::default()),
    )
    .await;
    assert_eq!(response.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectStatus").await.1["lastSequence"],
        "0"
    );
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectUpdates").await.1["updates"],
        json!([])
    );
    assert_eq!(
        put(&f.state, &cookie, id, new_id(), INITIAL).await.0,
        StatusCode::CREATED
    );
}

#[sqlx::test]
async fn upload_limits_cover_known_lengths_streams_and_read_failures(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let update = new_id();
    let path = format!("/api/submitProjectUpdate?projectId={id}&updateId={update}");
    let headers = [
        ("origin", "http://localhost:5173"),
        ("content-type", "application/octet-stream"),
        ("x-mindgrab-schema-version", "1"),
    ];
    // A real update awaiting clock 0 can fill the protocol bound without
    // exceeding schema text limits. Keep its original bytes and identity.
    let doc = Doc::with_client_id(1);
    let text = doc.get_or_insert_text("pending");
    text.insert(&mut doc.transact_mut(), 0, "x");
    let vector = doc.transact().state_vector();
    text.insert(
        &mut doc.transact_mut(),
        1,
        &"x".repeat(MAX_UPDATE_BYTES - 100),
    );
    let length = doc.transact().encode_state_as_update_v1(&vector).len();
    let offset = text.len(&doc.transact());
    text.insert(
        &mut doc.transact_mut(),
        offset,
        &"x".repeat(MAX_UPDATE_BYTES - length),
    );
    let bytes = doc.transact().encode_state_as_update_v1(&vector);
    assert_eq!(bytes.len(), MAX_UPDATE_BYTES);
    let stream = |bytes: &[u8]| {
        Body::from_stream(futures_util::stream::iter(
            bytes
                .chunks(8192)
                .map(|chunk| Ok::<_, std::io::Error>(Bytes::copy_from_slice(chunk)))
                .collect::<Vec<_>>(),
        ))
    };
    let length = bytes.len().to_string();
    let mut known_length = headers.to_vec();
    known_length.push(("content-length", &length));
    let (status, receipt) = send(
        &f.state,
        &cookie,
        "POST",
        &path,
        bytes.clone(),
        &known_length,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(receipt["sha256"], digest(&bytes));
    assert_eq!(receipt["durable"], true);
    assert_eq!(
        send(&f.state, &cookie, "POST", &path, stream(&bytes), &headers).await,
        (StatusCode::OK, receipt.clone())
    );
    let baseline = get(&f.state, &cookie, id, "getProjectBaseline").await;
    let path = format!(
        "/api/submitProjectUpdate?projectId={id}&updateId={}",
        new_id()
    );
    let mut oversized = bytes.clone();
    oversized.push(0);
    let too_long = oversized.len().to_string();
    let mut oversized_headers = headers.to_vec();
    oversized_headers.push(("content-length", &too_long));
    let read_failure = || {
        Body::from_stream(futures_util::stream::iter([
            Ok(Bytes::from_static(&[0])),
            Err(std::io::Error::other("injected read failure")),
        ]))
    };
    let never_read = Body::from_stream(futures_util::stream::poll_fn::<
        Result<Bytes, std::io::Error>,
        _,
    >(|_| {
        panic!("Content-Length rejection must not poll the body")
    }));
    for (body, headers) in [
        (never_read, oversized_headers.as_slice()),
        (Body::from(oversized.clone()), oversized_headers.as_slice()),
        (stream(&oversized), headers.as_slice()),
        (read_failure(), headers.as_slice()),
        (read_failure(), known_length.as_slice()),
    ] {
        let response = send(&f.state, &cookie, "POST", &path, body, headers).await;
        assert_eq!(
            response,
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error": {
                    "code": "resource_limit", "message": "The update or document exceeds a resource limit."
                }})
            )
        );
    }
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectBaseline").await,
        baseline
    );
    let stored: (Vec<u8>, i64, i64) = sqlx::query_as("SELECT data, (SELECT COUNT(*) FROM crdt_update WHERE project_id = $1), (SELECT COUNT(*) FROM crdt_receipt WHERE project_id = $1) FROM crdt_update WHERE project_id = $1")
        .bind(id).fetch_one(&f.state.pool).await.unwrap();
    assert_eq!(stored, (bytes.clone(), 1, 1));
    assert_eq!(
        put(&f.state, &cookie, id, update, &bytes).await,
        (StatusCode::OK, receipt)
    );
}

#[sqlx::test]
async fn storage_failure_including_commit_failure_has_no_receipt(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    // Deferred trigger fails at COMMIT, after both update and sequence are staged.
    sqlx::raw_sql("CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON crdt_update DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit();").execute(&f.state.pool).await.unwrap();
    let update = new_id();
    assert_eq!(
        put(&f.state, &cookie, id, update, INITIAL).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectStatus").await.1["lastSequence"],
        "0"
    );
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectUpdates").await.1["updates"],
        json!([])
    );
    sqlx::raw_sql("DROP TRIGGER fail_commit ON crdt_update; DROP FUNCTION fail_commit();")
        .execute(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(
        put(&f.state, &cookie, id, update, INITIAL).await.1["sequence"],
        "1"
    );
}

#[sqlx::test]
async fn every_read_and_submission_checks_ownership_and_upload_headers(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let other = session_for(&f, "other_user").await;
    let id = register(&f.state, &cookie).await;
    for (session, expected) in [
        ("", StatusCode::UNAUTHORIZED),
        (other.as_str(), StatusCode::NOT_FOUND),
    ] {
        assert_eq!(
            put(&f.state, session, id, new_id(), INITIAL).await.0,
            expected
        );
        for endpoint in [
            "getProjectBaseline",
            "getProjectStatus",
            "getProjectUpdates",
        ] {
            assert_eq!(get(&f.state, session, id, endpoint).await.0, expected);
        }
    }
    let query = format!("projectId={id}&updateId={}", new_id());
    let valid = query.as_str();
    // Header errors follow authentication, account fencing and query IDs.
    for (session, query, headers, status, code) in [
        ("", valid, vec![], 401, "unauthenticated"),
        (&cookie, "", vec![], 400, "invalid_request"),
        (
            &cookie,
            "projectId=invalid&updateId=invalid",
            vec![],
            400,
            "invalid_project_id",
        ),
        (
            &cookie,
            valid,
            vec![("x-mindgrab-account", "9223372036854775807")],
            409,
            "account_changed",
        ),
        (&cookie, valid, vec![], 426, "unsupported_schema"),
        (
            &cookie,
            valid,
            vec![("x-mindgrab-schema-version", "2")],
            426,
            "unsupported_schema",
        ),
        (
            &cookie,
            valid,
            vec![("x-mindgrab-schema-version", "1")],
            400,
            "invalid_request",
        ),
        (
            &cookie,
            valid,
            vec![
                ("x-mindgrab-schema-version", "1"),
                ("content-type", "application/json"),
            ],
            400,
            "invalid_request",
        ),
    ] {
        let mut headers = headers;
        headers.push(("origin", "http://localhost:5173"));
        for (size, known_length) in [
            (0, false),
            (MAX_UPDATE_BYTES + 1, false),
            (MAX_UPDATE_BYTES + 1, true),
        ] {
            let length = size.to_string();
            let mut headers = headers.clone();
            if known_length {
                headers.push(("content-length", &length));
            }
            let response = send(
                &f.state,
                session,
                "POST",
                &format!("/api/submitProjectUpdate?{query}"),
                vec![255; size],
                &headers,
            )
            .await;
            assert_eq!(response.0.as_u16(), status);
            assert_eq!(response.1["error"]["code"], code);
        }
    }
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectStatus").await.1["lastSequence"],
        "0"
    );
}

#[sqlx::test]
async fn concurrent_writers_allocate_gapless_sequences_and_deduplicate_retries(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let mut tasks = tokio::task::JoinSet::new();
    let updates: Vec<_> = (0..8).map(|_| new_id()).collect();
    for update in updates.into_iter().cycle().take(24) {
        let state = f.state.clone();
        let cookie = cookie.clone();
        tasks.spawn(async move { put(&state, &cookie, id, update, INITIAL).await });
    }
    let results = tasks.join_all().await;
    assert_eq!(
        results
            .iter()
            .filter(|r| r.0 == StatusCode::CREATED)
            .count(),
        8
    );
    assert!(results.iter().all(|r| r.0.is_success()));
    let mut cursor = "0".to_string();
    let mut sequences = Vec::new();
    loop {
        let page = rpc(
            &f.state,
            &cookie,
            "getProjectUpdates",
            json!({"projectId": id, "after": cursor, "limit": 3}),
        )
        .await
        .1;
        sequences.extend(
            page["updates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["sequence"].as_str().unwrap().to_owned()),
        );
        cursor = page["nextAfter"].as_str().unwrap().into();
        if page["hasMore"] == false {
            break;
        }
    }
    assert_eq!(
        sequences,
        (1..=8).map(|n| n.to_string()).collect::<Vec<_>>()
    );
    for args in [
        json!({"projectId": id, "after": "-1"}),
        json!({"projectId": id, "after": "01"}),
        json!({"projectId": id, "limit": 0}),
        json!({"projectId": id, "limit": 101}),
        json!({"projectId": id, "unknown": 1}),
    ] {
        assert_eq!(
            rpc(&f.state, &cookie, "getProjectUpdates", args).await.0,
            StatusCode::BAD_REQUEST
        );
    }
}

#[sqlx::test]
async fn causal_gap_regressions_survive_restart_and_converge_in_js_and_rust(pool: PgPool) {
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
        assert_eq!(
            put(&f.state, &cookie, id, new_id(), &binary(&data["initial"]))
                .await
                .0,
            StatusCode::CREATED
        );
        for index in order {
            let update = new_id();
            let bytes = binary(&data["causal"][index]);
            let original = put(&f.state, &cookie, id, update, &bytes).await;
            assert_eq!(original.0, StatusCode::CREATED);
            // Read/reconstruct between arrivals, and retry the exact receipt.
            let baseline = get(&f.state, &cookie, id, "getProjectBaseline").await;
            assert_eq!(baseline.0, StatusCode::OK);
            let restarted = process_baseline(&f.state.pool, id).await;
            assert_eq!(
                javascript(
                    json!({"inspect": true, "updates": [STANDARD.decode(restarted["data"].as_str().unwrap()).unwrap()]})
                ),
                javascript(
                    json!({"inspect": true, "updates": [STANDARD.decode(baseline.1["data"].as_str().unwrap()).unwrap()]})
                )
            );
            assert_eq!(restarted["validation"], baseline.1["validation"]);
            assert_eq!(
                put(&f.state, &cookie, id, update, &bytes).await.1,
                original.1
            );
        }
        assert_baseline(&f.state, &cookie, id, &data["causalExpected"]).await;
    }
    let id = register(&f.state, &cookie).await;
    put(&f.state, &cookie, id, new_id(), &binary(&data["gapBase"])).await;
    let update = new_id();
    let gapped = binary(&data["gapped"]);
    let receipt = put(&f.state, &cookie, id, update, &gapped).await.1;
    assert_eq!(receipt["validation"], "pending_dependencies");
    let baseline = get(&f.state, &cookie, id, "getProjectBaseline").await.1;
    assert_eq!(baseline["validation"], "pending_dependencies");
    let probe = process_baseline(&f.state.pool, id).await;
    assert_eq!(
        javascript(
            json!({"inspect": true, "updates": [STANDARD.decode(probe["data"].as_str().unwrap()).unwrap()]})
        ),
        javascript(
            json!({"inspect": true, "updates": [STANDARD.decode(baseline["data"].as_str().unwrap()).unwrap()]})
        )
    );
    let pool = f.state.pool.clone();
    drop(f);
    let restarted = fixture(pool).await;
    assert_eq!(
        put(&restarted.state, &cookie, id, update, &gapped).await.1,
        receipt
    );
    put(
        &restarted.state,
        &cookie,
        id,
        new_id(),
        &binary(&data["predecessor"]),
    )
    .await;
    assert_baseline(&restarted.state, &cookie, id, &data["gapExpected"]).await;
    // A peer bootstrapped while the hole was open receives the missing bytes later.
    let forward = javascript(
        json!({"verify": true, "updates": [STANDARD.decode(baseline["data"].as_str().unwrap()).unwrap(), binary(&data["predecessor"])]}),
    );
    assert_eq!(forward["content"], data["gapExpected"]);
    assert_eq!(
        get(&restarted.state, &cookie, id, "getProjectStatus")
            .await
            .1["validation"],
        "valid"
    );
    assert_eq!(
        put(&restarted.state, &cookie, id, update, &gapped).await.1,
        receipt
    );
}

#[sqlx::test]
async fn delete_only_updates_are_durable_even_when_state_vectors_match(pool: PgPool) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(
        &f.state,
        &cookie,
        id,
        new_id(),
        &binary(&data["deleteBase"]),
    )
    .await;
    let before = get(&f.state, &cookie, id, "getProjectBaseline").await.1;
    let deletion = binary(&data["deletion"]);
    assert!(
        Update::decode_v1(&deletion)
            .unwrap()
            .state_vector()
            .is_empty()
    );
    let receipt = put(&f.state, &cookie, id, new_id(), &deletion).await.1;
    assert_eq!(receipt["sequence"], "2");
    let after = get(&f.state, &cookie, id, "getProjectBaseline").await.1;
    assert_eq!(before["stateVector"], after["stateVector"]);
    assert_baseline(&f.state, &cookie, id, &data["deleteExpected"]).await;
}

#[sqlx::test]
async fn reconstruction_uses_checkpoint_and_committed_tail(pool: PgPool) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let initial = binary(&data["initial"]);
    put(&f.state, &cookie, id, new_id(), &initial).await;
    let owner: i64 = sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert!(
        maintenance::compact(&f.state.pool, owner, id)
            .await
            .unwrap()
            .coverage
    );
    for update in data["causal"].as_array().unwrap().iter().rev() {
        put(&f.state, &cookie, id, new_id(), &binary(update)).await;
    }
    assert_baseline(&f.state, &cookie, id, &data["causalExpected"]).await;
}

#[sqlx::test]
async fn pending_invalid_content_is_retained_and_quarantined_when_dependencies_arrive(
    pool: PgPool,
) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    assert_eq!(
        put(
            &f.state,
            &cookie,
            id,
            new_id(),
            &binary(&data["invalidBase"])
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let update = new_id();
    let pending = binary(&data["invalidPending"]);
    let receipt = put(&f.state, &cookie, id, update, &pending).await.1;
    assert_eq!(receipt["validation"], "pending_dependencies");
    let resolving = put(&f.state, &cookie, id, new_id(), &binary(&data["withheld"])).await;
    assert_eq!(resolving.0, StatusCode::CREATED);
    assert_eq!(resolving.1["validation"], "quarantined");
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectStatus").await.1["validation"],
        "quarantined"
    );
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectBaseline").await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectUpdates").await.1["updates"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        put(&f.state, &cookie, id, update, &pending).await,
        (StatusCode::OK, receipt)
    );
    assert_eq!(
        put(&f.state, &cookie, id, new_id(), &[0, 0]).await.0,
        StatusCode::CONFLICT
    );
}

#[sqlx::test]
async fn complete_candidates_enforce_schema_and_content_limits(pool: PgPool) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    for case in data["limits"].as_array().unwrap() {
        let id = register(&f.state, &cookie).await;
        let result = put(&f.state, &cookie, id, new_id(), &binary(&case["bytes"])).await;
        assert_eq!(
            u64::from(result.0.as_u16()),
            case["status"].as_u64().unwrap(),
            "{result:?}"
        );
        assert_eq!(
            get(&f.state, &cookie, id, "getProjectStatus").await.1["lastSequence"],
            "0"
        );
    }
}

#[sqlx::test]
async fn every_golden_fixture_converges_through_shuffled_duplicate_api_delivery(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let directory = std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../webapp/tests/fixtures/yjs"
    ));
    for file in std::fs::read_dir(directory).unwrap() {
        let file = file.unwrap().path();
        if file.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let fixture: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        let id = register(&f.state, &cookie).await;
        let owner: i64 = sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
            .bind(id)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
        for update in fixture["updates"].as_array().unwrap().iter().rev() {
            let bytes = std::fs::read(directory.join(update.as_str().unwrap())).unwrap();
            let update_id = new_id();
            let receipt = put(&f.state, &cookie, id, update_id, &bytes).await;
            assert_eq!(
                receipt.0,
                StatusCode::CREATED,
                "{}: {receipt:?}",
                file.display()
            );
            maintenance::compact(&f.state.pool, owner, id)
                .await
                .unwrap();
            assert_eq!(
                put(&f.state, &cookie, id, update_id, &bytes).await.1,
                receipt.1
            );
        }
        assert_baseline(&f.state, &cookie, id, &fixture["expected"]).await;
    }
}

#[test]
fn binary_preflight_rejects_amplification_nesting_overflow_and_trailing_bytes() {
    // Huge declared client/struct/Any lengths are rejected before Yrs allocation.
    for bytes in [
        vec![255, 255, 255, 255, 15],
        vec![1, 255, 255, 255, 255, 15],
        vec![0, 0, 1],
    ] {
        assert!(wire::preflight(&bytes).is_err());
    }
    let mut nested = vec![1, 1, 1, 0, 40, 1, 1, b'm', 1, b'k', 1];
    for _ in 0..18 {
        nested.extend([117, 1]);
    }
    nested.extend([126, 0]);
    assert!(matches!(
        wire::preflight(&nested),
        Err(ApiError::ResourceLimit)
    ));
    let overflow = [1, 1, 1, 255, 255, 255, 255, 15, 0, 1, 0];
    assert!(matches!(
        wire::preflight(&overflow),
        Err(ApiError::InvalidUpdate)
    ));
}

#[test]
fn merged_reconstruction_handles_upstream_670_in_both_transaction_modes() {
    // Exact topology from the report, independent of the domain schema wrapper.
    for batch in [false, true] {
        let source = Doc::with_client_id(1);
        let a = source.get_or_insert_text("a");
        let b = source.get_or_insert_text("b");
        let mut updates = Vec::new();
        for (text, index, value) in [(&a, 0, "A"), (&a, 1, "B"), (&b, 0, "C")] {
            let mut txn = source.transact_mut();
            text.insert(&mut txn, index, value);
            updates.push(txn.encode_update_v1());
        }
        for order in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ] {
            let merged = Update::merge_updates(
                order
                    .into_iter()
                    .chain(order)
                    .map(|i| Update::decode_v1(&updates[i]).unwrap()),
            );
            let doc = Doc::new();
            if batch {
                let mut txn = doc.transact_mut();
                txn.apply_update(merged).unwrap();
            } else {
                doc.transact_mut().apply_update(merged).unwrap();
            }
            use yrs::GetString;
            assert_eq!(
                doc.get_or_insert_text("a").get_string(&doc.transact()),
                "AB"
            );
            assert_eq!(doc.get_or_insert_text("b").get_string(&doc.transact()), "C");
            assert!(!doc.transact().has_missing_updates());
        }
    }
}
