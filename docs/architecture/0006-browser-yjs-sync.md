# ADR 0006: Browser synchronization and durable cloud saving

Status: implemented for protocol/schema v1 (MIN-37).

## Attachment and account lifetime

`ProjectSync` attaches to an IndexedDB-hydrated `ProjectHandle`. It registers the
client-generated UUID through the authenticated catalog API, merges a coherent
server baseline into the existing document, and awaits local persistence before
connecting the pinned y-websocket 3.1.0 provider. It never creates a root while
opening an existing UUID, copies a semantic snapshot over dirty content, or
compares client timestamps. Remote application uses `ORIGIN.remote`; provider
transactions use the provider instance. Neither is tracked by local undo.

The app starts network work only after `/api/me` confirms the account. A cached
user ID can select offline storage but cannot authorize an upload. Cookies travel
through the configured API origin; identity/ownership is never document content.
Providers, HTTP requests, callbacks and pending batches have one account/project
lifetime. Destruction synchronously aborts requests, fences delayed results,
unsubscribes document/browser events and destroys the socket before the handle
or repository closes. App activation and catalog callbacks also check their
repository/generation before updating the UI.

`CloudWorkspace` discovers all catalog pages, hydrates remote UUIDs into the
account's repository, and refreshes the UI catalog after local commit. Existing
local content is merged. Its bounded, sequential background pass reconciles
inactive local projects too. Only the active document keeps a socket. Discovery
and inactive reconciliation repeat every 30 seconds, on focus/online, and on
explicit retry. Transient failures back off exponentially to 30 seconds; active
edits coalesce for 250 ms. Requests time out after 15 seconds. Socket close
1008/1009 pauses until attention/retry; 1013 and transport failures retry with
bounded backoff. A terminal 401 pauses cloud saving without deleting documents.

## Exact receipt coverage and restart recovery

The controller compares persisted content against the committed binary baseline.
It uses the server's state vector for insertion diffs and checks deletion interval
coverage independently. Equal vectors never imply that deletes are saved. The
baseline is retained as binary data, including gapped updates, rather than being
reconstructed from visible JSON.

Each coalesced batch gets one UUID and immutable V1 bytes. The HTTP companion
API receipt must match the protocol, project UUID, update UUID and SHA-256, and
assert `durable: true`. A lost response retries that exact UUID/byte pair, even
when a subsequent baseline already contains it. Only the captured generation is
acknowledged; edits during registration, local flush or receipt latency remain
pending. A current `valid` server status is required before showing **Saved to
cloud**. Pending causal dependencies and quarantine never count as usable saved
content. A socket `sync` event only wakes reconciliation.

On reload the persisted Y.Doc and a new coherent server baseline determine missing
content. No in-memory queue, timestamp, latest-project pointer or durable pending
queue is needed for correctness. If a response was lost before reload, its bytes
are already in the baseline or are resubmitted under a new UUID; Yjs application
is idempotent. Within a running controller uncertain retries preserve UUIDs.

V1 diffs larger than the server's 1 MiB submission limit are divided using the
pinned Yjs encoder. Struct IDs, parent/origin references, Unicode and deletion
ranges are preserved. Dependency chunks are submitted last so partially created
nodes remain causal gaps until the batch completes. All chunks have independent
stable receipts, but the local generation is acknowledged only after the whole
batch commits and current validation is valid. A single oversized struct or
server storage limit pauses with a recoverable message; local content remains.
The backend's 10 MiB retained-input and 10,000-row limits still apply until MIN-39
adds compaction. This transport chunking does not replace that storage policy.

## Local tabs and save status

The repository's BroadcastChannel names include deployment, account namespace,
project UUID and storage generation. That relay remains active offline, persists
received updates, and exchanges diffs including delete sets. y-websocket's
URL-only BroadcastChannel is disabled to avoid crossing account namespaces.
Awareness is unused and has no local state.

**Saved locally** means the IndexedDB write transaction completed. **Saved to
cloud** means the durable baseline/verified receipts cover the observed local
generation and current server validation is valid. These labels are independent:
network failure does not invalidate a completed local save. Offline, transient
retry, expired authentication and blocked recovery states preserve content and
show the pending cloud status; Retry resumes reconciliation.

Anonymous claiming, explicit cross-tab logout and offline auth boundaries are
implemented in [ADR 0007](0007-account-workspaces.md). Only a confirmed session
starts cloud work; expired auth requires revalidation before creating fresh
controllers. MIN-33 owns cold application-shell caching.
MIN-43 removes the legacy API implementation. `/api/projects` permanently returns
426 upgrade instructions; see [cutover operations](../yjs-cutover.md).

## Repeatable verification

```sh
mise run db
mise run webapp:install
(cd webapp && bun --bun x playwright install chromium)
mise run webapp:check
mise run webapp:test
mise run webapp:test:browser
mise run webapp:test:cloud
```

`webapp:test:cloud` builds the production webapp and runs an explicitly selected
SQLx fixture. It uses a temporary Postgres database, mock WorkOS session, real
Rust TCP API/sockets, Chromium contexts and real IndexedDB. It requires no live
WorkOS credentials. The fixture is ignored by the standalone server unit suite;
`mise run check` includes it through its dedicated task.

The test covers remote-only discovery without reseeding, live socket propagation,
two independent offline devices with concurrent text/tree edits, reload before
upload, dropped commit responses, two offline tabs, delete-only reload recovery,
a document exceeding 1 MiB and fresh-device reconstruction. The production UI
also verifies authenticated UUID autosave, cloud status, rename, reload and the
cloud-discovered Load list. Intercepted page assets allow reloading the harness
while offline; explicit partition signals disconnect sockets and prevent HTTP
submission. This tests document recovery, not MIN-33's application-shell cache.
Unit tests cover generation boundaries, stable uncertain retries, receipt hash/
identity verification, pagination, delayed account/project results, auth pause,
causal-gap status and reversed/duplicate V1 chunk delivery.

Backend restart/multi-process durability remains covered by the existing real
socket and subprocess tests in ADR 0004. The complete fault/release gate belongs
to MIN-42. These focused tests supplement the pinned Yjs/Yrs interoperability
gate rather than replacing it.
