# Gotchas

- Yjs is the writable project state; Solid and Rust read models are projections.
  Opening a document must never seed missing maps or defaults. Hydrate first;
  incomplete content may be waiting for causal dependencies.
- Replace placement `{ parent, rank }` and position as whole atomic values.
  Never mutate an assigned object or reparent an integrated Y.Map/Y.Text.
  Delete with tombstones; retain node identities and history for undo/offline peers.
- Browser and Rust projections must agree: missing/deleted parents promote children
  to roots; cycles promote their smallest UUID; siblings sort by rank then UUID
  using ASCII order, never `localeCompare`. Projection must not write repairs.
  See `webapp/src/project-document.ts` and `server/src/project/projection.rs`.
- Yrs uses UTF-16 offsets and `small-client`; text commands must preserve surrogate
  pairs. Track only local user origins in undo, which belongs to one editor session.
- IndexedDB request success and y-indexeddb `whenSynced` do not prove edits committed.
  Only transaction completion proves local durability. Preserve in-memory edits
  after storage failure; see `webapp/src/project-repository.ts`.
- A connected/synced socket or equal state vectors do not prove cloud durability:
  vectors omit deletions. Require binary baseline/delete coverage, verified durable
  receipts and valid server content. Retry uncertain submissions with the same UUID
  and exact bytes; acknowledge only their captured edit generation.
- Pinned Yrs has causal-gap pitfalls (#670/#673). Merge retained original updates
  before applying to a fresh document; observer output/re-encoding can omit pending
  data. Check insertion holes as well as missing dependencies. See
  `server/src/project/updates/document.rs` and its regression tests.
- Compaction must prove insertion/delete coverage and replay through the production
  validation path before pruning. Retain immutable receipts and unsafe source rows.
  Use the same Postgres project-row lock for ingestion, checkpoints and backup;
  publish updates and receipts only after COMMIT. Read models are disposable.
- Scope storage and local relays by deployment/account/project/generation. Keep
  y-websocket BroadcastChannel disabled. Cached account hints permit offline reads;
  only confirmed authentication permits cloud work. Fence stale account callbacks
  and requests; a 401 pauses sync without deleting projects or implying logout.
- JSON import creates fresh identities/history; binary backup preserves them.
  Never recover CRDT state from visible JSON or clear browser data to fix an upgrade.
  Storage, document, file and transport versions are separate contracts. Workers
  must not force activation with `skipWaiting`/`clients.claim` or migrate databases
  while old tabs run; see `webapp/src/offline-contract.ts` and `webapp/build`.

Use focused `mise` tasks for the changed area. For schema, CRDT dependency or
persistence changes, run `mise run check`, including interoperability and release
gates. Do not regenerate golden fixtures or relax budgets just to pass a failure.
