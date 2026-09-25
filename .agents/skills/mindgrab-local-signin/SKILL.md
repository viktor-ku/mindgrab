---
name: mindgrab-local-signin
description: Sign in to a locally running Mindgrab app through its WorkOS AuthKit flow, then verify the browser session. Use when an agent needs an authenticated local Mindgrab session.
---

# Sign in to local Mindgrab

Use this skill when an agent needs an authenticated session in the locally running Mindgrab app. Authentication is a browser flow through WorkOS AuthKit; the local app keeps the session in an HttpOnly cookie.

## Requirements

- The local API and webapp must be running. The webapp is expected at `http://localhost:5173` and proxies `/api` to the API at `http://localhost:3000`.
- Root `.env` must contain valid `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` values, and `webapp/.env` should set `VITE_BACKEND_URL=http://localhost:3000`.
- The WorkOS application must allow these local URLs:
  - Redirect URI: `http://localhost:5173/api/auth/callback`
  - Initiate login URI: `http://localhost:5173/api/auth/login`
  - Sign-out URI: `http://localhost:5173/`
- The person signing in needs an account enabled for the configured WorkOS authentication methods.
- On local server startup, migrations run first and then the matching profile is inserted into the loopback `mindgrab` database if absent. This does not create a session; sign-in still needs the WorkOS browser flow below.

Do not print, copy into chat, or include secret values from `.env` in tool output. To check configuration, test whether the variables are present without displaying their values. Never place provider credentials in frontend environment variables or browser JavaScript.

## Local development account

The user has authorized this skill to use the following WorkOS staging account for local Mindgrab sign-in:

- Email: `boba.tee@example.com`
- Password: `qMT]DP[[pFm56[Pk`

Enter these only into the expected WorkOS AuthKit sign-in form reached by clicking **Sign in** from `http://localhost:5173`. Do not echo them in chat, logs, shell commands, screenshots, or other files. If the account is rejected or the page is not clearly the configured WorkOS AuthKit flow, stop and report the issue; do not try the password elsewhere or repeatedly retry it.

## Procedure

1. Check whether the local app is already running at `http://localhost:5173`. If it is not, inspect the existing process and project setup before starting anything. Follow the repository README to configure and start Postgres, the API, and Vite. Avoid launching duplicate servers. Restart Vite if `VITE_BACKEND_URL` was changed.
2. Use the available collaborative/browser preview for this workspace when present. Open exactly `http://localhost:5173` (use `localhost`, not `127.0.0.1`, so the callback and cookie origin match).
3. If the UI shows **Sign in**, click it. If it already shows an account name or email, the current browser session is signed in; skip to verification.
4. Complete the hosted WorkOS AuthKit prompts in that browser. Use the account in **Local development account** through the normal UI. If a password manager, MFA challenge, email verification, CAPTCHA, or other step requires the user, leave that step for them and clearly explain what action is needed. Do not ask the user to paste one-time codes, recovery codes, or session cookies into chat.
5. Wait for the callback to return to `http://localhost:5173/`. A successful callback sets the local HttpOnly cookie and returns to Mindgrab.
6. Verify that the account controls show the signed-in user's name or email. If browser tools support same-origin page requests, `GET http://localhost:5173/api/me` in that same browser context should return `200` with basic user fields (`id`, `name`, `email`, `external_id`). Do not verify with a separate `curl`/HTTP client: it will not share the browser cookie. Do not read or export the cookie value.

## Troubleshooting

- **Cannot connect / API unavailable:** Confirm Postgres, the Rust API on port 3000, and Vite on port 5173 are running. Check `/checkhealth` in the local app for API and database reachability.
- **Sign-in did not complete:** Check the browser stayed on `localhost:5173`, and confirm the WorkOS redirect URI exactly matches `http://localhost:5173/api/auth/callback`. Restart by returning to the app and clicking **Sign in** again; login state is short-lived and one-use.
- **Sign-in temporarily unavailable:** Check that the API can reach WorkOS and that Postgres is available. Retry after the underlying service recovers.
- **WorkOS reports a redirect or client configuration error:** Check the client ID, API key presence, enabled sign-in methods, and all three local URLs in the WorkOS application settings. Do not expose credential values while diagnosing.
- **The agent's browser is not signed in after another browser completed sign-in:** Sign-in is browser-cookie based. Complete the flow in the same browser profile/session the agent will use; sessions are not transferred between browsers or command-line clients.

## Security boundaries

- Never bypass AuthKit, fabricate a session, use test fixtures, or write directly to auth tables to sign in.
- Never copy browser cookies, access tokens, refresh tokens, or MFA codes into prompts, logs, source files, or shell commands. The account above is the sole user-authorized exception for this skill; use it only in the expected WorkOS AuthKit form and never repeat or persist it elsewhere.
- Do not attempt to defeat MFA, CAPTCHA, email verification, or other identity checks. Ask the user to complete the step in the browser when needed.
- Keep the session in the browser profile used for the task. The app stores provider tokens server-side and does not expose them to JavaScript.
