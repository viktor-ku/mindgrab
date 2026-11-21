# Rust backend

`mindgrab-backend` is an Axum service with WorkOS AuthKit authentication and
Postgres persistence. It uses `mindgrab-state` directly; there is no JavaScript
server runtime or separate implementation of document rules.

## Railway deployment

Railway runs two services from the `live` branch, both rooted at `/`:

- `mindgrab` builds the root `Dockerfile` and serves the API at `api.mindgrab.app`.
  Its healthcheck path is `/`.
- `web` builds `webapp/Dockerfile` and serves the static webapp at `mindgrab.app`.
  Its healthcheck path is `/`. `VITE_BACKEND_URL=https://api.mindgrab.app` is a
  build variable on this service. `POSTHOG_CLI_API_KEY`, a PostHog personal API
  key with error tracking write access, lets the build upload source maps so
  exceptions in PostHog show original code. Without it the build skips the upload.

Both domains are proxied through Cloudflare. They scale and deploy independently:
watch patterns limit each service to its own files, plus `crates/`, `tooling/` and
`Cargo.*`, which both builds use. A new Railway custom domain only verifies while its
Cloudflare record is DNS-only; turn the proxy on once the certificate is valid.
The API must stay on a subdomain of `APP_URL`: sessions use `SameSite=Lax` cookies,
which browsers only send within one site, and `*.up.railway.app` is a public suffix,
so it is never the same site. Startup rejects a callback on any other site. Set
`APP_URL=https://mindgrab.app/` and
`WORKOS_REDIRECT_URI=https://api.mindgrab.app/api/auth/callback.php`; Origin checks
and CORS allow the app's origin.

Set `HOST=::` and `PORT=8080` so the API is reachable on Railway's public and
private networks. Keep `DATABASE_URL` pointing at the project's Postgres
service. Configure the WorkOS credentials, `APP_URL` and `WORKOS_REDIRECT_URI`
as described below. Release builds use WorkOS authentication.

The backend image contains the compiled native API and trusted HTTPS certificates.
Postgres schema creation runs on startup. GET `/` is the healthcheck: Apache's "It works!" page
with a 200 when the database is reachable, and a 503 otherwise. No login is required. The webapp's
`/checkhealth` page is a separate client-side route that calls
`/api/getHealth.php`.

The healthcheck path and `WORKOS_REDIRECT_URI` are Railway settings, and WorkOS
keeps its own list of allowed redirects, so moving either route in code is not
enough. The [deploy skill](../.agents/skills/deploy/SKILL.md) covers changing them.

## Local development

Run `mise run worktree:bootstrap`, `mise run db`, `mise run backend:dev` and
`mise run webapp:dev`. Open the `APP_URL` from this worktree's `mise.local.toml`.
Vite proxies API and WebSocket requests on the web app's
origin, keeping login callbacks and HttpOnly cookies on that origin.

Before removing a worktree, run `mise run worktree:settle`. It stops the dev
servers listening on this worktree's ports, removes its Compose project with the
Postgres container and data volume, and drops the generated variables from
`mise.local.toml`. It does nothing in the main checkout.

`schema.sql` installs a fresh `mindgrab_loro` schema. This is schema creation,
not a conversion of previous data. Sessions and login attempts expire. Project
UUIDs are globally reserved for their owner; deleting a cloud copy removes its
snapshot while retaining the UUID reservation. The same owner can re-enable it.

## Authentication

### Local login for agents and worktrees

`mise run backend:dev` sets `MINDGRAB_ENV=development` and defaults
`MINDGRAB_AUTH_MODE` to `local`. No WorkOS credentials or registered callbacks
are needed. A new browser session starts signed out. Click **Sign in** to create
the local **Boba Tee** account (`boba.tee@mindgrab.test`, external ID
`local_boba_tee`); click **Sign out** to return to anonymous use. This account is
separate from the WorkOS staging account and persists in the worktree database.

The backend completes the one-use state/callback flow on `APP_URL`, sets a real
opaque HttpOnly session cookie, and uses normal database sessions, expiry,
account fences, project permissions and logout revocation. Local login,
account checks and logout make no WorkOS requests. Cookies include the app port
because browser cookies otherwise overlap between localhost worktrees.
The frontend's normal persistence, cloud saving and signed-out behavior remain
available to test. This does not simulate hosted AuthKit UI, JWT validation,
refresh rotation, or provider failures; existing provider-fixture tests cover
those paths.

Local authentication requires a debug build, `MINDGRAB_ENV=development`, and
loopback `APP_URL` and backend `HOST`. The backend defaults to `127.0.0.1` in this
mode. Release builds reject local mode. To run directly with Cargo, set both
`MINDGRAB_ENV=development` and `MINDGRAB_AUTH_MODE=local`; defaults remain WorkOS
outside the dev task. Agents should follow
[mindgrab-local-signin](../.agents/skills/mindgrab-local-signin/SKILL.md).

### WorkOS AuthKit

For the hosted flow, configure `.env` from `.env.example` and run
`MINDGRAB_AUTH_MODE=workos mise run backend:dev`. The WorkOS application must
allow the exact `WORKOS_REDIRECT_URI` and `APP_URL` for that environment.

`mise run worktree:bootstrap` keeps saved worktree settings, except that a saved
`WORKOS_REDIRECT_URI` ending in `/api/auth/callback` moves to
`/api/auth/callback.php`. The value in `mise.local.toml` wins over `.env`, and local
login ignores it.

WorkOS authorization uses one-use state and PKCE. The server stores an opaque,
hashed browser credential and keeps access/refresh tokens in Postgres. Each
protected request validates a signed RS256 JWT against WorkOS JWKS, checking
issuer, client ID, audience when present, session identity and token timing.
Refresh rotation is serialized with a short lease on the session row, so no
database connection is held during a WorkOS call. Provider outages do not erase
local browser work or valid stored sessions. Logout removes server authority
before redirecting to WorkOS.

Mutations and sockets require the configured app Origin. Requests also carry an
account fence (`x-mindgrab-account`) so a changed cookie cannot write into the
previous workspace. The backend does not rate limit requests; that belongs in
Cloudflare. It does bound document work: as many merges and projections at once
as there are cores, two per account. Requests over that wait up to 3 seconds and
are then answered 429 `busy`. The webapp treats a 429 as a temporary cloud
failure and keeps retrying.

## API

All RPC endpoints use POST and return uncached responses:

| Endpoint | Behavior |
| --- | --- |
| `/api/getHealth.php` | Database reachability and timing |
| `/api/startLogin.php`, `/api/logout.php` | Login/logout navigation |
| `/api/getMe.php` | Verified current account |
| `/api/createProject.php` | Reserve `{projectId, schemaVersion: 1}` |
| `/api/listProjects.php` | Cursor pagination of the current owner's initialized projects |
| `/api/getProjectSnapshot.php` | Complete Loro history snapshot, base64 encoded |
| `/api/getProjectState.php` | Read-only Rust projection for inspection |
| `/api/mergeProject.php?projectId=<uuid>` | Merge an octet-stream snapshot, or only the changes the stored one lacks |
| `/api/commandProject.php` | Apply `{projectId, command}` with the native shared core |
| `/api/deleteProject.php` | Delete the cloud snapshot |
| `/api/getShareLink.php` | The owner's `{projectId, token}`; `token` is null while private |
| `/api/setShareLink.php` | Owner turns the view-only link on (keeps an existing token) or off (revokes it) |
| `/api/getSharedProject.php` | Anyone with `{token}`: the current map without its edit history, revision and name; no session |

GET `/api/auth/callback.php` completes login. GET `/ws/project/<uuid>?ownerId=<id>`
upgrades to a read-only notification socket. Notifications contain committed
revisions, never uncommitted document changes. Postgres NOTIFY reaches all Rust
processes; periodic reconciliation handles reconnects and missed notifications.
Sockets revalidate their session and ownership before notifications.
GET `/ws/share/<token>` is the same notification socket for a shared link,
without a session; it closes with code 1008 once the link is revoked. Deleting a
cloud copy also revokes its link. The webapp's read-only viewer lives at
`/s/<token>`.

The stored snapshot is the owner's full Loro history, which still holds deleted
ideas, notes and earlier names. Viewers never get it: `getSharedProject` serves
a new document built from the visible map (`Project::share_snapshot`). It is
built once per revision, on its first view, by one background task that every
viewer of that revision awaits and that takes one of the owner's compute seats,
and kept in `shared_snapshot`/`shared_revision`. It shares no history with
earlier ones, so the viewer replaces its document on each revision instead of
merging, keeping one view so unchanged ideas are not rebuilt on screen.

Uploads validate and merge with the shared Rust core off the async executor,
holding no database connection or row lock meanwhile. The result is stored only
if the project is still at the revision it was computed from; otherwise the merge
starts over, up to three times, and then answers 429. The complete result is
committed before acknowledging
`{projectId, encoding: "loro-snapshot", data, revision, durable: true}`. Repeated
uploads are idempotent. Invalid bytes do not mutate accepted storage. Errors
use `{error: {code}}`; snapshots are capped at 10 MiB.

A request body is read only after the session check, so a request without a
session is refused before any of its body is held in memory. Each method then
reads up to its own limit and answers 413 `payload_too_large` beyond it: 10 MiB
for `mergeProject`, 2 MiB for `commandProject`, and 16 KiB for everything else,
including `getSharedProject`, which has no session. `getHealth`, `getMe`,
`startLogin` and `logout` read no body at all. The analytics proxy and the
phpMyAdmin decoy keep their own limits.

The webapp uploads a complete snapshot only while the cloud has none. After that
it sends the changes the cloud copy lacks. It reads the cloud copy before every
upload, so a save whose acknowledgement was lost is not sent again. Changes that build
on history the cloud copy does not hold are refused with 422
`missing_dependencies`, and the webapp then sends the complete snapshot once.

Pool connections set `lock_timeout` (5 s), `statement_timeout` and
`idle_in_transaction_session_timeout` (15 s each). No request computes or calls
WorkOS while it holds one.

## Apache and PHP disguise

The backend presents itself as Apache and PHP. It is a joke built to production
quality, and it is meant to cost an attacker time, so no page, header or error
should give it away at a glance. The models are the `php:8.3.14-apache` and
`phpmyadmin:5.2` images: before changing a page, header or cookie here, run the
image and copy what it sends.

The disguise must never make the app easier to attack. It copies how PHP and Apache
look, not what they accept: every real endpoint keeps exactly one URL, the router
matches paths exactly, and nothing from a request reaches a page except a validated
host name. When looking like PHP would mean accepting more, the answer is no.

`src/disguise.rs` is the outermost layer, so it sees every response from the
router. It answers in one of two voices:

- **PHP**, on a route that passes as a script: any path containing `.php`, and a
  directory's index (`/` is `/index.php`, `/phpmyadmin/` is `/phpmyadmin/index.php`).
  These carry `x-powered-by: PHP/8.3.14`. A request or response that carries the
  session cookie also gets the three headers `session_start()` sends, including
  `expires: Thu, 19 Nov 1981 08:52:00 GMT`. Without a session they are left out,
  because PHP never sends them without also setting the cookie.
- **Apache**, everywhere else: paths with no route, the decoy's static files and
  the WebSocket routes. PHP never ran for these, so they carry no PHP header, no
  CORS header and no `cache-control`.

Both carry `server: Apache/2.4.62 (Debian)`. Cloudflare replaces `server` with its
own value and no rule can change that, so on the public domains the Apache version
shows only in Apache's error pages.

The layer rewrites every error with an empty or plain-text body: axum's 404s, 405s,
413s and extractor rejections, and the same kinds of error from the analytics proxy.
JSON errors pass through, because the webapp reads their codes. hyper answers
requests it cannot parse (400, 414, 431) before any layer runs, so those stay
undisguised; Cloudflare answers them first in production.

- **A script that fails** shows PHP's uncaught-exception output with the same
  status, naming its own file under `/var/www/html`. A script sent the wrong method
  answers 405 with `allow` and an empty body, as `http_response_code(405); exit;` does.
- **A path with no route** gets what Apache's file handler gives, at once. Slowing
  scanners down is Cloudflare's job: a wait here made every miss stand out from the
  real routes. `GET`, `HEAD` and `POST` get the 404 page. `OPTIONS` gets a 200 with
  `allow: GET,POST,OPTIONS,HEAD`. `PUT`, `DELETE`, `PATCH` and the WebDAV methods
  get a 405 with the same `allow`, and a method Apache has never heard of gets a
  501. A path ending in `.php` is a 404 for every method, because PHP's handler
  looks for the script first. Only `/api/*.php` and `/ingest.php` answer CORS
  preflights.
- **`TRACE`** gets a 405 that allows nothing, on any path.
- **An encoded slash** (`%2F`) after a decoy script, or a path segment over 255
  bytes, is refused as Apache refuses it: 404 and 403.
- **A script's response without a body** still names `text/html; charset=UTF-8`,
  as PHP does on a redirect.
- **`.ht*` in a directory that exists** gets Apache's 403, as Debian's Apache gives
  whether or not the file exists. Paths are decoded first, so `/%2ehtaccess` counts.
  Below a directory that does not exist it is the usual 404.
- **`/server-status`, `/icons/` and `/icons/small/`** get the 403 Debian's stock
  configuration gives. The icon files themselves are not served.
- **`/api`, `/api/auth`, `/phpmyadmin` and its theme directories** redirect to the
  trailing slash with a 301, and all but `/phpmyadmin/` then answer 403, as
  directories without an index do. The redirect says `http://`, because Apache
  behind a proxy sees plain HTTP, and keeps a port other than 80.

Apache's pages name the host from the `Host` header, lowercased. A value that is not
a hostname becomes `localhost`, and nothing else from the request reaches a page.

- **Routes.** Each `.php` route is written out literally, so every name stays
  greppable: `src/lib.rs` has one line per RPC method and reads like a list of PHP
  scripts, and `src/phpmyadmin.rs` has the decoy's. There is no suffix-stripping
  helper.
- **`/`** is Apache's "It works!" page and the Railway healthcheck, because Railway
  refuses a healthcheck path containing a dot. It still queries the database, so a
  deployment that cannot reach Postgres never goes live. Like any PHP script, it and
  `/index.php` answer every method.
- **A path that continues past a script** (PATH_INFO, `/index.php/x`) runs the script
  in PHP. Here only the decoys accept it: `/index.php` and `/phpmyadmin/index.php`.
  The `/api/*.php` endpoints answer 404, as Apache does with `AcceptPathInfo Off`,
  so a rule written for an endpoint's exact path always covers it.
- **`/ingest.php/<path>`** is PATH_INFO style, as in a PHP front controller. The
  PostHog SDK appends its own paths, so the URL cannot end in `.php`.
- **`/ws/project/<uuid>` and `/ws/share/<token>`** are the deliberate exception to the
  `.php` rule. PHP behind Apache cannot hold a WebSocket, so real PHP stacks run a
  Ratchet daemon behind `mod_proxy_wstunnel` on a path such as `/ws`.
- **Headers.** No header name ends in `.php`, because no PHP site sends one. The
  account fence is `x-mindgrab-account`. It fails open when the header is missing,
  so a later rename must accept both names until every open tab has reloaded. CORS
  sends no `vary`, because tower-http's default list of three request headers
  appears on no PHP site.
- **Cookies.** `PHPSESSID` holds the session and `PHPLOGINID` the login state; local
  mode appends `_local_<port>`. Both values are 32 hex characters, the shape of
  PHP's session ID, and `Set-Cookie` is spelled as PHP's `setcookie()` spells it,
  down to deleting with the value `deleted`. `mindgrab_analytics_consent` belongs
  to the webapp.

### The webapp and Cloudflare

`mindgrab.app` plays along from `webapp/Caddyfile`, as Apache serving static files
with `FallbackResource /index.php` for everything else. The app shell carries
`x-powered-by: PHP/8.3.14`, PHP's `charset=UTF-8` and no `etag` or `last-modified`,
as if `index.php` rendered it, and it answers every unknown path and every method.
The fallback does not cover a script that is not there, so any other `.php` path
gets Apache's 404 page.

Static files carry no `etag`, because Caddy's is not in Apache's form, and no
charset on JavaScript and CSS. A POST for one gets the file. A missing `/assets/`
file gets Apache's 404 page, `/assets` redirects to its slash, and `/assets/`,
`.ht*`, `/icons/` and `/server-status` get the 403 page. `TRACE` gets the 405.
`/phpmyadmin` redirects to the decoy on the API with Apache's 301 page.

Two things live only in Cloudflare, on the `mindgrab.app` zone. Recreate them if the
zone is rebuilt.

- **A response header transform rule**, described as "Hide the host", removes the
  headers Railway's edge adds: `x-railway-edge`, `x-railway-request-id`,
  `x-hikari-trace`, `x-railway-cdn-edge` and `x-railway-fallback`. No rule can
  change `server`.
- **URL normalization** (Rules, Settings) is set to the *Cloudflare* type with both
  *Normalize incoming URLs* and *Normalize URLs to origin* on. Apache finds a
  script after decoding the path, merging slashes and resolving dot segments, so
  `/api/%67etMe.php` and `/api//getMe.php` run `getMe.php`. Cloudflare does that
  tidying before it forwards a request, which lets the backend keep matching paths
  exactly. Do not add normalization to the router instead: Cloudflare's rules and
  the backend must always see the same path.

### phpMyAdmin decoy

`/phpmyadmin/` and `/phpmyadmin/index.php` imitate the phpMyAdmin 5.2 login, for
any method, and `/phpmyadmin` redirects to the directory as above. It
lives in `src/phpmyadmin.rs` and `src/phpmyadmin.html`, needs no database, and is
served from the API domain, not `mindgrab.app`. Vite does not proxy it, so
locally use the backend's `PORT`.

Its response headers and cookies are copied from the `phpmyadmin:5.2` image. The
login page sets a new `phpMyAdmin` session cookie on every load, after repeating
the one it was sent; real phpMyAdmin does the same. A cookie is repeated only if it
is 32 lowercase hex characters. The form token is 16 printable characters written
as hex, as phpMyAdmin's is. The page links to a stylesheet and a favicon at
phpMyAdmin's own URLs (`themes/pmahomme/css/theme.css?v=5.2.3`, `favicon.ico`).
Both files are ours, `src/phpmyadmin.css` and `src/phpmyadmin.ico`: phpMyAdmin's
are GPL-licensed, so do not copy them in.

A POST waits a random 100ms to 10s, then always fails: HTTP 200, as real phpMyAdmin
returns, with MySQL's access-denied error on the login page. A malformed or
oversized body (the route's limit is 8 KiB) counts as empty fields, never a 4xx.
Up to 1 MiB of an oversized body is read and discarded first: closing a connection
with bytes unread resets it, and a browser still sending would never see the page.
Reading stops after 15 seconds. Because the backend has no rate limit, at most 1,024
attempts read or wait at once, and any others are denied immediately without reading
the body.

- **Credentials.** The password is only tested with `is_empty()`. Nothing submitted
  is logged, stored, traced, sent to analytics or forwarded, and the form struct must
  not derive `Debug`.
- **Reflected XSS.** The page shares the API origin, where a same-origin script
  could use the session cookie. The reflected username is escaped and truncated to
  32 characters, and placeholders in it render literally. Keep the page free of
  JavaScript: its CSP allows no script at all, which is stricter than phpMyAdmin's
  own, and allows styles and images from this origin only.

## Verification

`mise run backend:test` starts local Postgres and uses isolated test databases.
`mise run state:check` runs Rust formatting and Clippy over all crates and targets.
`mise run state:interop` exercises the actual app, OAuth callback, persistent API,
native commands, offline concurrent editing and live browser convergence. Test
identity providers and credentials are compiled only into test/example fixtures;
the local login mode is available only in explicitly configured debug development.
