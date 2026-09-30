import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { build } from "vite";

// Real HTTP + production output; no request interception and no dev harness.
// A persistent profile also proves reopen after the browser process exits.
setDefaultTimeout(45_000);
const webapp = join(import.meta.dir, "../..");
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
let resetWorkerUnavailable = false;
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
      plugins: [
        {
          name: "release-fixture",
          transformIndexHtml: (html) =>
            html.replace(
              "<title>mindgrab</title>",
              `<title>mindgrab ${index}</title>`,
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
      if (path === "/api/me")
        return Response.json(
          {
            id: user,
            name: `Account ${user}`,
            email: `${user}@test.example`,
            external_id: `user_${user}`,
          },
          { headers },
        );
      if (path === "/api/auth/logout" && request.method === "POST") {
        user = 0;
        return new Response(null, {
          status: 303,
          headers: { ...headers, Location: "/" },
        });
      }
      if (path === "/api/auth/login")
        return new Response(null, {
          status: 303,
          headers: { ...headers, Location: "/" },
        });
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
      if (path === "/auth/callback")
        return new Response("Auth callback", { headers });
      if (path === "/legacy-tab")
        return new Response("<title>Old development tab</title>", {
          headers: { ...headers, "Content-Type": "text/html" },
        });
      if (path === "/legacy-reset-worker.js" && resetWorkerUnavailable)
        return new Response("Reset coordination unavailable", { status: 503 });
      if (path === "/sw.js") {
        if (workerUnavailable)
          return new Response("Worker temporarily unavailable", {
            status: 503,
          });
        let script = await Bun.file(join(builds[version], "sw.js")).text();
        if (incompatible)
          script = script.replace('"storage":1', '"storage":99');
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

async function launch() {
  context = await chromium.launchPersistentContext(profile, { headless: true });
  page = context.pages()[0];
  page.on("pageerror", (error) => errors.push(error.message));
}

beforeEach(async () => {
  profile = await mkdtemp(join(directory, "profile-"));
  version = 0;
  incompatible = false;
  missingAsset = false;
  workerUnavailable = false;
  resetWorkerUnavailable = false;
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
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="Project actions"]')
      ?.textContent?.includes("Saved locally"),
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

test("production shell cold-opens an account project after process exit, edits offline and persists reload", async () => {
  await load();
  await installed();
  await edit("Account work online");
  await context.close();
  await launch();
  await context.setOffline(true);
  await load(`${origin}/?project=cached`);
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Account work online",
  );
  expect(
    await page.getByRole("region", { name: "Account" }).innerText(),
  ).toContain("Account 1");
  await edit("Account work offline");
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Account work offline",
  );
  await context.setOffline(false);
  const me = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/me` && response.status() === 200,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await me;
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Account work offline",
  );
});

test("API/auth/logout/health, token queries, foreign origins and unknown routes bypass the cache", async () => {
  await load();
  await installed();
  const paths = [
    "/api/me",
    "/api/crdt/v1/projects",
    "/api/health",
    "/api/auth/login",
    "/api/auth/callback",
    "/api/auth/logout",
    "/auth/callback",
    "/checkhealth",
    "/?token=secret",
    "/unknown",
  ];
  for (const path of paths) {
    const result = await page.evaluate(async (path) => {
      const response = await fetch(path, {
        method: path === "/api/auth/logout" ? "POST" : "GET",
      });
      return { status: response.status, body: await response.text() };
    }, path);
    expect(result.body).not.toContain("Ready to reopen offline");
  }
  for (const path of [
    "/api/me",
    "/api/crdt/v1/projects",
    "/api/health",
    "/api/auth/login",
    "/api/auth/callback",
    "/checkhealth",
  ])
    expect(requests).toContain(`GET ${path}`);
  expect(requests).toContain("POST /api/auth/logout");
  const cache = await cacheKeys();
  expect(cache.names).toHaveLength(1);
  expect(cache.urls).toHaveLength(6);
  expect(cache.urls).toContain("/icons.svg");
  expect(
    cache.urls.every(
      (path) =>
        path === "/index.html" ||
        path === "/icons.svg" ||
        path === "/legacy-reset-worker.js" ||
        path === "/favicon.svg" ||
        path.startsWith("/assets/"),
    ),
  ).toBe(true);
  await context.setOffline(true);
  for (const path of [...paths, "https://example.invalid/api/me"])
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
    tab.goto(`${origin}/api/auth/callback?code=secret`),
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
  expect(await page.getByLabel("Offline application").innerText()).toContain(
    "An update is ready",
  );
  expect(await page.title()).toBe("mindgrab 0");
  expect(await second.title()).toBe("mindgrab 0");
  expect((await cacheKeys()).names).toHaveLength(2);
  await edit("Unsynced after upgrade installed");
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.title()).toBe("mindgrab 0");
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
  expect(await page.title()).toBe("mindgrab 1");
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
  expect(await page.title()).toBe("mindgrab 0");
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
  await context.close();
  await launch();
  await load();
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Do not migrate or delete",
  );
});

test("an unvisited profile cannot cold-open offline", async () => {
  await context.setOffline(true);
  await expect(page.goto(origin)).rejects.toThrow();
  expect(await context.serviceWorkers()).toHaveLength(0);
});

test("cached shell logout and account switches preserve local workspace isolation", async () => {
  await load();
  await installed();
  await edit("Private account A");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("link", { name: "Sign in", exact: true }).waitFor();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "New idea",
  );
  user = 2;
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByText("Account 2", { exact: true }).waitFor();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "New idea",
  );
  await edit("Private account B");
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Private account B",
  );
  await context.setOffline(false);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("link", { name: "Sign in", exact: true }).waitFor();
  user = 1;
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByText("Account 1", { exact: true }).waitFor();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Private account A",
  );
  expect((await cacheKeys()).urls.some((path) => path.startsWith("/api"))).toBe(
    false,
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
        name?.includes("/account-1/g1/project/"),
      ),
    ),
  ).toBe(true);
});

test("an already online tab discovers a later release when focused", async () => {
  await load();
  await installed();
  await edit("Pending cloud work before deployment");
  version = 1;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitForWorker(page, async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  );
  expect(await page.getByLabel("Offline application").innerText()).toContain(
    "An update is ready",
  );
  expect(await page.title()).toBe("mindgrab 0");
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Pending cloud work before deployment",
  );
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
  expect(await page.title()).toBe("mindgrab 0");
  workerUnavailable = false;
  await page.clock.fastForward(5 * 60_000);
  await waitForWorker(page, async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  );
  expect(await page.getByLabel("Offline application").innerText()).toContain(
    "An update is ready",
  );
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

async function seedLegacy(target: Page) {
  await target.evaluate(() => {
    for (const key of [
      "proj/Ideas",
      "project-updated/Ideas",
      "mindgrab/latest-project",
      "mindgrab/user/1/proj/Ideas",
      "mindgrab/user/1/project-updated/Ideas",
      "mindgrab/user/1/mindgrab/latest-project",
    ])
      localStorage.setItem(key, "obsolete");
    localStorage.setItem("mindgrab/legacy-project-reset", "999");
    localStorage.setItem("unrelated", "keep");
    localStorage.setItem("mindgrab/user/1/theme", "keep");
    localStorage.setItem("mindgrab/auth/fixture", "keep-auth");
  });
}
async function legacyState(target: Page) {
  return target.evaluate(() => ({
    obsolete: localStorage.getItem("proj/Ideas"),
    generation: localStorage.getItem("mindgrab/legacy-project-reset"),
    unrelated: localStorage.getItem("unrelated"),
    preference: localStorage.getItem("mindgrab/user/1/theme"),
    auth: localStorage.getItem("mindgrab/auth/fixture"),
    keys: Object.keys(localStorage).sort(),
  }));
}

test("fresh cutover clears only known legacy keys and ignores a forged reset marker", async () => {
  await page.goto(`${origin}/legacy-tab`);
  await seedLegacy(page);
  await load();
  const reset = await legacyState(page);
  expect(reset.obsolete).toBeNull();
  expect(reset.generation).toBe("1");
  expect(
    reset.keys.filter(
      (key) => key.includes("Ideas") || key.endsWith("latest-project"),
    ),
  ).toEqual([]);
  expect(reset.unrelated).toBe("keep");
  expect(reset.preference).toBe("keep");
  expect(reset.auth).toBe("keep-auth");
  expect(
    await page.getByRole("region", { name: "Account" }).innerText(),
  ).toContain("Account 1");
});

test("reset preserves valid Yjs documents and all existing databases on every repeat", async () => {
  await load();
  await installed();
  await edit("Retain Yjs edits across cutover");
  const nodes = await page
    .locator("[data-node-id]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-node-id")),
    );
  const databases = await page.evaluate(async () =>
    (await indexedDB.databases()).map((db) => db.name).sort(),
  );
  for (let repeat = 0; repeat < 2; repeat++) {
    await seedLegacy(page);
    await page.reload();
    await page.waitForSelector('[data-storage-ready="true"]');
    expect(await page.locator("[data-node-id]").first().innerText()).toBe(
      "Retain Yjs edits across cutover",
    );
    expect(
      await page
        .locator("[data-node-id]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-node-id")),
        ),
    ).toEqual(nodes);
    expect(
      await page.evaluate(async () =>
        (await indexedDB.databases()).map((db) => db.name).sort(),
      ),
    ).toEqual(databases);
    expect((await legacyState(page)).obsolete).toBeNull();
  }
});

test("uncontrolled old tabs fence reset, including offline reopening, until closed", async () => {
  await load();
  await installed();
  await edit("Current Yjs work");
  const stale = await context.newPage();
  await stale.goto(`${origin}/legacy-tab`);
  await seedLegacy(stale);
  await context.setOffline(true);
  await page.reload();
  await page
    .getByRole("heading", { name: "Application update needed" })
    .waitFor();
  expect((await legacyState(page)).obsolete).toBe("obsolete");
  await context.setOffline(false);
  await page.reload();
  await page
    .getByRole("heading", { name: "Application update needed" })
    .waitFor();
  expect(await page.getByRole("alert").innerText()).toContain(
    "Close all other tabs",
  );
  expect((await legacyState(stale)).obsolete).toBe("obsolete");
  await stale.close();
  await page.getByRole("button", { name: "Retry opening" }).click();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect(await page.locator("[data-node-id]").first().innerText()).toBe(
    "Current Yjs work",
  );
  expect((await legacyState(page)).obsolete).toBeNull();
});

test("failed reset coordination keeps legacy state and recovers on retry", async () => {
  await page.goto(`${origin}/legacy-tab`);
  await seedLegacy(page);
  resetWorkerUnavailable = true;
  await page.goto(origin);
  await page
    .getByRole("heading", { name: "Application update needed" })
    .waitFor();
  expect((await legacyState(page)).obsolete).toBe("obsolete");
  expect(await page.locator("[data-node-id]").count()).toBe(0);
  resetWorkerUnavailable = false;
  await page.getByRole("button", { name: "Retry opening" }).click();
  await page.waitForSelector('[data-storage-ready="true"]');
  expect((await legacyState(page)).obsolete).toBeNull();
});
