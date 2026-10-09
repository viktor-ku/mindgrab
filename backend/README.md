# Rust backend

`mindgrab-backend` is an Axum service with WorkOS AuthKit authentication and
Postgres persistence. It uses `mindgrab-state` directly; there is no JavaScript
server runtime or separate implementation of document rules.

## Local development

Set the root `.env` from `.env.example`, then run `mise run db` and
`mise run backend:dev`. Vite proxies API and WebSocket requests on the web app's
origin, keeping login callbacks and HttpOnly cookies on that origin. The backend
also serves the production build in `webapp/dist`.

`schema.sql` installs a fresh `mindgrab_loro` schema. This is schema creation,
not a conversion of previous data. Sessions and login attempts expire. Project
UUIDs are globally reserved for their owner; deleting a cloud copy removes its
snapshot while retaining the UUID reservation. The same owner can re-enable it.

## Authentication

WorkOS authorization uses one-use state and PKCE. The server stores an opaque,
hashed browser credential and keeps access/refresh tokens in Postgres. Each
protected request validates a signed RS256 JWT against WorkOS JWKS, checking
issuer, client ID, audience when present, session identity and token timing.
Refresh rotation is serialized with a row lock. Provider outages do not erase
local browser work or valid stored sessions. Logout removes server authority
before redirecting to WorkOS.

Mutations and sockets require the configured app Origin. Requests also carry an
account fence so a changed cookie cannot write into the previous workspace.
Rate limits use the direct TCP peer; proxy headers are not trusted. Keep this in
mind when placing many clients behind a reverse proxy.

## API

All RPC endpoints use POST and return uncached responses:

| Endpoint | Behavior |
| --- | --- |
| `/api/getHealth` | Database reachability and timing |
| `/api/startLogin`, `/api/logout` | AuthKit navigation |
| `/api/getMe` | Verified current account |
| `/api/createProject` | Reserve `{projectId, schemaVersion: 1}` |
| `/api/listProjects` | Cursor pagination of the current owner's initialized projects |
| `/api/getProjectSnapshot` | Complete Loro history snapshot, base64 encoded |
| `/api/getProjectState` | Read-only Rust projection for inspection |
| `/api/mergeProject?projectId=<uuid>` | Merge an octet-stream snapshot |
| `/api/commandProject` | Apply `{projectId, command}` with the native shared core |
| `/api/deleteProject` | Delete the cloud snapshot |

GET `/api/auth/callback` completes login. GET `/sync/loro/<uuid>?ownerId=<id>`
upgrades to a read-only notification socket. Notifications contain committed
revisions, never uncommitted document changes. Postgres NOTIFY reaches all Rust
processes; periodic reconciliation handles reconnects and missed notifications.
Sockets revalidate their session and ownership before notifications.

Uploads lock the project row, validate and merge with the shared Rust core off
the async executor, and commit the complete result before acknowledging
`{projectId, encoding: "loro-snapshot", data, revision, durable: true}`. Repeated
snapshots are idempotent. Invalid bytes do not mutate accepted storage. Errors
use `{error: {code}}`; snapshots are capped at 10 MiB.

## Verification

`mise run backend:test` starts local Postgres and uses isolated test databases.
`mise run state:check` runs Rust formatting and Clippy over all crates and targets.
`mise run state:interop` exercises the actual app, OAuth callback, persistent API,
native commands, offline concurrent editing and live browser convergence. Test
identity providers and credentials are compiled only into test/example fixtures.
