# ADR 0007: Account workspaces, offline auth and anonymous claims

Status: accepted for MIN-41.

## Account authority and offline use

`AuthSession` owns session checks and deployment-scoped account coordination.
Its browser record contains a validated user hint, a revision, a navigation flag
and an explicit logout tombstone. It contains no credential. The old global
`cached-user-id` hint migrates once into this scope, without granting cloud access.
Only a successful `/api/me` response starts a `CloudWorkspace`.

A network failure or 503 preserves the cached account and its local catalog.
A terminal 401 preserves that same workspace, marks its session expired and
stops all cloud controllers. Generic retry, focus and online events cannot
restart expired controllers. A later successful account check creates fresh
controllers against the persisted Y.Doc; pending edits remain available offline.
An account check failure never means logout or an anonymous ownership transfer.

Explicit logout commits a tombstone, immediately stops providers, broadcasts the
transition and opens the anonymous namespace. Other tabs receive it through a
BroadcastChannel or storage event and fence stale requests; focus also checks
for missed transitions. A late `/api/me` response cannot undo logout. Until the
next explicit sign-in, an old server cookie cannot reopen the cached account.
The previous account's IndexedDB databases remain for later reauthentication.

Documents, catalogs, latest-project/view preferences and local document channels
retain the repository's deployment/account/project/generation namespaces. The
shared auth coordination channel is deployment-scoped and carries account hints,
never document content. Account changes detach the previous editor's observers,
clear its Load list and close its local relays before opening the new workspace.
A failed forced-transition flush parks the old document outside the new UI for
**Retry local saving**; it is not destroyed while the app can still recover it.

These boundaries provide UI/account isolation, **not browser-disk encryption**.
Anyone with access to the browser profile can inspect retained local caches.
Cold application-shell caching is separate (MIN-33).

## Navigation and network fencing

App-controlled login/logout first stop cloud work and pause incoming document
relays, then await document, catalog, latest-project and viewport persistence.
The auth coordination record must also commit before navigation. Storage failure
keeps the user in place with a recoverable message and resumes the current relays.

Every production cloud HTTP client sends its immutable expected owner in
`X-Mindgrab-Account`; WebSocket providers send `ownerId` in the upgrade query.
The backend always derives ownership from its authenticated session and compares
the expectation before any project operation. Mismatches return
`409 account_changed`, which pauses the client for account revalidation. This
prevents A's in-flight registration/upload from using B's newly rotated cookie.
Expectations are optional for compatibility with existing protocol clients.

Abort signals, controller lifetimes and repository identity checks fence delayed
session, discovery, baseline, receipt, preference and UI results. Provider
BroadcastChannel integration remains disabled; only namespaced local relays run.

## Recoverable, explicit anonymous claims

Signing in offers **Add anonymous projects to this account** when eligible local
anonymous projects exist. No transfer happens automatically. A source catalog
transaction binds each accepted project to one account with a stable destination
UUID and a `pending` marker; the source is then excluded from anonymous lists and
other accounts' claim offers. Browser locks serialize concurrent claims where
available, and transactional markers preserve identity across retries.

The destination catalog reserves a hidden `claimPending` entry before copying.
The service merges the complete Yjs V1 state, including unresolved causal data,
flushes it, copies the local viewport preference and registers the UUID through
an owner-fenced API client. Background sync and Load ignore incomplete targets.
Registration is idempotent. Once registration and the copy have committed, the
target is released to normal cloud reconciliation and the source marker becomes
`complete`. A crash after release but before completion simply replays the same
copy/registration on retry. A lost response likewise retries the same UUID.

If the UUID already belongs to another owner, or collides with an unrelated
local target, the source marker transaction selects a new UUID before retrying.
The raw document history/causal state is preserved; it is not regenerated from
visible JSON. The old incomplete reservation remains hidden and cannot upload.
Completed sources remain as a recovery copy, hidden from anonymous/other-account
lists. New anonymous projects may be claimed later only through another explicit
action; previously claimed content is never assigned to future accounts.

## Verification

`mise run webapp:test:browser` includes the production editor and real IndexedDB
account fixtures: anonymous offline editing → sign-in → claim → reload, lost
registration responses, concurrent retries, owner-conflict UUID replacement,
pending causal bytes, 503 versus 401, offline expiry/reauthentication, A→B isolation,
logout/login, delayed auth/catalog responses, logout from another tab, failed
local commits and recovery of parked account edits.

`mise run server:check` covers expected-owner HTTP and socket rejection alongside
existing session refresh/logout, ownership, durability and real socket tests.
`mise run webapp:test:cloud` runs the production app and sync implementation
against an isolated Rust TCP API/Postgres fixture, including offline/reload and
receipt recovery. It is independent of the shared development database and live
WorkOS configuration. Browser fixtures use controlled auth and failure responses;
manual verification uses an actual WorkOS browser session.
