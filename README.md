# Mindgrab

SolidJS mind maps with a Rust/Axum API and WorkOS AuthKit login.

## Run locally

1. Copy `.env.example` to `.env` if you do not already have one. Fill in the
   WorkOS client ID and API key. The Rust server loads the root `.env` when
   launched from either the repository root or `server/`; exported environment
   variables take precedence. Credentials never enter the Vite bundle.
2. In your WorkOS application's redirect settings, register:
   - Redirect URI: `http://localhost:5173/api/auth/callback`
   - Initiate login URI: `http://localhost:5173/api/auth/login`
   - Sign-out URI: `http://localhost:5173/`
   Enable the desired authentication methods in WorkOS. AuthKit's hosted page
   handles signup, sign-in, password resets, and email verification.
3. Start Postgres and the API:

   ```sh
   docker compose up -d postgres
   cargo run --manifest-path server/Cargo.toml
   ```

   The server applies database migrations automatically and listens on port 3000.
4. In a second terminal:

   ```sh
   cd webapp
   bun --bun install
   bun --bun run dev
   ```

   Open **http://localhost:5173**. Vite proxies `/api` to Axum. Use this exact
   hostname so the callback, cookies, and logout origin match. The dev server
   refuses to switch ports if 5173 is occupied.

## Authentication

- `GET /api/auth/login` starts AuthKit with a browser-bound, one-use state and
  PKCE. Login attempts expire after 10 minutes.
- `GET /api/auth/callback` exchanges the code, verifies the access token, upserts
  the local user by WorkOS user ID (`users.external_id`), and rotates the local
  session credential.
- `GET /api/me` returns `{ id, name, email, external_id }`, or `401` when signed
  out. Tokens are never returned to JavaScript. A `503` means authentication is
  temporarily unavailable; it does not clear an existing session.
- `POST /api/auth/logout` requires the configured app's `Origin` header, deletes
  the local session, and redirects the browser through WorkOS logout.

Postgres stores WorkOS access/refresh tokens and only a SHA-256 hash of each
random browser session credential. The browser receives an HttpOnly,
SameSite=Lax cookie, also Secure on HTTPS. Sessions have a 30-day local maximum;
WorkOS can end them sooner. Signed access tokens are checked on each `/api/me`
request, including issuer, client, subject, session ID, and expiry. Provider-side
revocation is observed when the token next refreshes, so configure a short access
token lifetime in WorkOS. Refreshes are serialized per session with a database
row lock; rotated refresh tokens are persisted before returning. Transient
refresh failures receive one bounded retry and preserve the session. Expired
records are cleaned up hourly.

Projects remain in browser `localStorage`. They are saved before auth redirects
and restored on return. They are not yet synced or scoped to an account; switching
accounts in the same browser uses the same local projects. Future project APIs
must enforce ownership on the server using the authenticated local user ID.

## Deployment

Use HTTPS and serve the frontend and `/api` on the same origin through a reverse
proxy. Set `DATABASE_URL`, the WorkOS credentials, `APP_URL` (the root URL), and
`WORKOS_REDIRECT_URI` (same origin, `/api/auth/callback`). Register corresponding
production login, callback, and sign-out URLs in WorkOS. If using a custom token
issuer, set `WORKOS_ISSUER` to its exact issuer URL. By default the expected
issuer is `https://api.workos.com/user_management/<WORKOS_CLIENT_ID>`. HTTP is accepted only for local
loopback development. Protect the database and its backups: they hold refresh
tokens. The bundled Postgres configuration uses passwordless local development
authentication and is not a production database configuration.

WorkOS references: [hosted AuthKit](https://workos.com/docs/authkit/hosted-ui),
[authentication API](https://workos.com/docs/reference/authkit/authentication),
[session tokens](https://workos.com/docs/reference/authkit/session-tokens), and
[refresh behavior](https://workos.com/docs/authkit/session-resilience).

## Checks

```sh
docker compose up -d postgres
cd server
DATABASE_URL=postgres://postgres@localhost:5432/mindgrab cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

The Rust integration tests create isolated databases using SQLx and a local mock
WorkOS server. The database role needs permission to create test databases. No
real WorkOS credentials, users, or emails are used by tests. The RSA key under
`server/src/auth/fixtures` is a public test fixture, never an application secret.

```sh
cd webapp
bun --bun run check
bun --bun run build
bun --bun test
```
