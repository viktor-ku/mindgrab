# Offline application reopening

A production installation visited online can reopen the editor at `/` (including
`/?project=…`) without a network connection. The editor opens the current
workspace's last local project and its UUID catalog. Only projects already stored
in this browser are available; a cloud-only project must first be opened online.
The service worker stores only the application shell. Account hints and projects
continue to use the existing deployment/account-scoped repository. This is not
offline sign-in: WorkOS and authenticated cloud access require a live connection.

## Prerequisites and limits

- Visit online and wait for **Ready to reopen offline in this browser**. A first
  visit without network access cannot install the shell. Installation is atomic:
  one unavailable or redirected asset prevents the new worker from installing.
- Use HTTPS, or localhost for development. Service workers need a secure context.
  Registration is production-only; Vite development does not install a worker.
- Wait for **Saved locally** before closing a tab. A cloud outage does not prevent
  local saving. Closing a tab during an uncommitted write or composition can lose
  that unfinished change; the worker cannot commit editor state for you.
- Browser eviction, clearing site data, private browsing, disabled storage, or a
  full disk can remove/disable Cache Storage or IndexedDB. Offline readiness
  describes successful installation, not guaranteed permanent storage. Export
  important projects as backups. The cache provides no disk encryption.
- The build currently requires deployment at `/`. `/checkhealth` is deliberately
  network-only, including its navigation. Unknown routes, API/auth traffic, token
  queries, non-GET requests and cross-origin traffic bypass the worker.

## Build and deployment contract

`webapp/build/offline-shell.ts` emits `/sw.js` after Vite has generated HTML,
JS and CSS. Its allowlist includes every emitted chunk and required public asset
(including `icons.svg` and `favicon.svg`), excluding source maps. The cache version
hash covers those bytes, worker code and the compatibility contract. Never place
private content or credentials in `public/` or build output. Reserved API, auth,
health and worker paths fail the build.

Serve `sw.js` with JavaScript MIME type and `Cache-Control: no-cache` (or
`no-store`). Publish the HTML, worker and assets as one release; retain previous
hashed assets during rollout. Serve public static assets without authentication
or redirects, using HTTPS. The server's normal SPA fallback must not shadow `/api`
or WorkOS callbacks. Registration uses `updateViaCache: none`. A new worker
precaches with omitted credentials and rejects redirects. It never caches runtime
responses, API data, WorkOS pages, tokens, or health results. Editor navigation
and exact manifest assets come from the same version's cache, preventing mixed
HTML/bundles after a release. Missing/evicted entries try the network without
adding responses to the cache.

## Upgrades and schema compatibility

Cached clients check for a newer worker on opening, reconnect, focus, returning
from a hidden tab, and every five minutes while visible and online. Checks use
`updateViaCache: none` and continue after an offline startup or failed deployment.
Concurrent checks within a tab are coalesced. Hidden/suspended browsers cannot
promise an exact detection time; returning to the app triggers another check.
A client that remains offline keeps its last complete installation until the
release is reachable. Downloads must finish before the update-ready notice.

No `skipWaiting`, `clients.claim`, controller-change reload, database migration,
or database deletion runs in the worker. New releases stay waiting while any old
controlled tab remains open; those tabs keep their own shell and code. Once all
old clients close, activation deletes only obsolete `mindgrab-shell/` caches.
Unrelated caches and IndexedDB are untouched. The update notice asks users to
wait for **Saved locally**, close **all** Mindgrab tabs and reopen. Unsynced Yjs
updates remain durable locally and the normal sync provider reconciles later.

`src/offline-contract.ts` is the shared source of storage-generation, catalog,
document-schema and shell-protocol versions. Before mounting the editor, a
controlled production page asks its worker for that contract. A mismatch or
unverifiable worker shows **Application update needed** with retry instructions
without opening the repository, while still checking for a compatible worker
update. Unsupported document versions also show a
recoverable message and retain the document; document commands already reject
unsupported content. Never clear data to fix an upgrade.

Version bumps require a reviewed migration plan. In-place incompatible IndexedDB
upgrades must wait for old clients to close; a new storage generation must retain
and explicitly migrate/import old generations. The Yjs cutover retains
generation 1 and resets only obsolete localStorage
snapshot keys, never an IndexedDB database. A separate worker at
`/legacy-reset-worker.js` with scope `/legacy-reset/` inventories all same-origin
window clients, including uncontrolled legacy tabs, before reset. It has no
fetch/cache handler and unregisters after the check. Web Locks serialize reset
attempts. More than one tab, unavailable coordination, or storage errors block
editor startup until retry. See [cutover operations](yjs-cutover.md). Waiting
activation alone does not authorize future destructive
migrations, and no worker message permits forced activation.

## Repeatable automated verification

```sh
(cd webapp && bun --bun install --frozen-lockfile)
(cd webapp && bun --bun x playwright install chromium) # once
mise run webapp:test:offline
mise run check
```

The offline suite builds two real production releases into temporary directories
with `NODE_ENV=production`, serves them through real HTTP without browser request
interception, and uses isolated persistent Chromium profiles. It checks:

1. Online account editing, browser process exit, offline direct URL reopening,
   further editing, reload persistence and network reconnection.
2. API/project/auth/logout/health, foreign-origin, unknown-route and token-query
   exclusions, both network requests and exact cache contents.
3. A version update while cloud saving is unavailable and two old tabs are open;
   both retain their build, edits survive reload, and the new version activates
   only after all old clients close and then reopens offline.
4. Failed installation retains the old shell and edits; incompatible worker
   contracts block editor startup and preserve databases; first-visit offline
   failure; logout/account isolation under the cached production shell; newer
   catalog versions report an upgrade without deleting stored projects.
5. Automatic release discovery on reconnect/focus, periodic retries after a
   deployment outage, and recovery from failed first registration without reload.

The fixture deliberately leaves cloud saves pending; it is not a WorkOS or
Postgres mock convergence proof. Existing account-browser tests exercise receipt
and auth fencing; `webapp:test:cloud` exercises real Rust/Postgres reconnection.

For manual verification, run `mise run webapp:build`, then
`(cd webapp && bun --bun run preview --host localhost --port 4183)`. Visit
`http://localhost:4183`, wait for offline readiness, create/edit and wait for local
save. Close all site tabs, use browser DevTools' Network **Offline** setting,
reopen that direct URL, edit again and reload. Re-enable networking and verify
account checking/sync resumes. To test upgrades, keep two tabs open with edits,
change a static asset, rebuild, and reopen a tab online (or call
`(await navigator.serviceWorker.getRegistration()).update()` in its console).
Verify the update waits, old tabs keep working, and closing all tabs followed by
reopening uses the new shell with retained edits. The collaborative T3 preview
can verify the production UI; the automated suite controls process shutdown and
network isolation reproducibly.

## Development reset without deleting projects

A previously installed production worker can control the same origin when
switching back to Vite development. Prefer a separate preview port. To remove
only shell caching, close other Mindgrab tabs, run the following in that origin's
browser console, then reload online:

```js
for (const registration of await navigator.serviceWorker.getRegistrations()) {
  if (registration.active?.scriptURL === `${location.origin}/sw.js` ||
      registration.waiting?.scriptURL === `${location.origin}/sw.js`) {
    await registration.unregister();
  }
}
for (const name of await caches.keys()) {
  if (name.startsWith('mindgrab-shell/')) await caches.delete(name);
}
location.reload();
```

Do not use **Clear site data** unless intentionally deleting all local projects,
account hints and unsynced edits. Unregistering does not immediately detach other
open tabs; closing them prevents the old worker from remaining in use.

References: [Yjs offline support](https://docs.yjs.dev/getting-started/allowing-offline-editing),
[service worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).
