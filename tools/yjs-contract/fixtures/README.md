# Golden fixtures

Each `<scenario>.json` lists binary V1 update files in delivery order and expected
materialized content/forest. JS creates these fixtures with fixed client IDs;
Rust consumes exactly the checked-in bytes. Both single-transaction and separate
transaction delivery are checked, then the result is applied back to JS.

Regenerate explicitly with `mise run crdt:fixtures` and review changes. Do not
regenerate automatically during tests or dependency upgrades. `scenarios.ts`
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
