## Deployment (Railway)

- Railway project `8b285039-3bb1-4136-a31d-5fede17bc0e8` (mindgrab.app), environment
  `production`. It has two app services plus `Postgres`: `mindgrab` builds the
  repository-root `Dockerfile` and serves the API at `api.mindgrab.app`, with
  healthcheck `/checkhealth`; `web` builds `webapp/Dockerfile` and serves the static
  webapp at `mindgrab.app` with Caddy. See `backend/README.md`.
- Keep the API on a subdomain of the app. Login cookies are `SameSite=Lax`, so an API
  on another site, including a `*.up.railway.app` domain, cannot hold a session.
- Railway deploys the `live` branch. `mise run golive` force-pushes `main` to `live`,
  so a commit that exists only on `live` is lost on the next golive. Put deploy and
  config changes on `main` first.
- Prefer the Railway CLI. It may be installed at `~/.railway/bin/railway` and missing
  from the agent shell's `PATH`; if so, prefix `PATH="$HOME/.railway/bin:$PATH"`. The
  user's login is account-level and can delete or disconnect services.
- The Bitwarden (bw) item `RAILWAY_TOKEN` is a project token. Send it as the
  `Project-Access-Token` header, not `Authorization: Bearer`. It can read and update
  variables and service settings, but it cannot disconnect or delete services.

## Webapp async code

- Use TanStack Query (`@tanstack/solid-query`) for anything async in the webapp:
  `createQuery`/`queryOptions` for reads, `createMutation` (or `executeMutation`
  from `webapp/src/query-client.ts` outside components) for writes, and
  `refetch`/`invalidateQueries` to reload.
- Do not hand-roll async state: no in-flight promise variables, "run again"
  flags, `disposed`/`AbortController` bookkeeping, loading/error signals, retry or
  backoff timers, or `visibilitychange`/`online` listeners for refetching. Query
  already dedupes and cancels overlapping fetches, exposes status and errors,
  retries, polls (`refetchInterval`) and refetches on focus and reconnect.
- Shared defaults live in `webapp/src/query-client.ts`; override them per query
  rather than working around them.
