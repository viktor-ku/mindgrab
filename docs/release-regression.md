# Local-first release regression gate (MIN-42)

Run the focused release gate before cutting a Yjs release. It joins the **shipped
Solid editor**, production shell/service worker, real Chromium IndexedDB,
Yjs/y-websocket, separate Rust API processes and PostgreSQL. `mise run check`
includes this gate alongside the focused unit, browser, interop and storage tests.
No live WorkOS account, API key, existing user data, or manual browser login is
required. The mock issuer signs genuine test sessions verified by the Rust auth
middleware; it does not replace authorization or project endpoints.

## Reproduce

```sh
mise run db
mise run webapp:install
(cd webapp && bun --bun x playwright install chromium)
mise run test:release
mise run check
```

Requires the repository's pinned Bun/Rust toolchains, Chromium, and PostgreSQL 17
with permission to create/drop test databases. Override `DATABASE_URL` to use a
**development/test** Postgres server. SQLx creates the source database; the fixture
creates a second UUID-named database for binary restoration. It provisions two
source accounts and an explicitly mapped restore owner. Ports, profiles, static
build directories and project UUIDs are isolated. Normal completion and test
failure stop API children, close Chromium and remove profiles/builds/restore DBs.
SQLx owns source database cleanup. Do not run two copies of the same SQLx test
simultaneously against one Postgres server: SQLx reuses that test's database name.
After externally killing the entire test runner, terminate its remaining children
before rerunning, and remove only its `min42_restore_*` database/profile if needed.

The Rust SQLx fixture starts a separate loopback **test-only** control listener.
Controls exist only under `cfg(test)`; the production API has no fault/maintenance
HTTP route. API instances are separate OS processes running the production auth,
project router and background workers. `SIGKILL`/wait/start reconstructs solely
from Postgres. The Bun proxy forwards real HTTP and WebSocket traffic and serves a
Vite production build. Static/API traffic is never intercepted in Chromium.
Service-worker installation and offline navigation use the actual cache policy.

A build-only plugin exposes the active editor document and adds the observation
entry to the shell manifest. It does not replace the editor, repository, undo
manager, cloud controller or service worker. Normal builds contain none of these
hooks. File dialogs exercise the supported file-input/download fallback, since
native OS File System Access dialogs cannot be automated in headless Chromium.

## Assertions and fault boundaries

The gate proves these connected scenarios, rather than repeating command units:

- Two independent persistent browser profiles discover the same UUID, use two
  API processes, propagate live edits, then concurrently edit the same text and
  add tree branches offline. Scoped BroadcastChannel propagation works between
  two offline tabs. All peers eventually agree on sorted canonical content.
- After **Saved locally**, SIGKILL terminates Chromium. The same profile reopens a
  direct editor URL offline from the production cache, reconstructs acknowledged
  content, creates another branch and starts with empty undo/redo history.
- The proxy discards a real committed receipt and substitutes a transport failure.
  Retries use the same submission UUID and exact bytes. A held response cannot
  acknowledge a subsequent generation. PostgreSQL's deferred constraint trigger
  fails at COMMIT: no receipt/content is published, the UI stays pending, and
  retry recovers. An aborted IndexedDB transaction shows unsaved content and a
  successful retry commits the retained edit.
- Local undo removes only its own insertion while retaining a remote insertion
  into that same text; redo preserves the remote insertion. Redo's placement is
  CRDT-defined; the assertion does not impose an arbitrary insertion order.
  Pure text deletion keeps the same state vector and survives offline reload,
  cloud reconciliation and abrupt API restart.
- Real incremental updates arrive with causal successors before predecessors and
  with duplicate deliveries. The API reports pending dependencies before the
  missing bytes arrive, then JS, Rust canonical state and deterministic effective
  placements agree. Cycles and missing parents are projected without modifying
  the shared document. An empty imported map stays empty after reopening.
- A complex Unicode/undo history may trigger the pinned Yrs coverage refusal.
  That must retain **every** source row/byte and receipt, with identical canonical
  state. A separate safe history **must publish and prune**, retain immutable
  receipt retries, support a live undo/redo manager across the checkpoint and
  merge a client's pre-checkpoint offline branch on reconnect. Refusal cannot
  silently turn the successful pruning test into a no-op.
- The real binary archive is written/read/checksummed and restored into another
  database/account. A fresh browser reconstructs its canonical content, and the
  rebuilt read model's content, placements and freshness equal the source.
- Switching the browser cookie revalidates `/me` and selects the other namespace.
  Owner-scoped catalog/baseline/state/update reads and binary writes reject the
  old account's UUID. Switching back restores the original workspace.
- UI exports/downloads/imports preserve name, tree, Unicode text and colors with
  fresh identities. No request reaches the legacy `/api/projects` snapshot path.
  This checkout runs Yjs by default; it has no separate editor feature flag.

Existing gates retain their distinct responsibilities: `webapp:test:cloud`
checks oversized chunk transport; `webapp:test:offline` checks shell upgrades,
exclusions and first-visit failures; `server:check` includes compaction publication,
pruning/COMMIT process crashes and concurrent multi-process durability;
`crdt:test` checks the reviewed JS/Yrs fixtures. The supported deployment contract
is multiple API processes coordinated by Postgres row locks/polling, without
shared in-memory rooms. The release gate exercises that contract with two real
processes plus restart and restore.

## Fixtures, measurements and acceptance budgets

The source fixture generator is `webapp/tests/browser/release.integration.ts`.
It creates maps with **10** and **1,000** live nodes: one root and ordered sibling
children, with eight repetitions of `Idea <index> 🌍 ` per child and 100 incremental
prefix edits to the root. Import goes through the real UI/validated portable
format and mints fresh UUIDs. Shape, text and edit counts are deterministic.
The initial shared fixture adds concurrent branches, Unicode, deletion, undo,
cycle and orphan conflicts. UUID allocation and replica conflict ordering vary;
canonical equality, content preservation and deterministic projection are asserted.

| Measurement | Acceptance budget | Boundary |
| --- | ---: | --- |
| p95 of 100 text edits, both map sizes | < 50 ms | Synchronous command/validation and Solid observer/DOM work; excludes network and next paint |
| Editor reopen after browser death / fixture reload | < 2,500 ms | Navigation to hydrated, rendered storage-ready editor; independent of cloud |
| Rust baseline replay, before and after compaction | < 500 ms mean | Five full committed binary reconstructions through the production path |
| Retained binary update + checkpoint payload | < 1,500 bytes per fixture node | Both pre- and post-compaction, excluding receipt/index/table overhead |
| Local-origin cloud acknowledgement | 10,000 ms deadline | UI wait; a blocked/faulted state must not show saved |
| Replica convergence with sockets disabled | 35,000 ms deadline | Documented 30-second HTTP discovery/reconciliation interval plus 5 seconds processing |
| API child startup | 10,000 ms deadline | Listener becomes ready in a new OS process |
| Browser SIGKILL disconnection | 5,000 ms deadline | Verified browser PID from CDP, abrupt OS termination |

Budgets are acceptance gates, not advertised product SLAs. The edit budget allows
at most roughly three 60-Hz frames of synchronous work. Reopen/replay bounds are
local interactive targets. The 1,500-byte/node payload cap bounds encoding/history
growth for the fixed fixture, not arbitrary user text. The convergence deadline
explicitly accounts for the application's HTTP polling schedule; it does not
extend operation timeouts until a broken test passes. Do not increase a budget
without recording the regression and reviewing the intended acceptance target.

The fixture pauses browser networking and kills API writers after the cloud
acknowledgement before taking storage/replay samples. It then reopens offline,
compares to Rust reconstruction, restarts API processes and reconnects. This
prevents delayed socket echoes from changing the measured prefix. Compaction must
prune all sampled rows and leave content/receipts intact. Printed payload sizes
exclude PostgreSQL physical tuple/index/page overhead and the immutable receipt
ledger; receipt counts are printed and checked separately.

The final JSON printed by `mise run test:release` records CPU/count, OS, Bun,
Chromium, actual Rust/Postgres versions, budgets, p95/max edit cost, offline reopen
time, pre/post rows and payload sizes, receipt counts, replay means, and compaction
cost. Rust is tested in its unoptimized test profile. Keep this JSON with release
results; machine load and build profile materially affect comparisons.

## Recovery regression fixed by this gate

Chromium can buffer **localStorage** writes after `setItem` returns. An immediate
SIGKILL after signing in and saving locally could retain the account's IndexedDB
project but lose its new account hint; cold offline startup opened the anonymous
workspace instead. The account hint/logout tombstone now also commits through a
strict IndexedDB transaction before account confirmation or auth navigation is
acknowledged. Startup hydrates this record before selecting/opening a workspace.
A sequence allocated under the database write lock makes the committed record
win over a stale localStorage copy, including stale login hints after logout.
LocalStorage and BroadcastChannel still coordinate immediate cross-tab fences;
they carry no token and cannot authorize cloud access. Failed writes block auth
navigation and retain the prior committed hint. Existing local hints bootstrap
into the new separate store without migrating or deleting project databases.

Account browser regressions also verify missing/stale localStorage recovery,
durable logout, delayed account results, and an aborted hint transaction followed
by successful retry. If initial storage opening fails, export remains available
and Retry local saving retries hydration before choosing a workspace.

The 1,000-node fixture also exposed repeated full layouts from individual node ResizeObserver callbacks (about 5.5 seconds to reopen). Node measurements now publish together once per animation frame, preserving the same layout algorithm while keeping the original reopen budget. Existing drag, text, selection and project-switching browser checks validate the behavior.

## Recorded run

[MIN-42 result JSON](release-results/min-42.json) records the 2026-09-30 run on
an AMD Ryzen 9 5950X, Linux, Bun 1.4.2, Chromium 151.0.7922.34, Rust 1.98.1
(unoptimized test build), and PostgreSQL 17.11. The gate completed in 48.5 seconds.

| Nodes | p95 edit | Offline reopen | Replay before / after | Raw bytes → checkpoint bytes | Rows before → after |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 0.3 ms | 75 ms | 3.8 / 3.5 ms | 4,071 → 3,978 | 7 → 0 |
| 1,000 | 4.3 ms | 287 ms | 67.1 / 63.0 ms | 300,470 → 300,409 | 5 → 0 |

The lost receipt retried twice with identical bytes; the injected COMMIT failure
produced no receipt or changed durable content. All convergence, crash, recovery,
account, undo and import/export assertions passed. Coalescing and socket echoes
can vary pre-compaction row counts between runs; canonical content, bounds,
receipt preservation and actual pruning are the acceptance criteria.
