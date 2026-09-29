# ADR 0001: Mindgrab Yjs document contract

Status: accepted for the MIN-27 proof of concept; production integration follows.
Scope: one user across their devices/tabs, automatic local persistence, offline
reopening, and session-only undo/redo. No cross-user collaboration. Existing
snapshot development data may be discarded.

## Evidence and deliberate scope limit

The executable reference is [`tools/yjs-contract`](../../tools/yjs-contract).
It exchanges real V1 binary updates between Bun/Yjs and a Rust/Yrs process,
compares materialized content and independently projected forests, and sends
Rust text edits back to JS. Golden bytes and expected JSON are checked in.

Per the task owner's implementation instruction, upstream Yrs issues #670 and
#673 are **excluded from this POC**. There is no dependency patch or claim that
those issues are resolved. In particular, the seeded suite shuffles dependent
text edits/deletes; independent map transactions are delivered after their
client's text edits. This deliberately does not prove arbitrary independent
same-client gaps, the six #670 permutations, or #673 event/diff completeness.
Passing this suite establishes the scoped interoperability baseline, not a
production data-loss/convergence guarantee. Yrs remains the selected backend.
Do not use this POC to justify discarding raw accepted updates during compaction.

## Existing implementation and migration boundary

- `webapp/src/App.tsx` owns signals, gestures, viewport, selection and saving.
  `mind-map.ts` operates on nested immutable trees with explicit positions/colors.
  Keep its rendering/layout boundary by projecting the flat document to a forest.
- `projects.ts` keys localStorage by display name; `project-sync.ts` uploads
  snapshots and resolves conflicts with timestamps. Replace these in dependent
  tasks with UUID identity, IndexedDB, a durable outbox and update synchronization.
- `history.ts` stores snapshots and implements undo only. Replace with browser
  `Y.UndoManager`; never synchronize undo stacks or implement Rust undo.
- `server/src/auth.rs` already resolves the owner from the authenticated session.
  Preserve that boundary. Its snapshot validation and name-based PUT endpoint
  are not the new update protocol.
- `0003_projects.sql` has integer IDs and unique `(user_id,name)`;
  `0004_pnodes.sql`/`0005_pnode_colors.sql` store a relational tree with colors.
  Dependent migrations need project UUIDs, nonunique names, raw update storage and
  receipts. No migration or live endpoint is delivered by this isolated POC.

## Pinned compatibility configuration

| Component | Exact version/configuration | Evidence |
| --- | --- | --- |
| Yjs | 13.6.33 | Executed in Bun |
| Yrs | 0.28.0, `small-client` | Executed in Rust |
| y-indexeddb | 9.0.12 | Pinned for frontend integration; browser behavior not exercised |
| y-websocket | 3.1.0 | Pinned for frontend integration; live sockets not exercised |
| y-protocols | 1.0.7 | Pinned protocol implementation |
| fractional-indexing | 4.0.0, default alphabets | Executed ordering helpers |
| Bun / Rust | 1.4.2 / 1.98.1 | Rust uses `server/mise.toml` |

Both package manifests and lockfiles are committed. V1 is the **only** update and
state-vector encoding; do not call the V2 APIs. Yjs 13 uses 32-bit client IDs;
Yrs 0.28's `small-client` feature is required rather than its default 53-bit
configuration. Client IDs are generated afresh by the libraries for each live
replica, never derived from user/project UUIDs, persisted as a device identity,
or shared between active documents. Fixed client IDs are fixture-only.
Rust must use `Options { offset_kind: OffsetKind::Utf16, ..Default::default() }`;
its default byte offsets are incompatible with browser text offsets. Do not split
surrogate pairs in editing commands. No rich-text attributes or embeds in v1.

References: [Yrs features and offsets](https://docs.rs/yrs/0.28.0/yrs/),
[Yjs update API](https://docs.yjs.dev/api/document-updates),
[fractional-indexing](https://github.com/rocicorp/fractional-indexing).

## Identity and exact shared schema

One document per client-generated canonical lowercase RFC UUID (v4 for new
projects/nodes). The project UUID is the document GUID and authenticated room/API
identity, **not an editable map field**. Owner ID, credentials, transport identity,
receipt sequence and protocol version never enter document content. The registry
binds `(owner_id,project_uuid)`; a room lookup always includes the authenticated
owner. Node UUIDs are scoped to a project, are never reused, and survive moves.

Exactly one named root: `doc.getMap("project")`:

```text
project: Y.Map {
  schemaVersion: 1,
  metadata: Y.Map { name: string },
  nodes: Y.Map<nodeUUID, Y.Map {
    text: Y.Text,
    placement: { parent: nodeUUID | null, rank: string }, // atomic JSON value
    position?: { x: number, y: number },                 // atomic JSON value
    color: "blue" | "teal" | "green" | "amber" | "orange" |
           "rose" | "violet" | "slate",
    deleted: boolean
  }>
}
```

Name is a nonblank string, maximum 200 UTF-8 bytes. Duplicate names are allowed;
rename never changes identity. Lists display a short UUID suffix for duplicates,
expanding it if necessary to distinguish them. Metadata name is an atomic string;
node text is collaborative plain text. Color is required (new nodes use blue).
Position absent means automatic layout; present means an explicit shared position
in canvas coordinates. Coordinates must be finite. Placement and position are
replaced as **whole** values; never mutate an object previously assigned to Yjs.
Unknown fields are rejected in schema v1. See `contract.ts:validateContent` and
the golden JSON for machine-readable materialized examples.

Only explicit new-document creation installs metadata/nodes. Explicit new-node
creation installs its map and text once. Opening/loading an existing document
binds the root type and applies its persisted updates; it never inserts defaults,
replaces nested maps, or interprets temporarily missing content as a new document.
Wait for persistence hydration before editing. An incomplete or invalid document
is loading/quarantined, never silently reseeded. Never move an integrated shared
map/text into another parent; only update its placement value.

## Ordering and concurrent editing semantics

1. Read nondeleted nodes. An absent or deleted parent promotes the child to a root.
2. Detect cycles in the remaining parent graph (including self-cycles). For each
   cycle, promote its lexicographically smallest UUID to a root.
3. Sort each sibling set by rank, then UUID. Both comparisons are case-sensitive
   ASCII byte order (`<`/`>` in JS, string ordering in Rust), never `localeCompare`.
4. Return a valid forest. These steps do not write a repair transaction. An orphan
   can reattach when its parent arrives or deletion is undone.

Ranks use `fractional-indexing@4.0.0` with **omitted** alphabet arguments: base-62
digits and A-Z/a-z integer heads (`a0`, `a1`, `a0V`, etc.). Generate between adjacent
ranks using `generateKeyBetween`. Equal ranks remain valid and sort by UUID. If an
explicit insertion/move needs to go between equal ranks, or would exceed the
128-character rank limit, generate `generateNKeysBetween(null,null,n)` for that
observed sibling list including the moved node, and replace placements in the
same user transaction. This is an explicit command, never a background repair.
Concurrent re-spacing is resolved by ordinary Y.Map conflict rules and may change
an intended relative position; all replicas still derive the same order. Do not
promise that concurrent insertions always remain adjacent.

Parent and rank share one map key, so a concurrent move never mixes one move's
parent with another move's rank. Yjs/Yrs map conflict resolution selects the
winning atomic value; no wall-clock or application timestamp tie-breaker exists.
Reject direct local moves into the observed subtree. Concurrent moves can still
create cycles; the projection rule handles them deterministically.

Delete means set `deleted=true` on the selected node and every descendant in the
**observed projected subtree**, in one transaction. Do not remove node maps/text.
A concurrent move does not clear deletion; a concurrent unseen child survives and
is promoted if its parent is deleted. Ordinary edits/moves never set deletion
false. Undo may revert deletion through `Y.UndoManager`; concurrent undo/delete
uses Yjs semantics. Retain tombstones and CRDT history needed for outstanding
replicas; no application tombstone pruning policy is proven here.

## Local state, persistence and origins

Pan/zoom, selected/editing node, measured sizes, pointer previews, draft gestures,
layout stabilization anchors and undo stacks are local. Persist device preferences
(view/latest-project/etc.) separately, scoped by owner and project. Shared explicit
positions are content. Commit the final gesture as one transaction; text input
may use a chosen capture window, with explicit `stopCapturing()` at command and
project boundaries. The reference uses captureTimeout=0 for deterministic tests.

| Origin | Meaning | Included in undo? |
| --- | --- | --- |
| `ORIGIN.create` | Initial schema/content | No |
| `ORIGIN.local` | User edits, moves, deletes, explicit rank re-spacing | Yes |
| `ORIGIN.remote` / provider instance | WebSocket or log replay | No |
| `ORIGIN.persistence` / IndexedDB provider instance | Disk hydration | No |
| `ORIGIN.import` | Bulk loading a content copy | No |
| UndoManager instance | Undo/redo changes | Managed by Yjs |

Origins are process-local identities, not strings serialized on the wire.
`createUndoManager` tracks only `ORIGIN.local`. Create/destroy it per open editing
session; opening a new project starts empty history. Import before attaching undo.

Future browser persistence uses `y-indexeddb` under an owner/project key plus a
separate durable submission outbox. A local edit (including undo/redo) queues raw
V1 bytes under a stable update UUID. Persist before showing “saved locally”; keep
unacknowledged bytes across tab closure/restart. Hydration must not create new
outbox entries. Remote bytes are persisted locally but not echoed as new local
submissions. Receipt state is separate from WebSocket sync state. Implement and
test crash ordering between document persistence and outbox before rollout.

## Wire contract: protocol v1

These endpoints are normative **proposed integration contracts**, not implemented
HTTP/WebSocket handlers. They replace the name-based snapshot sync in dependent
work. All access uses the existing authenticated HttpOnly session; server derives
owner. Validate the browser Origin on mutations and WebSocket upgrade.

### Synchronization

`/api/crdt/v1/projects/<projectUUID>/sync` is a standard y-websocket room path
(provider serverUrl `/api/crdt/v1/projects`, room `<projectUUID>/sync`). The
versioned path selects protocol v1; do not wrap standard frames in custom JSON.
Use lib0 varuint framing: outer type 0 for sync, inner type 0 sync-step1 with V1
state vector, 1 sync-step2 with V1 update, 2 incremental V1 update. Both peers may
initiate step1. Respond with step2 using the peer's vector. Delete sets still need
to travel even when state vectors match. Awareness uses outer type 1 (and query
3), is ephemeral and unauthoritative; never store it as project content. This
scope does not require cursors or presence UI. Outer type 2 is the provider's
auth channel; use HTTP 401 before upgrade and close on session invalidation.

A sync event/step2/connected socket **does not acknowledge database durability**.
State vectors are not durability receipts or complete causal-hole detectors.
Reconnect repeats standard sync and also resumes the durable outbox/log below.

### Durable submission and replay

Create project: `POST /api/crdt/v1/projects` with
`{ "projectId": "<uuid>", "schemaVersion": 1 }`. Register identity/owner once;
idempotent for the same owner/id; no name uniqueness requirement. Initialization
is submitted as the first raw update through the following API. An uninitialized
registered project remains loading, and another tab does not initialize it.
Registration, owner-scoped listing and get-by-UUID are implemented; see the
[project catalog API](../../README.md#project-catalog-api-yjs-protocol-v1).

Submit: `PUT /api/crdt/v1/projects/<uuid>/updates/<updateUUID>`,
`Content-Type: application/octet-stream`, `X-Mindgrab-Schema-Version: 1`, body
exact V1 bytes. The update UUID identifies this submission, not a CRDT client or
clock. Commit original bytes, SHA-256 digest, owner/project/update UUID and a
monotonic per-project sequence in one database transaction **before** responding:

```json
{ "protocolVersion": 1, "projectId": "10000000-0000-4000-8000-000000000000",
  "updateId": "30000000-0000-4000-8000-000000000000", "sequence": "42",
  "sha256": "<64 lowercase hex characters>", "durable": true,
  "validation": "valid" }
```

Return 201 first time, 200 with the identical stored receipt on retry. Same
owner/project/update UUID with different bytes is 409 `update_id_conflict`.
Sequence values are decimal strings to avoid JS integer precision loss. The
receipt means **these exact bytes** are durably stored; never infer it from an
observer event, an encoded diff, a state vector or `has_missing_updates`.
Validation is `valid`, `pending_dependencies`, or `quarantined`. A pending receipt
still preserves the submitted bytes; it is not proof that content is materialized
or safe to expose. Mark pending submissions valid after prerequisites arrive and
validation succeeds. If later integration reveals an invalid schema, retain bytes
for recovery, quarantine the document and report that status; do not present a
quarantine as “cloud saved”. A retry returns the original receipt; current status
is obtained from the project status endpoint.

Replay: `GET /api/crdt/v1/projects/<uuid>/updates?after=0&limit=100` returns
`{ "updates": [{ "sequence": "1", "updateId": "...", "sha256": "...",
"encoding": "yjs-v1", "data": "<standard base64>" }], "nextAfter": "1",
"hasMore": false }`, ascending sequence, capped at 100 entries and 2 MiB decoded
bytes per page. A single entry is at most 1 MiB. Advance the durable cursor only
after saving each page locally; replay is idempotent. Snapshot plus uncompacted
raw log rebuilds a replica after restart, including pending dependencies and
delete-only updates. Read current status with
`GET /api/crdt/v1/projects/<uuid>/status` →
`{ "schemaVersion": 1, "lastSequence": "42", "validation": "valid" }`.
Do not compact away raw bytes based solely on transaction events or vector diffs.

### Errors, resource limits and schema transitions

HTTP errors use `{ "error": { "code": "...", "message": "..." } }` without
secrets. 400 malformed UUID/envelope/encoding; 401 unauthenticated; 404 missing or
unowned project (do not reveal other owners); 409 ID conflict or quarantined
project mutation; 413 byte/node/text/rank limit; 422 completed candidate schema
invalid; 426 unsupported protocol/schema; 429 throttled (Retry-After); 503 retryable
storage failure. Never issue a durable receipt after an uncommitted write.
WebSocket closes: 1009 size limit, 1008 auth/schema/policy, 1002 invalid frame.

Limits: 1 MiB raw update or sync-update payload; 10 MiB full encoded document or
recovery file; 10,000 nodes including tombstones; 65,536 UTF-16 units per text;
200 UTF-8 bytes per name; 128 ASCII characters per rank; 4 KiB recovery header.
Sync framing may add at most 32 bytes. Full sync updates over 1 MiB need the
paginated raw-log bootstrap, not a silent larger WebSocket frame. Rate-limit and
bound decoded structures and candidate processing before serving untrusted input.

Apply incoming data to a disposable candidate rebuilt from the trusted state/log,
not the live document before validation (Yjs transactions do not roll back).
Validate shared types as well as JSON and reject unknown fields/types. A causal
gap requires bounded pending storage and delayed validation, not reseeding or
throwing away offline edits. The Rust worker in this POC is a **trusted fixture
process**, not the production input validator or an HTTP service. Its JSON typing
and projections are not a substitute for the future bounded ingestion boundary.

Unknown/future schema is never auto-downgraded or opened editable. Preserve local
bytes and report upgrade required. Schema upgrades need a named migration, older
client policy, fixtures and explicit version transition; setting `schemaVersion`
alone is not a migration. None is defined for v1. Project identity and protocol
version remain external even though the content carries a schema marker.

## File contracts

Public JSON is format `mindgrab-project`, version **2** (distinct from the
existing snapshot file version 1):

```json
{ "format": "mindgrab-project", "version": 2,
  "sourceProjectId": "10000000-0000-4000-8000-000000000000",
  "content": { "schemaVersion": 1, "metadata": { "name": "Ideas" }, "nodes": {} } }
```

Content is the materialized flat schema above, including tombstones and atomic
placements, excluding all local state and ownership. Text is a string in JSON,
not a serialized shared type. Import creates a fresh project UUID and CRDT
lineage, preserving project-scoped node UUIDs. Never merge a JSON copy into an
existing lineage just because its name/source UUID matches. Duplicate names are
permitted. The helper rejects reuse of sourceProjectId. The existing v1 snapshot
format requires an explicit future converter; this helper rejects it.

Binary recovery restores the **same** lineage and UUID: 8 ASCII bytes `MGRABY01`,
4-byte little-endian unsigned header length, UTF-8 JSON header, then exactly one
V1 full-state update. Header:
`{ "projectId": "<uuid>", "schemaVersion": 1, "encoding": "yjs-v1",
"updateLength": 123 }`. Reject wrong magic/version, truncation, trailing data,
invalid UTF-8/JSON and size/schema violations. No auth/owner claims in the header
are honored; restore requires the current owner's authorization. This recovery
codec captures one loaded document; it is **not** a replacement for backing up
the durable raw update log, particularly for the excluded causal-gap scenarios.
No cryptographic integrity or authenticity is promised by this envelope.

## Verification and upgrade gate

From the repository root:

```sh
mise run crdt:test       # installs locked Bun dependencies, builds Rust, tests
mise run crdt:check      # TS/lint/format and Rust format/clippy
mise run crdt:fixtures   # explicitly regenerate reviewed golden binary/JSON files
mise run check          # includes the POC plus existing app/server checks
```

Fixtures cover nested maps/text, Unicode/emoji, text deletes, duplicate/reordered
dependent updates, delete-only state-vector diffs, pending text dependencies with
full encoding/restart, concurrent moves/deletes/reorders, cycles and equal ranks.
Unit tests cover no-write opening/projection, orphan/self-cycle handling, observed
deletion, undo origin isolation, format round trips and repeated insertion.
Seeded differential tests compare JS → Rust → JS after shuffled dependent edits.

Run the same suite for **every** Yjs/Yrs/provider/ordering dependency upgrade;
keep existing golden fixtures and add new coverage rather than automatically
rewriting expectations. Rust-authored text updates use random fresh client IDs;
compare content/forest, not byte-for-byte encodings of equivalent states.
The upstream exclusions above remain explicit follow-up work before claiming
production readiness. Browser persistence, real transport, durable API/database
integration, UI migration and fault-injection tests remain dependent-task work.
