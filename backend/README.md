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
