# Rust backend

`mindgrab-backend` is an Axum service with WorkOS AuthKit authentication and
Postgres persistence. It uses `mindgrab-state` directly; there is no JavaScript
server runtime or separate implementation of document rules.

## Railway deployment

Build the backend service from repository root `/`, using Dockerfile path
`backend/Dockerfile`. Clear custom build/start commands and set the healthcheck
path to `/checkhealth`. The old `/server` directory is no longer part of this
repository. Apply these settings through Railway's dashboard or API.

Set `HOST=::` and `PORT=3000` so the API is reachable on Railway's public and
private networks. Keep `DATABASE_URL` pointing at the project's Postgres
service. Configure the WorkOS credentials, `APP_URL` and `WORKOS_REDIRECT_URI`
as described below. Release builds use WorkOS authentication.

The image contains the compiled native API and trusted HTTPS certificates.
Postgres schema creation runs on startup. GET `/checkhealth` returns 200 when
the database is reachable and 503 otherwise; no login is required.

## Local development

Run `mise run worktree:bootstrap`, `mise run db`, `mise run backend:dev` and
`mise run webapp:dev`. Open the `APP_URL` from this worktree's `mise.local.toml`.
Vite proxies API and WebSocket requests on the web app's
origin, keeping login callbacks and HttpOnly cookies on that origin. The backend
also serves the production build in `webapp/dist`.

`schema.sql` installs a fresh `mindgrab_loro` schema. This is schema creation,
not a conversion of previous data. Sessions and login attempts expire. Project
UUIDs are globally reserved for their owner; deleting a cloud copy removes its
snapshot while retaining the UUID reservation. The same owner can re-enable it.

## Authentication

### Local login for agents and worktrees

`mise run backend:dev` sets `MINDGRAB_ENV=development` and defaults
`MINDGRAB_AUTH_MODE` to `local`. No WorkOS credentials or registered callbacks
are needed. A new browser session starts signed out. Click **Sign in** to create
the local **Boba Tee** account (`boba.tee@mindgrab.test`, external ID
`local_boba_tee`); click **Sign out** to return to anonymous use. This account is
separate from the WorkOS staging account and persists in the worktree database.

The backend completes the one-use state/callback flow on `APP_URL`, sets a real
opaque HttpOnly session cookie, and uses normal database sessions, expiry,
account fences, project permissions and logout revocation. Local login,
account checks and logout make no WorkOS requests. Cookies include the app port
because browser cookies otherwise overlap between localhost worktrees.
The frontend's normal persistence, cloud saving and signed-out behavior remain
available to test. This does not simulate hosted AuthKit UI, JWT validation,
refresh rotation, or provider failures; existing provider-fixture tests cover
those paths.

Local authentication requires a debug build, `MINDGRAB_ENV=development`, and
loopback `APP_URL` and backend `HOST`. The backend defaults to `127.0.0.1` in this
mode. Release builds reject local mode. To run directly with Cargo, set both
`MINDGRAB_ENV=development` and `MINDGRAB_AUTH_MODE=local`; defaults remain WorkOS
outside the dev task. Agents should follow
[mindgrab-local-signin](../.agents/skills/mindgrab-local-signin/SKILL.md).

### WorkOS AuthKit

For the hosted flow, configure `.env` from `.env.example` and run
`MINDGRAB_AUTH_MODE=workos mise run backend:dev`. The WorkOS application must
allow the exact `WORKOS_REDIRECT_URI` and `APP_URL` for that environment.

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
| `/api/startLogin`, `/api/logout` | Login/logout navigation |
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
identity providers and credentials are compiled only into test/example fixtures;
the local login mode is available only in explicitly configured debug development.
