# Yjs cutover and operations

Yjs is the only project state path. Commands and text binding edit the Y.Doc;
Solid renders a read-only projection. Undo uses a session-scoped Y.UndoManager.
IndexedDB commits incremental updates automatically. The Save button/Ctrl+S
flushes local durability; the viewport debounce writes only a local preference.
Layout, navigation, selection and drag previews remain local UI state.

## Release procedure

The preceding development builds kept the fenced snapshot endpoint alongside
`crdt/v1`; MIN-42 added the production release gate. Promote this cutover only
after that gate passes. This release removes the snapshot implementation, and
the final default configuration has one Yjs path with no snapshot feature flag
or fallback. Run `mise run check` (including `test:release`) on the exact
default configuration before publishing it. New reset fixtures use isolated
browser profiles and SQLx databases; checks never reset the operator's data.

1. Retain a consistent Postgres backup and binary exports of important Yjs
   projects. Coordinate the deployment so obsolete server processes stop before
   serving the new backend. Do not keep an old snapshot writer behind a proxy.
2. Deploy the compatible backend, frontend assets and service worker together.
   Keep previous hashed assets during rollout. All backends must share one
   Postgres primary and the same schema/protocol configuration.
3. Run `mise run server:reset-legacy-projects` against the intended development
   database. This explicit command loads `DATABASE_URL`, applies outstanding
   additive migrations and drops only `pnode` then `project`, without CASCADE,
   inside a transaction/advisory lock. Repeating it is safe. Unexpected table
   dependencies abort the entire transaction. It never deletes `users`, auth
   records, `crdt_*` canonical storage, receipts or read models. No backfill runs.
4. Old clients receive `426 legacy_client_upgrade_required` for GET/PUT
   `/api/projects`, even before sign-in and after tables are removed. The response
   is not cached and contains `action: reload`, protocol/schema version 1 and
   storage generation 1. Unknown Yjs schemas already return `426 unsupported_schema`;
   the new browser pauses cloud saving and retains local work until upgrade.
5. Browser startup inventories only `proj/*`, `project-updated/*`,
   `mindgrab/latest-project`, and their exact `mindgrab/user/<numeric-id>/`
   variants. Web Locks serialize reset and a worker counts **all same-origin
   window tabs**, including old tabs without cooperative code. Other tabs block
   reset; close them and retry. This conservative origin boundary may include
   another page hosted on the same site. Failure to verify tabs/storage retains
   data and blocks startup. The worker uses a separate `/legacy-reset/` scope,
   never controls the editor, and unregisters after the check.

Only obsolete development snapshots are discarded. The reset marker records
generation 1; it never authorizes a database deletion or bypasses an inventory
check. Recreated obsolete keys are safely reset again after closing stale tabs.
The reset never lists/deletes IndexedDB or clears localStorage. Current Yjs
documents, other generations, account hints, auth keys and unrelated preferences
stay intact. The database command is separate from browser startup.

Offline legacy tabs keep their installed build until they reconnect and all old
tabs close. They cannot overwrite UUID Yjs projects: the permanent endpoint fence
rejects snapshot writes, and the old localStorage keys are separate from Yjs IDB.
If coordination is unavailable offline, reconnect and retry. Do not clear site
data or force a waiting worker to activate. Shell-only reset instructions are in
[offline reopening](offline-reopening.md#development-reset-without-deleting-projects).

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
or receipts. Use [checkpoint/backup operations](architecture/0007-safe-checkpoints-and-backups.md)
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
and document/protocol v1 remain unchanged at this cutover. Future incompatible
changes require an explicit migration and multi-tab plan; version numbers must
not be used as instructions to clear databases. Cached-shell mismatch blocks
repository startup; unsupported document schemas retain bytes and block commands;
HTTP 426 and socket upgrade errors pause synchronization. Binary backups must be
restored with a build compatible with their versions. Run the release suite for
every supported version change.
