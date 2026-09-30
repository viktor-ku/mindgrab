# Mindgrab

SolidJS mind maps with local-first Yjs state, automatic IndexedDB saving,
durable Rust/Axum/Postgres synchronization and WorkOS AuthKit login.

## Run locally

1. Copy `.env.example` to `.env` and set the WorkOS client ID and API key.
   The server loads the root `.env` from the repository root or `server/`;
   exported variables take precedence. Credentials never enter the Vite bundle.
2. Register these local URLs in WorkOS and enable password or another desired
   authentication method:
   - Redirect: `http://localhost:5173/api/auth/callback`
   - Initiate login: `http://localhost:5173/api/auth/login`
   - Sign-out: `http://localhost:5173/`
3. Start Postgres and the API:

   ```sh
   mise run db
   mise run server:dev
   ```

   The server applies migrations automatically. Loopback development with the
   `mindgrab` database seeds the Boba Tee profile if absent; sign-in still uses
   AuthKit and does not receive a fabricated session.
4. In another terminal:

   ```sh
   cp webapp/.env.example webapp/.env
   mise run webapp:install
   mise run webapp:dev
   ```

   Open **http://localhost:5173**. Use this hostname for matching callback/cookie
   origins. Vite forwards `/api`, including WebSocket upgrades, to the backend
   configured in `webapp/.env` (locally port 3000). Restart after changing it.
   Vite refuses to switch ports when 5173 is occupied.

For agent sign-in, use the [local sign-in skill](.agents/skills/mindgrab-local-signin/SKILL.md).
Verify `/api/me` returns 200 in that same browser session.

## Editing and saving

Each project has a stable UUID and one Y.Doc. Names are editable and may repeat.
Commands and shared text edit Yjs directly; Solid renders observed projections.
Layout, selection, viewport and drag previews remain local UI state. Undo/redo
tracks local actions in the current project session and clears on project/account
change or reload. Remote changes do not enter the undo stack.

Editing saves automatically without network access or a Save click. **Saved
locally** means the IndexedDB transaction committed. Save/Ctrl+S flushes local
writes. **Saved to cloud** means a verified server baseline and durable receipts
cover edits and the server content is valid. A connected socket alone does not
confirm durability. Offline edits reconcile after reconnect or reload.

Production builds cache the shell after an online visit, allowing stored projects
to cold-open offline. Cloud-only projects must first be opened online.
Wait for local save before closing tabs. On storage failure,
keep the tab open, export content and retry saving.

**Export** includes unsynced/in-memory content as readable `.mindgrab.json`.
**Import** validates the version 2 format in
[`project-import-export.ts`](webapp/src/project-import-export.ts) before
creating fresh project/node UUIDs and an empty undo history. Repeated imports and
duplicate names stay independent. JSON portability is separate from binary recovery.

## Accounts and authentication

Anonymous projects remain local until **Add anonymous projects to this account**
is chosen after sign-in. Claims retain binary content and resume after interruption.
Documents, catalogs and local channels are isolated by deployment/account/project.

A transient outage preserves the cached workspace. A terminal 401 pauses sync
and asks for sign-in without deleting work. Explicit logout disconnects account
providers across tabs and opens anonymous projects; account caches remain for
later sign-in. Auth navigation awaits local commits and stays in place on storage
failure. Local caches are not encrypted.

- `GET /api/auth/login` starts browser-bound, one-use AuthKit state and PKCE.
- `GET /api/auth/callback` verifies the token, upserts the WorkOS user and rotates
  the local session credential.
- `GET /api/me` returns basic user fields, 401 when signed out, or 503 on temporary
  authentication failure. Tokens are never returned to browser JavaScript.
- `POST /api/auth/logout` checks Origin, deletes the session and redirects through
  WorkOS logout.

Postgres stores provider tokens and a SHA-256 hash of the browser credential.
The cookie is HttpOnly, SameSite=Lax and Secure on HTTPS. Access tokens are checked
on each authenticated request; refreshes are serialized and persisted before
returning. Local sessions have a 30-day maximum. Configure short provider access
lifetimes for timely revocation detection. Login attempts expire after 10 minutes.

## API and architecture

The owner comes from the authenticated session. Browser requests send
`X-Mindgrab-Account` and socket upgrades send expected `ownerId` to fence account
changes; these never select ownership. Mutations/socket upgrades require the
configured application Origin. Private responses are no-store.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/crdt/v1/projects` | Register a canonical client-generated v4 UUID with `schemaVersion: 1`; retries by the same owner are idempotent. |
| `GET /api/crdt/v1/projects?limit=50&cursor=…` | Paginated owner catalog; follow `nextCursor` to its end. |
| `GET /api/crdt/v1/projects/<uuid>` | Identity, sequence and projection freshness. |
| `PUT /api/crdt/v1/projects/<uuid>/updates/<updateUUID>` | Exact V1 bytes, `application/octet-stream`, `X-Mindgrab-Schema-Version: 1`; durable receipt after commit. |
| `GET /api/crdt/v1/projects/<uuid>/{baseline,updates,status}` | Binary bootstrap/replay and current validation. |
| `GET /api/crdt/v1/projects/<uuid>/state` | Canonical content and effective placements from a current read model. |
| `/api/crdt/v1/sync/<uuid>` | Authenticated y-websocket live propagation. |

Errors use `{ "error": { "code": "…", "message": "…" } }`. Another owner's
UUID reads as 404; unsupported schemas return 426; account changes return
`409 account_changed`; temporary storage/auth failures return 503. Uninitialized
and pending/quarantined projects are retained and cannot be presented as saved.

## Deployment and operations

Use same-origin HTTPS static hosting and `/api` proxying to compatible Rust API
processes backed by one Postgres primary. Configure the proxy to forward WebSocket
Upgrade/Connection, Cookie and Origin headers and allow heartbeats.
Serve worker scripts with no-cache, keep API paths out of SPA fallback/cache, and
publish HTML/assets/workers together. Set `DATABASE_URL`, WorkOS credentials,
`APP_URL` and `WORKOS_REDIRECT_URI`; register the matching production AuthKit URLs.
`VITE_BACKEND_URL` is a build-time backend base URL; leave it empty for same-origin
production hosting. An external backend needs credentialed CORS.

Rebuild disposable summaries with `mise run server:rebuild-read-models`.
For manual compaction and identity-preserving binary backup/recovery, set
`DATABASE_URL` to the intended database and run:

```sh
mise -C server exec -- cargo run -- compact-project <uuid> <owner-external-id>
mise -C server exec -- cargo run -- backup-project <uuid> <owner-external-id> project.mgb
mise -C server exec -- cargo run -- restore-project <uuid> <source-owner-external-id> <destination-owner-external-id> project.mgb
```

Owner arguments are existing `users.external_id` values. Backup requires a new
file path; restore requires the archive's UUID to be absent in the destination.
Verify a restore in an isolated database before switching production, with writers
stopped. Keep consistent Postgres backups/WAL as well: project archives exclude
users and authentication. Preserve canonical bytes and receipts during recovery
or rollback, and use a compatible build; do not truncate `crdt_*` tables.

**Development reset notice:** obsolete snapshot data is discarded without
conversion. Browser startup removes only known project keys after tab coordination;
current Yjs databases, auth and preferences are retained. Operators explicitly
remove only obsolete database tables using `mise run server:reset-legacy-projects`.
Stop obsolete server builds first. The retired `/api/projects` endpoint rejects
writes with 426. Keep existing SQL migrations unchanged; SQLx checks their checksums.

Use a separate port for production previews so a cached worker does not control
Vite development. To reset shell caching, close other tabs, unregister only this
origin's `/sw.js` worker and delete only `mindgrab-shell/` caches, then reload online.
Clearing site data also deletes local projects and unsynced edits.

Open **/checkhealth** for API/database reachability and latency. `GET /api/health`
returns 200 when healthy, 503 when degraded, and exposes database latency through
`Server-Timing`. Health results contain no connection details or credentials.

## Checks

```sh
mise run db
mise run check
```

The complete check runs Rust formatting/lint/tests, webapp static checks/build,
unit/browser/offline tests, Yjs/Yrs interoperability, real Rust/Postgres cloud
browser tests and the production release gate (`mise run test:release`).
Install Chromium once with `(cd webapp && bun --bun x playwright install chromium)`.
`mise tasks` lists focused commands. The webapp tests include Yjs/Yrs round trips
through the Rust worker in `server/examples/yjs_interop.rs`; `mise run crdt:test`
runs those tests alone. Shared golden inputs and server test helpers live in
[`webapp/tests/fixtures`](webapp/tests/fixtures/yjs/README.md) and use the webapp's
locked dependencies.

SQLx tests create isolated databases and mock WorkOS; the database role must be
able to create test databases. No real credentials, users or emails are used.
The RSA key under `server/src/auth/fixtures` is a public test fixture.
