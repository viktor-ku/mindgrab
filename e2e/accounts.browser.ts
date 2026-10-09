import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { chromium } from "playwright";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import type { ProjectDocument } from "../webapp/src/project-document";
import type { User } from "../webapp/src/auth-session";
import { openProjectDocument } from "../webapp/src/project-document";
import type { AccountHarness } from "./accounts-harness";

setDefaultTimeout(30_000);
const harnessPath = `/@fs/${import.meta.dir}/accounts-harness.html`;
const A: User = {
  id: 1,
  name: "Account A",
  email: "a@test.example",
  external_id: "user_a",
};
const B: User = {
  id: 2,
  name: "Account B",
  email: "b@test.example",
  external_id: "user_b",
};
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Backend {
  user?: User;
  nextUser = A;
  meStatus?: number;
  meGate?: ReturnType<typeof deferred>;
  catalogGate?: ReturnType<typeof deferred>;
  catalogStarted = false;
  meStarted = false;
  lostRegistration = false;
  leaveCookieOnLogout = false;
  loginRequests = 0;
  logoutRequests = 0;
  projects = new Map<string, { ownerId: number; doc: ProjectDocument }>();
  registrations: string[] = [];
  uploads: {
    projectId: string;
    ownerId: number;
    expected: string | undefined;
  }[] = [];
  async route(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    expect(request.method()).toBe("POST");
    const owner = this.user;
    const error = (status: number, code: string) =>
      route.fulfill({ status, json: { error: { code, message: code } } });
    if (url.pathname === "/api/startLogin") {
      this.loginRequests++;
      this.user = this.nextUser;
      this.meStatus = undefined;
      return route.fulfill({
        status: 303,
        headers: { Location: harnessPath },
      });
    }
    if (url.pathname === "/api/logout") {
      this.logoutRequests++;
      if (!this.leaveCookieOnLogout) this.user = undefined;
      return route.fulfill({
        status: 303,
        headers: { Location: harnessPath },
      });
    }
    if (url.pathname === "/api/getMe") {
      this.meStarted = true;
      const status = this.meStatus;
      await this.meGate?.promise;
      if (status)
        return error(
          status,
          status === 401 ? "unauthenticated" : "unavailable",
        );
      return owner
        ? route.fulfill({ json: owner })
        : error(401, "unauthenticated");
    }
    const expected = request.headers()["x-mindgrab-account"];
    if (!owner || this.meStatus === 401) return error(401, "unauthenticated");
    if (this.meStatus === 503) return error(503, "unavailable");
    if (expected !== String(owner.id)) return error(409, "account_changed");
    if (url.pathname === "/api/createProject") {
      const { projectId } = request.postDataJSON();
      let record = this.projects.get(projectId);
      if (record && record.ownerId !== owner.id)
        return error(409, "project_id_conflict");
      if (!record) {
        record = { ownerId: owner.id, doc: openProjectDocument(projectId) };
        this.projects.set(projectId, record);
      }
      this.registrations.push(projectId);
      if (this.lostRegistration) {
        this.lostRegistration = false;
        return route.abort("failed");
      }
      return route.fulfill({
        json: {
          projectId,
          format: "mindgrab-loro-v1",
          schemaVersion: 1,
          name: null,
        },
      });
    }
    if (url.pathname === "/api/listProjects") {
      this.catalogStarted = true;
      const projects = [...this.projects]
        .filter(([, entry]) => entry.ownerId === owner.id && entry.doc.ready)
        .map(([projectId]) => ({
          projectId,
          format: "mindgrab-loro-v1",
          schemaVersion: 1,
          name: null,
        }));
      await this.catalogGate?.promise;
      return route.fulfill({ json: { projects, nextCursor: null } });
    }
    if (url.pathname === "/api/deleteProject") {
      const { projectId } = request.postDataJSON();
      if (this.projects.get(projectId)?.ownerId === owner.id)
        this.projects.delete(projectId);
      return route.fulfill({ json: { deleted: true } });
    }
    const operation = url.pathname;
    const { projectId: id } =
      operation === "/api/mergeProject"
        ? Object.fromEntries(url.searchParams)
        : request.postDataJSON();
    const record = this.projects.get(id);
    if (!record || record.ownerId !== owner.id)
      return error(404, "project_not_found");
    const response = () => ({
      projectId: id,
      revision: "1",
      encoding: "loro-snapshot",
      data: base64(record.doc.snapshot()),
      durable: true,
    });
    if (operation === "/api/getProjectSnapshot")
      return route.fulfill({ json: response() });
    if (operation === "/api/mergeProject") {
      const bytes = new Uint8Array(request.postDataBuffer() as Buffer);
      record.doc.merge(bytes);
      this.uploads.push({ projectId: id, ownerId: owner.id, expected });
      return route.fulfill({ json: response() });
    }
    return error(404, "not_found");
  }
}
let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let backend: Backend;
let errors: Error[];
let appUrl: string;
beforeAll(async () => {
  const root = fileURLToPath(new URL("../webapp", import.meta.url));
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    cacheDir: "node_modules/.vite-account-tests",
    define: { "import.meta.env.VITE_BACKEND_URL": JSON.stringify("") },
    logLevel: "error",
    server: {
      port: 5197,
      strictPort: false,
      fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    },
    optimizeDeps: { entries: [`${import.meta.dir}/accounts-harness.html`] },
  });
  await server.listen();
  appUrl = new URL(harnessPath, server.resolvedUrls?.local[0]).href;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
beforeEach(async () => {
  backend = new Backend();
  context = await browser.newContext();
  errors = [];
  context.on("page", (page) =>
    page.on("pageerror", (error) => errors.push(error)),
  );
  await context.route("**/api/**", (route) => backend.route(route));
  page = await context.newPage();
  await page.goto(appUrl);
  await ready(page);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
});
afterEach(async () => {
  backend.meGate?.resolve();
  backend.catalogGate?.resolve();
  await context.close();
  for (const record of backend.projects.values()) record.doc.destroy();
  expect(errors).toEqual([]);
});
type AccountAction = {
  [K in keyof AccountHarness]: AccountHarness[K] extends (
    ...args: never[]
  ) => unknown
    ? K
    : never;
}[keyof AccountHarness];

function call<K extends AccountAction>(
  name: K,
  ...args: Parameters<AccountHarness[K]>
): Promise<Awaited<ReturnType<AccountHarness[K]>>> {
  return page.evaluate(
    ([name, args]) =>
      (window.accountHarness[name] as (...args: unknown[]) => unknown)(...args),
    [name, args] as const,
  ) as never;
}
async function ready(target = page) {
  await target.waitForSelector('[data-storage-ready="true"]');
  await target.waitForSelector("[data-node-id]");
}
async function login(user = A) {
  backend.nextUser = user;
  await page.getByRole("button", { name: /Sign in/ }).click();
  await page.getByText(user.name, { exact: true }).waitFor();
  await ready();
}
async function rename(name: string) {
  await page.getByRole("textbox", { name: "Project name" }).fill(name);
  await page.getByRole("textbox", { name: "Project name" }).press("Enter");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved locally.", { exact: true }).waitFor();
}
async function edit(text: string) {
  await page.locator("[data-node-id]").first().dblclick();
  await page.getByRole("textbox", { name: "Node text" }).fill(text);
  await page.getByRole("textbox", { name: "Node text" }).press("Escape");
}
async function refreshAccount() {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}
const claim = () =>
  page.getByRole("button", { name: "Add anonymous projects to this account" });
async function cloudSaved() {
  await page.getByText("Saved to cloud", { exact: true }).waitFor();
}

test("lost registration and repeated/concurrent claims reuse one target and retain Loro history", async () => {
  await rename("Interrupted anonymous claim");
  const id = await call("id");
  await login();
  await cloudSaved();
  await claim().waitFor();
  backend.lostRegistration = true;
  await claim().click();
  await page.getByText(/Could not finish adding anonymous projects/).waitFor();
  const marker = (await call("catalog", "anonymous", true)).find(
    (entry) => entry.id === id,
  )?.claim;
  expect(marker).toEqual({ ownerId: A.id, targetId: id, phase: "pending" });
  expect(
    (await call("catalog", "account-1")).some((entry) => entry.id === id),
  ).toBe(false);
  await page.reload();
  await ready();
  const concurrent = await context.newPage();
  await concurrent.goto(appUrl);
  await ready(concurrent);
  await Promise.all([
    claim().click(),
    concurrent
      .getByRole("button", { name: "Add anonymous projects to this account" })
      .click(),
  ]);
  await page.getByRole("textbox", { name: "Project name" }).waitFor();
  await page.waitForFunction((id) => window.accountHarness.id() === id, id);
  await cloudSaved();
  expect(
    (await call("catalog", "account-1")).filter((entry) => entry.id === id),
  ).toHaveLength(1);
  expect(
    (await call("catalog", "anonymous", true)).find((entry) => entry.id === id)
      ?.claim?.phase,
  ).toBe("complete");
  const pending = await call("historyClaim", A.id);
  expect(pending.equal).toBe(true);
  expect(pending.after).toEqual(pending.before);
});

test("a UUID owned elsewhere is copied to a new UUID without merging unrelated content", async () => {
  await edit("Mine before sign-in");
  await rename("My anonymous work");
  const id = await call("id");
  backend.projects.set(id, { ownerId: B.id, doc: openProjectDocument(id) });
  await login();
  await claim().click();
  await page.getByText("Mine before sign-in", { exact: true }).waitFor();
  await cloudSaved();
  const replacement = await call("id");
  expect(replacement).not.toBe(id);
  expect(backend.projects.get(id)?.ownerId).toBe(B.id);
  expect(backend.projects.get(replacement)?.ownerId).toBe(A.id);
  expect(
    (await call("catalog", "account-1")).some((entry) => entry.id === id),
  ).toBe(false);
  const marker = (await call("catalog", "anonymous", true)).find(
    (entry) => entry.id === id,
  )?.claim;
  expect(marker?.targetId).toBe(replacement);
});

test("logout from another tab fences a delayed getMe response and survives a stale server cookie", async () => {
  await login();
  await rename("Hidden after logout");
  await cloudSaved();
  const id = await call("id");
  const other = await context.newPage();
  await other.goto(appUrl);
  await ready(other);
  await other.getByText(A.name, { exact: true }).waitFor();
  backend.meStarted = false;
  backend.meGate = deferred();
  await refreshAccount();
  while (!backend.meStarted) await Bun.sleep(10);
  backend.leaveCookieOnLogout = true;
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await ready();
  backend.meGate.resolve();
  backend.meGate = undefined;
  expect(await call("id")).not.toBe(id);
  expect(await call("sockets")).toEqual([]);
  await page.reload();
  await ready();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  expect(await page.getByText(A.name, { exact: true }).count()).toBe(0);
  expect(
    (await call("catalog", "anonymous")).some((entry) => entry.id === id),
  ).toBe(false);
});

test("forced logout parks failed local writes outside anonymous UI until they can be retried", async () => {
  await login();
  await rename("Recoverable A");
  await cloudSaved();
  const id = await call("id");
  const other = await context.newPage();
  await other.goto(appUrl);
  await ready(other);
  await other.getByText(A.name, { exact: true }).waitFor();
  await call("failWrites", true);
  await edit("Retain these failed local edits");
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await page
    .getByText(/Edits from the previous account could not be saved/)
    .waitFor();
  await ready();
  expect(await call("id")).not.toBe(id);
  expect(
    await page
      .getByText("Retain these failed local edits", { exact: true })
      .count(),
  ).toBe(0);
  await call("failWrites", false);
  await page
    .getByRole("button", { name: "Retry local saving", exact: true })
    .click();
  await page
    .getByText(/Edits from the previous account could not be saved/)
    .waitFor({ state: "detached" });
  await login();
  await page
    .getByText("Retain these failed local edits", { exact: true })
    .waitFor();
  expect(await call("id")).toBe(id);
});

test("a focus event during an old session check queues a fresh account check", async () => {
  await login();
  await cloudSaved();
  const previous = await call("id");
  backend.meStarted = false;
  backend.catalogStarted = false;
  backend.meGate = deferred();
  backend.catalogGate = deferred();
  await refreshAccount();
  while (!backend.meStarted || !backend.catalogStarted) await Bun.sleep(10);
  // The old /me and catalog responses both describe A. Hold discovery so its
  // owner fence cannot mask a dropped auth refresh when the cookie becomes B.
  backend.user = B;
  await refreshAccount();
  backend.meGate.resolve();
  backend.meGate = undefined;
  await page.getByText(B.name, { exact: true }).waitFor();
  await ready();
  expect(await call("id")).not.toBe(previous);
  backend.catalogGate.resolve();
  backend.catalogGate = undefined;
  expect(
    (await call("catalog", "account-2")).some((entry) => entry.id === previous),
  ).toBe(false);
});

test("durable hints recover the workspace and logout when localStorage is missing or stale", async () => {
  await login();
  await rename("Crash hint recovery");
  await cloudSaved();
  const id = await call("id");
  const stale = await page.evaluate(() =>
    localStorage.getItem(
      `mindgrab/${encodeURIComponent(location.origin)}/auth`,
    ),
  );
  backend.meStatus = 503;
  await page.evaluate(() =>
    localStorage.removeItem(
      `mindgrab/${encodeURIComponent(location.origin)}/auth`,
    ),
  );
  await page.reload();
  await ready();
  await page.getByText(A.name, { exact: true }).waitFor();
  expect(await call("id")).toBe(id);
  expect(await page.getByLabel("Project name").inputValue()).toBe(
    "Crash hint recovery",
  );
  backend.meStatus = undefined;
  await refreshAccount();
  await cloudSaved();
  backend.leaveCookieOnLogout = true;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await page.evaluate((stale) => {
    if (stale)
      localStorage.setItem(
        `mindgrab/${encodeURIComponent(location.origin)}/auth`,
        stale,
      );
  }, stale);
  await page.reload();
  await ready();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  expect(await call("id")).not.toBe(id);
  expect(await page.getByText(A.name, { exact: true }).count()).toBe(0);
});

test("an aborted durable account hint prevents logout acknowledgement and can be retried", async () => {
  await login();
  await cloudSaved();
  const id = await call("id");
  await call("failAuthDatabase", true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByText(/Could not save your project before leaving/).waitFor();
  expect(backend.logoutRequests).toBe(0);
  expect(await call("id")).toBe(id);
  await page.getByText(A.name, { exact: true }).waitFor();
  await call("failAuthDatabase", false);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  expect(backend.logoutRequests).toBe(1);
});

test("signed-in users can disable both destinations, edit privately, and keep New projects private", async () => {
  await login();
  await cloudSaved();
  const id = await call("id");
  expect(backend.projects.has(id)).toBe(true);
  await page
    .getByRole("button", { name: "Project preferences", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Project preferences" });
  await dialog.getByRole("switch", { name: "Save in Mindgrab Cloud" }).click();
  await page.getByText("Cloud saving off", { exact: true }).waitFor();
  expect(backend.projects.has(id)).toBe(false);
  await dialog
    .getByRole("switch", { name: "Save locally", exact: true })
    .click();
  await dialog.getByText("This project lives only in memory.").waitFor();
  await page.waitForFunction(
    async (id) =>
      !(await indexedDB.databases()).some((db) =>
        db.name?.endsWith(`/project/${id}`),
      ),
    id,
  );
  await dialog
    .getByRole("button", { name: "Close project preferences" })
    .click();
  const uploads = backend.uploads.length;
  const registrations = backend.registrations.length;
  await edit("Secret work stays here");
  await refreshAccount();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByText("Local saving is off. Export a copy to keep your work.")
    .waitFor();
  expect(backend.uploads).toHaveLength(uploads);
  expect(backend.registrations).toHaveLength(registrations);
  expect(backend.projects.has(id)).toBe(false);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.waitForFunction((id) => window.accountHarness.id() !== id, id);
  expect(backend.registrations).toHaveLength(registrations);
  await page
    .getByText("Memory only · Export before closing this tab.")
    .waitFor();
});

test("cloud-only projects load after reload without leaving a local copy", async () => {
  await login();
  await rename("Cloud only project");
  await cloudSaved();
  const id = await call("id");
  await page
    .getByRole("button", { name: "Project preferences", exact: true })
    .click();
  await page.getByRole("switch", { name: "Save locally", exact: true }).click();
  await page.getByRole("button", { name: "Close project preferences" }).click();
  await cloudSaved();
  await page.reload();
  await ready();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await page
    .getByRole("button", { name: `Cloud only project · ${id.slice(0, 8)}` })
    .click();
  await page.getByText("Local saving off", { exact: true }).waitFor();
  expect(await call("id")).toBe(id);
  expect(
    await page.evaluate(
      async (id) =>
        (await indexedDB.databases()).some((db) =>
          db.name?.endsWith(`/project/${id}`),
        ),
      id,
    ),
  ).toBe(false);
});

test("anonymous projects with cloud saving off are never offered for account upload", async () => {
  const id = await call("id");
  await page
    .getByRole("button", { name: "Project preferences", exact: true })
    .click();
  await page.getByRole("switch", { name: "Save in Mindgrab Cloud" }).click();
  await page.getByRole("button", { name: "Close project preferences" }).click();
  await login();
  await cloudSaved();
  expect(backend.projects.has(id)).toBe(false);
  expect(await claim().count()).toBe(0);
  const anonymous = await call("catalog", "anonymous");
  expect(anonymous.find((entry) => entry.id === id)?.saving?.cloud).toBe(false);
});
