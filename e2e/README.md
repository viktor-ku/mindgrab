# End-to-end tests

Playwright runs in headless Chromium with Bun as the test runner. Browser suites
and harnesses live here; unit tests remain in `webapp/tests/`.

```sh
mise run install
mise run state:setup
(cd e2e && bun --bun x playwright install chromium)
```

| Command | Coverage |
| --- | --- |
| `mise run e2e:test` | Editor interactions, import/export, IndexedDB, account transitions and health queries |
| `mise run e2e:test:offline` | Production app and WASM caching, cold offline reopen and safe updates |
| `mise run state:interop` | Main app with Rust, isolated Postgres, OAuth callback, native commands, live sockets, concurrent offline edits and retry recovery |
| `mise run e2e:check` | Lint, formatting and browser harness type checks |

The editor/storage/account suites isolate browser behavior. The interoperability
suite starts the real Rust server with a test identity provider; it requires
local Postgres (`mise run db`) and drops its isolated database on shutdown.
Backend integration tests are Rust tests in `backend/tests/` and run through
`mise run backend:test`.

Run a single browser test with:

```sh
cd e2e
bun --bun test ./editor.browser.ts -t "add, edit, navigate"
```

`mise run check` includes all browser and native checks. The
`webapp:test:browser` and `webapp:test:offline` tasks remain aliases.
