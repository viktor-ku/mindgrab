# End-to-end tests

Playwright runs these suites in headless Chromium, using Bun as the test runner.
Browser harnesses live alongside the tests. Unit tests remain in `webapp/tests/`.

From the repository root, install the shared Bun workspace dependencies and Chromium:

```sh
mise run install
(cd e2e && bun --bun x playwright install chromium)
```

| Command | Coverage |
| --- | --- |
| `mise run e2e:test` | Editor interactions, import/export, IndexedDB persistence, account lifecycle, health-query refresh and recovery |
| `mise run e2e:test:offline` | Production shell caching, cold offline reopen, safe upgrades |
| `mise run e2e:check` | Lint, formatting, browser-suite and harness type checks |

The browser suites run without Postgres. The Bun backend's integration tests live
in `backend/tests/` and run with `mise run backend:test` against isolated local
Postgres databases (`mise run db`). The retired Rust cloud/release orchestration
is no longer part of the browser suites.

For browser interactions and offline tests, you can also run `bun --bun run test`
or `bun --bun run test:offline` from this directory. To run one browser test:

```sh
cd e2e
bun --bun test ./editor.browser.ts -t "add, edit, navigate"
```

`mise run check` includes browser and backend suites. The previous
`webapp:test:browser` and `webapp:test:offline` tasks remain aliases.
