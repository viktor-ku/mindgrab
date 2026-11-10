import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { chromium, devices } from "playwright";
import { build } from "vite";
import { STORAGE_GENERATION } from "../webapp/src/offline-contract";

// Real HTTP + production output; no request interception and no dev harness.
// A persistent profile also proves reopen after the browser process exits.
setDefaultTimeout(45_000);
const webapp = join(import.meta.dir, "../webapp");
let directory: string;
let profile: string;
let builds: string[];
let context: BrowserContext;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let version = 0;
let incompatible = false;
let missingAsset = false;
let workerUnavailable = false;
let user = 1;
const requests: string[] = [];
const errors: string[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mindgrab-offline-"));
  builds = [join(directory, "a"), join(directory, "b")];
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  for (const [index, outDir] of builds.entries()) {
    await build({
      root: webapp,
      configFile: join(webapp, "vite.config.ts"),
      logLevel: "error",
      define: { "import.meta.env.VITE_BACKEND_URL": JSON.stringify("") },
      plugins: [
        {
          name: "release-fixture",
          transformIndexHtml: (html) =>
            html.replace(
              "<title>Mindgrab</title>",
              `<title>Mindgrab ${index}</title>`,
            ),
        },
      ],
      build: { outDir, emptyOutDir: true },
    });
  }
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  server = Bun.serve({
    hostname: "localhost",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      const headers = { "Cache-Control": "no-store" };
      if (path === "/api/getMe.php")
        return Response.json(
          {
            id: user,
            name: `Account ${user}`,
            email: `${user}@test.example`,
            external_id: `user_${user}`,
          },
          { headers },
        );
      if (path === "/api/logout.php" && request.method === "POST") {
        user = 0;
        return new Response(null, {
          status: 303,
          headers: { ...headers, Location: "/" },
        });
      }
      if (path === "/api/startLogin.php")
        return new Response(null, {
          status: 303,
          headers: { ...headers, Location: "/" },
        });
      if (path === "/api/auth/callback.php" && request.method === "GET")
        return new Response("Auth callback", { headers });
      if (path.startsWith("/api/"))
        return Response.json(
          {
            error: {
              code: "unavailable",
              message: "Cloud is unavailable in this fixture",
            },
          },
          { status: 503, headers },
        );
      if (path === "/sw.js") {
        if (workerUnavailable)
          return new Response("Worker temporarily unavailable", {
            status: 503,
          });
        let script = await Bun.file(join(builds[version], "sw.js")).text();
        if (incompatible)
          script = script.replace(
            `"storage":${STORAGE_GENERATION}`,
            '"storage":99',
          );
        return new Response(script, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      }
      if (missingAsset && path === "/icons.svg")
        return new Response("Missing asset", { status: 404 });
      const file = Bun.file(
        join(
          builds[version],
          path === "/" || path === "/checkhealth"
            ? "index.html"
            : path.slice(1),
        ),
      );
      return (await file.exists())
        ? new Response(file, { headers })
        : new Response("Not found", { status: 404, headers });
    },
  });
  origin = `http://localhost:${server.port}`;
}, 45_000);

afterAll(async () => {
  server?.stop(true);
  await rm(directory, { recursive: true, force: true });
});

async function launch(
  options: Parameters<typeof chromium.launchPersistentContext>[1] = {},
) {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...options,
  });
  page = context.pages()[0];
  page.on("pageerror", (error) => errors.push(error.message));
}

beforeEach(async () => {
  profile = await mkdtemp(join(directory, "profile-"));
  version = 0;
  incompatible = false;
  missingAsset = false;
  workerUnavailable = false;
  user = 1;
  requests.length = 0;
  errors.length = 0;
  await launch();
});

afterEach(async () => {
  await context?.close();
  expect(errors).toEqual([]);
});

async function load(url = origin) {
  await page.goto(url);
  // A cold profile opens the anonymous workspace until getMe swaps in the
  // account's, which strands edits and closes menus. The name also shows offline
  // (inside the closed menu on phones).
  await page
    .locator('[aria-label="Account"]', { hasText: `Account ${user}` })
    .first()
    .waitFor({ state: "attached" });
  await page.waitForSelector('[data-storage-ready="true"]');
  await page.waitForSelector("[data-node-id]");
}
async function waitForWorker(target: Page, predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await target.evaluate(predicate))) {
    if (Date.now() > deadline)
      throw new Error("Service worker state timed out");
    await Bun.sleep(50);
  }
}
async function installed() {
  await waitForWorker(
    page,
    async () =>
      (await navigator.serviceWorker.getRegistration())?.active?.state ===
      "activated",
  );
  // The first page is deliberately not claimed. Reopening takes control.
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.waitForSelector('[data-storage-ready="true"]');
}
async function edit(text: string) {
  await page.locator("[data-node-id]").first().dblclick();
  await page.getByLabel("Node text").fill(text);
  await page.getByLabel("Node text").press("Enter");
  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Save now" }).click();
  await page
    .locator(".notice")
    .getByText("Saved locally", { exact: true })
    .waitFor();
}
// Set MINDGRAB_SCREENSHOTS to a directory to keep pictures of the notice.
async function screenshot(target: Page, name: string) {
  const directory = process.env.MINDGRAB_SCREENSHOTS;
  if (directory)
    await target.screenshot({
      path: join(directory, `${name}.png`),
      animations: "disabled",
    });
}
const updateNotice = (target: Page) =>
  target.getByRole("region", { name: "Update" });
const updateNow = (target: Page, disabled = false) =>
  updateNotice(target).getByRole("button", { name: "Update now", disabled });
async function release(target = page) {
  version = 1;
  await target.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitForWorker(target, async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  );
}
async function updated(target = page) {
  await target.waitForFunction(() => document.title === "Mindgrab 1");
  await target.waitForSelector('[data-storage-ready="true"]');
  await waitForWorker(
    target,
    async () => !(await navigator.serviceWorker.getRegistration())?.waiting,
  );
}
async function cacheKeys() {
  return page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) =>
      name.startsWith("mindgrab-shell/"),
    );
    return {
      names,
      urls: (
        await Promise.all(
          names.map(async (name) =>
            (
              await (await caches.open(name)).keys()
            ).map((request) => new URL(request.url).pathname),
          ),
        )
      ).flat(),
    };
  });
}

test("API/auth/logout/health, token queries, foreign origins and unknown routes bypass the cache", async () => {
  await load();
  await installed();
  const paths = [
    "/api/getMe.php",
    "/api/listProjects.php",
    "/api/getHealth.php",
    "/api/startLogin.php",
    "/api/auth/callback.php",
    "/api/logout.php",
    "/ws/project/test-project",
    "/ws/share/test-token",
    "/ingest.php/e/",
    "/checkhealth",
    "/?token=secret",
    "/unknown",
  ];
  for (const path of paths) {
    const result = await page.evaluate(async (path) => {
      const response = await fetch(path, {
        method:
          path.startsWith("/api/") && path !== "/api/auth/callback.php"
            ? "POST"
            : "GET",
      });
      return { status: response.status, body: await response.text() };
    }, path);
    expect(result.body).not.toContain("Ready to reopen offline");
  }
  for (const path of [
    "/api/getMe.php",
    "/api/listProjects.php",
    "/api/getHealth.php",
    "/api/startLogin.php",
    "/api/auth/callback.php",
    "/ingest.php/e/",
    "/checkhealth",
  ])
    expect(requests).toContain(
      `${path.startsWith("/api/") && path !== "/api/auth/callback.php" ? "POST" : "GET"} ${path}`,
    );
  expect(requests).toContain("POST /api/logout.php");
  const cache = await cacheKeys();
  expect(cache.names).toHaveLength(1);
  const assets: string[] = [];
  for (const name of await readdir(builds[version], { recursive: true })) {
    if (name === "sw.js" || name.endsWith(".map")) continue;
    if ((await stat(join(builds[version], name))).isFile())
      assets.push(`/${name}`);
  }
  expect(cache.urls.toSorted()).toEqual(assets.toSorted());
  expect(cache.urls).toContain("/icons.svg");
  expect(
    cache.urls.every(
      (path) =>
        path === "/index.html" ||
        path === "/icons.svg" ||
        path === "/favicon.svg" ||
        path.startsWith("/assets/"),
    ),
  ).toBe(true);
  await context.setOffline(true);
  for (const path of [...paths, "https://example.invalid/api/getMe.php"])
    expect(
      await page.evaluate(async (path) => {
        try {
          await fetch(path);
          return "served";
        } catch {
          return "network unavailable";
        }
      }, path),
    ).toBe("network unavailable");
  const tab = await context.newPage();
  await expect(
    tab.goto(`${origin}/api/auth/callback.php?code=secret`),
  ).rejects.toThrow();
  await tab.close();
});

test("a new production version waits for all tabs while unsynced edits remain durable", async () => {
  await load();
  await installed();
  const second = await context.newPage();
  await second.goto(origin);
  await second.waitForSelector('[data-storage-ready="true"]');
  await context.setOffline(true);
  await edit("Unsynced before upgrade");
  version = 1;
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForWorker(page, async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  );
  await updateNotice(page)
    .getByText("Updating also reloads your other Mindgrab tab")
    .waitFor();
  expect(await page.title()).toBe("Mindgrab 0");
  expect(await second.title()).toBe("Mindgrab 0");
  expect((await cacheKeys()).names).toHaveLength(2);
  await edit("Unsynced after upgrade installed");
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.title()).toBe("Mindgrab 0");
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Unsynced after upgrade installed",
  );
  await second.close();
  await page.close();
  page = await context.newPage();
  // Wait for natural activation after the last old client closes, then verify
  // offline navigation receives only the new cached shell and all local edits.
  await page.goto(origin);
  await waitForWorker(
    page,
    async () => !(await navigator.serviceWorker.getRegistration())?.waiting,
  );
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.title()).toBe("Mindgrab 1");
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Unsynced after upgrade installed",
  );
  expect((await cacheKeys()).names).toHaveLength(1);
});

test("a failed upgrade leaves the installed shell and local work intact", async () => {
  await load();
  await installed();
  await edit("Retained during failed install");
  version = 1;
  missingAsset = true;
  await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistration())?.update(),
  );
  await waitForWorker(
    page,
    async () => !(await navigator.serviceWorker.getRegistration())?.installing,
  );
  expect(
    await page.evaluate(async () =>
      Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
    ),
  ).toBe(false);
  expect((await cacheKeys()).names).toHaveLength(1);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.title()).toBe("Mindgrab 0");
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Retained during failed install",
  );
});

test("incompatible cached versions show recovery before opening project storage", async () => {
  incompatible = true;
  await load();
  await waitForWorker(
    page,
    async () =>
      (await navigator.serviceWorker.getRegistration())?.active?.state ===
      "activated",
  );
  await edit("Do not migrate or delete");
  const databases = await page.evaluate(() => indexedDB.databases());
  await page.reload();
  await page
    .getByRole("heading", { name: "Application update needed" })
    .waitFor();
  expect(await page.getByRole("alert").innerText()).toContain(
    "local data is retained",
  );
  expect(await page.locator('[aria-label="Mind map canvas"]').count()).toBe(0);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual(databases);
  incompatible = false;
  // Recovery pages still check for an update, without touching local storage.
  await page.getByRole("button", { name: "Retry opening" }).click();
  await page
    .getByRole("heading", { name: "Application update needed" })
    .waitFor();
  await waitForWorker(page, async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  );
  // No editor runs here, so the update can replace the cached shell at once.
  await screenshot(page, "desktop-recovery");
  await updateNow(page).click();
  await page.waitForSelector('[data-storage-ready="true"]');
  await waitForWorker(
    page,
    async () => !(await navigator.serviceWorker.getRegistration())?.waiting,
  );
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Do not migrate or delete",
  );
});

test("a newer catalog version reports a recoverable upgrade and retains stored projects", async () => {
  await load();
  await installed();
  await edit("Preserve on catalog downgrade");
  const catalog = await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(
      ({ name }) => name?.includes("/account-1/") && name.endsWith("/catalog"),
    )?.name;
    if (!name) throw new Error("Missing account catalog");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    return name;
  });
  await page.reload();
  await page
    .getByText("Browser storage needs a newer application version.", {
      exact: false,
    })
    .waitFor();
  expect(
    await page.evaluate(
      async (name) =>
        (await indexedDB.databases()).find((database) => database.name === name)
          ?.version,
      catalog,
    ),
  ).toBe(2);
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).some(({ name }) =>
        name?.includes("/account-1/g2/project/"),
      ),
    ),
  ).toBe(true);
});

test("visible tabs retry failed release checks periodically without an online event or reload", async () => {
  await page.clock.install();
  await load();
  await installed();
  await edit("Retain through deployment outage");
  version = 1;
  workerUnavailable = true;
  const before = requests.filter((request) => request === "GET /sw.js").length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const deadline = Date.now() + 5000;
  while (
    requests.filter((request) => request === "GET /sw.js").length === before
  ) {
    if (Date.now() > deadline) throw new Error("No worker update request");
    await Bun.sleep(20);
  }
  // Allow the failed check's rejection to settle before advancing the clock.
  await page.clock.runFor(100);
  expect(await page.title()).toBe("Mindgrab 0");
  workerUnavailable = false;
  await page.clock.fastForward(5 * 60_000);
  await waitForWorker(page, async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  );
  await updateNow(page).waitFor();
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Retain through deployment outage",
  );
});

test("a failed first registration recovers on reconnect without reopening", async () => {
  workerUnavailable = true;
  await load();
  await page
    .getByLabel("Offline application")
    .filter({ hasText: "Offline reopening is not ready" })
    .waitFor();
  expect(
    await page.evaluate(async () =>
      Boolean(await navigator.serviceWorker.getRegistration()),
    ),
  ).toBe(false);
  await edit("Work before shell installation");
  workerUnavailable = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForWorker(
    page,
    async () =>
      (await navigator.serviceWorker.getRegistration())?.active?.state ===
      "activated",
  );
  expect(await page.getByLabel("Offline application").innerText()).toContain(
    "Ready to reopen offline",
  );
  await page.close();
  await context.setOffline(true);
  page = await context.newPage();
  await load();
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Work before shell installation",
  );
});

test("an old tab and a tab opened beside it both offer the update, and one click moves both to the new build with their edits", async () => {
  await load();
  await installed();
  await edit("Kept through Update now");
  await release();
  await updateNotice(page)
    .getByText("A new version of Mindgrab is ready.")
    .waitFor();
  // The update replaces the offline status instead of sharing its look.
  expect(await page.getByLabel("Offline application").count()).toBe(0);
  await screenshot(page, "desktop-old-tab");
  // A tab opened now still gets the old build, and offers the same update.
  const second = await context.newPage();
  second.on("pageerror", (error) => errors.push(error.message));
  await second.goto(origin);
  await second.waitForSelector('[data-storage-ready="true"]');
  expect(await second.title()).toBe("Mindgrab 0");
  await updateNotice(second)
    .getByText("Updating also reloads your other Mindgrab tab.")
    .waitFor();
  await screenshot(second, "desktop-new-tab");
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await updateNotice(page)
    .getByText("Updating also reloads your other Mindgrab tab.")
    .waitFor();
  // Nothing reloads until someone clicks.
  expect(await page.title()).toBe("Mindgrab 0");
  expect(await second.title()).toBe("Mindgrab 0");
  await updateNow(page).click();
  await Promise.all([updated(page), updated(second)]);
  for (const target of [page, second]) {
    expect(await target.locator("[data-node-id]").first().innerText()).toBe(
      "Kept through Update now",
    );
    expect(await updateNotice(target).count()).toBe(0);
  }
  await page
    .getByLabel("Offline application")
    .getByText("Ready to reopen offline", { exact: false })
    .waitFor();
  expect((await cacheKeys()).names).toHaveLength(1);
  await screenshot(page, "desktop-updated");
  await second.close();
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.title()).toBe("Mindgrab 1");
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Kept through Update now",
  );
});

test("Update now warns and stays before any tab would lose a map with local saving off", async () => {
  await load();
  await installed();
  await page.locator("[data-node-id]").first().dblclick();
  await page.getByLabel("Node text").fill("Only in these tabs");
  await page.getByLabel("Node text").press("Enter");
  const second = await context.newPage();
  second.on("pageerror", (error) => errors.push(error.message));
  await second.goto(origin);
  await second.waitForSelector('[data-storage-ready="true"]');
  // Local saving is turned off in the other tab.
  await second.getByRole("button", { name: "Project menu" }).click();
  await second
    .getByRole("menuitem", { name: "Project preferences…" })
    .first()
    .click();
  await second
    .getByRole("switch", { name: "Save locally", exact: true })
    .click();
  await second
    .getByRole("button", { name: "Close project preferences" })
    .click();
  await page.bringToFront();
  await release();
  await updateNow(page).click();
  const warning = updateNotice(page).getByRole("alert");
  await warning.getByText("Updating now would lose work").waitFor();
  expect(await warning.innerText()).toContain(
    "In another tab: A map with local saving off is not saved anywhere else yet.",
  );
  await screenshot(page, "desktop-unsafe-warning");
  await updateNotice(page).getByRole("button", { name: "Not now" }).click();
  await updateNow(page).waitFor();
  expect(await page.title()).toBe("Mindgrab 0");
  expect(await second.title()).toBe("Mindgrab 0");
  expect(
    await page.evaluate(async () =>
      Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
    ),
  ).toBe(true);
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Only in these tabs",
  );
  // Confirming the loss is the only way past the warning.
  await updateNow(page).click();
  await updateNotice(page)
    .getByRole("button", { name: "Update and lose it" })
    .click();
  await Promise.all([updated(page), updated(second)]);
});

test("on a phone the update notice clears the menu and the selection toolbar and updates", async () => {
  await context.close();
  const { defaultBrowserType: _, ...phone } = devices["iPhone 13"];
  await launch({ ...phone, deviceScaleFactor: 2 });
  await load();
  await installed();
  await release();
  await page.locator("[data-node-id]").first().click();
  const toolbar = page.getByRole("region", { name: "Selected idea" });
  await toolbar.waitFor();
  await updateNow(page).waitFor();
  const box = async (locator: ReturnType<Page["locator"]>) => {
    const rect = await locator.boundingBox();
    if (!rect) throw new Error("Not on screen");
    return rect;
  };
  const notice = await box(updateNotice(page));
  const viewport = page.viewportSize();
  expect(notice.x).toBeGreaterThanOrEqual(0);
  expect(notice.x + notice.width).toBeLessThanOrEqual(viewport?.width ?? 0);
  for (const other of [
    await box(page.getByRole("button", { name: "Project menu" })),
    await box(toolbar),
  ])
    expect(
      notice.x < other.x + other.width &&
        other.x < notice.x + notice.width &&
        notice.y < other.y + other.height &&
        other.y < notice.y + notice.height,
    ).toBe(false);
  await screenshot(page, "phone-old-tab");
  await updateNow(page).click();
  await updated();
  expect(await updateNotice(page).count()).toBe(0);
});
