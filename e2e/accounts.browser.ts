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
import {
  createChild,
  createProjectDocument,
  openProjectDocument,
} from "../webapp/src/project-document";
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
  // Holds uploads, as a slow connection would.
  mergeGate?: ReturnType<typeof deferred>;
  mergeStarted = false;
  catalogGate?: ReturnType<typeof deferred>;
  catalogStarted = false;
  // Holds a new browser's first open, which asks for the recent projects.
  recentGate?: ReturnType<typeof deferred>;
  // Fails this many "recent projects" requests with a transient 503.
  recentFailures = 0;
  meStarted = false;
  // Holds registrations, which keeps a migration at its pending marker.
  registerGate?: ReturnType<typeof deferred>;
  lostRegistration = false;
  leaveCookieOnLogout = false;
  loginRequests = 0;
  logoutRequests = 0;
  // What every share link answers: a project, or a failure status.
  shared: { projectId: string; data: string } | number = 404;
  projects = new Map<
    string,
    { ownerId: number; doc: ProjectDocument; updatedAt?: string }
  >();
  // Commit times are strictly increasing, like the server's updated_at.
  clock = Date.parse("2026-01-01T00:00:00Z");
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
    expect(url.pathname).toEndWith(".php");
    const owner = this.user;
    const error = (status: number, code: string) =>
      route.fulfill({ status, json: { error: { code, message: code } } });
    if (url.pathname === "/api/startLogin.php") {
      this.loginRequests++;
      this.user = this.nextUser;
      this.meStatus = undefined;
      return route.fulfill({
        status: 303,
        headers: { Location: harnessPath },
      });
    }
    if (url.pathname === "/api/logout.php") {
      this.logoutRequests++;
      if (!this.leaveCookieOnLogout) this.user = undefined;
      return route.fulfill({
        status: 303,
        headers: { Location: harnessPath },
      });
    }
    if (url.pathname === "/api/getSharedProject.php") {
      const shared = this.shared;
      return typeof shared === "number"
        ? error(shared, "unavailable")
        : route.fulfill({
            json: {
              ...shared,
              name: null,
              revision: "1",
              encoding: "loro-snapshot",
            },
          });
    }
    if (url.pathname === "/api/getMe.php") {
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
    const expected = request.headers()["x-mindgrab-account.php"];
    if (!owner || this.meStatus === 401) return error(401, "unauthenticated");
    if (this.meStatus === 503) return error(503, "unavailable");
    if (expected !== String(owner.id)) return error(409, "account_changed");
    if (url.pathname === "/api/createProject.php") {
      const { projectId } = request.postDataJSON();
      let record = this.projects.get(projectId);
      if (record && record.ownerId !== owner.id)
        return error(409, "project_id_conflict");
      if (!record) {
        record = { ownerId: owner.id, doc: openProjectDocument(projectId) };
        this.projects.set(projectId, record);
      }
      this.registrations.push(projectId);
      await this.registerGate?.promise;
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
    if (url.pathname === "/api/listProjects.php") {
      const { recent = false, limit = 100 } = request.postDataJSON();
      if (recent && this.recentFailures > 0) {
        this.recentFailures--;
        return error(503, "unavailable");
      }
      // Like the server: by UUID, or a single page with the latest change first.
      const projects = [...this.projects]
        .filter(([, entry]) => entry.ownerId === owner.id && entry.doc.ready)
        .sort(
          ([a, x], [b, y]) =>
            (recent && (y.updatedAt ?? "").localeCompare(x.updatedAt ?? "")) ||
            a.localeCompare(b),
        )
        .slice(0, limit)
        .map(([projectId, entry]) => ({
          projectId,
          format: "mindgrab-loro-v1",
          schemaVersion: 1,
          name: null,
          ...(entry.updatedAt && { updatedAt: entry.updatedAt }),
        }));
      // This gate holds background discovery, not a new browser's first open.
      if (recent) await this.recentGate?.promise;
      else {
        this.catalogStarted = true;
        await this.catalogGate?.promise;
      }
      return route.fulfill({ json: { projects, nextCursor: null } });
    }
    if (url.pathname === "/api/deleteProject.php") {
      const { projectId } = request.postDataJSON();
      if (this.projects.get(projectId)?.ownerId === owner.id)
        this.projects.delete(projectId);
      return route.fulfill({ json: { deleted: true } });
    }
    const operation = url.pathname;
    const { projectId: id } =
      operation === "/api/mergeProject.php"
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
    if (operation === "/api/getProjectSnapshot.php")
      return route.fulfill({ json: response() });
    if (operation === "/api/mergeProject.php") {
      this.mergeStarted = true;
      await this.mergeGate?.promise;
      const bytes = new Uint8Array(request.postDataBuffer() as Buffer);
      const before = record.doc.version();
      record.doc.merge(bytes);
      if (record.doc.version() !== before)
        record.updatedAt = new Date(this.clock++).toISOString();
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
// A fresh browser context has no local projects, account hints or cookies.
async function openFreshBrowser() {
  context = await browser.newContext();
  // Shorter than a test's own timeout, which would take the browser with it.
  context.setDefaultTimeout(15_000);
  context.on("page", (page) =>
    page.on("pageerror", (error) => errors.push(error)),
  );
  await context.route("**/api/**", (route) => backend.route(route));
  page = await context.newPage();
  await page.goto(appUrl);
  await ready(page);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
}
beforeEach(async () => {
  backend = new Backend();
  errors = [];
  await openFreshBrowser();
});
afterEach(async () => {
  backend.meGate?.resolve();
  backend.catalogGate?.resolve();
  backend.recentGate?.resolve();
  backend.registerGate?.resolve();
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
async function signOut(target = page) {
  await target
    .locator('[aria-label="Account"] button[aria-haspopup="menu"]')
    .click();
  await target.getByRole("menuitem", { name: "Sign out", exact: true }).click();
}
async function projectMenu(item: string) {
  await page.getByRole("button", { name: "Project menu" }).click();
  // Menu item names include their shortcut hints, such as "Save now ⌘S".
  await page.getByRole("menuitem", { name: item }).first().click();
}
async function rename(name: string) {
  await page.getByRole("textbox", { name: "Project name" }).fill(name);
  await page.getByRole("textbox", { name: "Project name" }).press("Enter");
  await projectMenu("Save now");
  await page
    .locator(".notice")
    .getByText("Saved locally", { exact: true })
    .waitFor();
}
async function edit(text: string) {
  await page.locator("[data-node-id]").first().dblclick();
  await page.getByRole("textbox", { name: "Node text" }).fill(text);
  await page.getByRole("textbox", { name: "Node text" }).press("Escape");
}
async function refreshAccount() {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}
async function cloudSaved(target = page) {
  await target.getByText(/^Saved to cloud/).waitFor();
}
// Adds a child to the first idea from the keyboard, as a user types on.
async function addChild(text: string, target = page) {
  await target.locator("[data-node-id]").first().click();
  await target.keyboard.press("Tab");
  await target.getByRole("textbox", { name: "Node text" }).waitFor();
  await target.keyboard.type(text);
  await target.keyboard.press("Enter");
  await target.getByText(text, { exact: true }).waitFor();
}
// The migration never asks or tells: no banner, no alert, no notice.
async function expectSilence(target = page) {
  const messages = await target.evaluate(() =>
    window.accountHarness.messages(),
  );
  expect(messages.filter((text) => !text.startsWith("Saved locally"))).toEqual(
    [],
  );
}
const claimPhase = (id: string, target = page) =>
  target.evaluate(
    async (id) =>
      (await window.accountHarness.catalog("anonymous", true)).find(
        (entry) => entry.id === id,
      )?.claim?.phase,
    id,
  );
// Playwright's waitForFunction takes an async predicate's promise for a truthy
// answer and returns at once, so anything read from IndexedDB polls here.
async function eventually(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(20);
  }
}
async function claimed(id: string, target = page) {
  await eventually(
    async () => (await claimPhase(id, target)) === "complete",
    `claim of ${id} to complete`,
  );
}
async function accountCatalogSize(size: number) {
  await eventually(
    async () => (await call("catalog", "account-1")).length === size,
    `account catalog of ${size}`,
  );
}
async function untilRegistrationRequested(count = 1, id?: string) {
  const deadline = Date.now() + 10_000;
  const requested = () =>
    backend.registrations.filter((entry) => id === undefined || entry === id)
      .length;
  while (requested() < count) {
    if (Date.now() > deadline) throw new Error("No registration request");
    await Bun.sleep(10);
  }
}

test("lost registration and repeated/concurrent claims reuse one target and retain Loro history", async () => {
  await rename("Interrupted anonymous claim");
  const id = await call("id");
  backend.registerGate = deferred();
  backend.lostRegistration = true;
  await login();
  // The map stays on screen and the copy begins behind it, without a word.
  expect(await call("id")).toBe(id);
  await eventually(
    async () => (await claimPhase(id)) === "pending",
    "claim to begin",
  );
  await untilRegistrationRequested();
  expect(
    (await call("catalog", "anonymous", true)).find((entry) => entry.id === id)
      ?.claim,
  ).toEqual({ ownerId: A.id, targetId: id, phase: "pending" });
  expect(
    (await call("catalog", "account-1")).some((entry) => entry.id === id),
  ).toBe(false);
  await expectSilence();
  await edit("Edited while the claim waits");
  expect(await call("id")).toBe(id);
  // The lost response fails this registration; the query retries after a
  // second, and the retry is held so the failed state can be observed.
  const first = backend.registerGate;
  backend.registerGate = deferred();
  first.resolve();
  await untilRegistrationRequested(2, id);
  // After the failure: same map, still pending, still silent, still editable.
  expect(await call("id")).toBe(id);
  expect(await claimPhase(id)).toBe("pending");
  await expectSilence();
  await addChild("Edited after the failure");
  expect(await call("id")).toBe(id);
  // A second tab opens the pending map too and waits for the claim lock the
  // first tab holds, so both contend for one target.
  const concurrent = await context.newPage();
  await concurrent.goto(appUrl);
  await ready(concurrent);
  expect(await concurrent.evaluate(() => window.accountHarness.id())).toBe(id);
  expect(await claimPhase(id, concurrent)).toBe("pending");
  await expectSilence(concurrent);
  expect(
    (await call("catalog", "account-1")).some((entry) => entry.id === id),
  ).toBe(false);
  backend.registerGate.resolve();
  backend.registerGate = undefined;
  await cloudSaved();
  await cloudSaved(concurrent);
  await claimed(id);
  // A reload lands on the finished account copy, with every edit.
  await page.reload();
  await ready();
  await page
    .getByText("Edited while the claim waits", { exact: true })
    .waitFor();
  await page.getByText("Edited after the failure", { exact: true }).waitFor();
  await page.waitForFunction((id) => window.accountHarness.id() === id, id);
  await cloudSaved();
  await cloudSaved(concurrent);
  await expectSilence();
  await expectSilence(concurrent);
  expect(
    (await call("catalog", "account-1")).filter((entry) => entry.id === id),
  ).toHaveLength(1);
  expect(await claimPhase(id)).toBe("complete");
  expect(backend.registrations.filter((entry) => entry === id).length).toBe(2);
  const pending = await call("historyClaim", A.id);
  expect(pending.equal).toBe(true);
  expect(pending.after).toEqual(pending.before);
});

test("signing in keeps the open map editable and keeps the edit made during migration", async () => {
  await edit("Before sign-in");
  const id = await call("id");
  backend.registerGate = deferred();
  await login();
  await page.getByText("Before sign-in", { exact: true }).waitFor();
  expect(await call("id")).toBe(id);
  await untilRegistrationRequested();
  expect(await claimPhase(id)).toBe("pending");
  await addChild("Typed during migration");
  expect(await call("id")).toBe(id);
  await page.keyboard.press("Alt+o");
  const outline = page.getByRole("complementary", { name: "Outline" });
  await outline.waitFor();
  expect(await outline.getByRole("treeitem").count()).toBe(2);
  await outline.locator(".outline-row").first().click();
  await page
    .locator("[data-node-id][data-selected=true]")
    .filter({ hasText: "Before sign-in" })
    .waitFor();
  await page.getByRole("button", { name: "Close outline" }).click();
  await outline.waitFor({ state: "detached" });
  await page.locator("[data-node-id]").first().click({ button: "right" });
  await page.getByRole("menu").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "detached" });
  await expectSilence();
  backend.registerGate.resolve();
  backend.registerGate = undefined;
  await cloudSaved();
  await claimed(id);
  expect(await call("id")).toBe(id);
  await page.reload();
  await ready();
  await page.getByText("Before sign-in", { exact: true }).waitFor();
  await page.getByText("Typed during migration", { exact: true }).waitFor();
  expect(await call("id")).toBe(id);
  expect(await call("catalog", "account-1")).toHaveLength(1);
  await expectSilence();
});

test("a second tab signed in through the first tab's login swaps too and keeps its edits", async () => {
  await edit("Shared before sign-in");
  const id = await call("id");
  const other = await context.newPage();
  await other.goto(appUrl);
  await ready(other);
  expect(await other.evaluate(() => window.accountHarness.id())).toBe(id);
  backend.registerGate = deferred();
  await login();
  await other.getByText(A.name, { exact: true }).waitFor();
  await untilRegistrationRequested();
  // The other tab keeps its map open and editable while the copy is made.
  expect(await other.evaluate(() => window.accountHarness.id())).toBe(id);
  await addChild("Second tab edit", other);
  await expectSilence(other);
  backend.registerGate.resolve();
  backend.registerGate = undefined;
  await cloudSaved();
  await cloudSaved(other);
  await claimed(id);
  expect(await call("id")).toBe(id);
  expect(await other.evaluate(() => window.accountHarness.id())).toBe(id);
  await other.getByText("Second tab edit", { exact: true }).waitFor();
  await page.getByText("Second tab edit", { exact: true }).waitFor();
  const texts = () =>
    backend.projects
      .get(id)
      ?.doc.view()
      .nodes.map((node) => node.text) ?? [];
  const deadline = Date.now() + 10_000;
  while (
    !texts().includes("Shared before sign-in") ||
    !texts().includes("Second tab edit")
  ) {
    if (Date.now() > deadline) throw new Error("Edits never reached the cloud");
    await Bun.sleep(10);
  }
  expect(
    (await call("catalog", "account-1")).filter((entry) => entry.id === id),
  ).toHaveLength(1);
});

test("editing the placeholder before storage opens keeps the edit", async () => {
  const stored = await call("id");
  await call("openGate", true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="false"]');
  await page.waitForSelector("[data-node-id]");
  const draft = await call("id");
  expect(draft).not.toBe(stored);
  await edit("Typed before storage opened");
  const name = page.getByRole("textbox", { name: "Project name" });
  await name.fill("Named before storage opened");
  await name.press("Enter");
  await call("openGate", false);
  await ready();
  expect(await call("id")).toBe(draft);
  await page
    .getByText("Typed before storage opened", { exact: true })
    .waitFor();
  expect(await name.inputValue()).toBe("Named before storage opened");
  expect(
    (await call("catalog", "anonymous")).filter((entry) => entry.id === draft),
  ).toHaveLength(1);
  await page.reload();
  await ready();
  expect(await call("id")).toBe(draft);
  await page
    .getByText("Typed before storage opened", { exact: true })
    .waitFor();
  expect(await name.inputValue()).toBe("Named before storage opened");
});

test("typing on while storage opens under the placeholder loses nothing", async () => {
  const stored = await call("id");
  await call("openGate", true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="false"]');
  await page.waitForSelector("[data-node-id]");
  const draft = await call("id");
  expect(draft).not.toBe(stored);
  await page.locator("[data-node-id]").first().dblclick();
  await page.getByRole("textbox", { name: "Node text" }).waitFor();
  await page.keyboard.type("Typed before ");
  // The stored map opens, the edited placeholder is adopted under the open
  // editor, and typing simply goes on.
  await call("openGate", false);
  await ready();
  expect(await call("id")).toBe(draft);
  await page.keyboard.type("and after storage opened");
  await page.keyboard.press("Enter");
  await page
    .getByText("Typed before and after storage opened", { exact: true })
    .waitFor();
  expect(await call("id")).toBe(draft);
  expect(
    (await call("catalog", "anonymous")).filter((entry) => entry.id === draft),
  ).toHaveLength(1);
  await page.reload();
  await ready();
  expect(await call("id")).toBe(draft);
  await page
    .getByText("Typed before and after storage opened", { exact: true })
    .waitFor();
});

test("editing the placeholder while storage fails keeps the edit through Retry local saving", async () => {
  const stored = await call("id");
  await call("failOpen", true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="false"]');
  await page.waitForSelector("[data-node-id]");
  const retry = page.getByRole("button", { name: "Retry local saving" });
  await retry.waitFor();
  const draft = await call("id");
  expect(draft).not.toBe(stored);
  await edit("Typed while storage failed");
  const name = page.getByRole("textbox", { name: "Project name" });
  await name.fill("Named while storage failed");
  await name.press("Enter");
  await call("failOpen", false);
  await retry.click();
  await ready();
  await retry.waitFor({ state: "detached" });
  expect(await call("id")).toBe(draft);
  await page.getByText("Typed while storage failed", { exact: true }).waitFor();
  expect(await name.inputValue()).toBe("Named while storage failed");
  expect(
    (await call("catalog", "anonymous")).filter((entry) => entry.id === draft),
  ).toHaveLength(1);
  await page.reload();
  await ready();
  expect(await call("id")).toBe(draft);
  await page.getByText("Typed while storage failed", { exact: true }).waitFor();
  expect(await name.inputValue()).toBe("Named while storage failed");
});

// Two cloud maps under account A, "Podcast plan" changed last; the browser
// forgets everything local and signs out before each case.
async function cloudAccountWithTwoMaps() {
  const renameInCloud = async (name: string) => {
    await rename(name);
    const id = await call("id");
    const record = () => backend.projects.get(id)?.doc;
    const deadline = Date.now() + 10_000;
    while (!record()?.ready || record()?.view().name !== name) {
      if (Date.now() > deadline)
        throw new Error(`"${name}" (${id}) never reached the cloud`);
      await Bun.sleep(10);
    }
    return id;
  };
  // An account without maps gets exactly one first map.
  await login();
  const older = await renameInCloud("Older plan");
  expect(accountMaps()).toHaveLength(1);
  await projectMenu("New map");
  await page.waitForFunction((id) => window.accountHarness.id() !== id, older);
  const latest = await renameInCloud("Podcast plan");
  expect(accountMaps()).toHaveLength(2);
  return latest;
}
const accountMaps = () =>
  [...backend.projects.values()].filter((entry) => entry.ownerId === A.id);
async function freshBrowser() {
  await context.close();
  backend.user = undefined;
  await openFreshBrowser();
}

test("signing in from a fresh browser opens the latest cloud map instead of adding an empty one", async () => {
  const latest = await cloudAccountWithTwoMaps();
  const registrations = backend.registrations.length;
  // A transient catalog failure is retried rather than seeding a map.
  for (const failures of [0, 1]) {
    await freshBrowser();
    backend.recentFailures = failures;
    const seed = await call("id");
    await login();
    // The most recently changed map opens, not an empty new one.
    await page.waitForFunction(
      (id) => window.accountHarness.id() === id,
      latest,
    );
    expect(backend.recentFailures).toBe(0);
    expect(await page.getByLabel("Project name").inputValue()).toBe(
      "Podcast plan",
    );
    await cloudSaved();
    // Background discovery brings the older map to this browser as well.
    await accountCatalogSize(2);
    expect(accountMaps()).toHaveLength(2);
    expect(backend.registrations).toHaveLength(registrations);
    expect(
      (await call("catalog", "account-1")).some((entry) => entry.id === seed),
    ).toBe(false);
    await expectSilence();
  }
});

test("signing in from a fresh browser with a draft keeps the draft and adds the cloud maps behind it", async () => {
  await cloudAccountWithTwoMaps();
  const registrations = backend.registrations.length;
  await freshBrowser();
  await edit("First browser draft");
  const draft = await call("id");
  backend.registerGate = deferred();
  await login();
  // The draft stays on screen, and the swap to its copy resets nothing.
  expect(await call("id")).toBe(draft);
  await page.getByText("First browser draft", { exact: true }).waitFor();
  await page.locator("[data-node-id]").first().click();
  expect(await page.locator("[data-selected=true]").count()).toBe(1);
  await untilRegistrationRequested();
  backend.registerGate.resolve();
  backend.registerGate = undefined;
  await cloudSaved();
  await claimed(draft);
  expect(await call("id")).toBe(draft);
  await page.getByText("First browser draft", { exact: true }).waitFor();
  expect(await page.locator("[data-selected=true]").count()).toBe(1);
  expect(backend.registrations).toHaveLength(registrations + 1);
  expect(backend.projects.get(draft)?.ownerId).toBe(A.id);
  await accountCatalogSize(3);
  expect(accountMaps()).toHaveLength(3);
  await expectSilence();
});

test("an edit while the cloud lookup is held keeps the map and the cloud maps join the list", async () => {
  await cloudAccountWithTwoMaps();
  await freshBrowser();
  backend.recentGate = deferred();
  const draft = await call("id");
  await login();
  await edit("Typed during lookup");
  expect(await call("id")).toBe(draft);
  expect(await page.locator("[data-selected=true]").count()).toBe(1);
  backend.recentGate.resolve();
  backend.recentGate = undefined;
  await accountCatalogSize(3);
  await cloudSaved();
  await claimed(draft);
  expect(await call("id")).toBe(draft);
  await page.getByText("Typed during lookup", { exact: true }).waitFor();
  expect(await page.locator("[data-selected=true]").count()).toBe(1);
  expect(await page.getByLabel("Project name").inputValue()).not.toBe(
    "Podcast plan",
  );
  expect(accountMaps()).toHaveLength(3);
  await expectSilence();
});

test("a UUID owned elsewhere is copied to a new UUID without merging unrelated content", async () => {
  await edit("Mine before sign-in");
  await rename("My anonymous work");
  const id = await call("id");
  backend.projects.set(id, { ownerId: B.id, doc: openProjectDocument(id) });
  await login();
  await page.waitForFunction((id) => window.accountHarness.id() !== id, id);
  const replacement = await call("id");
  await page.getByText("Mine before sign-in", { exact: true }).waitFor();
  await cloudSaved();
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
  expect(marker?.phase).toBe("complete");
  await expectSilence();
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
  await signOut(other);
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
  await signOut(other);
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
  await page.getByRole("button", { name: "Save error details" }).click();
  await page
    .getByRole("button", { name: "Retry local saving", exact: true })
    .click();
  await page
    .getByText(/Edits from the previous account could not be saved/)
    .first()
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
  await signOut();
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

test("the account menu holds the name and sign out, and closes like a menu", async () => {
  await login();
  const avatar = page.locator(
    '[aria-label="Account"] button[aria-haspopup="menu"]',
  );
  const menu = page.getByRole("menu", { name: "Account menu" });
  expect(await menu.count()).toBe(0);
  expect(await page.getByRole("menuitem", { name: "Sign out" }).count()).toBe(
    0,
  );

  await avatar.click();
  await menu.getByText(A.email, { exact: true }).waitFor();
  // Opaque: it opens over the search results.
  expect(
    await menu.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(255, 255, 255)");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
    "BUTTON",
  );

  await avatar.click();
  await menu.waitFor();
  await page.mouse.click(640, 500);
  await menu.waitFor({ state: "detached" });

  // The open menu owns the keyboard: map shortcuts do not act behind it.
  await page.keyboard.press("Escape");
  expect(await page.locator("[data-selected=true]").count()).toBe(0);
  await avatar.click();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("role") === "menuitem",
  );
  await page.keyboard.press("/");
  await page.keyboard.press("?");
  expect(await menu.isVisible()).toBe(true);
  expect(await page.getByRole("searchbox").count()).toBe(0);
  expect(await page.locator("dialog[open]").count()).toBe(0);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });

  // The menu opens over the search island, and a press on its text keeps it.
  await page.keyboard.press("ControlOrMeta+f");
  const search = page.getByRole("searchbox", { name: "Search ideas" });
  await search.fill("no idea says this");
  await avatar.click();
  await menu.getByText(A.email, { exact: true }).click();
  expect(await menu.isVisible()).toBe(true);
  // Esc on the avatar closes the menu and nothing behind it.
  await avatar.focus();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  expect(await avatar.evaluate((el) => el === document.activeElement)).toBe(
    true,
  );
  expect(await search.count()).toBe(1);
  // Tabbing on from the last item closes it, like a native menu.
  await avatar.click();
  await page.getByRole("menuitem", { name: "Sign out" }).waitFor();
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "detached" });
});

test("the red save dot opens the failure and clears itself once saving recovers", async () => {
  await call("failWrites", true);
  await edit("A failed local edit");
  const dot = page.getByRole("button", { name: "Save error details" });
  await dot.waitFor();
  const details = page.getByRole("dialog", { name: "Couldn’t save" });
  expect(await details.isVisible()).toBe(false);

  await dot.click();
  await details.waitFor();
  await page.keyboard.press("Escape");
  await details.waitFor({ state: "hidden" });
  await dot.click();
  await details.waitFor();
  await page.mouse.click(20, 400);
  await details.waitFor({ state: "hidden" });

  await dot.click();
  await details.waitFor();
  await call("failWrites", false);
  await dot.waitFor({ state: "detached" });
  await details.waitFor({ state: "hidden" });
  expect(await page.locator(".save-state").getAttribute("data-tone")).toBe(
    "local",
  );
});

test("on a phone the menu button shows a save failure and leads to its details", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator(".phone-menu-button");
  await menu.waitFor();
  expect(await menu.getAttribute("data-problem")).toBeNull();
  await call("failWrites", true);
  await edit("A failed local edit");
  await page.locator(".phone-menu-button[data-problem]").waitFor();

  await menu.click();
  await page
    .getByRole("dialog", { name: "Project menu" })
    .getByRole("button", { name: /Couldn’t save/ })
    .click();
  const details = page.getByRole("dialog", { name: "Couldn’t save" });
  await details.waitFor();
  await call("failWrites", false);
  await details.waitFor({ state: "hidden" });
  await page.locator(".phone-menu-button:not([data-problem])").waitFor();
});

test("a failed sign-in on a phone opens the menu to say so", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${appUrl}?auth_error=unavailable`);
  await page
    .getByRole("dialog", { name: "Project menu" })
    .getByText("Sign-in is temporarily unavailable. Please try again.")
    .waitFor();
});

test("an aborted durable account hint prevents logout acknowledgement and can be retried", async () => {
  await login();
  await cloudSaved();
  const id = await call("id");
  await call("failAuthDatabase", true);
  await signOut();
  await page.getByText(/Could not save your map before leaving/).waitFor();
  expect(backend.logoutRequests).toBe(0);
  expect(await call("id")).toBe(id);
  await page.getByText(A.name, { exact: true }).waitFor();
  await call("failAuthDatabase", false);
  await signOut();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  expect(backend.logoutRequests).toBe(1);
});

test("signed-in users can disable both destinations, edit privately, and keep New projects private", async () => {
  await login();
  await cloudSaved();
  const id = await call("id");
  expect(backend.projects.has(id)).toBe(true);
  await projectMenu("Project preferences…");
  const dialog = page.getByRole("dialog", { name: "Project preferences" });
  await dialog.getByRole("switch", { name: "Save in Mindgrab Cloud" }).click();
  await page
    .getByText("Saved locally · cloud saving off", { exact: true })
    .waitFor();
  expect(backend.projects.has(id)).toBe(false);
  await dialog
    .getByRole("switch", { name: "Save locally", exact: true })
    .click();
  await dialog.getByText("This map lives only in memory.").waitFor();
  await eventually(
    () =>
      page.evaluate(
        async (id) =>
          !(await indexedDB.databases()).some(
            (db) =>
              db.name?.includes("account-1") &&
              db.name.endsWith(`/project/${id}`),
          ),
        id,
      ),
    "the local database to go",
  );
  await dialog
    .getByRole("button", { name: "Close project preferences" })
    .click();
  const uploads = backend.uploads.length;
  const registrations = backend.registrations.length;
  await edit("Secret work stays here");
  await refreshAccount();
  await projectMenu("Save now");
  const localOff = page.getByText(
    "Local saving is off. Export a backup to keep your work.",
  );
  await localOff.waitFor();
  // A message that has been read can be put away; the standing warning stays.
  await page.getByRole("button", { name: "Dismiss" }).click();
  await localOff.waitFor({ state: "detached" });
  await page
    .getByText("In memory only · Export before closing this tab.")
    .waitFor();
  expect(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
  ).toBe("Mind map canvas");
  expect(backend.uploads).toHaveLength(uploads);
  expect(backend.registrations).toHaveLength(registrations);
  expect(backend.projects.has(id)).toBe(false);
  await projectMenu("New map");
  await page.waitForFunction((id) => window.accountHarness.id() !== id, id);
  expect(backend.registrations).toHaveLength(registrations);
  await page
    .getByText("In memory only · Export before closing this tab.")
    .waitFor();
});

test("Project preferences switch sections and reopen at Saving", async () => {
  await projectMenu("Project preferences…");
  const preferences = page.getByRole("dialog", { name: "Project preferences" });
  const sections = preferences.getByRole("navigation", {
    name: "Preference sections",
  });
  const local = preferences.getByRole("switch", {
    name: "Save locally",
    exact: true,
  });
  await local.waitFor();
  await sections.getByRole("button", { name: "Backup" }).click();
  await preferences.getByRole("button", { name: "Export backup" }).waitFor();
  expect(await local.count()).toBe(0);
  expect(
    await sections
      .getByRole("button", { name: "Backup" })
      .getAttribute("aria-current"),
  ).toBe("true");
  await preferences
    .getByRole("button", { name: "Close project preferences" })
    .click();
  await projectMenu("Project preferences…");
  await local.waitFor();
});

test("signed-out Share and Project preferences start the normal sign-in", async () => {
  await projectMenu("Share link…");
  const share = page.getByRole("dialog", { name: "Share" });
  await share.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText(A.name, { exact: true }).waitFor();
  await ready();
  expect(backend.loginRequests).toBe(1);
  expect(await share.isVisible()).toBe(false);

  await signOut();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await ready();
  await projectMenu("Project preferences…");
  const preferences = page.getByRole("dialog", { name: "Project preferences" });
  // Cloud saving is locked until sign-in, with Sign in in place of its switch.
  await preferences.getByText("Save locally", { exact: true }).waitFor();
  expect(
    await preferences
      .getByRole("switch", { name: "Save in Mindgrab Cloud" })
      .count(),
  ).toBe(0);
  await preferences
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await page.getByText(A.name, { exact: true }).waitFor();
  expect(backend.loginRequests).toBe(2);
});

test("Share returns from Project preferences once cloud saving is on", async () => {
  await login();
  await cloudSaved();
  await projectMenu("Project preferences…");
  const preferences = page.getByRole("dialog", { name: "Project preferences" });
  const cloud = preferences.getByRole("switch", {
    name: "Save in Mindgrab Cloud",
  });
  const close = preferences.getByRole("button", {
    name: "Close project preferences",
  });
  await cloud.click();
  await page
    .getByText("Saved locally · cloud saving off", { exact: true })
    .waitFor();
  await close.click();

  await projectMenu("Share link…");
  const share = page.getByRole("dialog", { name: "Share" });
  // Closing the preferences without turning cloud saving on ends the errand.
  await share.getByRole("button", { name: "Open project preferences" }).click();
  await close.click();
  await preferences.waitFor({ state: "hidden" });
  expect(await share.isVisible()).toBe(false);

  await projectMenu("Share link…");
  await share.getByRole("button", { name: "Open project preferences" }).click();
  await share.waitFor({ state: "hidden" });
  await cloud.click();
  await cloudSaved();
  await close.click();
  await share.waitFor();
  expect(await preferences.isVisible()).toBe(false);
  await share.getByRole("button", { name: "Close sharing" }).click();

  // Opened from the menu, the preferences close back to the map.
  await projectMenu("Project preferences…");
  await close.click();
  await preferences.waitFor({ state: "hidden" });
  expect(await share.isVisible()).toBe(false);
});

test("cloud-only projects load after reload without leaving a local copy", async () => {
  await login();
  await rename("Cloud only project");
  await cloudSaved();
  const id = await call("id");
  await projectMenu("Project preferences…");
  await page.getByRole("switch", { name: "Save locally", exact: true }).click();
  await page.getByRole("button", { name: "Close project preferences" }).click();
  await cloudSaved();
  await page.reload();
  await ready();
  await projectMenu("Open map…");
  await page
    .getByRole("menuitem", { name: `Cloud only project · ${id.slice(0, 8)}` })
    .click();
  await page
    .getByText("Saved to cloud · local saving off", { exact: true })
    .waitFor();
  expect(await call("id")).toBe(id);
  // The migrated anonymous source keeps its database under the same UUID;
  // the account's own copy is the one that must be gone.
  expect(
    await page.evaluate(
      async (id) =>
        (await indexedDB.databases()).some(
          (db) =>
            db.name?.includes("/account-1/") &&
            db.name.endsWith(`/project/${id}`),
        ),
      id,
    ),
  ).toBe(false);
});

test("anonymous projects with cloud saving off migrate locally without ever being uploaded", async () => {
  const id = await call("id");
  await call("setSaving", { local: true, cloud: false });
  await eventually(
    async () =>
      (await call("catalog", "anonymous")).find((entry) => entry.id === id)
        ?.saving?.cloud === false,
    "the anonymous catalog to record cloud saving off",
  );
  await login();
  await claimed(id);
  expect(await call("id")).toBe(id);
  expect(backend.projects.has(id)).toBe(false);
  expect(backend.registrations).toHaveLength(0);
  expect(
    (await call("catalog", "account-1")).find((entry) => entry.id === id)
      ?.saving?.cloud,
  ).toBe(false);
  await page
    .getByText("Saved locally · cloud saving off", { exact: true })
    .waitFor();
  await expectSilence();
});

test("the shared view has editor-sized islands, plain tooltips and a retry that keeps the keyboard", async () => {
  const doc = createProjectDocument(crypto.randomUUID(), "Shared", {
    text: "Root",
  });
  createChild(doc, doc.view().roots[0], { text: "Child", note: "A note" });
  backend.shared = { projectId: doc.id, data: base64(doc.snapshot()) };
  doc.destroy();
  // The live channel stays open and silent.
  await page.routeWebSocket(/\/sync\/share\//, () => {});
  await page.goto(new URL("/s/token", appUrl).href);
  await page.waitForSelector("[data-node-id]");
  const island = page.getByRole("region", { name: "Shared map" });
  const own = page.getByRole("link", { name: "Make your own map" });
  expect((await own.boundingBox())?.height).toBe(44);
  expect((await own.boundingBox())?.y).toBe((await island.boundingBox())?.y);
  expect((await island.boundingBox())?.height).toBe(44);

  // The shared view has no shortcuts, so its tooltips name none.
  for (const name of ["Zoom out", "Zoom to 100%", "Zoom in", "Fit map"])
    expect(await page.getByRole("button", { name }).getAttribute("title")).toBe(
      name,
    );
  expect(
    await page.getByRole("img", { name: "Has notes" }).getAttribute("title"),
  ).toBe("Has notes");
  expect(await page.locator("[aria-keyshortcuts]").count()).toBe(0);
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  expect(
    await page
      .getByRole("button", { name: "Close outline" })
      .getAttribute("title"),
  ).toBe("Close outline");
  await page.getByRole("treeitem", { name: "Root" }).focus();
  await page.keyboard.press("ArrowLeft");
  expect(
    await page
      .getByRole("button", { name: "Expand 1 idea" })
      .getAttribute("title"),
  ).toBe("Expand children");

  // A dead link is announced, as the loading text it replaces was.
  backend.shared = 404;
  await page.goto(new URL("/s/gone", appUrl).href);
  expect(await page.getByRole("alert").innerText()).toContain(
    "This link isn’t shared anymore",
  );

  // A page that only offers a retry shows it as the primary button.
  backend.shared = 503;
  await page.goto(new URL("/s/other", appUrl).href);
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await retry.waitFor();
  // The failure replaces the announced loading text, so it is announced too.
  expect(await page.getByRole("alert").innerText()).toBe(
    "Couldn’t open this map\n\nCheck your connection and try again.",
  );
  expect((await island.boundingBox())?.height).toBe(44);
  expect(
    await retry.evaluate((button) => getComputedStyle(button).backgroundColor),
  ).toBe("rgb(27, 31, 38)");
  // The button turns itself off while it retries, so focus moves to the map.
  await retry.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Shared mind map",
  );
});

test("in the shared view, an idea's notes open in the side panel, clear of the idea", async () => {
  const doc = createProjectDocument(crypto.randomUUID(), "Shared", {
    text: "Root",
  });
  createChild(doc, doc.view().roots[0], { text: "Child", note: "A note" });
  backend.shared = { projectId: doc.id, data: base64(doc.snapshot()) };
  doc.destroy();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.routeWebSocket(/\/sync\/share\//, () => {});
  await page.goto(new URL("/s/token", appUrl).href);
  const idea = page.locator("[data-node-id]").filter({ hasText: "Child" });
  await idea.click();
  // Selecting an idea with notes opens them, titled by the idea.
  const notes = page.getByRole("complementary", { name: "Notes" });
  await notes.waitFor();
  expect(await notes.getByRole("heading").innerText()).toBe("Child");
  expect(await notes.getByText("A note").count()).toBe(1);
  // The panel would cover the idea, so the map moves it aside once settled.
  await page.waitForFunction(() => {
    const moving = [".side-drawer", ".map-layer"].some(
      (selector) => document.querySelector(selector)?.getAnimations().length,
    );
    const idea = [...document.querySelectorAll("[data-node-id]")].find((node) =>
      node.textContent?.includes("Child"),
    );
    const panel = document.querySelector(".side-panel");
    return (
      !moving &&
      !!idea &&
      !!panel &&
      idea.getBoundingClientRect().right < panel.getBoundingClientRect().left
    );
  });
  // The outline is the same panel's other tab.
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await page.getByRole("complementary", { name: "Outline" }).waitFor();
  expect(
    await page
      .getByRole("tab", { name: "Outline" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  // Folding a branch from its row leaves the selection, and Show on map
  // unfolds the branch again to reach the idea.
  await page
    .getByRole("treeitem", { name: "Root" })
    .locator(".outline-toggle")
    .first()
    .click();
  await idea.waitFor({ state: "detached" });
  await page.getByRole("tab", { name: "Notes" }).click();
  await notes.getByRole("button", { name: "Show on map" }).click();
  await idea.waitFor();
  // While the panel slides out it keeps the tab it was on.
  expect(
    await page.evaluate(async () => {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close notes"]')
        ?.click();
      await Promise.resolve();
      const closing = document.querySelector(".side-drawer[data-closing]");
      return closing?.querySelector("aside")?.getAttribute("aria-label");
    }),
  ).toBe("Notes");
});

test("an unknown address shows a page with a way back", async () => {
  await page.goto(new URL("/no/such/page", appUrl).href);
  await page.getByRole("heading", { name: "Page not found" }).waitFor();
  await page.getByRole("link", { name: "Open Mindgrab" }).click();
  await page.waitForURL(new URL("/", appUrl).href);
  await ready();
});

test("checking the account again from the keyboard leaves focus on the map", async () => {
  await login();
  await cloudSaved();
  backend.meStatus = 503;
  await refreshAccount();
  const again = page.getByRole("button", { name: "Check account again" });
  await again.waitFor();
  expect(
    await again.evaluate((button) => getComputedStyle(button).borderTopWidth),
  ).toBe("1px");
  backend.meStatus = undefined;
  await again.focus();
  await page.keyboard.press("Enter");
  await again.waitFor({ state: "detached" });
  expect(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
  ).toBe("Mind map canvas");
});

test("retrying a failed storage change from the keyboard keeps focus in the dialog", async () => {
  await projectMenu("Project preferences…");
  const dialog = page.getByRole("dialog", { name: "Project preferences" });
  const local = dialog.getByRole("switch", {
    name: "Save locally",
    exact: true,
  });
  await local.click();
  await dialog.getByText("This map lives only in memory.").waitFor();
  await dialog
    .locator('[role="switch"][data-busy]')
    .first()
    .waitFor({ state: "detached" });
  await call("failWrites", true);
  await local.click();
  const retry = dialog.getByRole("button", { name: "Retry", exact: true });
  await retry.focus();
  // The button disables itself and goes away while the retry runs.
  await page.keyboard.press("Enter");
  expect(await local.evaluate((el) => el === document.activeElement)).toBe(
    true,
  );
  await dialog.getByRole("alert").waitFor();
  expect(await local.evaluate((el) => el === document.activeElement)).toBe(
    true,
  );
});

async function accountlessCatalog(size: number) {
  await eventually(
    async () => (await call("catalog", "anonymous")).length === size,
    `anonymous catalog of ${size}`,
  );
}
async function newMap() {
  const previous = await call("id");
  await projectMenu("New map");
  await eventually(async () => (await call("id")) !== previous, "a new map");
}

// Holds registration so a second map is still being copied once it is opened
// from Load. Its copy then completes while the user is typing in the original.
async function typingAcrossCompletion() {
  await rename("Waiting map");
  const waiting = await call("id");
  await newMap();
  await rename("Open map");
  backend.registerGate = deferred();
  await login();
  await untilRegistrationRequested();
  await projectMenu("Open map…");
  await page.getByRole("menuitem", { name: /Waiting map/ }).click();
  await eventually(async () => (await call("id")) === waiting, "Load to open");
  await page.locator("[data-node-id]").first().dblclick();
  await page.getByRole("textbox", { name: "Node text" }).waitFor();
  await page.keyboard.type("Early");
  backend.registerGate.resolve();
  backend.registerGate = undefined;
  await claimed(waiting);
  await page.keyboard.type(" LATE");
  return waiting;
}

test("text typed after the copy completed reaches the account copy", async () => {
  const waiting = await typingAcrossCompletion();
  await page.keyboard.press("Enter");
  await eventually(
    async () =>
      (await call("texts", "account-1", waiting)).includes("Early LATE"),
    "late text to reach the copy",
  );
  await page.reload();
  await ready();
  expect(await call("texts", "account-1", waiting)).toContain("Early LATE");
});

test("text typed right before a reload reaches the account copy after it", async () => {
  const waiting = await typingAcrossCompletion();
  await eventually(
    async () =>
      (await call("texts", "anonymous", waiting)).includes("Early LATE"),
    "the keystrokes to be stored",
  );
  await page.reload();
  await ready();
  await eventually(
    async () =>
      (await call("texts", "account-1", waiting)).includes("Early LATE"),
    "late text to reach the copy after the reload",
  );
  const [entry] = (await call("catalog", "anonymous", true)).filter(
    (entry) => entry.id === waiting,
  );
  expect(entry?.claim?.stale).toBeUndefined();
});

test("an edit stored by a tab killed before it could flag it reaches the account copy", async () => {
  await rename("Killed tab");
  const id = await call("id");
  await login();
  await claimed(id);
  await eventually(
    async () => (await call("catalog", "account-1")).length > 0,
    "the copy to arrive",
  );
  await newMap();
  await call("killedAfterEdit", id, A.id, "Stored before the kill");
  await page.reload();
  await ready();
  await eventually(
    async () =>
      (await call("texts", "account-1", id)).includes("Stored before the kill"),
    "the stored edit to reach the copy",
  );
});

test("a second tab's edits after the copy completed reach the account copy", async () => {
  await rename("Two tabs");
  const id = await call("id");
  const other = await context.newPage();
  await other.goto(appUrl);
  await ready(other);
  expect(await call("id")).toBe(id);
  await login();
  await claimed(id);
  await eventually(
    async () =>
      (await call("catalog", "account-1")).some((entry) => entry.id === id),
    "the copy to arrive",
  );
  await addChild("Typed in the other tab", other);
  await eventually(
    async () =>
      (await call("texts", "account-1", id)).includes("Typed in the other tab"),
    "the other tab's edit to reach the copy",
  );
  await other.close();
});

test("a map that cannot be read holds back neither the others nor the Load list", async () => {
  await rename("A damaged map");
  const damaged = await call("id");
  await newMap();
  await rename("B healthy map");
  const healthy = await call("id");
  await newMap();
  await rename("C open map");
  await call("corrupt", "anonymous", damaged);
  await login();
  await claimed(healthy);
  expect(await claimPhase(damaged)).not.toBe("complete");
  await eventually(
    async () =>
      (await call("catalog", "account-1")).some(
        (entry) => entry.id === healthy,
      ),
    "the healthy map to arrive",
  );
  await projectMenu("Open map…");
  await page.getByRole("menuitem", { name: /A damaged map/ }).waitFor();
  await page.getByRole("menuitem", { name: /B healthy map/ }).waitFor();
  await page.keyboard.press("Escape");
  await expectSilence();
});

for (const [title, typed, composed] of [
  ["beside typed text", "Draft ", "Draft 日本"],
  ["as the only input", "", "日本"],
] as const)
  test(`text being composed ${title} survives storage opening under it`, async () => {
    await call("openGate", true);
    await page.reload();
    await page.waitForSelector('[data-storage-ready="false"]');
    await page.waitForSelector("[data-node-id]");
    const draft = await call("id");
    await page.locator("[data-node-id]").first().dblclick();
    const input = page.getByRole("textbox", { name: "Node text" });
    await input.waitFor();
    if (typed) await page.keyboard.type(typed);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "にほん",
      selectionStart: 3,
      selectionEnd: 3,
    });
    await call("openGate", false);
    // The stored map has opened by now; it waits for the composition to end.
    await Bun.sleep(300);
    expect(await input.inputValue()).toBe(`${typed}にほん`);
    await page.waitForSelector('[data-storage-ready="false"]');
    await cdp.send("Input.insertText", { text: "日本" });
    await ready();
    expect(await call("id")).toBe(draft);
    await page.keyboard.press("Enter");
    await page.getByText(composed, { exact: true }).waitFor();
    await page.reload();
    await ready();
    expect(await call("id")).toBe(draft);
    await page.getByText(composed, { exact: true }).waitFor();
  });

test("a draft left behind by a change of account stays with its own account", async () => {
  await login();
  await call("failOpen", true);
  backend.user = B;
  await refreshAccount();
  await page.getByText(B.name, { exact: true }).waitFor();
  const retry = page.getByRole("button", { name: "Retry local saving" });
  await retry.waitFor();
  const draft = await call("id");
  await edit("Written as B");
  backend.user = A;
  await refreshAccount();
  await page.getByText(A.name, { exact: true }).waitFor();
  expect(await call("id")).not.toBe(draft);
  await page.getByText("Written as B", { exact: true }).waitFor({
    state: "detached",
  });
  await call("failOpen", false);
  await retry.click();
  await ready();
  await eventually(
    async () =>
      (await call("catalog", "account-2")).some((entry) => entry.id === draft),
    "the draft to be stored under its own account",
  );
  expect(await call("texts", "account-2", draft)).toContain("Written as B");
  expect(
    (await call("catalog", "account-1")).some((entry) => entry.id === draft),
  ).toBe(false);
  expect(backend.registrations).not.toContain(draft);
  expect(backend.projects.has(draft)).toBe(false);
});

test("a map saved while the first map opens is not replaced by it", async () => {
  const stored = await call("id");
  await call("openGate", true, stored);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="false"]');
  await page.waitForSelector("[data-node-id]");
  const draft = await call("id");
  await edit("Saved first");
  await projectMenu("Save now");
  await page
    .locator(".notice")
    .getByText("Saved locally", { exact: true })
    .waitFor();
  await ready();
  await page.locator("[data-node-id]").first().dblclick();
  const input = page.getByRole("textbox", { name: "Node text" });
  await input.waitFor();
  await call("openGate", false);
  await Bun.sleep(300);
  await page.keyboard.type("!");
  expect(await input.inputValue()).toBe("!");
  await page.keyboard.press("Enter");
  expect(await call("id")).toBe(draft);
});

test("a background switch to the account's map waits for search to close", async () => {
  await cloudAccountWithTwoMaps();
  await freshBrowser();
  backend.recentGate = deferred();
  const seed = await call("id");
  await login();
  await page.keyboard.press("ControlOrMeta+f");
  const search = page.getByRole("searchbox", { name: "Search ideas" });
  await search.waitFor();
  await page.keyboard.type("ne");
  backend.recentGate.resolve();
  backend.recentGate = undefined;
  await accountCatalogSize(2);
  await Bun.sleep(300);
  await page.keyboard.type("w");
  expect(await search.inputValue()).toBe("new");
  expect(await call("id")).toBe(seed);
  await page.keyboard.press("Escape");
  await eventually(async () => (await call("id")) !== seed, "the switch");
});

test("a background switch to the account's map waits for Notes to lose focus", async () => {
  await cloudAccountWithTwoMaps();
  await freshBrowser();
  backend.recentGate = deferred();
  const seed = await call("id");
  await login();
  await page.locator("[data-node-id]").first().click();
  await page.getByRole("button", { name: /Notes/ }).first().click();
  const notes = page.getByRole("textbox", { name: "Idea notes" });
  await notes.click();
  backend.recentGate.resolve();
  backend.recentGate = undefined;
  await accountCatalogSize(2);
  await Bun.sleep(300);
  expect(await call("id")).toBe(seed);
  expect(await notes.evaluate((el) => el === document.activeElement)).toBe(
    true,
  );
  await page.locator("[data-node-id]").first().click();
  await eventually(async () => (await call("id")) !== seed, "the switch");
});

test("a saving switch flipped on the placeholder keeps it as the map and leaves the stored one alone", async () => {
  await rename("Stored map");
  const stored = await call("id");
  await call("openGate", true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="false"]');
  await page.waitForSelector("[data-node-id]");
  const draft = await call("id");
  await projectMenu("Project preferences…");
  const dialog = page.getByRole("dialog", { name: "Project preferences" });
  await dialog
    .getByRole("switch", { name: "Save locally", exact: true })
    .click();
  await dialog.getByText("This map lives only in memory.").waitFor();
  await call("openGate", false);
  await ready();
  expect(await call("id")).toBe(draft);
  await dialog.getByText("This map lives only in memory.").waitFor();
  expect(
    (await call("catalog", "anonymous")).find((entry) => entry.id === stored)
      ?.saving?.local,
  ).toBe(true);
});

test("waiting maps stay listed while the account check fails", async () => {
  await rename("Waiting one");
  await newMap();
  await rename("Open map");
  backend.registerGate = deferred();
  await login();
  await untilRegistrationRequested();
  backend.meStatus = 503;
  await page.reload();
  await ready();
  await projectMenu("Open map…");
  await page.getByRole("menuitem", { name: /Waiting one/ }).waitFor();
  await page.keyboard.press("Escape");
  backend.meStatus = undefined;
});

test("a damaged remembered map does not stop a reload or the account check", async () => {
  await rename("B healthy map");
  const healthy = await call("id");
  await newMap();
  await rename("A damaged map");
  const damaged = await call("id");
  backend.registerGate = deferred();
  await login();
  await untilRegistrationRequested();
  await call("corrupt", "anonymous", damaged);
  await page.reload();
  await ready();
  expect(await call("id")).toBe(healthy);
  await page.getByText(A.name, { exact: true }).waitFor();
  backend.registerGate.resolve();
  backend.registerGate = undefined;
  await claimed(healthy);
  expect(await claimPhase(damaged)).not.toBe("complete");
});

test("closing the tab warns about an edited placeholder", async () => {
  await call("failOpen", true);
  await page.reload();
  await page.getByRole("button", { name: "Retry local saving" }).waitFor();
  const warned = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await warned()).toBe(false);
  await edit("Not stored anywhere");
  expect(await warned()).toBe(true);
});

test("an open editor on the placeholder is left alone when the stored map arrives", async () => {
  await call("openGate", true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="false"]');
  await page.waitForSelector("[data-node-id]");
  const draft = await call("id");
  await page.locator("[data-node-id]").first().dblclick();
  await page.getByRole("textbox", { name: "Node text" }).waitFor();
  await call("openGate", false);
  await Bun.sleep(300);
  await page.keyboard.type("Hello");
  await page.keyboard.press("Enter");
  await page.getByText("Hello", { exact: true }).waitFor();
  await ready();
  expect(await call("id")).toBe(draft);
});

test("a name being typed or composed survives a stored map being turned away", async () => {
  await rename("Stored map");
  await call("openGate", true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="false"]');
  await page.waitForSelector("[data-node-id]");
  const draft = await call("id");
  await edit("Edited first");
  const name = page.getByRole("textbox", { name: "Project name" });
  await name.click();
  await name.fill("");
  await page.keyboard.type("My ");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "にほん",
    selectionStart: 3,
    selectionEnd: 3,
  });
  await call("openGate", false);
  await ready();
  expect(await call("id")).toBe(draft);
  await cdp.send("Input.insertText", { text: "日本" });
  await page.keyboard.type(" plan");
  await page.keyboard.press("Enter");
  expect(await name.inputValue()).toBe("My 日本 plan");
});

test("an account's damaged latest map gives way to its other maps on a reload", async () => {
  await login();
  await rename("Healthy map");
  const healthy = await call("id");
  await newMap();
  await rename("Damaged map");
  const damaged = await call("id");
  await call("corrupt", "account-1", damaged);
  await page.reload();
  await ready();
  expect(await call("id")).toBe(healthy);
  await expectSilence();
});

test("an account's damaged latest map gives way to its other maps at sign-in", async () => {
  await login();
  await rename("Healthy map");
  const healthy = await call("id");
  await cloudSaved();
  await newMap();
  await rename("Damaged map");
  const damaged = await call("id");
  await cloudSaved();
  await signOut();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await ready();
  await call("corrupt", "account-1", damaged);
  // Another tab's sign-in reaches this one in place, over its untouched map.
  const other = await context.newPage();
  await other.goto(appUrl);
  await ready(other);
  backend.nextUser = A;
  await other.getByRole("button", { name: /Sign in/ }).click();
  await other.getByText(A.name, { exact: true }).waitFor();
  await page.getByText(A.name, { exact: true }).waitFor();
  await eventually(async () => (await call("id")) === healthy, "the switch");
  await expectSilence();
  await other.close();
});

test("with every stored map damaged, a new map keeps what is typed without a Save", async () => {
  await rename("Damaged map");
  const damaged = await call("id");
  await call("corrupt", "anonymous", damaged);
  await page.reload();
  await ready();
  const id = await call("id");
  expect(id).not.toBe(damaged);
  await edit("Kept without a save");
  await eventually(
    async () =>
      (await call("texts", "anonymous", id)).includes("Kept without a save"),
    "the edit to be stored",
  );
  await expectSilence();
});

test("the account check does not wait for a map that cannot open", async () => {
  await login();
  await call("failOpen", true);
  backend.meStarted = false;
  await page.reload();
  await page.getByRole("button", { name: "Retry local saving" }).waitFor();
  await eventually(async () => backend.meStarted, "the account check");
});

test("a sign-in returning under a name being typed leaves the name alone", async () => {
  await login();
  await rename("Account map");
  await cloudSaved();
  await signOut();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await ready();
  await rename("My work");
  const anon = await call("id");
  await call("openGate", true, anon);
  backend.nextUser = A;
  await page.getByRole("button", { name: /Sign in/ }).click();
  await page.waitForSelector('[data-storage-ready="false"]');
  const name = page.getByRole("textbox", { name: "Project name" });
  await name.click();
  await name.fill("");
  await page.keyboard.type("My ");
  await call("openGate", false);
  await Bun.sleep(500);
  await page.keyboard.type("plan");
  await page.keyboard.press("Enter");
  await ready();
  expect(await name.inputValue()).toBe("My plan");
  await expectSilence();
});

test("a focused name field is left alone when the stored map arrives", async () => {
  await rename("Stored map");
  await call("openGate", true);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="false"]');
  await page.waitForSelector("[data-node-id]");
  const draft = await call("id");
  const name = page.getByRole("textbox", { name: "Project name" });
  await name.click();
  await call("openGate", false);
  await Bun.sleep(300);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Plan");
  await page.keyboard.press("Enter");
  await ready();
  expect(await name.inputValue()).toBe("Plan");
  expect(await call("id")).toBe(draft);
});

test("a map that failed to open once is still the one the next visit opens", async () => {
  await rename("Real map");
  const real = await call("id");
  await call("failOpen", true, real);
  await page.reload();
  await ready();
  expect(await call("id")).not.toBe(real);
  await call("failOpen", false);
  await page.reload();
  await ready();
  expect(await call("id")).toBe(real);
});

test("a sign-in returning before the anonymous map opens keeps that map", async () => {
  await login();
  await rename("Account map");
  await cloudSaved();
  await signOut();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await ready();
  await rename("My work");
  await edit("Anonymous work");
  await rename("My work");
  const anon = await call("id");
  await call("openGate", true, anon);
  backend.nextUser = A;
  await page.getByRole("button", { name: /Sign in/ }).click();
  await page.waitForSelector('[data-storage-ready="false"]');
  // Long enough for the account check to answer, were it not held for this open.
  await Bun.sleep(500);
  await call("openGate", false);
  await ready();
  await page.getByText("Anonymous work", { exact: true }).waitFor();
  await page.getByText(A.name, { exact: true }).waitFor();
  await expectSilence();
});

test("a damaged account map holds back no other map's upload", async () => {
  await login();
  await rename("Aaa damaged first by name");
  await cloudSaved();
  const damaged = await call("id");
  await signOut();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await ready();
  await rename("Zzz migrating");
  await edit("Anonymous text");
  await rename("Zzz migrating");
  const anon = await call("id");
  await newMap();
  await rename("Mmm open one");
  await call("corrupt", "account-1", damaged);
  await login();
  await claimed(anon);
  await eventually(
    async () => backend.uploads.some((upload) => upload.projectId === anon),
    "the migrated map to upload",
  );
});

test("saving during a slow first visit leaves one map", async () => {
  await context.close();
  context = await browser.newContext();
  context.setDefaultTimeout(15_000);
  await context.route("**/api/**", (route) => backend.route(route));
  await context.addInitScript(() => {
    if (!sessionStorage.getItem("accountHarness/started")) {
      sessionStorage.setItem("accountHarness/started", "1");
      sessionStorage.setItem("accountHarness/open", "hold");
    }
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(appUrl);
  await page.waitForSelector("[data-node-id]");
  const draft = await call("id");
  await page.getByRole("textbox", { name: "Project name" }).fill("Saved early");
  await page.getByRole("textbox", { name: "Project name" }).press("Enter");
  await projectMenu("Save now");
  await call("openGate", false);
  await ready();
  expect(await call("id")).toBe(draft);
  await accountlessCatalog(1);
});

test("a memory-only anonymous map stays reachable after New map under an account", async () => {
  await edit("Only in memory");
  const id = await call("id");
  await projectMenu("Project preferences…");
  const dialog = page.getByRole("dialog", { name: "Project preferences" });
  await dialog
    .getByRole("switch", { name: "Save locally", exact: true })
    .click();
  await dialog.getByText("This map lives only in memory.").waitFor();
  await dialog
    .getByRole("button", { name: "Close project preferences" })
    .click();
  const name = await page.getByLabel("Project name").inputValue();
  // Signing in here would navigate and end the map; another tab's sign-in
  // reaches this one in place.
  backend.user = A;
  await refreshAccount();
  await page.getByText(A.name, { exact: true }).waitFor();
  await newMap();
  await projectMenu("Open map…");
  await page.getByRole("menuitem", { name }).click();
  await eventually(async () => (await call("id")) === id, "the map to reopen");
  await page.getByText("Only in memory", { exact: true }).waitFor();
});
