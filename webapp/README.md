# Webapp deployment

The frontend uses the shared Rust document core compiled to WebAssembly. Build
from the repository root so the Rust workspace and generated bindings are
available. A build rooted only at `webapp` cannot generate these bindings.

## Deployment

The Railway `web` service builds `webapp/Dockerfile` and serves the assets with
Caddy. `webapp/Caddyfile` marks hashed `/assets/*` files immutable, makes everything
else revalidate, and falls back to `index.html` for client-side routes.
`VITE_BACKEND_URL` is baked in at build time and points the app at the API. See
[`backend/README.md`](../backend/README.md) for the Railway settings.

`VITE_POSTHOG_KEY` is passed to the image build as a build argument; leave it
unset to disable analytics. Set it on the `web` service.

## Local container verification

From the repository root:

```sh
docker build -t mindgrab-web -f webapp/Dockerfile .
docker run --rm -p 8080:8080 mindgrab-web
```

Open `http://localhost:8080`. The API is not part of this image. For local
frontend builds, use
`mise run state:setup` once, then `mise run webapp:build`.
