# Webapp deployment

The frontend uses the shared Rust document core compiled to WebAssembly. Build
from the repository root so the Rust workspace and generated bindings are
available. A build rooted only at `webapp` cannot generate these bindings.

## Railway

Configure the frontend service with:

- **Root Directory:** `/` (the repository root).
- **Dockerfile Path:** `webapp/Dockerfile`.
- **Healthcheck Path:** `/`.
- Clear custom build and start commands; the Dockerfile builds the app and starts
  Caddy on Railway's `PORT`.
- **BACKEND_URL:** the Rust API's internal HTTP URL including its port, for
  example `http://backend.railway.internal:3000`. Caddy forwards `/api`, `/auth`
  and `/sync` to this service, including WebSocket upgrades.

These settings can be applied in Railway's dashboard or through its API.
`railway.toml` and `railway.json` are deprecated. Railway's replacement for
versioned platform configuration is [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)
in `.railway/railway.ts`.

Set the backend's `APP_URL` to the frontend's public HTTPS URL and
`WORKOS_REDIRECT_URI` to that URL followed by `/api/auth/callback`. The backend
must listen on `HOST=0.0.0.0`; its other required settings are documented in
[`backend/README.md`](../backend/README.md).

Leave `VITE_BACKEND_URL` unset for this same-origin proxy setup. It is supported
as a Docker build argument for deployments that intentionally use a separate
public API origin.

The Docker build installs the pinned TypeScript compiler and Bun dependencies,
generates WASM and TypeScript bindings with the matching wasm-bindgen version,
then builds the Vite assets. Only Caddy and the built assets enter the runtime
image; the Rust backend remains a separate service.

## Local container verification

From the repository root:

```sh
docker build -f webapp/Dockerfile -t mindgrab-webapp .
docker run --rm -p 8080:8080 -e BACKEND_URL=http://host.docker.internal:3000 \
  --add-host=host.docker.internal:host-gateway mindgrab-webapp
```

Open `http://localhost:8080`. For local frontend builds, use
`mise run state:setup` once, then `mise run webapp:build`.
