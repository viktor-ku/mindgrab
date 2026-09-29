//! PostgreSQL is the room: every connection tails committed sequences. No
//! process-local broadcast/cache can strand HTTP writes or cross-process edits.
mod wire;

use std::{sync::Arc, time::Duration};

use axum::{
    Router,
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::HeaderMap,
    response::Response,
    routing::get,
};
use axum_extra::extract::cookie::CookieJar;
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{Instant, timeout},
};
use uuid::Uuid;
use yrs::{
    StateVector,
    sync::{Message as ProtocolMessage, SyncMessage},
    updates::{decoder::Decode, encoder::Encode},
};

use super::{ApiError, parse_project_id, require_same_origin, updates};
use crate::{
    auth::{AppState, authenticated_user},
    workos::AuthError,
};

const POLL: Duration = Duration::from_millis(250);
const AUTH_INTERVAL: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FRAME: usize = updates::MAX_UPDATE_BYTES + 16;
static CONNECTIONS: std::sync::LazyLock<Arc<Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(Semaphore::new(64)));

pub(super) fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/crdt/v1/sync/{project_id}", get(upgrade))
}

async fn upgrade(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    Path(project): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let permit = CONNECTIONS
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::Unavailable)?;
    require_same_origin(&state, &headers)?;
    let owner = authenticated_user(&state, &jar).await?;
    let id = parse_project_id(&project)?;
    // Validate ownership, schema and quarantine before returning 101. Bootstrap
    // again inside the socket: a commit between upgrade and bootstrap is safe.
    updates::synchronization_baseline(&state.pool, owner.id, id).await?;
    Ok(ws
        .max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .write_buffer_size(0)
        .max_write_buffer_size(11 * 1_048_576)
        .on_upgrade(move |socket| serve(socket, state, jar, owner.id, id, permit)))
}

async fn send(socket: &mut WebSocket, message: ProtocolMessage) -> Result<(), ApiError> {
    timeout(
        IO_TIMEOUT,
        socket.send(Message::Binary(message.encode_v1().into())),
    )
    .await
    .map_err(|_| ApiError::Unavailable)?
    .map_err(|_| ApiError::Unavailable)
}

async fn authorize(state: &AppState, jar: &CookieJar, owner: i64) -> Result<(), ApiError> {
    match authenticated_user(state, jar).await {
        Ok(user) if user.id == owner => Ok(()),
        Ok(_) | Err(AuthError::Unauthorized) => Err(ApiError::Unauthenticated),
        Err(error) => Err(error.into()),
    }
}

async fn serve(
    mut socket: WebSocket,
    state: Arc<AppState>,
    jar: CookieJar,
    owner: i64,
    id: Uuid,
    _permit: OwnedSemaphorePermit,
) {
    let result = run(&mut socket, &state, &jar, owner, id).await;
    let (code, reason) = match result {
        Ok(()) => return,
        Err(ApiError::Unauthenticated) => (1008, "Sign in again"),
        Err(ApiError::Unavailable) => (1013, "Sync temporarily unavailable; retry"),
        Err(ApiError::ResourceLimit) => (1009, "Sync resource limit"),
        Err(_) => (1008, "Invalid or unsupported sync content"),
    };
    let _ = timeout(
        IO_TIMEOUT,
        socket.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        }))),
    )
    .await;
}

#[derive(sqlx::FromRow)]
struct TailRow {
    last_sequence: i64,
    validation: String,
    schema_version: i16,
    protocol_version: i16,
    sequence: Option<i64>,
    data: Option<Vec<u8>>,
}

async fn run(
    socket: &mut WebSocket,
    state: &AppState,
    jar: &CookieJar,
    owner: i64,
    id: Uuid,
) -> Result<(), ApiError> {
    authorize(state, jar, owner).await?;
    let baseline = updates::synchronization_baseline(&state.pool, owner, id).await?;
    let mut sequence = baseline.sequence;
    // Full merged originals retain pending blocks and delete sets omitted by Yrs
    // transaction events/diffs (#670/#673). Empty rooms wait for client seeds.
    if sequence > 0 {
        send(
            socket,
            ProtocolMessage::Sync(SyncMessage::Update(baseline.bytes)),
        )
        .await?;
    }
    send(
        socket,
        ProtocolMessage::Sync(SyncMessage::SyncStep1(
            StateVector::decode_v1(&baseline.state_vector).map_err(|_| ApiError::Unavailable)?,
        )),
    )
    .await?;
    let mut poll = tokio::time::interval(POLL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut authorized_at = Instant::now();
    let mut last_activity = Instant::now();
    let mut last_ping = Instant::now();
    loop {
        tokio::select! {
            _ = poll.tick() => {
                if authorized_at.elapsed() >= AUTH_INTERVAL {
                    authorize(state, jar, owner).await?;
                    authorized_at = Instant::now();
                }
                let (next, catching_up) = tail(socket, state, jar, owner, id, sequence).await?;
                if next != sequence { authorized_at = Instant::now(); }
                sequence = next;
                if catching_up { poll.reset_immediately(); }
                if last_ping.elapsed() >= Duration::from_secs(20) {
                    last_ping = Instant::now();
                    timeout(IO_TIMEOUT, socket.send(Message::Ping(Vec::new().into()))).await
                        .map_err(|_| ApiError::Unavailable)?.map_err(|_| ApiError::Unavailable)?;
                }
                if last_activity.elapsed() >= Duration::from_secs(60) { return Err(ApiError::Unavailable); }
            }
            incoming = socket.recv() => {
                match incoming {
                    None | Some(Ok(Message::Close(_))) => return Ok(()),
                    Some(Err(_)) => return Err(ApiError::InvalidRequest),
                    Some(Ok(Message::Pong(_) | Message::Ping(_))) => { last_activity = Instant::now(); }
                    Some(Ok(Message::Text(_))) => return Err(ApiError::InvalidRequest),
                    Some(Ok(Message::Binary(bytes))) => {
                        last_activity = Instant::now();
                        let message = wire::decode(&bytes)?;
                        authorize(state, jar, owner).await?;
                        authorized_at = Instant::now();
                        handle(socket, state, owner, id, message).await?;
                    }
                }
            }
        }
    }
}

/// At most one retained row and one pending write per connection. No in-memory
/// fan-out queue; the durable log is the reconnect/backpressure buffer.
async fn tail(
    socket: &mut WebSocket,
    state: &AppState,
    jar: &CookieJar,
    owner: i64,
    id: Uuid,
    sequence: i64,
) -> Result<(i64, bool), ApiError> {
    let row: Option<TailRow> = sqlx::query_as(
        "SELECT p.last_sequence, p.validation, p.schema_version, p.protocol_version, u.sequence, u.data FROM crdt_project p LEFT JOIN LATERAL (SELECT sequence, data FROM crdt_update WHERE project_id = p.id AND sequence > $3 ORDER BY sequence LIMIT 1) u ON TRUE WHERE p.id = $1 AND p.owner_id = $2")
        .bind(id).bind(owner).bind(sequence).fetch_optional(&state.pool).await?;
    let row = row.ok_or(ApiError::NotFound)?;
    if row.schema_version != 1 || row.protocol_version != 1 {
        return Err(ApiError::UnsupportedSchema);
    }
    if row.validation == "quarantined" {
        return Err(ApiError::Quarantined);
    }
    if row.last_sequence <= sequence {
        return Ok((sequence, false));
    }
    // Revalidate before sending, even when the periodic check isn't due.
    authorize(state, jar, owner).await?;
    if row.sequence == Some(sequence + 1) {
        send(
            socket,
            ProtocolMessage::Sync(SyncMessage::Update(row.data.ok_or(ApiError::Unavailable)?)),
        )
        .await?;
        Ok((sequence + 1, sequence + 1 < row.last_sequence))
    } else {
        // Compaction may remove a tail while a client is slow. Recover from a
        // coherent checkpoint+tail baseline rather than skipping missing rows.
        let baseline = updates::synchronization_baseline(&state.pool, owner, id).await?;
        send(
            socket,
            ProtocolMessage::Sync(SyncMessage::Update(baseline.bytes)),
        )
        .await?;
        Ok((baseline.sequence, false))
    }
}

async fn handle(
    socket: &mut WebSocket,
    state: &AppState,
    owner: i64,
    id: Uuid,
    message: wire::Frame<'_>,
) -> Result<(), ApiError> {
    match message {
        wire::Frame::Step1(vector) => {
            let baseline = updates::synchronization_baseline(&state.pool, owner, id).await?;
            let bytes = if baseline.validation == "valid" {
                yrs::diff_updates_v1(&baseline.bytes, vector)
                    .map_err(|_| ApiError::InvalidRequest)?
            } else {
                baseline.bytes
            };
            send(socket, ProtocolMessage::Sync(SyncMessage::SyncStep2(bytes))).await?;
            // The tail cursor stays unchanged: concurrent HTTP writes still
            // need forwarding, and duplicate delivery is safe in Yjs.
        }
        wire::Frame::Update(bytes) if bytes != [0, 0] => {
            let update_id = uuid::Builder::from_random_bytes(rand::random()).into_uuid();
            updates::ingest(&state.pool, owner, id, update_id, bytes.to_vec()).await?;
            // Delivery happens only through the committed log.
        }
        wire::Frame::Update(_) | wire::Frame::Awareness => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests;
