# ADR 0007: Safe checkpoints and canonical binary recovery

Status: implemented by MIN-39. Requires ADRs 0001, 0003, 0004 and 0005.
Pinned implementations: Yrs **0.28.0**, `small-client`, UTF-16 offsets; Yjs
**13.6.33**. Changing either pin requires rerunning the release gates below.

## Coverage and publication

A checkpoint is a **standalone full-state V1 update** produced by re-encoding
an existing Yrs document. It is not `Y.snapshot`, JSON, a projected node tree,
a new document seeded with equivalent visible text, or a state-vector diff.
Project UUID, client IDs, clocks, origins and tombstones remain the same.

Every compactor locks `crdt_project` with the same PostgreSQL `FOR UPDATE` lock
as ingestion, baseline reconstruction, backup and projection. It reads exactly
one committed prefix, verifies checkpoint/update checksums and contiguous
application sequences, and merges the retained checkpoint and original tail
before applying once to a fresh Yrs document. This retains the application-level
workaround for [Yrs #670](https://github.com/y-crdt/y-crdt/issues/670).

For these pins and the accepted schema-v1 update subset, the sufficient coverage
criterion is all of the following:

1. Union the insertion ranges **including deleted/GC ranges** and delete sets
   of **every original input**, before merging. This union is the obligation.
2. Reject a merged insertion beyond its contiguous state-vector clock; in
   particular, an independent item beyond a Skip is unsafe even if
   `has_missing_updates` is false ([#673](https://github.com/y-crdt/y-crdt/issues/673)).
3. After application, require no pending structures or pending delete sets and
   valid schema-v1 content. Quarantined and uninitialized states cannot prune.
4. Encode a full update with an empty target vector. Decode it again and require
   exact equality of insertion ID ranges with the source union, coverage of
   **all source deletion ranges**, and equality of the encoded, integrated and
   source contiguous state vectors. A delete-only update is an obligation even
   though it does not advance any client clock.
5. Apply the encoding to a fresh Yrs document; require no pending dependencies
   and identical canonical content. Also replay the encoding through the actual
   production preflight/merge/reconstruction path and compare content. Direct
   decode/apply alone is insufficient: the live undo/offline Unicode fixture
   found an encoding rejected by that production path. Such states retain their
   source rows instead of publishing that encoding.
6. Require a complete immutable receipt ledger for the covered prefix.

Range coverage establishes retention of every item ID/clock and every accepted
explicit delete. No server GC runs, so Yrs re-encoding retains the integrated
items' payloads/structure, including deleted content. The fresh-document checks
verify that encoding retains the same interpretation and is usable by our
pinned reconstruction path. These checks supplement, rather than replace, the
JS/Rust causal-gap and replica regression gates. They do not prove arbitrary
future versions correct. Existing GC blocks supplied by clients remain GC blocks;
the server cannot recreate payloads a client already discarded.

If any coverage check is uncertain, retain the previous safe checkpoint and
**all** tail rows. No partially covered prefix is guessed. An unresolved delete
or Skip stays outside the checkpoint until dependencies arrive. Backup still
contains the previous safe full-state checkpoint (or empty `[0,0]` at sequence
zero) plus those exact original rows. The synchronization baseline continues to
merge originals, including unresolved bytes.

Publication upserts checkpoint bytes, SHA-256, checkpoint version `1`, encoding
`yjs-v1`, covered sequence and creation time, then deletes only rows at or below
that sequence, **in one transaction** with `synchronous_commit=on`. A crash before
COMMIT leaves the old checkpoint and rows; a crash after COMMIT leaves the new
checkpoint and tail. No externally visible publication/pruning window exists.

## GC, undo and replay

Server reconstruction sets `skip_gc=true` and never forces garbage collection.
Compaction consolidates the binary log and eliminates duplicate encoding/row
cost, but intentionally retains deleted payloads and CRDT history required for
safe merging. It does not promise a constant-size document, an audit log, a
historical revision browser, or undo after closing the active session. The
10 MiB reconstruction budget remains; unsafe or oversized states retain source
rows and eventually reject additional writes with 413 rather than lose data.

A connected client's Yjs UndoManager remains in its own live document, with its
tracked local origins and kept items. Server checkpoints are remote updates;
they do not recreate that document or clear the undo stack. Tests keep actual
JS documents and an UndoManager alive across repeated compactions, binary
restore, offline text edits, moves, deletes, undo and redo.

Migration `0009` backfills `crdt_receipt` from existing updates. An INSERT trigger
atomically records every subsequent receipt with UUID, sequence, SHA-256,
original byte length, acceptance validation and commit time. Receipt updates are
forbidden. Pruning deletes binary update rows only; retries compare digest and
length and return the original receipt. Receipts deliberately grow with accepted
submission IDs. They are recovery/idempotency metadata, not content revisions.
Their retention cannot be shortened while old offline retries are supported.

`GET /updates?after=<cursor>` now locks the project for a coherent page. A cursor
older than the checkpoint receives **409 `baseline_required`**. Persist a new
`/baseline` locally, record its `lastSequence`, then resume replay. No cursor
silently skips a pruned interval. The browser uses baseline/receipt synchronization
and WebSockets; socket polling already falls back to a coherent baseline if an
expected raw row has been compacted.

## Bounded maintenance and observability

One worker per API process polls every **5 seconds**, scanning at most **50
projects per page** with UUID keyset pagination. It runs one compaction at a time;
the shared reconstruction semaphore permits at most **two CPU decoders** per
process. Database row locks serialize workers and writers across API processes;
maintenance lock acquisition times out after 5 seconds. Missed ticks are skipped.

A project is due when its retained log reaches any of:

- **1,000 rows**, measured by `COUNT(*)`;
- **1 MiB**, measured by `SUM(octet_length(data))`;
- **1 hour**, measured from the oldest retained row's committed time.

These conservative defaults trigger before the hard 10,000-row/10 MiB limits.
The realistic fixture below exercises the count trigger; tests separately
exercise the byte and age triggers. After a coverage refusal, the worker records
the attempted sequence and waits for more accepted bytes rather than re-decoding
an unchanged gap. Storage/decoding failures preserve canonical data, increment
`compaction_failures` and schedule exponential retries at 30, 60, 120 ... seconds,
capped at 30 minutes. Scheduling survives restarts. A failed scheduling write is
retried by subsequent sweeps. A manual command bypasses scheduling and is safe
to repeat.

`crdt_compaction` logs structured JSON with sequence, coverage, input log rows and
bytes, resulting/current checkpoint bytes, pruned rows, reconstruction microseconds
and total microseconds. Worker errors emit `crdt_compaction_failure` or
`crdt_compaction_sweep_failure`. Inspect retry state and retained storage with:

```sql
SELECT id, last_sequence, compaction_attempt_sequence, compaction_failures,
       compaction_retry_at FROM crdt_project;
SELECT project_id, count(*), sum(octet_length(data)), min(committed_at)
       FROM crdt_update GROUP BY project_id;
SELECT project_id, covered_sequence, octet_length(data), created_at
       FROM crdt_checkpoint;
```

Alert on failures, long-lived unchanged unsafe tails, increasing receipt storage,
and log sizes approaching hard budgets. No content, credentials or binary payloads
are included in maintenance logs.

## Admin archive format

The server CLI runs these commands using only `DATABASE_URL`; WorkOS credentials
and an API listener are unnecessary. It applies migrations first. Commands use
canonical lowercase, non-nil v4 UUIDs and explicit external account identities:

```sh
mise -C server exec -- cargo run -- compact-project <uuid> <owner-external-id>
mise -C server exec -- cargo run -- backup-project <uuid> <owner-external-id> project.mgb
mise -C server exec -- cargo run -- restore-project <uuid> <source-owner-external-id> <destination-owner-external-id> project.mgb
```

A single `.mgb` file contains, in order:

- eight-byte magic `MGBK0001`;
- four-byte little-endian unsigned manifest length;
- 32 raw SHA-256 bytes of the UTF-8 manifest;
- the JSON manifest;
- concatenated **binary** V1 full-state checkpoint and required original tail.

Manifest fields include `formatVersion`, `schemaVersion`, `protocolVersion`,
`checkpointVersion`, `encoding`, `projectId`, `sourceOwnerExternalId`, original
creation/content times, decimal-string `coveredSequence`/`lastSequence`,
validation, checkpoint length/checksum, complete payload checksum, receipt
ledger and ordered tail lengths/sequences/checksums. It contains no read models,
login sessions or provider tokens. Checksums detect corruption, not authenticity;
use the operator's trusted backup storage. Unknown fields/versions, malformed
sequences, gaps, duplicate submission IDs, incomplete checkpoints, wrong lengths,
checksums and validation mismatches are rejected before writes. File reads are
bounded to **256 MiB**, receipts to **1,000,000**, and binary reconstruction to
existing 10 MiB/10,000-tail limits. Exceeding a bound fails explicitly; use a
coordinated full database backup for larger receipt ledgers.

Backup obtains the owner-authorized project lock and captures one coherent
committed prefix. A complete state can produce a new full checkpoint without
mutating the source. An uncertain/pending/quarantined state exports the previous
safe checkpoint and exact tail. Output uses exclusive creation, Unix mode 0600,
file fsync and parent-directory fsync. A failure may leave an incomplete file;
choose a new path for a retry and validate the archive before relying on it.

Restore requires the destination UUID to equal the manifest UUID **and be absent**.
It requires the stated source account to match the manifest, and resolves the
explicit destination account from an already existing `users.external_id`.
Changing ownership is an explicit mapping, never inferred from document JSON or
numeric user IDs. There is no overwrite/reset/new-UUID mode. Concurrent claims
are rejected. Canonical project/checkpoint/tail/receipts commit atomically; a
storage or commit failure leaves no partial project. The CLI then rebuilds the
read model. If that separate rebuild fails, it reports that binary restore
committed and instructs the operator to rerun `rebuild-read-models`.

## Recovery runbook and database coordination

1. Choose recovery scope. The per-project archive covers its stated prefix only;
   writes committed after backup need a later archive or PostgreSQL WAL/PITR.
2. Keep normal consistent PostgreSQL backups/WAL in addition to `.mgb` files.
   `pg_dump -Fc` sees either side of compaction's atomic commit in its MVCC
   snapshot. Never independently dump checkpoint and update tables at different
   times. Preserve users/ownership and receipts together with canonical bytes.
   Read-model tables are disposable; session/token tables need normal database
   backup protection and are not present in the project archive.
3. Restore into an isolated database first. Apply migrations and provision the
   intended destination user through the existing account provisioning flow or
   the coordinated users backup. Verify the exact external source/destination
   identities and project UUID, then run `restore-project` above against the
   isolated `DATABASE_URL`.
4. Run `rebuild-read-models` if necessary. Compare owner-authorized `/state`
   canonical content and effective placements with the expected backup state;
   require `current: true` for complete content. Pending gaps remain pending and
   quarantined projects remain quarantined, with their raw bytes retained.
5. Connect a pre-backup replica and exchange updates. Verify text, moves,
   tombstones and durable receipt retries; do not seed a new Y.Doc from JSON.
6. For production recovery, quiesce writes and stop old API processes before
   switching the database; retain the original database and backup for rollback.
   Switch every API instance together, start workers and verify auth/cloud save.
   A full database restore restores identities directly; do not also import
   `.mgb` files over those existing UUIDs. PostgreSQL VACUUM reclaims dead log
   tuples normally; compaction does not shrink database files immediately.

## Release gates and measurements

```sh
mise run db
mise run server:check
mise run crdt:test
mise run crdt:check
mise run webapp:test:cloud
DATABASE_URL=postgres://postgres@localhost:5432/mindgrab \
  mise -C server exec -- cargo test realistic_fixture_records_replay_storage_cost_and_count_trigger -- --nocapture
```

The server suite tests 60 concurrent append/compact jobs, repeat jobs, immutable
receipt retries, stale replay cursors, corruption, storage failures at publication,
pruning and deferred COMMIT, and abrupt subprocess death before publication,
after publication, after pruning and after COMMIT. Every acknowledged update
remains reconstructible. All golden JS/Yrs fixtures also compact between reversed,
duplicate arrivals. Six #670 permutations and #673 independent gaps are backed
up/restored into separate databases between arrivals, then completed in fresh
JS and Rust documents. Delete-only pending updates have the same gates.

The deterministic realistic fixture uses **131 nodes**, Unicode text (128 nodes
with 32 repetitions of `Idea 🌍 `), and **1,200 incremental edits** mixing text
insertion, text deletion and placement changes. The benchmark prints
`MIN39_BENCH`: 1,201 source rows and raw/checkpoint bytes, compaction cost and
mean baseline reconstruction time over ten reads before/after. Canonical JS
content and rebuilt Rust content must agree; storage reduction is asserted,
wall-clock speed is reported without a flaky timing assertion. Receipt metadata
remains in both measurements and is excluded from reported binary payload size;
Postgres tuple/index/page overhead is not a payload-byte measurement.

Measured on the development machine with PostgreSQL 17 and an unoptimized Rust
build: binary input **94,244 bytes → 88,713 bytes** (5.9% reduction), raw log
**1,201 rows → 0**, mean baseline reconstruction **117.1 ms → 18.6 ms** (6.3×
faster), atomic compaction **147.4 ms**. Receipt rows remain intact. These are
debugging baselines, not latency guarantees.
