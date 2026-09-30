# Golden fixtures

Each `<scenario>.json` lists binary V1 update files in delivery order and expected
materialized content/forest. JS creates these fixtures with fixed client IDs;
Rust consumes exactly the checked-in bytes. Both single-transaction and separate
transaction delivery are checked, then the result is applied back to JS.

Regenerate explicitly with `mise run crdt:fixtures` and review changes. Do not
regenerate automatically during tests or dependency upgrades. `../yjs-scenarios.ts`
defines the source operations. A repeated binary entry represents duplicate
network delivery. Golden assertions check content/forest, not equivalent binary
encoding identity.

- `unicode`: nested maps, plain shared text, emoji/non-ASCII, color and position.
- `text-causal-reversal`: dependent text insertion/deletion delivered backwards
  and duplicated.
- `delete-only`: deletion without state-vector advancement, duplicate delivery.
- `move-delete-cycle` and `move-delete-cycle-reversed`: concurrent cycle, observed
  delete and surviving unseen child; two delivery schedules converge.
- `equal-ranks-conflicting-move`: equal sibling ranks and competing placements.
- `repeated-insertion`: 24 insertions into the same gap, including collision
  re-spacing, then independent JS/Rust forest materialization.

The test suite additionally exercises Rust-authored Unicode edits, state-vector
and delete-only diffs, pending dependency recovery, and 32 deterministic seeds.
The server storage suite additionally exercises Yrs #670/#673 causal gaps.

The fixtures live with the webapp tests and are also consumed by the server's
storage and read-model suites. `../project-document.ts` builds deterministic
wire inputs using the shipped document model and the webapp's locked Yjs.

`../../project-interop.test.ts` exchanges these updates with the server's
`examples/yjs_interop.rs` worker, including Rust-authored UTF-16 edits,
state-vector diffs, pending dependency recovery and seeded deliveries. Run it
with `mise run crdt:test`; the regular webapp tests also include it.

The `../server-storage.ts`, `../server-maintenance.ts` and
`../server-websocket.ts` helpers supply real Yjs replicas to the Rust/Postgres
storage, checkpoint, backup and WebSocket tests. `mise run server:test` installs
the webapp dependencies they share. `mise run crdt:check` uses the existing
webapp and server checks; there is no separate test tooling package.
