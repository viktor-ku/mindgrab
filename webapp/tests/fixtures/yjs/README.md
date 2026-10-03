# Golden fixtures

Each `<scenario>.json` lists binary V1 update files in delivery order and expected
materialized content/forest. Fixtures use fixed Yjs client IDs. The backend tests
consume the checked-in bytes and compare forward, reversed and duplicate delivery.

Regenerate explicitly with `mise run crdt:fixtures` and review changes. Do not
regenerate automatically during tests or dependency upgrades. `../yjs-scenarios.ts`
defines the source operations. Assertions check content/forest, not binary identity.

- `unicode`: nested maps, plain shared text, emoji/non-ASCII, color and position.
- `text-causal-reversal`: dependent insertions/deletions delivered backwards and duplicated.
- `delete-only`: deletion without state-vector advancement, duplicate delivery.
- `move-delete-cycle` and `move-delete-cycle-reversed`: concurrent cycles, observed deletion and surviving unseen children.
- `equal-ranks-conflicting-move`: equal sibling ranks and competing placements.
- `repeated-insertion`: 24 insertions into the same gap, including collision re-spacing.

`../../project-interop.test.ts` exchanges generated updates with
`backend/examples/yjs-interop.ts` in a separate Bun process. It checks UTF-16 edits,
state-vector diffs and pending dependency recovery. Run it with `mise run crdt:test`.

The backend storage, compaction, archive and WebSocket tests use the same document
model and locked Yjs version as the client. Run `mise run backend:test` with local
Postgres running. Tests create and remove isolated databases.
