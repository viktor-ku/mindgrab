# ADR 0005: Rebuildable Yjs read models

Status: accepted. Implements MIN-38 and supplies the projection boundary for
MIN-39 and the release suite in MIN-42.

## Source and canonical projection

The verified `crdt_checkpoint` plus exact committed `crdt_update` tail is the
sole content source. `updates::load` checks hashes and sequence coverage under
the project lock. Reconstruction merges original V1 bytes before applying them
to a fresh UTF-16 Yrs document, retaining the MIN-35 workarounds for #670/#673.
Both insertion holes and pending dependencies prevent partial publication;
vectors alone never establish completeness, including for delete-only updates.
This task does not write checkpoints or prune updates.

`server/src/project/projection.rs` defines the browser's canonical `Content`
DTO, including tombstones and stored placements. The interoperability worker
imports this production projector. Live nodes with missing/deleted parents
become roots; the bytewise smallest UUID in each cycle is detached; siblings
sort by ASCII rank then UUID. Projection never writes CRDT repair transactions.
Only explicit semantic positions are projected; viewport, DOM measurements,
and layout anchors stay local. Flat effective placements keep the output safe
for a 10,000-node chain. Group by parent and sort by sibling order to recover
the same forest as the browser.

## Atomic storage and catch-up

Migration `0008` adds disposable catalog summaries and `crdt_node_read`.
Normalized rows hold canonical text/color/deletion/stored placement/position,
effective parent/order, and source sequence. Deleted nodes remain in canonical
content but have no effective placement. Summaries record name, visible node
count, projection version, published sequence, attempted sequence and status.
Text and canonical names use UTF-8 BYTEA to preserve NUL, which Yjs permits but
Postgres TEXT cannot represent. The existing TEXT name column mirrors names
when representable; catalog responses read the exact UTF-8 name.

Jobs acquire the project row lock **before** loading source bytes and hold it
through atomic summary/node publication. A delayed job reconstructs the latest
committed sequence after taking the lock, so older jobs cannot replace newer
views. This shares the update/checkpoint locking contract across API processes.
Current-state reads hold the same lock through catch-up and result retrieval.

Each API process runs one worker polling every second in UUID pages of at most
50 projects, processing projects sequentially. It advances past failed projects,
wraps after the final page, and retries failures on the next sweep. Reconstruction
uses the update store's shared two-worker semaphore and existing 10 MiB/10,000
tail-row bounds. Logs identify project UUIDs without content or credentials.
This implementation reconstructs full documents while holding project locks;
incremental projection and a separate durable queue are future performance
improvements. Multiple processes may duplicate work but publication is safe.

Updates commit independently before projection. Projection errors roll back the
whole derived publication, leaving acknowledged binary updates untouched for
the next retry. Catalog reads are eventually consistent; compare
`projectionSequence` with `lastSequence` before using summaries as current.
An unresolved gap records `pending_dependencies` and the attempted sequence,
retaining the previous complete view if available. New dependencies advance
the log sequence and trigger retry. Quarantine likewise retains the last valid
view with explicit stale metadata. Registered empty UUIDs are `uninitialized`;
reads and rebuilds never seed nodes.

## Owner-authorized current state

`GET /api/crdt/v1/projects/<uuid>/state` uses the session cookie, returns
`Cache-Control: no-store`, and synchronously catches up:

```json
{
  "projectId": "10000000-0000-4000-8000-000000000000",
  "schemaVersion": 1,
  "current": true,
  "freshness": {
    "lastSequence": "12", "sourceSequence": "12", "attemptedSequence": "12",
    "projectionVersion": 1, "status": "ready", "name": "Ideas", "nodeCount": 1,
    "contentUpdatedAt": "2026-09-30T12:00:00.000000Z"
  },
  "content": {
    "schemaVersion": 1, "metadata": { "name": "Ideas" },
    "nodes": {
      "20000000-0000-4000-8000-000000000001": {
        "text": "A😀é中B", "color": "blue", "deleted": false,
        "placement": { "parent": null, "rank": "a0" }
      }
    }
  },
  "placements": {
    "20000000-0000-4000-8000-000000000001": { "parent": null, "siblingOrder": 0 }
  }
}
```

Sequences are decimal strings. `current` is true only for a complete view
covering `lastSequence`. Gapped/quarantined/uninitialized results return `200`
with `current: false`; content is the previous complete view or `null`, and
`sourceSequence` identifies that view. `contentUpdatedAt` is the latest accepted
update's commit time, not the age of stale projected content. Transient failures
return `503 unavailable`; unsupported schemas return `426`. Signed-out requests
return `401`; missing and other-owned UUIDs return the same `404`. Ownership
always comes from the authenticated session.

The frontend continues to render/merge its local Y.Doc. This inspection JSON
must never become input to a whole-tree overwrite or to binary reconstruction.

## Repair command

Run `mise run server:rebuild-read-models`, or `server rebuild-read-models` with
`DATABASE_URL` set. The command needs only database configuration, applies
migrations, rebuilds every project in pages of 50, and exits without HTTP,
auth or worker startup. WorkOS credentials are unnecessary.

Each project rebuilds independently under its lock from verified binary bytes,
ignoring existing derived rows. Repeating the command safely repairs deleted/
corrupt summaries and nodes. For incomplete/quarantined documents, forced
repair clears untrusted caches and records status; canonical bytes and auth
remain intact. Arriving dependencies can rebuild the content later. Failures
are logged per UUID, other projects continue, and any failed rebuild causes a
nonzero exit. Restore missing/corrupt binary backups before rebuilding indexes;
derived JSON cannot replace canonical storage.

## Verification

`mise run server:check` tests all seven checked-in JS goldens through ingestion,
current-state reads and normalized rows, with forward/reversed delivery and
duplicate retries. Canonical DTO/placement comparisons cover Unicode, cycles,
rank ties, moved subtrees, orphan promotion, deletion and repeated insertion.
SQLx tests cover empty forests/NUL, a 10,000-node chain, causal gaps,
equal-vector deletes, quarantine, ownership, checkpoint/tail repair after
corruption, concurrent appends/jobs, deferred projection commit failure, and
worker page fairness. `mise run crdt:test` runs the production projector against
JS through 53 contract/interoperability tests including 32 deterministic seeds.
