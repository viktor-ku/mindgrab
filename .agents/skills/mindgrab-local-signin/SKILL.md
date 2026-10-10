---
name: mindgrab-local-signin
description: Sign in or out of a local Mindgrab worktree using development login, then verify the browser session. Use when an agent needs to test authenticated or anonymous local app behavior; supports explicitly configured WorkOS AuthKit too.
---

# Sign in to local Mindgrab

Use this skill when an agent needs to test signed-in or anonymous behavior in a local Mindgrab worktree. The default development flow stays on the local app and creates a real HttpOnly browser session without contacting WorkOS.

## Default local development flow

1. Read this worktree's `mise.local.toml` for `APP_URL`, `WEBAPP_PORT`, `PORT`, and `VITE_BACKEND_URL`. Use the exact `APP_URL` host and port; worktrees have different ports. If settings are missing, run `mise run worktree:bootstrap`. Do not print credentials from `.env`.
2. Check whether the API and webapp already run on those ports. Start missing services with `mise run db`, `mise run backend:dev`, and `mise run webapp:dev`. Avoid duplicate servers. `backend:dev` defaults to `MINDGRAB_AUTH_MODE=local` and sets `MINDGRAB_ENV=development`; startup reports local development authentication. This mode needs a debug build and loopback addresses, and no WorkOS credentials or callback registration.
3. Use the available collaborative browser preview. Check preview status first, open a tab if needed, and navigate to `APP_URL` in the browser profile used for the task.
4. A fresh browser session starts signed out. Click **Sign in** to complete the local callback and show **Boba Tee** (`boba.tee@mindgrab.test`, `local_boba_tee`). No credentials or hosted prompts are involved. Local sessions and their account persist in the worktree database; auth cookies include the app port so other worktrees stay independent.
5. Verify account controls and, if browser tools allow page requests, `POST /api/getMe` in that browser context: expect `200` and `id`, `name`, `email`, `external_id`. Do not use a separate HTTP client to verify the browser session or read/export cookie values.
6. To test anonymous behavior, use the app's **Sign out** action (found in the account menu) and verify `POST /api/getMe` returns `401`. Cloud APIs must require login while anonymous editing remains usable. Click **Sign in** again to return to the same local account.

Use the actual app actions and server sessions. Do not force frontend auth state, fabricate cookies, or insert auth database rows. The local account is separate from the WorkOS staging account. Local login tests app sessions and permissions; use the hosted flow below only when specifically testing the WorkOS integration.

## Optional hosted WorkOS flow

The remaining instructions apply only when `MINDGRAB_AUTH_MODE=workos` is explicitly configured. The user's request to test local app behavior does not require enabling WorkOS. Substitute this worktree's configured `APP_URL` and callback for the default port below. Hosted testing still needs that exact callback registered with WorkOS.

## Requirements

- The local API and webapp must be running at the URLs in this worktree's `mise.local.toml`. The webapp proxies `/api`, `/auth` and `/sync` to the Rust API. `WEBAPP_PORT` is the webapp port; `PORT` and `VITE_BACKEND_URL` configure the backend.
- The API environment must contain valid `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` values, either exported or loaded from root `.env`, and `VITE_BACKEND_URL` must point to the Rust API port.
- The WorkOS application must allow these local URLs:
  - Redirect URI: `http://localhost:5173/api/auth/callback`
  - Initiate login URI: `http://localhost:5173/`
  - Default sign-out URI: `http://localhost:5173/`
- The person signing in needs an account enabled for the configured WorkOS authentication methods.
- On local Rust server startup, the fresh Loro schema is created if absent. A successful WorkOS callback creates the local profile and session. No migrations or preseeded production profiles are required.

Do not print, copy into chat, or include secret values from `.env` in tool output. To check configuration, test whether the variables are present without displaying their values. Never place provider credentials in frontend environment variables or browser JavaScript.

## Local development account

The user has authorized this skill to use the following WorkOS staging account for local Mindgrab sign-in:

- Email: `boba.tee@mindgrab.test`
- Password: `qMT]DP[[pFm56[Pk`

This is a real password user in the configured WorkOS staging environment, with an already verified test email. Its WorkOS user ID is `user_01M3D7HX2KDTKS1SQXA8KWMX15`. The reserved `.test` domain receives no email; use password sign-in, not email codes or password-reset emails.

Enter the credentials only into the expected WorkOS AuthKit sign-in form reached by clicking **Sign in** from `http://localhost:5173`. This staging application's hosted form is on `pleased-myth-32-staging.authkit.app`. Do not echo the password in chat, logs, shell commands, screenshots, or other files. If the account is rejected or the page is not clearly the configured WorkOS AuthKit flow, stop and report the issue; do not try the password elsewhere or repeatedly retry it.

## Procedure

1. Check whether the local app is already running at `http://localhost:5173`. If it is not, inspect the existing process and project setup before starting anything. Follow the repository README to configure and start Postgres, the API, and Vite. Avoid launching duplicate servers. Restart Vite if `VITE_BACKEND_URL` was changed.
2. Use the available collaborative/browser preview for this workspace when present. Open exactly `http://localhost:5173` (use `localhost`, not `127.0.0.1`, so the callback and cookie origin match).
3. If the UI shows **Sign in**, click it. If it already shows an account name or email, the current browser session is signed in; skip to verification.
4. Complete the hosted WorkOS AuthKit prompts in that browser. Enter the email from **Local development account**, click **Continue with email**, then enter its password and click **Sign in**. If a password manager, MFA challenge, email verification, CAPTCHA, or other step requires the user, leave that step for them and clearly explain what action is needed. Do not ask the user to paste one-time codes, recovery codes, or session cookies into chat.
5. Wait for the callback to return to `http://localhost:5173/`. A successful callback sets the local HttpOnly cookie and returns to Mindgrab.
6. Verify that the account controls show the signed-in user's name or email. If browser tools support same-origin page requests, `POST http://localhost:5173/api/getMe` in that same browser context should return `200` with basic user fields (`id`, `name`, `email`, `external_id`). Do not verify with a separate `curl`/HTTP client: it will not share the browser cookie. Do not read or export the cookie value.

## Troubleshooting

- **Preview opens but inspection times out:** Check preview status and retry. If the tab remains unavailable, open a fresh collaborative tab with `reuseExistingTab=false`, then start sign-in from the local app in that tab.
- **Cannot connect / API unavailable:** Confirm Postgres, the Rust backend at the configured API port, and Vite on port 5173 are running. Check `/checkhealth` in the local app for API and database reachability.
- **Sign-in did not complete:** Check the browser stayed on `localhost:5173`, and confirm the WorkOS redirect URI exactly matches `http://localhost:5173/api/auth/callback`. Restart by returning to the app and clicking **Sign in** again; login state is short-lived and one-use.
- **Sign-in temporarily unavailable:** Check that the API can reach WorkOS and that Postgres is available. Retry after the underlying service recovers.
- **WorkOS reports a redirect or client configuration error:** Check the client ID, API key presence, enabled sign-in methods, and all three local URLs in the WorkOS application settings. Do not expose credential values while diagnosing.
- **The agent's browser is not signed in after another browser completed sign-in:** Sign-in is browser-cookie based. Complete the flow in the same browser profile/session the agent will use; sessions are not transferred between browsers or command-line clients.

## Security boundaries

- In hosted WorkOS mode, never bypass AuthKit. In either mode, use the app login action; never fabricate a session, use test fixtures, or write directly to auth tables to sign in.
- Never copy browser cookies, access tokens, refresh tokens, or MFA codes into prompts, logs, source files, or shell commands. The account above is the sole user-authorized exception for this skill; use it only in the expected WorkOS AuthKit form and never repeat or persist it elsewhere.
- Do not attempt to defeat MFA, CAPTCHA, email verification, or other identity checks. Ask the user to complete the step in the browser when needed.
- Keep the session in the browser profile used for the task. The app stores provider tokens server-side and does not expose them to JavaScript.
