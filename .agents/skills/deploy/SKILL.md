---
name: deploy
description: Deploy Mindgrab to production on Railway by moving the `live` branch to `main`, watching the build and rollout, verifying mindgrab.app, and fixing failures with an immediate hotfix on `main` followed by another golive. Use when asked to deploy, ship, release, go live, or fix a broken production deploy.
---

# Deploy Mindgrab to production

Railway project `8b285039-3bb1-4136-a31d-5fede17bc0e8`, environment `production`,
service `mindgrab` (plus `Postgres`). Railway builds the root `Dockerfile` from the
`live` branch. Production is `https://mindgrab.app` and its healthcheck is `/checkhealth`.

The rule behind every step: **`live` is only ever a copy of `main`.** Commit every
change, including hotfixes, to `main`, push `main`, then run `mise run golive`.
Never commit to `live`, push another ref to it, or edit it on GitHub. The next golive
erases anything that exists only on `live`.

Use the Railway CLI. If `railway` is missing from `PATH`, prefix
`PATH="$HOME/.railway/bin:$PATH"`. Pass the project, environment and service
explicitly rather than relying on `railway link`. Use an array: the Bash tool runs zsh,
which does not split a plain string variable into words. Shell state does not carry
over between commands, so define `R` again in each one:

```sh
R=(-p 8b285039-3bb1-4136-a31d-5fede17bc0e8 -e production -s mindgrab)
```

The CLI login is account-level. Never delete, disconnect or recreate services,
volumes or domains, and never run `railway down`. If the CLI is not logged in, use
the Bitwarden item `RAILWAY_TOKEN` (a project token) as the `RAILWAY_TOKEN`
environment variable for the command. Never print it.

## 1. Preflight

1. `git fetch origin`. Local `main` must equal `origin/main`. If local `main` is ahead,
   push it first with `git push origin main`. Golive pushes local `main`, and `live`
   must never contain commits that are missing from `origin/main`. If local `main` is
   behind or has diverged, stop and ask.
2. Check for commits that exist only on `live`:
   `git log --oneline origin/main..origin/live`. If this prints anything, stop. Those
   commits would be lost, so first bring them to `main` (cherry-pick, commit, push).
3. Show what will ship: `git log --oneline origin/live..main` and
   `git diff --stat origin/live..main`. If the range is empty, nothing will deploy.
   Say so and stop, unless the user asked for a redeploy (`railway redeploy "${R[@]}" -y`).
4. Review the diff for deploy risk and handle these **before** golive:
   - **Schema.** `backend/schema.sql` runs on startup against the production database.
     A redeploy does not reverse a schema change. Make sure the change is additive
     and works with the code currently live, because the old deployment keeps serving
     until the new one passes its healthcheck. Ask the user about anything destructive.
   - **New environment variables.** Look for new `env::var`, `std::env`,
     `import.meta.env` or `ARG` in the diff. Check them with `railway variables $R`.
     Set missing ones with `railway variable set KEY=value "${R[@]}" --skip-deploys`, so the
     golive deploy picks them up. `VITE_*` values are baked in at build time: each
     needs an `ARG` in the `Dockerfile` and a Railway service variable.
   - **Dockerfile and build.** Railway requires cache mount IDs that start with
     `s/<service-id>-`. Keep the existing IDs.
   - **Auth.** If `APP_URL` or the WorkOS redirect changes, the WorkOS dashboard must
     be updated too. Ask the user.
5. Run checks. Commit hooks already run lint, format and Clippy. For any change to
   code, dependencies or the `Dockerfile`, also run `mise run check`, or at least the
   tasks covering the changed areas (`backend:test`, `webapp:test`, `e2e:test`,
   `webapp:build`). If a check fails, stop and fix it on `main`. Changes to docs or
   agent files alone can skip this step.
6. Record the rollback target, the current successful deployment:
   `railway deployment list "${R[@]}" --limit 10 --json | jq -r 'map(select(.status=="SUCCESS"))[0] | "\(.id) \(.meta.commitHash)"'`.

## 2. Go live

```sh
mise run golive            # git push --force-with-lease origin main:live
git fetch origin && test "$(git rev-parse origin/live)" = "$(git rev-parse main)"
```

If `--force-with-lease` rejects the push, someone moved `live`. Go back to step 1.2.

## 3. Monitor the rollout

Run the wait script **in the background** and wait for it to exit. Do not poll with
`sleep`. The Rust release build and the WASM build take several minutes.

```sh
.agents/skills/deploy/scripts/wait-for-deploy.sh "$(git rev-parse main)" 1800
```

It prints each status change and exits `0` on `SUCCESS`, `1` on
`FAILED`/`CRASHED`/`REMOVED`/`SKIPPED`/`NEEDS_APPROVAL`, and `2` on timeout. If it
stays `NOT_FOUND` for more than about 3 minutes, Railway did not pick up the push.
Check that the service source branch is still `live` and that it has no watch
patterns (`railway status -p 8b285039-3bb1-4136-a31d-5fede17bc0e8 -e production`, or the Railway MCP `get-service-config`).

When it exits with `SUCCESS`, verify production:

```sh
curl -fsS -o /dev/null -w '%{http_code}\n' https://mindgrab.app/checkhealth   # 200 (503 = database unreachable)
curl -fsS https://mindgrab.app/ | grep -q '<div id="root"\|<script' && echo webapp ok
railway logs "${R[@]}" --since 10m --filter '@level:error'
railway logs "${R[@]}" --http --since 10m --filter '@httpStatus:>=500'
```

Then wait about 5 minutes and check again. The restart policy is `ON_FAILURE` with 10
retries, so a crash loop only becomes visible after startup. A deployment that turns
`CRASHED` after `SUCCESS` counts as an outage.

How to read the result: when a build or healthcheck **fails**, Railway keeps the
previous deployment serving, so production is not down. When a deployment
**crashes** after going live, or `/checkhealth` returns 503 or 5xx errors spike,
users are affected. Mitigate those first (step 4.2).

## 4. Fix failures

### 4.1 Diagnose

```sh
railway logs <deployment-id> "${R[@]}" --build -n 300       # build failures
railway logs <deployment-id> "${R[@]}" --deployment -n 300  # startup, healthcheck, crashes
```

The Railway MCP `get-deployment-diagnosis` tool, when available, gives a quick
summary. Decide whether this is a **code** problem (fix it on `main`) or a **config**
problem (variables or service settings in Railway).

### 4.2 Mitigate an outage first

If users are affected, roll back to the target recorded in step 1.6 before you
debug:

```sh
railway redeploy "${R[@]}" --commit <last-good-sha> -y
.agents/skills/deploy/scripts/wait-for-deploy.sh <last-good-sha>   # the rollback deploy
```

This deploys the old commit once without moving `live`, and the next golive
replaces it. It cannot undo a schema change. If the new schema broke the old code,
fix forward instead and tell the user.

### 4.3 Hotfix: `main` first, then `live`

1. Work in the main checkout on `main`. Make the smallest fix that addresses the
   diagnosed cause. Do not bundle in other changes.
2. Reproduce and verify locally before pushing. For a build failure, run
   `docker build .` from the repository root. For runtime failures, run the relevant
   `mise` tests or `mise run backend:dev`.
3. Commit through the normal hooks: never `--no-verify`, never skip the hooks. Use a
   conventional message such as `fix(deploy): …`.
4. `git push origin main`, then `mise run golive`, then monitor again (step 3).

For a **config** problem, fix it in Railway: `railway variable set …` without
`--skip-deploys` triggers a redeploy. A changed `VITE_*` build variable needs a
rebuild (`railway redeploy "${R[@]}" --from-source -y`). Record any lasting settings change
in `backend/README.md` on `main`. Agents learn these settings from there.

Stop after **two** failed hotfix attempts. Make sure production is serving a good
deployment (roll back if it is not), then report to the user with the logs and your
diagnosis.

## 5. Report

Finish with a short summary:

- The shipped range (`old-live..new-live`) and the commit subjects.
- The Railway deployment ID and its final status.
- The health and log check results.
- Any hotfix commits or rollbacks.
- Anything left for the user: dashboard changes, WorkOS settings, follow-up work.
