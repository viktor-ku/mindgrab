// Invoked by the Rust SQLx fixture with an isolated DB, mock WorkOS and real TCP
// endpoint. The pages use real Chromium IndexedDB and pinned y-websocket.
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as buildWebapp } from "vite";
import type { CloudHarness } from "./cloud-harness";
declare const mg: CloudHarness;
const config = JSON.parse(await Bun.stdin.text()) as {
  serverUrl: string;
  cookie: string;
  ownerId: number;
  expectRateLimits?: boolean;
};
const origin = "http://localhost:5173";
const ws = `${config.serverUrl}/sync/v1`;
const http = config.serverUrl.replace("ws:", "http:");
const directory = await mkdtemp(join(tmpdir(), "mindgrab-cloud-"));
const outDir = join(directory, "dist");
const build = await Bun.build({
  entrypoints: [`${import.meta.dir}/cloud-harness.ts`],
  target: "browser",
  format: "esm",
});
if (!build.success) throw new AggregateError(build.logs, "Cloud harness build");
const bundle = await build.outputs[0].text();
const browser = await chromium.launch();
const contexts: BrowserContext[] = [];
let droppedReceipt = false;
let submissions = 0;
let catalogRequests = 0;
let primeQuota = config.expectRateLimits === true;
let throttledSubmissions = 0;
let retriedSubmissions = 0;
const rejected = new Map<string, string>();
async function context(production = false) {
  const context = await browser.newContext();
  contexts.push(context);
  const [name, value] = config.cookie.split("=");
  await context.addCookies([
    { name, value, url: origin, httpOnly: true, sameSite: "Lax" },
  ]);
  await context.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/getMe" && production) {
      await route.fulfill({
        json: {
          id: config.ownerId,
          name: "Browser fixture",
          email: "fixture@mindgrab.test",
          external_id: "test_user",
        },
      });
    } else if (path.startsWith("/api/")) {
      const request = route.request();
      if (path === "/api/submitProjectUpdate" && primeQuota) {
        primeQuota = false;
        // Spend the test's single account token with invalid schema metadata.
        // The real limiter runs before metadata/body/ingestion, so this writes
        // nothing and the immediately following valid upload must get 429.
        const probe = await route.fetch({
          url: `${http}${new URL(request.url()).pathname}${new URL(request.url()).search}`,
          headers: {
            ...request.headers(),
            origin,
            "x-mindgrab-schema-version": "2",
          },
        });
        expect(probe.status()).toBe(426);
      }
      const response = await route.fetch({
        url: `${http}${new URL(request.url()).pathname}${new URL(request.url()).search}`,
        headers: { ...request.headers(), origin: origin },
      });
      if (!response.ok())
        console.error(
          "API failure",
          request.method(),
          path,
          response.status(),
          await response.text(),
        );
      if (path === "/api/submitProjectUpdate") {
        submissions++;
        const updateId = new URL(request.url()).searchParams.get("updateId")!;
        const sha256 = new Bun.CryptoHasher("sha256")
          .update(request.postDataBuffer()!)
          .digest("hex");
        if (response.status() === 429) {
          expect(response.headers()["retry-after"]).toBeDefined();
          throttledSubmissions++;
          if (rejected.has(updateId))
            expect(sha256).toBe(rejected.get(updateId)!);
          rejected.set(updateId, sha256);
        } else if (response.ok() && rejected.has(updateId)) {
          expect(sha256).toBe(rejected.get(updateId)!);
          rejected.delete(updateId);
          retriedSubmissions++;
        }
        if (droppedReceipt && response.ok()) {
          droppedReceipt = false;
          await route.abort("failed");
          return;
        }
      }
      if (path === "/api/listProjects") catalogRequests++;
      await route.fulfill({ response });
    } else if (production) {
      const file = Bun.file(`${outDir}${path === "/" ? "/index.html" : path}`);
      await route.fulfill({
        contentType: file.type,
        body: Buffer.from(await file.arrayBuffer()),
      });
    } else
      await route.fulfill({
        contentType: path === "/harness.js" ? "text/javascript" : "text/html",
        body:
          path === "/harness.js"
            ? bundle
            : '<script type="module" src="/harness.js"></script>',
      });
  });
  return context;
}
async function tab(context: BrowserContext) {
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto(origin);
  await page.waitForFunction(() => "mg" in globalThis);
  return page;
}
async function saved(page: Page) {
  try {
    await page.waitForFunction(() => mg.status()?.status === "saved", null, {
      timeout: 15_000,
    });
  } catch (error) {
    console.error(
      "Cloud status at timeout:",
      await page.evaluate(() => mg.status()),
    );
    throw error;
  }
}
try {
  const aContext = await context();
  const bContext = await context();
  const a = await tab(aContext);
  const b = await tab(bContext);
  const id = await a.evaluate((ws) => mg.open(ws), ws);
  await a.evaluate(() => mg.start());
  await saved(a);

  // Independent device discovers the existing UUID and never seeds another root.
  await b.evaluate((ws) => mg.open(ws), ws);
  const list = await b.evaluate(() => mg.discover());
  expect(list.some((entry) => entry.id === id)).toBe(true);
  await b.evaluate((id) => mg.use(id), id);
  await b.evaluate(() => mg.start());
  await saved(b);
  expect(await b.evaluate(() => Object.keys(mg.content().nodes).length)).toBe(
    1,
  );
  expect(catalogRequests).toBeGreaterThan(0);

  // Real live socket propagation, with no manual Save or reload.
  await a.evaluate(() => mg.edit("Live "));
  await b.waitForFunction(() =>
    mg.content().nodes[mg.root()].text.startsWith("Live "),
  );
  await saved(a);

  await aContext.setOffline(true);
  await a.evaluate(() => mg.networkFault(true));
  await bContext.setOffline(true);
  await b.evaluate(() => mg.networkFault(true));
  await a.evaluate(async () => {
    mg.edit("Device A ");
    mg.child("A child");
    await mg.flush();
  });
  await b.evaluate(async () => {
    mg.edit("Device B ");
    mg.child("B child");
    await mg.flush();
  });
  // Reload before any upload; IndexedDB is the recovery source.
  await a.reload();
  await a.waitForFunction(() => "mg" in globalThis);
  await a.evaluate(([ws, id]) => mg.open(ws, id), [ws, id]);
  await a.evaluate(() => mg.start());
  expect(await a.evaluate(() => mg.status()?.status)).toBe("offline");
  droppedReceipt = true;
  await aContext.setOffline(false);
  await a.evaluate(() => mg.networkFault(false));
  await bContext.setOffline(false);
  await b.evaluate(() => mg.networkFault(false));
  await a.evaluate(() => mg.sync());
  await b.evaluate(() => mg.sync());
  await saved(a);
  await saved(b);
  await a.waitForFunction(() => Object.keys(mg.content().nodes).length === 3);
  await b.waitForFunction(() => Object.keys(mg.content().nodes).length === 3);
  expect(await a.evaluate(() => mg.content())).toEqual(
    await b.evaluate(() => mg.content()),
  );

  // Two offline tabs in one device still relay scoped Yjs updates.
  const a2 = await tab(aContext);
  await a2.evaluate(([ws, id]) => mg.open(ws, id), [ws, id]);
  await aContext.setOffline(true);
  await a.evaluate(() => mg.networkFault(true));
  await a.evaluate(() => mg.edit("Offline tab "));
  await a2.waitForFunction(() =>
    mg.content().nodes[mg.root()].text.startsWith("Offline tab "),
  );
  await a2.evaluate(async () => {
    mg.child("Tab child");
    await mg.flush();
  });
  await a.waitForFunction(() => Object.keys(mg.content().nodes).length === 4);
  await aContext.setOffline(false);
  await a.evaluate(() => mg.networkFault(false));
  await a.evaluate(() => mg.sync());
  await saved(a);
  await b.waitForFunction(() => Object.keys(mg.content().nodes).length === 4);

  // Pure deletion survives reload with equal state vectors.
  await aContext.setOffline(true);
  await a.evaluate(() => mg.networkFault(true));
  await a.evaluate(async () => {
    mg.deleteText();
    await mg.flush();
  });
  await a.reload();
  await a.waitForFunction(() => "mg" in globalThis);
  await a.evaluate(([ws, id]) => mg.open(ws, id), [ws, id]);
  await a.evaluate(() => mg.start());
  await aContext.setOffline(false);
  await a.evaluate(() => mg.networkFault(false));
  await a.evaluate(() => mg.sync());
  await saved(a);
  await b.waitForFunction(() => mg.content().nodes[mg.root()].text === "");

  // A multi-megabyte cold recovery splits V1 bytes within the HTTP limit.
  await a.evaluate(() => mg.stop());
  await a.evaluate(() => mg.large());
  await a.reload();
  await a.waitForFunction(() => "mg" in globalThis);
  await a.evaluate(([ws, id]) => mg.open(ws, id), [ws, id]);
  await a.evaluate(() => mg.start());
  await saved(a);
  await b.waitForFunction(() => Object.keys(mg.content().nodes).length === 29);
  const content = await a.evaluate(() => mg.content());
  expect(await b.evaluate(() => mg.content())).toEqual(content);
  // A fresh third device reconstructs solely from Rust/Postgres state.
  const c = await tab(await context());
  await c.evaluate(([ws, id]) => mg.open(ws, id), [ws, id]);
  await c.evaluate(() => mg.start());
  await saved(c);
  expect(await c.evaluate(() => mg.content())).toEqual(content);
  // The shipped production UI uses the same real HTTP endpoints and fixture
  // account. Sockets are covered above; close this UI's socket to exercise HTTP
  // durability when live propagation is temporarily unavailable.
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await buildWebapp({
      root: join(import.meta.dir, "../.."),
      logLevel: "silent",
      envDir: false,
      define: { "import.meta.env.VITE_BACKEND_URL": JSON.stringify("") },
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
  const uiContext = await context(true);
  await uiContext.routeWebSocket("ws://localhost:5173/sync/v1/**", (socket) =>
    socket.close(),
  );
  const ui = await uiContext.newPage();
  await ui.goto(origin);
  await ui.getByText("Browser fixture", { exact: true }).waitFor();
  await ui.getByText("Saved to cloud", { exact: true }).waitFor();
  const previousName = await ui.getByLabel("Project name").inputValue();
  await ui.getByRole("button", { name: "New", exact: true }).click();
  await ui.waitForFunction(
    (name) =>
      (document.querySelector("input") as HTMLInputElement)?.value !== name,
    previousName,
  );
  await ui.getByLabel("Project name").fill("Production cloud UI");
  await ui.getByLabel("Project name").press("Tab");
  await ui.getByText("Saved to cloud", { exact: true }).waitFor();
  await ui.reload();
  await ui.getByText("Saved to cloud", { exact: true }).waitFor();
  expect(await ui.getByLabel("Project name").inputValue()).toBe(
    "Production cloud UI",
  );
  await ui.getByRole("button", { name: "Load", exact: true }).click();
  await ui
    .getByRole("button", { name: /Shared/ })
    .first()
    .waitFor();
  console.log(
    JSON.stringify({
      converged: true,
      projectId: id,
      submissions,
      throttledSubmissions,
      retriedSubmissions,
      nodes: Object.keys(content.nodes).length,
    }),
  );
} finally {
  for (const context of contexts) {
    await context.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
