# Mindgrab

SolidJS mind maps with local-first Yjs state, automatic IndexedDB saving,
durable Rust/Axum/Postgres synchronization and WorkOS AuthKit login.

## Run locally

1. Copy `.env.example` to `.env` and set the WorkOS client ID and API key.
   The server loads the root `.env` from the repository root or `server/`;
   exported variables take precedence. Credentials never enter the Vite bundle.
2. Register these local URLs in WorkOS and enable password or another desired
   authentication method:
   - Redirect: `http://localhost:5173/auth/callback`
   - Initiate login: `http://localhost:5173/`
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
   origins. Vite forwards `/api`, `/auth` and `/sync` (including WebSocket upgrades) to the backend
   configured in `webapp/.env` (locally port 3000). Restart after changing it.
   Vite refuses to switch ports when 5173 is occupied.

For agent sign-in, use the [local sign-in skill](.agents/skills/mindgrab-local-signin/SKILL.md).
Verify `POST /api/getMe` returns 200 in that same browser session.

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

- `POST /api/startLogin` starts browser-bound, one-use AuthKit state and PKCE.
- `GET /auth/callback` verifies the token, upserts the WorkOS user and rotates
  the local session credential.
- `POST /api/getMe` returns basic user fields, 401 when signed out, or 503 on temporary
  authentication failure. Tokens are never returned to browser JavaScript.
- `POST /api/logout` checks Origin, deletes the session and redirects through
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

Public API methods live in [`server/src/api`](server/src/api). The flat filenames
match the RPC URLs exactly: `getMe.rs` implements `POST /api/getMe`, for example.
[`mod.rs`](server/src/api/mod.rs) registers the methods; shared authentication,
project storage and projection code remain in their domain modules.

Every public API method uses POST. Project arguments are JSON objects with
`Content-Type: application/json`; methods without arguments accept an empty body.
Sign-in and logout are browser form POSTs that return 303 redirects.

| Method | Arguments and purpose |
| --- | --- |
| `POST /api/getMe` | Current user, or 401/503. |
| `POST /api/getHealth` | API/database status and latency. |
| `POST /api/startLogin` | Start browser-bound AuthKit state and PKCE; requires Origin. |
| `POST /api/logout` | Delete the session and redirect through WorkOS; requires Origin. |
| `POST /api/createProject` | `{ projectId, schemaVersion: 1 }`; register a canonical client-generated v4 UUID. Retries by the same owner are idempotent. |
| `POST /api/listProjects` | `{ limit?: 50, cursor?: "…" }`; paginated owner catalog, follow `nextCursor` to its end. |
| `POST /api/getProject` | `{ projectId }`; identity, sequence and projection freshness. |
| `POST /api/getProjectBaseline` | `{ projectId }`; binary bootstrap. |
| `POST /api/getProjectUpdates` | `{ projectId, after?: "0", limit?: 100 }`; binary replay. |
| `POST /api/getProjectStatus` | `{ projectId }`; current validation and sequence. |
| `POST /api/getProjectState` | `{ projectId }`; canonical content and effective placements from a current read model. |
| `POST /api/submitProjectUpdate?projectId=<uuid>&updateId=<updateUUID>` | Exact V1 bytes, `application/octet-stream`, `X-Mindgrab-Schema-Version: 1`; durable receipt after commit. Retries retain the same IDs and exact bytes. |

The GET-only protocol endpoints are outside the RPC namespace: `/auth/callback`
receives the OAuth redirect, and `/sync/v1/<uuid>` upgrades to an authenticated
y-websocket connection. The retired `/api/projects` route only returns 426 to
obsolete snapshot clients; it is not a callable public API method.

Errors use `{ "error": { "code": "…", "message": "…" } }`. Another owner's
UUID reads as 404; unsupported schemas return 426; account changes return
`409 account_changed`; temporary storage/auth failures return 503. Uninitialized
and pending/quarantined projects are retained and cannot be presented as saved.

## Deployment and operations

Use same-origin HTTPS static hosting and `/api`, `/auth`, `/sync` proxying to compatible Rust API
processes backed by one Postgres primary. Configure the proxy to forward WebSocket
Upgrade/Connection, Cookie and Origin headers and allow heartbeats.
Serve worker scripts with no-cache, keep API and protocol paths out of SPA fallback/cache, and
publish HTML/assets/workers together. Set `DATABASE_URL`, WorkOS credentials,
`APP_URL` and `WORKOS_REDIRECT_URI`; register the matching production AuthKit URLs.
`VITE_BACKEND_URL` is a build-time backend base URL; leave it empty for same-origin
production hosting. An external backend needs credentialed CORS.

When upgrading from the REST routes, deploy the frontend and backend together,
update `WORKOS_REDIRECT_URI` and the WorkOS allowed redirect to `/auth/callback`,
and register the application root as the initiate-login URL. Older cached clients
retain their local data and need to reload before resuming cloud sync.

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

Open **/checkhealth** for API/database reachability and latency. `POST /api/getHealth`
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
