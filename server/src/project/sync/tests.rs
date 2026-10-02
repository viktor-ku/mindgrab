use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use sqlx::PgPool;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    WebSocketStream, connect_async,
    tungstenite::{Message as WsMessage, client::IntoClientRequest},
};
use yrs::{Doc, Map, ReadTxn, Text, Transact, Update};

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

async fn receive_update(socket: &mut Client) -> Vec<u8> {
    match protocol(socket).await {
        ProtocolMessage::Sync(SyncMessage::Update(bytes)) => bytes,
        _ => panic!("Expected update"),
    }
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
