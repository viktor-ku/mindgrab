# Golden fixtures

Each `<scenario>.json` lists binary V1 update files in delivery order and expected
materialized content/forest. JS creates these fixtures with fixed client IDs;
Rust consumes exactly the checked-in bytes. The server read-model suite sends
them through the production ingestion path with forward/reversed delivery and
duplicate submissions, then compares content and effective trees against JS.

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

The interoperability suite additionally exercises Rust-authored Unicode edits,
state-vector and delete-only diffs, and pending dependency recovery. Randomized
command convergence lives in the document suite's 24-seed scenario. The server
storage suite exercises Yrs #670/#673 causal gaps, including both transaction
modes for the insertion-hole regression.

The fixtures live with the webapp tests and are also consumed by the server's
read-model suite. `../project-document.ts` builds deterministic
wire inputs using the shipped document model and the webapp's locked Yjs.

`../../project-interop.test.ts` exchanges generated updates with the server's
`examples/yjs_interop.rs` worker for Rust-authored UTF-16 edits, state-vector
diffs and pending dependency recovery. Run it
with `mise run crdt:test`; the regular webapp tests also include it.

The `../server-storage.ts` and `../server-maintenance.ts` helpers supply real
Yjs replicas to the Rust/Postgres storage, checkpoint and backup tests. Real
Chromium providers exercise WebSockets in the cloud/release tasks.
`mise run server:test` installs
the webapp dependencies they share. `mise run crdt:check` uses the existing
webapp and server checks; there is no separate test tooling package.
