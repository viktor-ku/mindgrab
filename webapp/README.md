# Webapp deployment

The frontend uses the shared Rust document core compiled to WebAssembly. Build
from the repository root so the Rust workspace and generated bindings are
available. A build rooted only at `webapp` cannot generate these bindings.

## Deployment

There is no separate frontend service. The repository-root `Dockerfile` builds
these assets into the backend image, and the Rust backend serves them from
`WEBAPP_DIST` on the same origin as the API. See
[`backend/README.md`](../backend/README.md) for the Railway settings.

`VITE_POSTHOG_KEY` is passed to the image build as a build argument; leave it
unset to disable analytics.

## Local container verification

From the repository root:

```sh
docker build -t mindgrab .
docker run --rm -p 3000:3000 --env-file .env mindgrab
```

Open `http://localhost:3000`. For local frontend builds, use
`mise run state:setup` once, then `mise run webapp:build`.
