# Mindgrab backend

Bun 1.4.2 and TypeScript serve the existing HTTP API and y-websocket protocol.
Hono routes requests, Bun SQL connects to Postgres, jose verifies WorkOS tokens,
and Yjs validates and reconstructs canonical binary updates in a bounded worker
pool. Client and backend import `@mindgrab/document` from `shared/` and use the
same locked Yjs version.

## Local development

From the repository root:

```sh
mise run install
mise run db
mise run backend:dev
mise run webapp:dev
```

The root `.env` must provide `WORKOS_CLIENT_ID`, `WORKOS_API_KEY` and
`WORKOS_REDIRECT_URI=http://localhost:5173/api/auth/callback`. `APP_URL` defaults
to the callback origin. `DATABASE_URL` defaults to
`postgres://postgres@localhost:5432/mindgrab`; `PORT` defaults to 3000.
Use HTTPS callback/app URLs outside loopback. Vite proxies `/api` and `/sync`.

### Worktree development

T3's worktree setup command is `bun tooling/worktree-bootstrap.ts`, run from the
repository root. It needs only Bun and Git, so it can run before dependency
installation. You can also invoke it with `mise run worktree:bootstrap`.

The script creates an ignored root `mise.local.toml` containing `WEBAPP_PORT`,
backend `PORT`, `POSTGRES_PORT`, `DATABASE_URL`, `VITE_BACKEND_URL`,
`COMPOSE_PROJECT_NAME`, `WORKOS_REDIRECT_URI`, and `APP_URL`. Each worktree gets
three available ports and its own Compose project, Postgres container, and named
volume. Reruns preserve those settings and any custom mise configuration. Port
allocation checks other worktrees' saved settings as well as listening sockets;
simultaneous bootstraps in the same repository are serialized.

When available, the main checkout's `.env` supplies shared credentials through
mise's dotenv directive. A worktree's existing `.env` overrides shared values;
the generated port and URL settings override both. Credentials are referenced,
not copied. Missing dotenv files are skipped and can be added later. If neither
file exists, provide `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` in the worktree's
`.env`, or configure them
directly in `mise.local.toml`. Ensure WorkOS allows the generated callback URL.

Use the same `mise run db`, `mise run backend:dev`, and `mise run webapp:dev`
commands as above. Every task inherits the worktree environment. For other
commands, use `mise exec -- <command>` or an activated mise shell; a plain shell
does not automatically read `mise.local.toml`. To stop this worktree's database,
run `mise exec -- docker compose down`. Its named volume is retained for reuse.

Postgres 18 stores data under `/var/lib/postgresql/18/docker`; Compose mounts the
named volume at `/var/lib/postgresql`. Existing containers created with the old
`/var/lib/postgresql/data` mount used a separate anonymous volume for actual data.
Export any needed data from those containers before recreating them.

Startup applies `backend/migrations/` under a database advisory lock. Existing
`_sqlx_migrations` records are adopted only when their SHA-384 checksums match the
unchanged SQL files. Existing users, sessions, project updates, checkpoints,
receipts and archives remain compatible; no database export is required.

## Verification

```sh
mise run backend:test
mise run crdt:test
mise run check
```

Backend tests use real Postgres in disposable databases and a local mock WorkOS
provider. The database role needs permission to create/drop test databases. Tests
cover authentication, API contracts, concurrent commits, causal gaps, read-model
rebuilds, compaction, archives, process termination and live cross-instance sync.
The editor, account, repository and offline-shell browser tests live in `e2e/`.
The old browser cloud/recovery and release orchestration was removed.

## Administration

Run from `backend/`. Administrative commands require `DATABASE_URL`, without
WorkOS configuration. Owners are identified by their WorkOS external user IDs.

```sh
bun --bun src/main.ts rebuild-read-models
bun --bun src/main.ts compact-project <uuid> <owner-external-id>
bun --bun src/main.ts backup-project <uuid> <owner-external-id> <new-file>
bun --bun src/main.ts restore-project <uuid> <source-owner-external-id> <destination-owner-external-id> <file>
```

Backups use the existing checksummed `MGBK0001` binary format, exclusive 0600
files and fsync. Restore requires an absent project UUID and explicit owner
mapping. Complete checkpoints preserve insertion and deletion coverage before
pruning updates. Pending causal dependencies retain the original binary tail;
invalid content exposed by a late dependency is quarantined. Derived read models
can be rebuilt from canonical bytes.

Sockets poll committed database sequences, so HTTP uploads and other backend
instances converge without a shared in-memory document cache. Per-instance
quotas use the TCP peer address and authenticated account; proxy headers are not
trusted. Large replay jobs run off the HTTP event loop with bounded queues and
timeouts. This implementation has correctness coverage, but production load and
memory benchmarks remain future work.
