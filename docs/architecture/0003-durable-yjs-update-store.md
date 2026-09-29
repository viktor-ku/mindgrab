# ADR 0003: Durable Yjs V1 update storage

Status: implemented by MIN-35. Builds on [ADR 0001](0001-yjs-document-contract.md).
Yrs remains exactly `0.28.0` with `small-client` and UTF-16 offsets; no upstream
patch or alternate CRDT service is used.

## Storage and commit boundary

Migration `0007_crdt_update_store.sql` adds immutable `crdt_update` rows containing
project UUID, sequence, submission UUID, original `BYTEA`, SHA-256, validation at
acceptance and commit time. `crdt_checkpoint` holds a binary baseline, checksum
and covered sequence. Ownership remains in `crdt_project`, outside the document.
No legacy data is reset or converted.

Every ingestion transaction locks the authenticated owner's project row with
`SELECT ... FOR UPDATE`. That lock serializes all processes using the same
Postgres database. It covers reading the checkpoint/tail, candidate validation,
sequence allocation, byte insertion and status update. `synchronous_commit=on`
is set locally and the response follows successful COMMIT. Database/WAL durability
still requires the normal durable Postgres storage configuration (`fsync=on`).

HTTP and future WebSocket handlers must use
`project::updates::ingest(pool, owner_id, project_id, update_id, bytes)`.
The owner is resolved by the authenticated transport, never accepted from content.
Only broadcast the **original accepted bytes after success**, and only expose
content when validation is `valid`. Do not apply unvalidated data to a cached
room. A socket sync response is separate from a durable submission receipt.

An identical project/update UUID and identical bytes returns the original receipt
and sequence; different bytes at that UUID return 409. Two different submission
UUIDs intentionally create two rows even if their payloads happen to match.
Receipts remain immutable after pending dependencies arrive or quarantine occurs.
Read current project status separately.

## Causal gaps without a dependency patch

The storage service merges the checkpoint and original tail using
`Update::merge_updates` before applying once to a fresh Yrs document. It never
replays arbitrary arrival order into an existing room. This is the application
workaround for [Yrs #670](https://github.com/y-crdt/y-crdt/issues/670): rebuilding
from the merged retained inputs resolves dependencies once the missing bytes
arrive, without depending on Yrs retrying its cached pending state.

For [Yrs #673](https://github.com/y-crdt/y-crdt/issues/673), the authoritative
baseline is the **merged original update**, not transaction observer output or
`encode_state_as_update` output. Detect holes by comparing the merged insertion
ranges with its contiguous state vector, as well as `has_missing_updates` for
dependencies and delete sets. State vectors alone cannot establish completeness
or deletion durability. Forward original committed updates while a gap is open;
standard Yrs state-vector diffs alone are insufficient in that state.

Transport-valid, bounded gapped updates receive `pending_dependencies` receipts.
Content remains unavailable for projection until reconstruction is complete.
Complete invalid candidates are rejected before writing. When a predecessor
exposes invalid previously accepted pending content, retain the resolving bytes
and mark the project `quarantined`. New writes and normal baselines then return
409, while original receipt retries and owner-scoped raw replay remain available
for recovery. Quarantined/pending receipts never mean the UI can claim a usable
cloud-saved document.

## Implemented HTTP API

All responses are `Cache-Control: no-store` and use the existing session cookie.
Missing and foreign-owned UUIDs both return 404. Submission requires exactly the
configured application Origin.

| Method and project-relative path | Behavior |
| --- | --- |
| `PUT /updates/<updateUUID>` | V1 bytes with `Content-Type: application/octet-stream` and `X-Mindgrab-Schema-Version: 1`; 201 for a new receipt, 200 for an identical retry |
| `GET /updates?after=0&limit=100` | Ascending original rows; standard-base64 `data`, decimal-string `sequence`, UUID, digest, `encoding: "yjs-v1"`; `nextAfter` and `hasMore` |
| `GET /status` | `schemaVersion`, decimal-string `lastSequence`, current `validation` |
| `GET /baseline` | `schemaVersion: 1`, decimal-string `lastSequence`, `validation`, `encoding: "yjs-v1"`, standard-base64 merged `data` and `stateVector` |

Prefix every path with `/api/crdt/v1/projects/<projectUUID>`. The submission
receipt follows ADR 0001: `protocolVersion`, `projectId`, `updateId`, `sequence`,
`sha256`, `durable: true`, `validation`. A baseline for a registered, uninitialized
project has sequence `"0"`, empty V1 update `[0,0]`, empty vector `[0]`, and
`pending_dependencies`. Loading it must not seed a new document.

For bootstrap, persist the baseline locally before recording its covered
`lastSequence`, then replay rows after that sequence. Baseline reconstruction
holds the project lock, so it identifies one coherent committed prefix. Apply
updates idempotently and advance replay cursors only after local durability.
For gaps, keep the merged binary baseline itself, including pending state;
exported semantic JSON is not a recovery substitute.

`project::updates::synchronization_baseline(pool, owner_id, project_id)` exposes
the same coherent binary result to MIN-36 and MIN-38. Project/node read models
and catalog names remain MIN-38 work; this task updates sequence/time/status.

New error codes are `400 invalid_update`, `409 update_id_conflict`,
`409 project_quarantined`, `413 resource_limit`, and `422 invalid_schema`.
Unsupported schema/protocol is 426, storage failure 503. No error response is a
durability receipt; retry with the same submission UUID and bytes after an
uncertain outcome.

## Bounded ingestion and checkpoint handoff

Updates are limited to 1 MiB; a replay page is limited to 100 entries and 2 MiB
of decoded bytes. A baseline is limited to 10 MiB of merged V1 data. Content
limits match ADR 0001: 10,000 nodes including tombstones, 65,536 UTF-16 units per
node, 200 UTF-8 name bytes, and 128-character canonical fractional ranks.
Unknown fields, wrong shared types, rich text, XML and subdocuments are rejected.
An allocation-free V1 preflight bounds counts to actual remaining input and
200,000 entries, atomic JSON nesting to 16, UTF-8 and clock arithmetic before
Yrs decoding. At most two candidate workers run across all projects.

Until MIN-39 implements checkpoint maintenance, reconstruction additionally
bounds the retained checkpoint plus tail inputs to 10 MiB and the tail to 10,000
rows. Reaching that budget returns 413 and requires checkpoint maintenance;
updates are never silently dropped. These are deliberately conservative work
limits, not a promise that every document with a 10 MiB visible encoding fits.

No compaction worker or raw-row deletion is introduced here. A future checkpoint
worker **must acquire the same project row lock**, verify checksum and covered
sequence, and prove causal completeness before retiring bytes. Receipt identities
and original immutable responses must survive compaction; raw-row removal without
an independent receipt archive would break retries. `load` verifies checksums
and requires a gapless committed tail after the checkpoint. Never compact based
only on `has_missing_updates`, an observer event or a state-vector diff.

## Verification

```sh
mise run db
mise run server:check
mise run crdt:test
mise run crdt:check
```

Server tests use isolated SQLx databases and mock authentication. `server:test`
installs the locked Bun contract dependencies, since the storage suite generates
and verifies bytes with the pinned Yjs library. The suite exercises commit-time
failure via a deferred Postgres trigger, immutable retries, concurrent writers,
ownership and Origin checks, content/resource rejection, quarantine, checkpoints,
delete-only updates, and all existing golden fixtures in reversed/duplicate
delivery. Six #670 delivery permutations and the #673 independent-gap topology
pass through the real submission/replay/baseline routes. A separately launched
Rust process reconstructs committed storage between arrivals and exits without
runtime cleanup; JS and Rust canonical content match after dependencies arrive.
The standalone trusted POC worker's earlier exclusions remain its historical
scope; production storage uses the tested workaround above. Run this storage
suite as well as the original contract suite on dependency upgrades.
