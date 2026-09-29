# Yjs/Yrs contract proof of concept

Executable reference for [ADR 0001](../../docs/architecture/0001-yjs-document-contract.md).
No running webapp, database, authentication or browser is required.

```sh
# From the repository root
mise run crdt:test
mise run crdt:check
```

`contract.ts` implements creation/opening, validation, deterministic forest
projection, observed deletion, ordering and session undo. `formats.ts` implements
public JSON copies and binary recovery. `rust/src/main.rs` independently projects
forests, applies/encodes updates and edits UTF-16 text. The Bun suite builds the
worker using the repository's Rust toolchain before invoking it.

The worker accepts one JSON request per stdin line, returns one JSON response per
line, and starts a fresh document for each request. `updates` contains arrays of
V1 bytes. Optional `batch` applies them in one transaction; `stateVector` asks for
a V1 diff; `edit: {node,index,delete,insert}` edits a node's text. Output includes
content, forest, full update, state vector, optional diff and pending status.
This is a trusted-fixture worker, not a bounded production ingestion service.

Yrs #670/#673 regressions and arbitrary independent same-client gaps are excluded
at the task owner's request. The seeded suite documents its delivery constraints.
Provider versions are pinned but live IndexedDB/WebSocket behavior is not tested.
See the ADR for the exact compatibility evidence, limitations and proposed API.

The production [durable update store](../../docs/architecture/0003-durable-yjs-update-store.md)
now covers those causal-gap topologies with a Mindgrab workaround, without a Yrs
patch. `storage-fixtures.ts` supplies JS bytes and round-trip verification to the
SQLx storage API suite (`mise run server:test`); that suite also launches a fresh
Rust process to verify committed reconstruction between arrivals. Run both suites
on upgrades. This does not change the trusted POC worker's replay algorithm.
