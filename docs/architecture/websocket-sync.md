# Authenticated Yjs WebSocket synchronization

## Endpoint and client contract

Register the project UUID before connecting to `/api/crdt/v1/sync/<projectUUID>`
with the existing HttpOnly session cookie and an `Origin` matching `APP_URL`.
The binary endpoint implements the y-websocket multiplexing envelope and
y-protocols sync step 1/step 2/update messages using Yjs V1 encoding. It is tested
with y-websocket 3.1.0, y-protocols 1.0.7, Yjs 13.6.33 and Yrs 0.28.0 with
`small-client`.

```ts
new WebsocketProvider(`${wsOrigin}/api/crdt/v1/sync`, projectId, doc);
```

Browsers send the cookie automatically. Do not put credentials in query
parameters; there is no socket token login. UUIDs address rooms, never names.
Ownership comes from the session, and stored protocol/schema is checked before
upgrade. Rejected upgrades use catalog HTTP errors (401/403/404/426/503); a
non-owner receives the same 404 as a missing project.

The server sends merged full-state bytes for existing content, then its state
vector. Either peer's step 1 is answered with step 2. Valid state uses
`yrs::diff_updates_v1`, including delete sets even when vectors match. Incomplete
causal state uses merged originals so gapped structures survive bootstrap.
Empty step 2 (`00 00` update bytes) is a no-op, letting an empty room await the
creator's seed. Opening clients never independently initialize nested maps;
the server creates no shared content or repair transactions.

Awareness updates/queries are consumed and ignored. Presence is neither
forwarded nor persisted. Unknown messages, trailing bytes, malformed updates,
unsupported content and text WebSocket messages are rejected.

## Durable propagation and supported topology

Postgres supplies room state and fan-out. There is no process-local room
document or broadcast queue. Each connection bootstraps from a coherent
checkpoint/update tail, then polls its owner's project and next committed
sequence every 250 ms. Backlogs drain immediately, one bounded row/write at a
time. All processes observe HTTP and socket submissions. No sticky sessions or
Postgres notification delivery is required.

Multiple API processes are supported with the same primary Postgres database,
WorkOS configuration and APP_URL. Asynchronous read replicas are unsupported for
this path. A rolling deployment may drop sockets; the replacement reconstructs
from Postgres and clients exchange their vector/diff again. No in-memory room
flush is needed. Stop routing new requests before terminating an instance.

Socket ingestion uses `updates::ingest` unchanged. Project locking,
`synchronous_commit=on` and COMMIT precede delivery; a failed commit emits no
update. Out-of-order original bytes remain durable and are forwarded unchanged,
avoiding Yrs event/diff omissions (#670/#673). Quarantined projects close sockets
without forwarding the invalid resolving update. If compaction removes a slow
connection's next row, it gets a coherent full baseline rather than skipping a
gap. Checkpoint maintenance uses the same project lock.

Socket sync is **not a durable save receipt**. Browser clients submit stable update
UUIDs through the companion HTTP API and reconcile pending submissions after
reconnect. Socket messages get fresh storage UUIDs: duplicates may consume
distinct sequences while remaining semantically idempotent in Yjs. Neither
`provider.synced`, an echo, nor a vector match proves all local submissions were
saved. The 10,000-tail-row/10 MiB storage bounds still apply until compaction.

## Authentication, failures and resource bounds

WorkOS-backed sessions are revalidated before application frames, before sending
new committed content, and at least every five seconds while idle. Logout and
expiry close sockets. WorkOS revocation follows existing refresh-based detection
semantics. Temporary provider/storage failure closes retryably without clearing
sessions or deleting data; clients keep local edits and reconnect.

| Close code | Meaning | Client action |
| --- | --- | --- |
| 1008 | Rejected session, invalid/unsupported content, or quarantine | Inspect reason; reauthenticate or recover content before retry |
| 1009 | Resource limit | Split submissions or recover/compact the project |
| 1013 | Temporary auth/storage failure, send timeout or missing heartbeat | Preserve pending work and retry with backoff |

Per process, 64 upgrades/connections hold slots, including validation/bootstrap.
Slots release on failed upgrade, disconnect or timeout. Incoming frames/messages
are limited to 1 MiB plus 16 envelope bytes; update bodies stay limited to 1 MiB.
State vectors allow 10,000 entries with 32-bit client IDs/clocks, matching the
pinned configuration. Outgoing baseline data is bounded by the existing 10 MiB
document limit and an 11 MiB socket write-buffer limit. Each connection retains
one tail row and one pending send, with a ten-second write deadline. Closing
also has a ten-second deadline, after which the socket and permit drop.
Heartbeats ping every 20 seconds; no inbound activity/pong for 60 seconds closes
the socket. Disconnected rooms retain no cache or observers.

Polling adds up to 250 ms discovery latency and four idle queries per second
per connection. Increase limits only with measured Postgres/memory capacity and
passing release performance budgets.

## Proxy configuration

Vite's `/api` proxy forwards WebSocket upgrades locally. Production proxies must
keep sync on the webapp origin, forward Cookie/Origin and Upgrade/Connection
headers, and allow idle periods longer than the heartbeat interval. For example,
inside an Nginx HTTPS server with a configured `mindgrab_api` upstream:

```nginx
location /api/crdt/v1/sync/ {
    proxy_pass http://mindgrab_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 75s;
}
```

## Verification

`mise run server:check` uses isolated SQLx Postgres databases and mocked WorkOS
with real TCP sockets. Run transport coverage with
`mise run server:test -- project::sync`. `mise run crdt:test` and
`mise run crdt:check` retain the pinned JS/Yrs interoperability gate.

Tests cover owner/room isolation, rejected Origin/session/schema, connected
expiry, transient auth failure/reconnect, malformed/oversized frames, ignored
awareness, duplicates, concurrent text/structural edits, pure deletes,
HTTP-to-socket propagation, causal-gap bootstrap, deferred COMMIT failure without
broadcast, and an 8 MiB checkpoint sent to a slow reader while another room
stays responsive. A subprocess test connects to two independent Rust processes,
kills one, starts a fresh process, and proves both directions of propagation.
The Bun helper runs actual pinned y-websocket providers with BroadcastChannel
disabled for offline/reconnect convergence and fresh-client reconstruction.

References: [y-websocket](https://docs.yjs.dev/ecosystem/connection-provider/y-websocket),
[y-protocols](https://github.com/yjs/y-protocols/blob/master/PROTOCOL.md),
[Durable storage](durability.md).
