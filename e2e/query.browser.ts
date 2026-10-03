import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: Error[];
beforeAll(async () => {
  const root = fileURLToPath(new URL("../webapp", import.meta.url));
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    cacheDir: "node_modules/.vite-query-tests",
    define: { "import.meta.env.VITE_BACKEND_URL": JSON.stringify("") },
    logLevel: "error",
    server: { port: 5196, strictPort: false },
    optimizeDeps: { entries: ["index.html"] },
  });
  await server.listen();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();
  errors = [];
  page.on("pageerror", (error) => errors.push(error));
});
afterEach(async () => {
  await context.close();
  expect(errors).toEqual([]);
});
const openHealth = () =>
  page.goto(new URL("checkhealth", server.resolvedUrls?.local[0]).href);

test("health queries retain the report during refresh and poll through TanStack Query", async () => {
  await page.clock.install();
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/getHealth", async (route) => {
    requests++;
    if (requests === 2) await gate;
    await route.fulfill({
      status: 200,
      json: {
        database: { status: requests === 1 ? "up" : "down", latency_ms: 2 },
      },
    });
  });
  await openHealth();
  await page
    .getByRole("heading", { name: "All systems operational" })
    .waitFor();
  expect(requests).toBe(1);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Checking…" }).waitFor();
  expect(
    await page.getByRole("button", { name: "Checking…" }).isDisabled(),
  ).toBe(true);
  expect(
    await page
      .getByRole("heading", { name: "All systems operational" })
      .isVisible(),
  ).toBe(true);
  release();
  await page.getByRole("heading", { name: "Database unreachable" }).waitFor();
  await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  expect(requests).toBe(2);
  const polled = page.waitForResponse("**/api/getHealth");
  await page.clock.fastForward(15_000);
  await polled;
  expect(requests).toBe(3);
});

test("health queries show an outage offline and recover on a manual retry", async () => {
  let down = true;
  await page.route("**/api/getHealth", async (route) => {
    if (down) return route.abort("internetdisconnected");
    await route.fulfill({ status: 200, json: { database: { status: "up" } } });
  });
  await openHealth();
  await page.getByRole("heading", { name: "API unreachable" }).waitFor();
  down = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("heading", { name: "All systems operational" })
    .waitFor();
});
