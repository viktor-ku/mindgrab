# ADR 0002: Local project repository in IndexedDB

Status: accepted for the MIN-31 storage layer; UI integration (MIN-32) and
network sync (MIN-37) are separate tasks. Scope: browser storage APIs only.
The existing localStorage snapshot path stays untouched until the cutover.

## Storage layout

All names derive from one scope: a `deployment` label (one per backend an
origin serves), an owner namespace (`anonymous`, or `account-<userId>`), and a
schema `generation`. `storageNames()` produces

```text
mindgrab/<deployment>/<namespace>/g<generation>/catalog          # project index
mindgrab/<deployment>/<namespace>/g<generation>/project/<uuid>  # one Yjs document
```

Document databases keep the exact `y-indexeddb@9.0.12` layout (the `updates`
auto-increment store plus `custom`), so its hydration code and any external
tools keep working. The catalog adds two stores at version 1: `projects`
(keyed by project UUID) and `preferences`. Old localStorage snapshot records
are not ported; MIN-43 performs the authorized dev reset.

## Verified adapter behavior

`y-indexeddb` resolves `synced` (and `whenSynced`) after **initial hydration
only**. Its per-update writes are fire-and-forget `IDBRequest.add` calls: a
request `success` event means queued, not committed, and transaction aborts
are never reported. The repository therefore reuses the adapter for opening
and hydration, but replaces its store handler (`_storeUpdate`) with tracked
transactions: an update is written in a readwrite transaction and counted as
durable only on that transaction's `complete` event; `abort` (including
`QuotaExceededError`) marks the change unsaved and keeps the in-memory
document. A full-state write (`Y.encodeStateAsUpdate`) covers every earlier
failed or missing update and then prunes superseded rows; at most one full
write queues behind the running one. `flush()` resolves only after every
pending transaction commits and throws the last `StorageError` otherwise. When
the document has unresolved structs or delete sets, `flush()` first persists its
full binary state: Yjs update events can omit these pending portions. Relayed
causal gaps also trigger a full-state write. Callers must not report "saved locally"
before `flush()` or a
`{ status: "saved" }` durability notification. Accumulated updates are
trimmed to one snapshot after `PREFERRED_TRIM_SIZE`, matching the adapter.

## Lifecycle APIs

`ProjectRepository` (one instance per tab and scope):

- `create({ id?, name, root? })` — seeds **only an explicitly new UUID**,
  rejects with `ProjectExistsError` if that UUID already has content
  (including another tab's in-flight seed), persists the seed before
  registering it in the catalog, and remembers it as the latest project.
- `open(id)` — resolves after hydration. Never seeds: an empty document is
  `state() === "loading"`; wait for it to become `"ready"` before deciding
  the project is missing. `create`/`open` return a `ProjectHandle`.
- `list()` — merges catalog entries with stored document databases, so a
  document saved before its catalog write is recovered (as `pending`)
  without duplicate seeds.
- `latestProject()` / `setLatestProject(id)` and `preference` /
  `setPreference` — device-local values under `local/<key>`, e.g.
  `project/<uuid>/view`; never project content.
- `refreshMetadata()` (also invoked automatically after edits settle) —
  keeps the catalog name in sync and registers hydrated-but-unregistered
  documents; it waits for document commits so the index never points at
  unsaved content.
- `markRegistered(id)` — flips `registration` from `pending` to
  `registered` once the backend acknowledges the UUID.
- `onCatalogChange(listener)` — fires for catalog changes made in this or
  another tab (cross-tab `BroadcastChannel` on the catalog name).
- `close()` — flushes, closes this tab's connections, and removes observers.
  It never deletes or closes another tab's data.

`ProjectHandle`: `doc` (edit with `project-document` commands), `state()`,
`durability()`, `onDurability(listener)`, `flush()`, `refreshMetadata()`,
`close()`. Multiple handles on the same UUID share one session per tab;
closing the last one tears it down, and repeated open/close does not
accumulate observers or connections.

## Durability, failures, and cross-tab behavior

`Durability` is `{ status: "saved" }`, `{ status: "saving" }`, or
`{ status: "unsaved", error }`. `StorageError` reasons: `unavailable`
(no/private IndexedDB), `quota`, `blocked` (open exceeded `openTimeoutMs`),
`open`, `versionchange`, `closed`, `aborted`. Editability never depends on
storage health: failed commits keep in-memory content, mark the document
unsaved, and retry as a full-state write — including after quota frees up
or the connection recovers. Another tab upgrading a database fires
`versionchange`; sessions close and transparently reopen once. Two tabs on
the same UUID relay updates over a `BroadcastChannel` (state-vector exchange
on open, incremental updates after), each persisting what it receives;
remote-origin and persistence-origin updates are never echoed back. Each tab
owns its connections only — no tab deletes another tab's database or
interrupts its pending transactions. A connection held by another tab that
ignores `versionchange` surfaces as `blocked` on open rather than hanging.

## Testing

`webapp/tests/browser/project-repository.browser.ts` runs a real Chromium
(Playwright) against the actual implementation, via `mise run
webapp:test:browser`: create/edit/reload offline, two tabs on
one UUID including one tab's repository closing, hydration racing with an
empty document, duplicate-UUID seeds, rename/latest/preference restoration,
deployment/namespace/UUID isolation, injected commit aborts and real quota
exhaustion (CDP `Storage.overrideQuotaForOrigin`) with in-memory retention
and post-recovery reconstruction equivalence (content and state vector),
interrupted catalog registration recovery, repeated open/close leak checks,
and database-upgrade reconnection plus blocked-open timeout. The browser must
be installed once with `bunx playwright install chromium`.


MIN-41 adds durable anonymous source claim markers and hidden account target
reservations; see [ADR 0007](0007-account-workspaces.md). Default `list()` and
`latestProject()` exclude claimed sources and incomplete targets. Recovery may
use `list({ includeClaims: true })`. `detach()` immediately fences catalog and
document channels while a failed local write remains in memory for retry;
`setRelaysPaused()` temporarily fences incoming updates before auth navigation.
