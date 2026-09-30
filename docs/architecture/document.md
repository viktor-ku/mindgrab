# Yjs document contract

The browser's `project-document.ts` owns creation, validation, commands and
materialization. Rust uses `project/projection.rs` for matching canonical content
and effective placements. Yjs is the sole writable content authority; the Solid
view and nested renderer forest are read-only projections.

## Supported configuration

| Component | Version/configuration |
| --- | --- |
| Yjs | 13.6.33, V1 updates/state vectors |
| Yrs | 0.28.0, `small-client`, UTF-16 offsets |
| y-indexeddb | 9.0.12 |
| y-websocket | 3.1.0 |
| fractional-indexing | 4.0.0, default alphabets |
| Bun / Rust | 1.4.2 / 1.98.1 |

Use the committed lockfiles. Live replicas get fresh library-generated client
IDs; fixed IDs are fixture-only. Yrs must use UTF-16 offsets and 32-bit client IDs.
Text is plain shared Y.Text; rich-text attributes, embeds and subdocuments are
unsupported. Never split surrogate pairs in editing commands.

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
Unknown fields are rejected in schema v1. See `webapp/src/project-document.ts` and the golden interoperability fixtures
for validation and materialized examples.

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
replicas; automatic tombstone pruning is not supported.

## Local state, persistence and origins

Pan/zoom, selected/editing node, measured sizes, pointer previews, draft gestures,
layout stabilization anchors and undo stacks are local. Persist device preferences
(view/latest-project/etc.) separately, scoped by owner and project. Shared explicit
positions are content. Commit the final gesture as one transaction; text input
may use a chosen capture window, with explicit `stopCapturing()` at command and
project boundaries. Tests use captureTimeout=0 for deterministic action boundaries.

| Origin | Meaning | Included in undo? |
| --- | --- | --- |
| `ORIGIN.create` | Initial schema/content | No |
| `ORIGIN.local` | User edits, moves, deletes, explicit rank re-spacing | Yes |
| `ORIGIN.remote` / provider instance | WebSocket or log replay | No |
| `ORIGIN.persistence` / IndexedDB provider instance | Disk hydration | No |
| `ORIGIN.import` | Bulk loading a content copy | No |
| UndoManager instance | Undo/redo changes | Managed by Yjs |

Origins are process-local identities, not strings serialized on the wire.
The editor creates one `Y.UndoManager` per open project session, tracks only
`ORIGIN.local`, and retains at most 100 user actions. Opening or importing a
project creates a fresh manager; switching projects destroys the old one.
Each semantic command and committed drag is a separate step. Consecutive text
changes within one node editing session group into one step; blur, Enter, Escape,
switching nodes, and other commands end that group. Undo and redo are available
from the toolbar, on the canvas, and while editing node text. Undo stacks remain
local to the editing session and are never synchronized.

## Synchronization, files and recovery

The versioned UUID catalog and binary receipt API use `/api/crdt/v1/projects`;
live sockets use `/api/crdt/v1/sync/<uuid>`. The backend derives ownership from
the authenticated session and checks Origin and expected-account fences.
See [durable storage](durability.md), [WebSocket sync](websocket-sync.md) and
[browser cloud saving](cloud-sync.md) for exact endpoints, framing, limits,
causal-gap reconstruction and receipt coverage.

Portable [version 2 JSON files](../project-file-format.md) contain semantic
content and create fresh project/node IDs on import. Operational
[binary backups](checkpoints-backups.md) retain project identity, clocks,
delete sets, receipts, checkpoints and required update tails. These formats
have separate compatibility contracts.

## Verification

`mise run crdt:test` exchanges golden/seeded V1 updates through a Rust fixture
worker and compares the production browser model to the production Rust
projector. `mise run server:test` adds bounded ingestion, causal-gap regressions
for Yrs #670/#673, durability, compaction and restore. Browser/editor tests cover
commands, selective undo, IndexedDB commits and account boundaries. The
[release gate](../release-regression.md) combines the shipped editor, production
shell, real browsers, multiple API processes and Postgres. Run `mise run check`
on dependency/schema changes; golden fixtures are regenerated only for reviewed
changes, never automatically to make a test pass.
