# Mindgrab

An offline-first mind-map editor. A shared Rust crate owns application state and
editing rules: the browser compiles it to WASM, and the Axum backend uses it
natively. Loro merges concurrent text edits and tree moves. Solid handles the UI,
IndexedDB stores local history, and Postgres stores authenticated cloud copies.

## Run locally

Configure WorkOS in `.env` using `.env.example`. The API key stays on the server.
`WORKOS_REDIRECT_URI` must point to the web app's `/api/auth/callback`, and
`APP_URL` must use the same origin. For worktrees, `mise run worktree:bootstrap`
assigns independent app, API and database ports in `mise.local.toml`.

```sh
mise install           # pinned Bun, Rust, Biome, and TypeScript
mise run state:setup   # once: WASM target and matching wasm-bindgen generator
mise run db
mise run backend:dev
```

In another terminal:

```sh
mise run webapp:dev
```

Open the printed Vite URL. Anonymous editing works offline. Sign in through
WorkOS to enable cloud saving; anonymous projects can be added to your account.
Open the same project in another browser to see live updates. Editing, text,
colors, positions, undo/redo, project naming and saving preferences all pass
through the same Rust document core.

## Build and verify

```sh
mise run webapp:build
mise run backend:build
mise run check
```

Biome and TypeScript are installed by mise. Bun type declarations remain in the
webapp/test workspaces; the root package only defines workspace membership.

The release backend serves `webapp/dist` and the API from one origin. Run
`target/release/mindgrab-backend` with the same database and WorkOS configuration;
`PORT` defaults to 3000 and `HOST` to `0.0.0.0`. `WEBAPP_DIST` overrides the static
asset directory. Route the public HTTPS origin to this process. The generated
service worker caches the app and WASM for cold offline reopening.

`mise run state:interop` tests the **main app** with the native Rust API,
Postgres and WebSockets, using an isolated database and a test identity provider.
Backend tests verify OAuth, JWT checks, serialized refresh rotation, ownership,
concurrent merging, durable acknowledgements and restart persistence.

The Loro format uses fresh browser storage and the `mindgrab_loro` Postgres
schema. Existing project data is deliberately not imported or converted.
See [backend](backend/README.md) and [shared state](crates/mindgrab-state/README.md)
for the API and document contract.
