# Mindgrab

SolidJS mind maps with a Rust/Axum API and WorkOS AuthKit login.

## Run locally

1. Copy `.env.example` to `.env` if you do not already have one. Fill in the
   WorkOS client ID and API key. The Rust server loads the root `.env` when
   launched from either the repository root or `server/`; exported environment
   variables take precedence. Credentials never enter the Vite bundle.
2. In your WorkOS application's redirect settings, register:
   - Redirect URI: `http://localhost:5173/api/auth/callback`
   - Initiate login URI: `http://localhost:5173/api/auth/login`
   - Sign-out URI: `http://localhost:5173/`
   Enable the desired authentication methods in WorkOS. AuthKit's hosted page
   handles signup, sign-in, password resets, and email verification.
3. Start Postgres and the API:

   ```sh
   mise run db
   mise run server:dev
   ```

   The server applies database migrations automatically and then inserts the
   local Boba Tee profile when both the app URL and `DATABASE_URL` point to
   loopback and the `mindgrab` database. Existing users are left unchanged.
   This seeds only the user profile; sign-in still goes through WorkOS AuthKit.
4. In a second terminal:

   ```sh
   cp webapp/.env.example webapp/.env
   (cd webapp && bun --bun install)
   mise run webapp:dev
   ```

   Open **http://localhost:5173**. Vite proxies `/api` to `VITE_BACKEND_URL`
   from `webapp/.env` (locally `http://localhost:3000`). Restart Vite after
   changing this value. Use this exact
   hostname so the callback, cookies, and logout origin match. The dev server
   refuses to switch ports if 5173 is occupied.

## Authentication

For agent browser sign-in, use the repository's
[local sign-in skill](.agents/skills/mindgrab-local-signin/SKILL.md). Its staging
password user is `boba.tee@mindgrab.test`, with a preverified test email. Complete
the hosted password flow in the browser the agent uses, then verify that
`/api/me` returns `200` in that browser session.

- `GET /api/auth/login` starts AuthKit with a browser-bound, one-use state and
  PKCE. Login attempts expire after 10 minutes.
- `GET /api/auth/callback` exchanges the code, verifies the access token, upserts
  the local user by WorkOS user ID (`users.external_id`), and rotates the local
  session credential.
- `GET /api/me` returns `{ id, name, email, external_id }`, or `401` when signed
  out. Tokens are never returned to JavaScript. A `503` means authentication is
  temporarily unavailable; it does not clear an existing session.
- `POST /api/auth/logout` requires the configured app's `Origin` header, deletes
  the local session, and redirects the browser through WorkOS logout.

Postgres stores WorkOS access/refresh tokens and only a SHA-256 hash of each
random browser session credential. The browser receives an HttpOnly,
SameSite=Lax cookie, also Secure on HTTPS. Sessions have a 30-day local maximum;
WorkOS can end them sooner. Signed access tokens are checked on each `/api/me`
request, including issuer, client, subject, session ID, and expiry. Provider-side
revocation is observed when the token next refreshes, so configure a short access
token lifetime in WorkOS. Refreshes are serialized per session with a database
row lock; rotated refresh tokens are persisted before returning. Transient
refresh failures receive one bounded retry and preserve the session. Expired
records are cleaned up hourly.

Projects are saved in browser `localStorage` first and restored from there on
startup. When signed in, saved projects also sync to the `project` table. Cloud
records are scoped to the authenticated local user ID, and the API never accepts
an owner ID from the browser. Projects downloaded from the cloud are copied to
`localStorage`, so they remain available if the server is temporarily unavailable.
Project names and project-level canvas data, including the view and layout
anchor, are stored in the `project.state` JSONB value. Each map node is stored
in `pnode` with its client-generated UUID as a native UUID primary key, text,
layout position, sibling order, and an optional UUID parent node. The API
rebuilds the nested project state from those rows while preserving node IDs. The
migration keeps project state intact and starts the `pnode` table empty; there
is no existing user data to backfill. Project names remain unique per user in
this legacy snapshot path.

## Project catalog API (Yjs protocol v1)

Yjs projects are identified by a client-generated UUID rather than by name.
The catalog lives in `crdt_project` and is served from `server/src/project.rs`.
The name-keyed snapshot endpoints above (`server/src/project/legacy.rs`) are
fenced: they only read and write `project`/`pnode`, never the catalog, and are
removed at cutover. All catalog endpoints use the session cookie; the owner is
always the signed-in user and is never read from the request body, query, or
document content. Responses are `Cache-Control: no-store`.

- `POST /api/crdt/v1/projects` with `{ "projectId": "<uuid>", "schemaVersion": 1 }`
  registers a project, including one created offline. It requires the app's
  `Origin` header. `projectId` must be a canonical lowercase, non-nil RFC 4122
  version 4 UUID. Unknown fields such as `ownerId` are rejected. Returns `201`
  with a `Location` header on first registration and `200` with the current
  record on a retry by the same owner. The first committed registration claims
  the UUID permanently; any other user receives `409 project_id_conflict`.
  Concurrent registrations produce exactly one project.
- `GET /api/crdt/v1/projects?limit=50&cursor=<nextCursor>` lists the signed-in
  user's projects, newest first (creation time, then UUID). `limit` is 1–100
  (default 50). Pass the returned opaque `nextCursor` to fetch the next page;
  it is `null` on the last page. Records never include document bodies.
- `GET /api/crdt/v1/projects/<uuid>` returns one owned project. Another user's
  project and a missing project both return `404 project_not_found`.

A project record is:

```json
{ "projectId": "10000000-0000-4000-8000-000000000000", "protocolVersion": 1,
  "schemaVersion": 1, "createdAt": "2026-09-29T18:00:00.000000Z", "name": null,
  "lastSequence": "0", "contentUpdatedAt": null }
```

`projectId`, the owner, `createdAt`, and `protocolVersion` are immutable (a
database trigger enforces it). `name`, `lastSequence` (a decimal string), and
`contentUpdatedAt` describe accepted content. The update store advances sequence
and time; name projection follows in MIN-38. Until content is accepted they are `null`/`"0"`,
which a client should treat as a registered but uninitialized project. Names are
not unique, and renaming never changes identity. Clients reconnect using
`projectId`, `protocolVersion`, `schemaVersion`, and `lastSequence`.

Errors use `{ "error": { "code": "...", "message": "..." } }`: `400`
(`invalid_request`, `invalid_project_id`, or `invalid_cursor`), `401
unauthenticated`, `403 invalid_origin`, `404 project_not_found`, `409
project_id_conflict`, `426 unsupported_schema` for any `schemaVersion` other
than 1, and `503 unavailable` for retryable storage or authentication failures.

**Development reset impact:** migration `0006_crdt_project_catalog.sql` only
adds the new table, and it starts empty. Existing `project`/`pnode` development
data is neither converted nor modified and remains available through the legacy
endpoints. No database reset is required to apply the migration. To start from
a clean database anyway, run `docker compose down -v && mise run db`, which
deletes all local users, sessions, and projects.

## Durable Yjs update API

Registered projects accept Yjs V1 bytes at
`PUT /api/crdt/v1/projects/<projectUUID>/updates/<updateUUID>`, with
`Content-Type: application/octet-stream` and `X-Mindgrab-Schema-Version: 1`.
Receipts identify the exact committed bytes by UUID, SHA-256 and sequence;
identical retries are idempotent. Owner-scoped `/updates`, `/status`, and
`/baseline` endpoints support raw replay and reconstruction after restart.
See [ADR 0003](docs/architecture/0003-durable-yjs-update-store.md) for request and
response shapes, pending/quarantine behavior, limits, and the shared ingestion
and reconstruction APIs for WebSocket sync and read models. Migration `0007`
adds binary storage without resetting legacy data. WebSocket transport and browser
cloud synchronization remain subsequent tasks.

## Health check

Open **/checkhealth** in the webapp for a status page showing whether the API
and database are reachable, the browser-to-API round trip, and the database
query time. It refreshes every 15 seconds while the tab is visible.

`GET /api/health` returns `200` with
`{ "status": "ok", "database": { "status": "up", "latency_ms": 0.6 } }`, or `503`
with `"status": "degraded"` and `"database": { "status": "down", "latency_ms": null }`
when the database does not answer within 2 seconds. A `Server-Timing: db;dur=…`
header reports the time spent on the database check. The response never
includes connection details or error messages.

## Deployment

`VITE_BACKEND_URL` sets the backend base URL at build time for account and
health requests. Leave it empty for the same-origin reverse proxy setup below.
An external backend origin must allow credentialed CORS requests from the webapp
and expose `Server-Timing` for health latency calculations.

Use HTTPS and serve the frontend and `/api` on the same origin through a reverse
proxy. Client-side routes such as `/checkhealth` must fall back to `index.html`. Set `DATABASE_URL`, the WorkOS credentials, `APP_URL` (the root URL), and
`WORKOS_REDIRECT_URI` (same origin, `/api/auth/callback`). Register corresponding
production login, callback, and sign-out URLs in WorkOS. If using a custom token
issuer, set `WORKOS_ISSUER` to its exact issuer URL. By default the expected
issuer is `https://api.workos.com/user_management/<WORKOS_CLIENT_ID>`. HTTP is accepted only for local
loopback development. Protect the database and its backups: they hold refresh
tokens. The bundled Postgres configuration uses passwordless local development
authentication and is not a production database configuration.

WorkOS references: [hosted AuthKit](https://workos.com/docs/authkit/hosted-ui),
[authentication API](https://workos.com/docs/reference/authkit/authentication),
[session tokens](https://workos.com/docs/reference/authkit/session-tokens), and
[refresh behavior](https://workos.com/docs/authkit/session-resilience).

## Checks

```sh
docker compose up -d postgres
mise run server:check
```

`server:check` runs `server:fmt`, `server:clippy`, and `server:test`. Tests use
`DATABASE_URL`, defaulting to the Compose database. Server tasks run with the
Rust version pinned in `server/mise.toml`. `mise run check` runs every server
and webapp check; `mise tasks` lists them all.

The Rust integration tests create isolated databases using SQLx and a local mock
WorkOS server. The database role needs permission to create test databases. No
real WorkOS credentials, users, or emails are used by tests. The RSA key under
`server/src/auth/fixtures` is a public test fixture, never an application secret.

```sh
mise run webapp:check
mise run webapp:build
mise run webapp:test
mise run webapp:test:browser
```

`webapp:test:browser` drives the editor in headless Chromium through Playwright
(`bunx playwright install chromium` once). Its harness page links the app's
document to a second in-process replica to simulate edits from another device.

## Yjs migration contract

The isolated [Yjs/Yrs proof of concept](tools/yjs-contract/README.md) defines the
[document and synchronization contract](docs/architecture/0001-yjs-document-contract.md).
Run `mise run crdt:test` for binary interoperability fixtures and seeded tests, and
`mise run crdt:check` for static checks. The existing application still uses
snapshot cloud synchronization. Local editing/persistence uses Yjs and IndexedDB.
The durable backend update store adds application-level causal-gap workarounds
without patching Yrs; its API/database regression suite runs in `server:test`.
Browser persistence in IndexedDB — y-indexeddb document storage, the local
project catalog, durability notifications, and failure handling — is specified
in [ADR 0002](docs/architecture/0002-local-project-repository.md), with its
storage lifecycle APIs tested against real Chromium IndexedDB by
`mise run webapp:test`.
