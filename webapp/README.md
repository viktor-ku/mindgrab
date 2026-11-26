# Webapp deployment

The frontend uses the shared Rust document core compiled to WebAssembly. Build
from the repository root so the Rust workspace and generated bindings are
available. A build rooted only at `webapp` cannot generate these bindings.

## Deployment

The Railway `web` service builds `webapp/Dockerfile` and serves the assets with
Caddy. `webapp/Caddyfile` marks hashed `/assets/*` files immutable, makes everything
else revalidate, and falls back to `index.html` for client-side routes. It also
keeps up the API's PHP disguise; see "Apache and PHP disguise" in
[`backend/README.md`](../backend/README.md).
`VITE_BACKEND_URL` is baked in at build time and points the app at the API. See
[`backend/README.md`](../backend/README.md) for the Railway settings.

`VITE_POSTHOG_KEY` is passed to the image build as a build argument; leave it
unset to disable analytics. Set it on the `web` service.

## Security headers

Every response carries `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy` and `Permissions-Policy`, set in `webapp/Caddyfile`, and a
Content Security Policy. The image build writes the policy with
`scripts/content-security-policy.ts` from `VITE_BACKEND_URL`, so it allows the
same API the bundle calls. When the app starts to load or call something from a
new place, add it there: a new origin, an inline script, or another host on the
way through sign-in.

The policy is sent as `Content-Security-Policy-Report-Only` unless `CSP_HEADER`
says otherwise when the container starts. Report-Only blocks nothing and logs
what the policy would have blocked to the browser console. Set
`CSP_HEADER=Content-Security-Policy` on the `web` service to enforce it, and
remove the variable to go back.

## Local container verification

From the repository root:

```sh
docker build -t mindgrab-web -f webapp/Dockerfile .
docker run --rm -p 8080:8080 mindgrab-web
```

Open `http://localhost:8080`. The API is not part of this image. To use the app
against a local API, build with `--build-arg VITE_BACKEND_URL=http://localhost:<port>`
and start that API with `APP_URL=http://localhost:8080/` and a
`WORKOS_REDIRECT_URI` on its own port. Add `-e CSP_HEADER=Content-Security-Policy`
to `docker run` to enforce the policy. For local frontend builds, use
`mise run state:setup` once, then `mise run webapp:build`.
