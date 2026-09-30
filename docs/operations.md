# Operations

Yjs is the only project state path. Commands and text binding edit the Y.Doc;
Solid renders a read-only projection. Undo uses a session-scoped Y.UndoManager.
IndexedDB commits incremental updates automatically. The Save button/Ctrl+S
flushes local durability; the viewport debounce writes only a local preference.
Layout, navigation, selection and drag previews remain local UI state.

## Deployment and development reset

Run `mise run check`, including the production release gate, before publishing
compatible backend, frontend and worker assets together. Retain previous hashed
assets during rollout. Tests use isolated browser profiles and databases.

`mise run server:reset-legacy-projects` explicitly removes the obsolete `pnode`
and `project` development tables after stopping obsolete backend builds. It
uses a transaction/advisory lock, omits CASCADE, is repeatable, and retains users,
authentication and all `crdt_*` data. Unexpected dependencies abort the reset.
Keep the original SQL migrations unchanged: SQLx checks their recorded versions
and checksums when opening existing databases.

Browser startup resets only `proj/*`, `project-updated/*`,
`mindgrab/latest-project`, and their `mindgrab/user/<numeric-id>/` variants.
A Web Lock serializes attempts; a separate worker inventories all same-origin
windows, including uncontrolled tabs. Other tabs or coordination/storage failure
block startup until **Retry opening**. Reconnect and close other tabs first.
The worker uses `/legacy-reset/` scope and unregisters after the check.
It has no cache/fetch handlers and never controls the editor.

This reset discards obsolete development snapshots without conversion. It never
lists/deletes IndexedDB, clears localStorage, removes auth/preferences, or deletes
a valid Yjs database. The generation marker cannot bypass inventory checks.
`/api/projects` returns no-store `426 legacy_client_upgrade_required` and cannot
write data. Offline cached tabs upgrade after reconnecting and closing all tabs.
Use [shell-only reset](offline-reopening.md#development-reset-without-deleting-projects)
for cache problems; do not clear site data or force waiting worker activation.

## Supported deployment

Pin dependencies using both Bun lockfiles, `server/Cargo.lock`, and the Rust
version in `server/mise.toml`. The supported topology is same-origin HTTPS static
hosting and `/api` proxying to one or more compatible Rust/Axum processes backed
by **one Postgres primary**. Other topologies (independent writable databases,
multi-region split-brain writers, or mixed protocol builds) are unsupported.
Processes poll committed updates, so sticky sessions are unnecessary.

[Nginx example](../deploy/nginx.conf) forwards WebSocket Upgrade/Connection,
Origin and Cookie and allows the 20-second heartbeat. Serve `/sw.js` and
`/legacy-reset-worker.js` as JavaScript with no-cache; their routes must not fall
back to the SPA. `/api` must never fall back to HTML or use a proxy response
cache. Configure WorkOS callback/origin and HTTPS cookie settings per README.
The development Vite proxy already has `ws: true`.

## Save-state meanings

| State | Guarantee / action |
| --- | --- |
| Saving locally | IndexedDB has not yet confirmed the transaction; keep the tab open. |
| Saved locally | Document update committed in this browser. Cloud durability is separate. |
| Saved to cloud | A verified baseline and durable receipts cover local edits, and server content is valid. A socket connection/sync event alone is insufficient. |
| Offline / cloud save pending | Local editing continues; synchronization resumes after connectivity/session recovery. |
| Local storage error | Edits may exist only in memory. Keep the tab open, export JSON, free storage, and retry saving. |
| Cloud blocked / update required | Retain local data, export if needed, and use a compatible build; do not use timestamps to choose a winner. |

Browser storage is not encrypted or guaranteed against user deletion/eviction.
JSON export is a portable content copy with fresh IDs on import; it cannot
restore CRDT clocks, causal gaps, receipts or identity.

## Database maintenance and recovery

Automatic checkpoint compaction uses complete validated state, preserves immutable
receipts and unresolved causal dependencies, and atomically prunes only proven
covered rows. Read models are disposable. Do not manually truncate `crdt_*` logs
or receipts. Use [checkpoint/backup operations](architecture/checkpoints-backups.md)
for limits, checksums, owner mappings, safe backup/restore commands and coordinated
database recovery. `mise run server:rebuild-read-models` rebuilds summaries from
canonical binary storage without WorkOS credentials.

Use `compact-project <uuid> <owner-external-id>` for bounded manual compaction,
`backup-project <uuid> <owner-external-id> <file>` for a binary archive, and
`restore-project <uuid> <source-owner-external-id> <destination-owner-external-id> <file>`
for validated restore, through `mise -C server exec -- cargo run -- ...` with the
intended `DATABASE_URL`. Authenticated users and owner mappings must already exist.
Archives contain sensitive project data; keep them and database backups protected.

After Yjs edits, rollback must retain/export canonical binary data and use a
compatible Yjs build. Snapshot writes are not a recovery strategy. Stop writers
and preserve browser IDB, receipts, checkpoints and update tails before recovery.
Restore and verify reconstruction/convergence before reopening writes. Never
downgrade to a build that mounts a writable legacy snapshot editor.

## Compatibility policy

Storage generation, IDB catalog version, document schema, portable JSON version,
HTTP/socket protocol and shell protocol have separate meanings. Generation 1
and document/protocol v1 are the supported versions. Future incompatible
changes require an explicit migration and multi-tab plan; version numbers must
not be used as instructions to clear databases. Cached-shell mismatch blocks
repository startup; unsupported document schemas retain bytes and block commands;
HTTP 426 and socket upgrade errors pause synchronization. Binary backups must be
restored with a build compatible with their versions. Run the release suite for
every supported version change.
