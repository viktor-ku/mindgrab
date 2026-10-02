use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use sqlx::PgPool;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    WebSocketStream, connect_async,
    tungstenite::{Message as WsMessage, client::IntoClientRequest},
};
use yrs::{Doc, GetString, Map, ReadTxn, Text, Transact, Update};

use super::*;
use crate::auth::tests::{fixture, session_for, sign_in};
use crate::project::updates::tests::{INITIAL, binary, get, javascript, new_id, put, register};
use crate::response_headers::assert_private_headers;

type Client = WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;
struct Server {
    address: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server(state: Arc<AppState>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("ws://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, crate::router(state)).await.unwrap();
    });
    Server { address, task }
}
fn request(
    server: &Server,
    cookie: &str,
    id: Uuid,
    origin: Option<&str>,
) -> axum::http::Request<()> {
    let mut request = format!("{}/sync/v1/{id}", server.address)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("cookie", cookie.parse().unwrap());
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("origin", origin.parse().unwrap());
    }
    request
}
async fn connect(server: &Server, cookie: &str, id: Uuid) -> Client {
    let (socket, response) =
        connect_async(request(server, cookie, id, Some("http://localhost:5173")))
            .await
            .unwrap();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SWITCHING_PROTOCOLS
    );
    assert_private_headers(response.headers());
    socket
}
async fn message(socket: &mut Client) -> WsMessage {
    timeout(Duration::from_secs(8), socket.next())
        .await
        .expect("socket timeout")
        .unwrap()
        .unwrap()
}
async fn protocol(socket: &mut Client) -> ProtocolMessage {
    let WsMessage::Binary(bytes) = message(socket).await else {
        panic!("Expected binary sync message")
    };
    ProtocolMessage::decode_v1(&bytes).unwrap()
}
async fn send_update(socket: &mut Client, bytes: &[u8]) {
    socket
        .send(WsMessage::Binary(
            ProtocolMessage::Sync(SyncMessage::Update(bytes.to_vec()))
                .encode_v1()
                .into(),
        ))
        .await
        .unwrap();
}
async fn bootstrap(socket: &mut Client, doc: &Doc) {
    if let ProtocolMessage::Sync(SyncMessage::Update(bytes)) = protocol(socket).await {
        doc.transact_mut()
            .apply_update(Update::decode_v1(&bytes).unwrap())
            .unwrap();
        assert!(matches!(
            protocol(socket).await,
            ProtocolMessage::Sync(SyncMessage::SyncStep1(_))
        ));
    } else {
        panic!("Expected baseline")
    }
}
async fn receive_update(socket: &mut Client) -> Vec<u8> {
    match protocol(socket).await {
        ProtocolMessage::Sync(SyncMessage::Update(bytes)) => bytes,
        _ => panic!("Expected update"),
    }
}

#[sqlx::test]
async fn independent_instances_forward_committed_http_and_socket_updates_and_reconnect(
    pool: PgPool,
) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(&f.state, &cookie, id, new_id(), INITIAL).await;
    let a_server = server(f.state.clone()).await;
    let b_server = server(f.state.clone()).await;
    let mut a = connect(&a_server, &cookie, id).await;
    let mut b = connect(&b_server, &cookie, id).await;
    let a_doc = Doc::with_client_id(11);
    let b_doc = Doc::with_client_id(12);
    bootstrap(&mut a, &a_doc).await;
    bootstrap(&mut b, &b_doc).await;
    let text = |doc: &Doc| {
        let txn = doc.transact();
        let root = txn.get_map("project").unwrap();
        let yrs::Out::YMap(nodes) = root.get(&txn, "nodes").unwrap() else {
            panic!()
        };
        let yrs::Out::YMap(node) = nodes
            .get(&txn, "20000000-0000-4000-8000-000000000001")
            .unwrap()
        else {
            panic!()
        };
        let yrs::Out::YText(text) = node.get(&txn, "text").unwrap() else {
            panic!()
        };
        text
    };
    let a_text = text(&a_doc);
    let b_text = text(&b_doc);
    let update = {
        let mut txn = a_doc.transact_mut();
        a_text.insert(&mut txn, 0, "A😀");
        txn.encode_update_v1()
    };
    send_update(&mut a, &update).await;
    let received = receive_update(&mut b).await;
    assert_eq!(received, update);
    b_doc
        .transact_mut()
        .apply_update(Update::decode_v1(&received).unwrap())
        .unwrap();
    assert_eq!(
        a_text.get_string(&a_doc.transact()),
        b_text.get_string(&b_doc.transact())
    );
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectStatus").await.1["lastSequence"],
        "2"
    );
    receive_update(&mut a).await;
    // Concurrent tree change from the second instance and text from the first.
    let tree = {
        let mut txn = b_doc.transact_mut();
        let root = txn.get_map("project").unwrap();
        let yrs::Out::YMap(meta) = root.get(&txn, "metadata").unwrap() else {
            panic!()
        };
        meta.insert(&mut txn, "name", "Renamed");
        txn.encode_update_v1()
    };
    let edit = {
        let mut txn = a_doc.transact_mut();
        a_text.insert(&mut txn, 0, "Concurrent");
        txn.encode_update_v1()
    };
    send_update(&mut b, &tree).await;
    send_update(&mut a, &edit).await;
    for _ in 0..2 {
        a_doc
            .transact_mut()
            .apply_update(Update::decode_v1(&receive_update(&mut a).await).unwrap())
            .unwrap();
        b_doc
            .transact_mut()
            .apply_update(Update::decode_v1(&receive_update(&mut b).await).unwrap())
            .unwrap();
    }
    assert_eq!(
        javascript(
            json!({"verify": true, "updates": [a_doc.transact().encode_state_as_update_v1(&StateVector::default())]})
        ),
        javascript(
            json!({"verify": true, "updates": [b_doc.transact().encode_state_as_update_v1(&StateVector::default())]})
        )
    );
    // A duplicate is harmless CRDT content, even with a distinct transport ID.
    send_update(&mut a, &update).await;
    receive_update(&mut a).await;
    receive_update(&mut b).await;
    // HTTP pure deletion has no new struct clock: still forwarded by sequence.
    let deletion = {
        let mut txn = a_doc.transact_mut();
        a_text.remove_range(&mut txn, 0, 1);
        txn.encode_update_v1()
    };
    assert!(
        Update::decode_v1(&deletion)
            .unwrap()
            .state_vector()
            .is_empty()
    );
    assert_eq!(
        put(&f.state, &cookie, id, new_id(), &deletion).await.0,
        axum::http::StatusCode::CREATED
    );
    assert_eq!(receive_update(&mut b).await, deletion);
    // Restart the server (no room survives), reconnect and reconstruct in JS.
    drop(a);
    drop(b);
    drop(a_server);
    drop(b_server);
    let restarted = server(f.state.clone()).await;
    let mut socket = connect(&restarted, &cookie, id).await;
    let reconstructed = Doc::new();
    bootstrap(&mut socket, &reconstructed).await;
    assert_eq!(
        javascript(
            json!({"verify": true, "updates": [reconstructed.transact().encode_state_as_update_v1(&StateVector::default())]})
        )["content"],
        javascript(
            json!({"verify": true, "updates": [a_doc.transact().encode_state_as_update_v1(&StateVector::default())]})
        )["content"]
    );
    // State vector handshake emits a step2 containing delete sets as well.
    socket
        .send(WsMessage::Binary(
            ProtocolMessage::Sync(SyncMessage::SyncStep1(a_doc.transact().state_vector()))
                .encode_v1()
                .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        protocol(&mut socket).await,
        ProtocolMessage::Sync(SyncMessage::SyncStep2(_))
    ));
}

#[sqlx::test]
async fn upgrades_reject_wrong_owner_session_origin_and_schema(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let other = session_for(&f, "other_user").await;
    let id = register(&f.state, &cookie).await;
    let server = server(f.state.clone()).await;
    for (cookie, origin, expected) in [
        ("", Some("http://localhost:5173"), 401),
        (other.as_str(), Some("http://localhost:5173"), 404),
        (cookie.as_str(), Some("https://evil.example"), 403),
        (cookie.as_str(), None, 403),
    ] {
        let error = connect_async(request(&server, cookie, id, origin))
            .await
            .unwrap_err();
        let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
            panic!("{error}")
        };
        assert_eq!(response.status().as_u16(), expected);
        assert_private_headers(response.headers());
    }
    sqlx::query("UPDATE crdt_project SET schema_version = 2 WHERE id = $1")
        .bind(id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let error = connect_async(request(&server, &cookie, id, Some("http://localhost:5173")))
        .await
        .unwrap_err();
    let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
        panic!()
    };
    assert_eq!(response.status().as_u16(), 426);
    assert_private_headers(response.headers());
}

#[sqlx::test]
async fn expired_session_closes_idle_socket_and_never_delivers_or_accepts_more_content(
    pool: PgPool,
) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let server = server(f.state.clone()).await;
    let mut socket = connect(&server, &cookie, id).await;
    assert!(matches!(
        protocol(&mut socket).await,
        ProtocolMessage::Sync(SyncMessage::SyncStep1(_))
    ));
    sqlx::query("UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 second'")
        .execute(&f.state.pool)
        .await
        .unwrap();
    let WsMessage::Close(Some(frame)) = message(&mut socket).await else {
        panic!()
    };
    assert_eq!(u16::from(frame.code), 1008);
    let other = session_for(&f, "other_user").await;
    let other_id = register(&f.state, &other).await;
    let mut socket = connect(&server, &other, other_id).await;
    protocol(&mut socket).await;
    sqlx::query("DELETE FROM auth_sessions")
        .execute(&f.state.pool)
        .await
        .unwrap();
    send_update(&mut socket, INITIAL).await;
    assert!(matches!(message(&mut socket).await, WsMessage::Close(_)));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM crdt_update")
            .fetch_one(&f.state.pool)
            .await
            .unwrap(),
        0
    );
}

#[sqlx::test]
async fn failed_commit_never_reaches_another_socket_and_retry_recovers(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let server = server(f.state.clone()).await;
    let mut a = connect(&server, &cookie, id).await;
    let mut b = connect(&server, &cookie, id).await;
    protocol(&mut a).await;
    protocol(&mut b).await;
    sqlx::raw_sql("CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END; $$; CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON crdt_update DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit();").execute(&f.state.pool).await.unwrap();
    send_update(&mut a, INITIAL).await;
    let WsMessage::Close(Some(frame)) = message(&mut a).await else {
        panic!()
    };
    assert_eq!(u16::from(frame.code), 1013);
    assert!(timeout(Duration::from_millis(600), b.next()).await.is_err());
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectStatus").await.1["lastSequence"],
        "0"
    );
    sqlx::raw_sql("DROP TRIGGER fail_commit ON crdt_update; DROP FUNCTION fail_commit();")
        .execute(&f.state.pool)
        .await
        .unwrap();
    put(&f.state, &cookie, id, new_id(), INITIAL).await;
    assert_eq!(receive_update(&mut b).await, INITIAL);
}

#[sqlx::test]
async fn malformed_and_oversized_clients_are_isolated_and_awareness_is_not_persisted(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let server = server(f.state.clone()).await;
    let mut healthy = connect(&server, &cookie, id).await;
    protocol(&mut healthy).await;
    for payload in [
        vec![0],
        vec![0, 0, 1, 255],
        vec![0, 2, 2, 0, 0, 1],
        vec![0, 2, 1, 255],
        vec![0; MAX_FRAME + 1],
    ] {
        let mut bad = connect(&server, &cookie, id).await;
        protocol(&mut bad).await;
        bad.send(WsMessage::Binary(payload.into())).await.unwrap();
        assert!(matches!(message(&mut bad).await, WsMessage::Close(_)));
    }
    healthy
        .send(WsMessage::Binary(vec![1, 1, 0].into()))
        .await
        .unwrap();
    healthy
        .send(WsMessage::Binary(vec![3].into()))
        .await
        .unwrap();
    send_update(&mut healthy, &[0, 0]).await;
    send_update(&mut healthy, INITIAL).await;
    assert_eq!(receive_update(&mut healthy).await, INITIAL);
    assert_eq!(
        get(&f.state, &cookie, id, "getProjectStatus").await.1["lastSequence"],
        "1"
    );
}

#[sqlx::test]
async fn pending_originals_reach_peers_before_and_after_dependencies_arrive(pool: PgPool) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(&f.state, &cookie, id, new_id(), &binary(&data["gapBase"])).await;
    let server = server(f.state.clone()).await;
    let mut socket = connect(&server, &cookie, id).await;
    let baseline = receive_update(&mut socket).await;
    protocol(&mut socket).await;
    let gapped = binary(&data["gapped"]);
    put(&f.state, &cookie, id, new_id(), &gapped).await;
    assert_eq!(receive_update(&mut socket).await, gapped);
    let mut reconnect = connect(&server, &cookie, id).await;
    let pending = receive_update(&mut reconnect).await;
    protocol(&mut reconnect).await;
    assert!(
        javascript(json!({"inspect": true, "updates": [pending.clone()]}))["pending"]
            .as_bool()
            .unwrap()
    );
    let predecessor = binary(&data["predecessor"]);
    send_update(&mut socket, &predecessor).await;
    let resolving = receive_update(&mut reconnect).await;
    assert_eq!(resolving, predecessor);
    assert_eq!(
        javascript(json!({"verify": true, "updates": [pending, resolving]}))["content"],
        data["gapExpected"]
    );
    assert_eq!(
        javascript(json!({"verify": true, "updates": [baseline, gapped, predecessor]}))["content"],
        data["gapExpected"]
    );
}

#[test]
fn wire_bounds_state_vectors_and_rejects_trailing_unknown_and_overflow_frames() {
    for bytes in [
        vec![],
        vec![0, 0, 5, 255, 255, 255, 255, 15],
        vec![0, 0, 2, 1, 0],
        vec![0, 9, 0],
        vec![3, 0],
        vec![2],
        vec![255, 255, 255, 255, 255, 1],
    ] {
        assert!(wire::decode(&bytes).is_err());
    }
    assert!(matches!(
        wire::decode(&[0, 0, 1, 0]).unwrap(),
        wire::Frame::Step1(_)
    ));
}

#[sqlx::test]
async fn pinned_y_websocket_providers_converge_after_offline_text_and_tree_edits(pool: PgPool) {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let server = server(f.state.clone()).await;
    let input = json!({"serverUrl": format!("{}/sync/v1", server.address), "projectId": id, "cookie": cookie});
    let result = tokio::task::spawn_blocking(move || {
        let mut child = Command::new("bun")
            .args(["--bun", "server-websocket.ts"])
            .current_dir(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../webapp/tests/fixtures"
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
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
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    })
    .await
    .unwrap();
    assert_eq!(result["converged"], true);
    let owner: i64 = sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    let baseline = updates::synchronization_baseline(&f.state.pool, owner, id)
        .await
        .unwrap();
    assert_eq!(
        javascript(json!({"verify": true, "updates": [baseline.bytes]}))["content"],
        result["content"]
    );
}

#[sqlx::test]
async fn slow_reader_times_out_without_blocking_another_room_or_losing_content(pool: PgPool) {
    let data = javascript(json!({"large": true}));
    let checkpoint = binary(&data["checkpoint"]);
    assert!(checkpoint.len() > 8_000_000);
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(&f.state, &cookie, id, new_id(), INITIAL).await;
    use sha2::{Digest, Sha256};
    let digest: String = Sha256::digest(&checkpoint)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    // Model a valid full-state checkpoint without spending this test on
    // 256 separate ingestion/reconstruction operations.
    sqlx::query("INSERT INTO crdt_checkpoint (project_id, covered_sequence, data, sha256) VALUES ($1, 1, $2, $3)").bind(id).bind(&checkpoint).bind(digest).execute(&f.state.pool).await.unwrap();
    let server = server(f.state.clone()).await;
    let stream = TcpStream::connect(server.address.trim_start_matches("ws://"))
        .await
        .unwrap();
    socket2::SockRef::from(&stream)
        .set_recv_buffer_size(1024)
        .unwrap();
    let (mut slow, _) = tokio_tungstenite::client_async(
        request(&server, &cookie, id, Some("http://localhost:5173")),
        stream,
    )
    .await
    .unwrap();
    // Leave the receive window closed while the 8 MiB bootstrap is written.
    let other = register(&f.state, &cookie).await;
    let mut healthy = connect(&server, &cookie, other).await;
    protocol(&mut healthy).await;
    send_update(&mut healthy, INITIAL).await;
    assert_eq!(receive_update(&mut healthy).await, INITIAL);
    // Keep the receive window closed through both bounded writes. Observe the
    // actual socket termination, not the process-global connection count (other
    // tests may release their permits concurrently).
    tokio::time::sleep(IO_TIMEOUT + IO_TIMEOUT + Duration::from_secs(1)).await;
    socket2::SockRef::from(slow.get_ref())
        .set_recv_buffer_size(1_048_576)
        .unwrap();
    let result = timeout(Duration::from_secs(8), slow.next())
        .await
        .expect("slow socket was not dropped");
    assert!(
        matches!(result, None | Some(Err(_)) | Some(Ok(WsMessage::Close(_)))),
        "slow socket continued sending after its write deadline"
    );
    drop(slow);
    let mut reconnect = connect(&server, &cookie, id).await;
    let received = receive_update(&mut reconnect).await;
    assert!(received.len() > 8_000_000);
    let doc = Doc::new();
    doc.transact_mut()
        .apply_update(Update::decode_v1(&received).unwrap())
        .unwrap();
    let txn = doc.transact();
    let root = txn.get_map("project").unwrap();
    let yrs::Out::YMap(nodes) = root.get(&txn, "nodes").unwrap() else {
        panic!()
    };
    assert_eq!(nodes.len(&txn), 259);
    let yrs::Out::YMap(node) = nodes
        .get(&txn, "20000000-0000-4000-8000-000000000265")
        .unwrap()
    else {
        panic!()
    };
    let yrs::Out::YText(text) = node.get(&txn, "text").unwrap() else {
        panic!()
    };
    assert_eq!(text.len(&txn), 32_000);
    assert!(!txn.has_missing_updates());
}

struct ProcessServer {
    server: Server,
    child: std::process::Child,
}
impl Drop for ProcessServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
async fn process_server(pool: &PgPool) -> ProcessServer {
    use sqlx::ConnectOptions;
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };
    let database = pool.connect_options().to_url_lossy().to_string();
    tokio::task::spawn_blocking(move || {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "project::sync::tests::sync_process_probe",
                "--nocapture",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(database.as_bytes())
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stdout = BufReader::new(stdout);
        let address = loop {
            let mut line = String::new();
            assert!(
                stdout.read_line(&mut line).unwrap() > 0,
                "Sync child exited before startup"
            );
            if let Some(address) = line.trim().strip_prefix("sync-process:") {
                break address.to_owned();
            }
        };
        ProcessServer {
            server: Server {
                address,
                task: tokio::spawn(async {}),
            },
            child,
        }
    })
    .await
    .unwrap()
}

#[test]
#[ignore = "subprocess entry point for real multi-process/restart verification"]
fn sync_process_probe() {
    use std::io::{Read, Write};
    let mut database = String::new();
    std::io::stdin().read_to_string(&mut database).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let pool = PgPool::connect(&database).await.unwrap();
        let f = fixture(pool).await;
        let server = server(f.state.clone()).await;
        println!("\nsync-process:{}", server.address);
        std::io::stdout().flush().unwrap();
        std::future::pending::<()>().await;
    });
}

#[sqlx::test]
async fn two_processes_and_a_killed_restarted_process_converge_from_postgres(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let local = server(f.state.clone()).await;
    let remote = process_server(&f.state.pool).await;
    let mut a = connect(&local, &cookie, id).await;
    let mut b = connect(&remote.server, &cookie, id).await;
    protocol(&mut a).await;
    protocol(&mut b).await;
    send_update(&mut a, INITIAL).await;
    assert_eq!(receive_update(&mut b).await, INITIAL);
    drop(remote); // Kill the entire sync process; no clean room flush is possible.
    let restarted = process_server(&f.state.pool).await;
    let mut socket = connect(&restarted.server, &cookie, id).await;
    let restarted_bytes = receive_update(&mut socket).await;
    assert_eq!(
        javascript(json!({"verify": true, "updates": [restarted_bytes]}))["content"],
        javascript(json!({"verify": true, "updates": [INITIAL]}))["content"]
    );
    protocol(&mut socket).await;
    let data = javascript(json!({}));
    // A commit accepted in the restarted process reaches the surviving process.
    // Use a second room with the generated causal fixture's matching base.
    let other_id = register(&f.state, &cookie).await;
    put(
        &f.state,
        &cookie,
        other_id,
        new_id(),
        &binary(&data["initial"]),
    )
    .await;
    let mut receiver = connect(&local, &cookie, other_id).await;
    receive_update(&mut receiver).await;
    protocol(&mut receiver).await;
    let mut writer = connect(&restarted.server, &cookie, other_id).await;
    receive_update(&mut writer).await;
    protocol(&mut writer).await;
    let update = binary(&data["causal"][0]);
    send_update(&mut writer, &update).await;
    assert_eq!(receive_update(&mut receiver).await, update);
    // Neither project receives the other's traffic.
    assert!(
        timeout(Duration::from_millis(600), socket.next())
            .await
            .is_err()
    );
}

#[sqlx::test]
async fn transient_auth_failure_closes_retryably_and_preserves_session_for_reconnect(pool: PgPool) {
    use crate::auth::tests::{expire_access_token, refresh_status};
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let server = server(f.state.clone()).await;
    let mut socket = connect(&server, &cookie, id).await;
    protocol(&mut socket).await;
    expire_access_token(&f).await;
    refresh_status(&f, 503);
    send_update(&mut socket, INITIAL).await;
    let WsMessage::Close(Some(frame)) = message(&mut socket).await else {
        panic!()
    };
    assert_eq!(u16::from(frame.code), 1013);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM auth_sessions")
            .fetch_one(&f.state.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM crdt_update")
            .fetch_one(&f.state.pool)
            .await
            .unwrap(),
        0
    );
    refresh_status(&f, 0);
    let mut reconnect = connect(&server, &cookie, id).await;
    protocol(&mut reconnect).await;
    send_update(&mut reconnect, INITIAL).await;
    assert_eq!(receive_update(&mut reconnect).await, INITIAL);
}

#[sqlx::test]
async fn schema_change_fences_an_already_connected_client(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    let server = server(f.state.clone()).await;
    let mut socket = connect(&server, &cookie, id).await;
    protocol(&mut socket).await;
    sqlx::query("UPDATE crdt_project SET schema_version = 2 WHERE id = $1")
        .bind(id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let WsMessage::Close(Some(frame)) = message(&mut socket).await else {
        panic!()
    };
    assert_eq!(u16::from(frame.code), 1008);
}

#[sqlx::test]
#[ignore = "Run mise run webapp:test:cloud; requires Chromium"]
async fn browser_cloud_sync_recovers_offline_tabs_receipts_deletes_and_large_batches(pool: PgPool) {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let server = server(f.state.clone()).await;
    let owner: i64 = sqlx::query_scalar("SELECT id FROM users ORDER BY id LIMIT 1")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    let input = json!({"serverUrl": server.address, "cookie": cookie, "ownerId": owner});
    let result = tokio::task::spawn_blocking(move || {
        let mut child = Command::new("bun")
            .args(["--bun", "tests/browser/cloud.integration.ts"])
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../webapp"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    })
    .await
    .unwrap();
    assert_eq!(result["converged"], true);
    assert_eq!(result["nodes"], 29);
    let id: Uuid = result["projectId"].as_str().unwrap().parse().unwrap();
    let owner: i64 = sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    let baseline = updates::synchronization_baseline(&f.state.pool, owner, id)
        .await
        .unwrap();
    assert_eq!(baseline.validation, "valid");
}

#[sqlx::test]
async fn socket_account_expectation_rejects_a_changed_cookie_before_upgrade(pool: PgPool) {
    let f = fixture(pool).await;
    sign_in(&f).await;
    let b = session_for(&f, "user_socket_other").await;
    let owner_a: i64 = sqlx::query_scalar("SELECT id FROM users WHERE external_id = 'user_test'")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    let server = server(f.state.clone()).await;
    let id = register(&f.state, &b).await;
    let mut req = request(&server, &b, id, Some("http://localhost:5173"));
    *req.uri_mut() = format!("{}/sync/v1/{id}?ownerId={owner_a}", server.address)
        .parse()
        .unwrap();
    match connect_async(req).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), axum::http::StatusCode::CONFLICT)
        }
        _ => panic!("A stale account socket must not upgrade"),
    }
}
