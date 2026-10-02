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
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";
import * as Y from "yjs";
import { digest } from "../../src/crdt-api";
import {
  materializeProject,
  openProjectDocument,
} from "../../src/project-document";
import type { User } from "../../src/auth-session";
import type { AccountHarness } from "./accounts-harness";

setDefaultTimeout(30_000);
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
  projects = new Map<string, { ownerId: number; doc: Y.Doc }>();
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
        headers: { Location: "/tests/browser/accounts-harness.html" },
      });
    }
    if (url.pathname === "/api/logout") {
      this.logoutRequests++;
      if (!this.leaveCookieOnLogout) this.user = undefined;
      return route.fulfill({
        status: 303,
        headers: { Location: "/tests/browser/accounts-harness.html" },
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
        json: { projectId, protocolVersion: 1, schemaVersion: 1, name: null },
      });
    }
    if (url.pathname === "/api/listProjects") {
      this.catalogStarted = true;
      const projects = [...this.projects]
        .filter(([, entry]) => entry.ownerId === owner.id)
        .map(([projectId]) => ({
          projectId,
          protocolVersion: 1,
          schemaVersion: 1,
          name: null,
        }));
      await this.catalogGate?.promise;
      return route.fulfill({ json: { projects, nextCursor: null } });
    }
    const operation = url.pathname;
    const { projectId: id, updateId } =
      operation === "/api/submitProjectUpdate"
        ? Object.fromEntries(url.searchParams)
        : request.postDataJSON();
    const record = this.projects.get(id);
    if (!record || record.ownerId !== owner.id)
      return error(404, "project_not_found");
    if (operation === "/api/getProjectBaseline")
      return route.fulfill({
        json: {
          schemaVersion: 1,
          lastSequence: "1",
          validation: "valid",
          encoding: "yjs-v1",
          data: base64(Y.encodeStateAsUpdate(record.doc)),
          stateVector: base64(Y.encodeStateVector(record.doc)),
        },
      });
    if (operation === "/api/getProjectStatus")
      return route.fulfill({
        json: { schemaVersion: 1, lastSequence: "1", validation: "valid" },
      });
    if (operation === "/api/submitProjectUpdate") {
      const bytes = new Uint8Array(request.postDataBuffer() as Buffer);
      Y.applyUpdate(record.doc, bytes);
      this.uploads.push({ projectId: id, ownerId: owner.id, expected });
      return route.fulfill({
        json: {
          protocolVersion: 1,
          projectId: id,
          updateId,
          sequence: "1",
          sha256: await digest(bytes),
          durable: true,
          validation: "valid",
        },
      });
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
  const root = fileURLToPath(new URL("../..", import.meta.url));
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    cacheDir: "node_modules/.vite-account-tests",
    define: { "import.meta.env.VITE_BACKEND_URL": JSON.stringify("") },
    logLevel: "error",
    server: { port: 5197, strictPort: false },
    optimizeDeps: { entries: ["tests/browser/accounts-harness.html"] },
  });
  await server.listen();
  appUrl = new URL(
    "tests/browser/accounts-harness.html",
    server.resolvedUrls?.local[0],
  ).href;
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
function call<K extends keyof AccountHarness>(
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

test("anonymous offline creation, explicit sign-in and claim survive reload without later reclaims", async () => {
  const anonymousId = await call("id");
  await context.setOffline(true);
  await edit("Anonymous offline content");
  await rename("Anonymous draft");
  expect(backend.uploads).toEqual([]);
  await context.setOffline(false);
  await login();
  expect(
    await page.getByText("Anonymous offline content", { exact: true }).count(),
  ).toBe(0);
  await claim().click();
  await page.getByText("Anonymous offline content", { exact: true }).waitFor();
  await cloudSaved();
  expect(await call("id")).toBe(anonymousId);
  expect(await call("catalog", "anonymous")).toEqual([]);
  await page.reload();
  await ready();
  await cloudSaved();
  expect(await call("id")).toBe(anonymousId);
  expect(await claim().count()).toBe(0);
  backend.user = B;
  await refreshAccount();
  await page.getByText(B.name, { exact: true }).waitFor();
  await ready();
  expect(await claim().count()).toBe(0);
  expect(
    (await call("catalog", "account-2")).some(
      (entry) => entry.id === anonymousId,
    ),
  ).toBe(false);
  expect(backend.projects.get(anonymousId)?.ownerId).toBe(A.id);
});

test("lost registration and repeated/concurrent claims reuse one target and retain pending Yjs bytes", async () => {
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
  const pending = await call("pendingClaim", A.id);
  expect(pending.pending).toBe(true);
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

test("503 and terminal 401 preserve cached edits, offline expiry pauses sync, and reauth resumes the same UUID", async () => {
  await login();
  await cloudSaved();
  const id = await call("id");
  backend.meStatus = 503;
  await refreshAccount();
  await page.getByText(/Account check unavailable/).waitFor();
  await edit("Edits during auth outage");
  await rename("Cached A");
  await page.reload();
  await ready();
  expect(await call("id")).toBe(id);
  await page.getByText("Edits during auth outage", { exact: true }).waitFor();
  const uploaded = backend.uploads.length;
  await context.setOffline(true);
  // The server session expires while this device cannot check it.
  backend.meStatus = 401;
  backend.user = undefined;
  expect(await call("id")).toBe(id);
  await edit("Pending while expired and offline");
  await rename("Cached A offline");
  await context.setOffline(false);
  await page.getByRole("button", { name: "Sign in again" }).waitFor();
  expect(backend.uploads.length).toBe(uploaded);
  expect(await call("sockets")).toEqual([]);
  await login();
  await cloudSaved();
  expect(await call("id")).toBe(id);
  expect(
    Object.values(
      materializeProject(backend.projects.get(id)?.doc as Y.Doc).nodes,
    ).map((node) => node.text),
  ).toContain("Pending while expired and offline");
});

test("A to B switching fences old catalogs, providers, relays and observers; logout/login restores only A", async () => {
  await login();
  await rename("Private A");
  await edit("Only account A");
  await cloudSaved();
  const idA = await call("id");
  backend.catalogStarted = false;
  backend.catalogGate = deferred();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  while (!backend.catalogStarted) await Bun.sleep(10);
  backend.user = B;
  await refreshAccount();
  await page.getByText(B.name, { exact: true }).waitFor();
  await ready();
  backend.catalogGate.resolve();
  backend.catalogGate = undefined;
  expect(await call("id")).not.toBe(idA);
  await page.waitForFunction(() =>
    window.accountHarness
      .channels()
      .every((name) => !name.includes("/account-1/")),
  );
  expect(
    (await call("sockets")).every((url) => !url.includes("ownerId=1")),
  ).toBe(true);
  expect(await call("editRetired", idA)).toBe(0);
  expect(
    await page.getByText("Late old account update", { exact: true }).count(),
  ).toBe(0);
  await page.getByRole("button", { name: "Load", exact: true }).click();
  expect(await page.getByRole("button", { name: /Private A ·/ }).count()).toBe(
    0,
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await ready();
  expect(
    (await call("catalog", "anonymous")).some((entry) => entry.id === idA),
  ).toBe(false);
  await login(A);
  await ready();
  expect(await call("id")).toBe(idA);
  await page.getByText("Only account A", { exact: true }).waitFor();
  expect(
    backend.uploads.every(
      (upload) => upload.expected === String(upload.ownerId),
    ),
  ).toBe(true);
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

test("failed local commits and failed auth coordination prevent navigation until recovery", async () => {
  const id = await call("id");
  await call("failWrites", true);
  await edit("Unsaved local content");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText(/Could not save your project before leaving/).waitFor();
  expect(backend.loginRequests).toBe(0);
  expect(await call("id")).toBe(id);
  await call("failWrites", false);
  await login();
  await cloudSaved();
  await call("failAuthWrites", true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByText(/Could not save your project before leaving/).waitFor();
  expect(backend.logoutRequests).toBe(0);
  expect(await page.getByText(A.name, { exact: true }).isVisible()).toBe(true);
  await call("failAuthWrites", false);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
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

test("an interrupted local claim copy stays hidden and resumes from the anonymous source", async () => {
  await edit("Content retained after copy failure");
  await rename("Local copy recovery");
  const id = await call("id");
  await login();
  await cloudSaved();
  await call("failProjectWrites", "account-1", id);
  await claim().click();
  await page.getByText(/Could not finish adding anonymous projects/).waitFor();
  expect(backend.projects.has(id)).toBe(false);
  expect(
    (await call("catalog", "account-1")).some((entry) => entry.id === id),
  ).toBe(false);
  const source = (await call("catalog", "anonymous", true)).find(
    (entry) => entry.id === id,
  );
  expect(source?.claim).toEqual({
    ownerId: A.id,
    targetId: id,
    phase: "pending",
  });
  await call("failWrites", false);
  await claim().click();
  await page
    .getByText("Content retained after copy failure", { exact: true })
    .waitFor();
  await cloudSaved();
  expect(await call("id")).toBe(id);
  expect(
    (await call("catalog", "account-1")).filter((entry) => entry.id === id),
  ).toHaveLength(1);
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
