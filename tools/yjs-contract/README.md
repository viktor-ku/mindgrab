# Yjs/Yrs interoperability tests

```sh
mise run crdt:test
mise run crdt:check
```

These tests use the shipped browser document model and Rust projector. The
fixture helpers construct deterministic wire inputs with fixed client IDs;
they do not implement a second validator, projection, editor or file format.
Library instances come from the webapp's locked dependencies to avoid loading
multiple Yjs copies. The tool package contains only test/compiler dependencies.

`interop.test.ts` checks golden V1 updates, Rust-authored UTF-16 edits, delete-only
diffs, pending dependency recovery and seeded duplicate/shuffled deliveries.
The Rust worker accepts line-oriented JSON containing `updates`, optional
`batch`, `stateVector`, or `edit: {node,index,delete,insert}` and returns content,
forest, full update, state vector, optional diff and pending status. It is a
trusted test process; the API's bounded ingestion is tested separately.

`storage-fixtures.ts`, `maintenance-fixtures.ts` and `websocket-client.ts` supply
wire inputs and verification to the real Rust/Postgres storage, checkpoint,
backup and socket suites. They include Yrs #670/#673 causal-gap scenarios.
`mise run check` also exercises the shipped editor, real IndexedDB, production
shell, account lifecycle and full-stack release faults.

[Document contract](../../docs/architecture/document.md),
[durable storage](../../docs/architecture/durability.md),
[golden fixture maintenance](fixtures/README.md).
