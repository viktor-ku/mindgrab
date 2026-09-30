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
      if (path === "/sw.js") {
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
  expect(cache.urls).toHaveLength(5);
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
  await context.setOffline(false);
  version = 1;
  await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistration())?.update(),
  );
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
