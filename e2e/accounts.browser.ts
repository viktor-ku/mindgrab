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
import { preferenceKey } from "../webapp/src/preferences";
import type {
  PreferenceRow,
  PreferenceTarget,
} from "../webapp/src/preferences";

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
  meGate?: ReturnType<typeof deferred>;
  // Fails this many "recent projects" requests with a transient 503.
  recentFailures = 0;
  meStarted = false;
  // Holds registrations, which keeps a migration at its pending marker.
  registerGate?: ReturnType<typeof deferred>;
  lostRegistration = false;
  leaveCookieOnLogout = false;
  projects = new Map<
    string,
    { ownerId: number; doc: ProjectDocument; updatedAt?: string }
  >();
  // Commit times are strictly increasing, like the server's updated_at.
  clock = Date.parse("2026-01-01T00:00:00Z");
  registrations: string[] = [];
  // Each account's preferences, by scope, map and name.
  preferences = new Map<number, Map<string, PreferenceRow>>();
  preferencesOf(ownerId: number) {
    const rows = this.preferences.get(ownerId) ?? new Map();
    this.preferences.set(ownerId, rows);
    return rows;
  }
  async route(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    expect(request.method()).toBe("POST");
    expect(url.pathname).toEndWith(".php");
    const owner = this.user;
    const error = (status: number, code: string) =>
      route.fulfill({ status, json: { error: { code, message: code } } });
    if (url.pathname === "/api/startLogin.php") {
      this.user = this.nextUser;
      return route.fulfill({
        status: 303,
        headers: { Location: harnessPath },
      });
    }
    if (url.pathname === "/api/logout.php") {
      if (!this.leaveCookieOnLogout) this.user = undefined;
      return route.fulfill({
        status: 303,
        headers: { Location: harnessPath },
      });
    }
    if (url.pathname === "/api/getMe.php") {
      this.meStarted = true;
      await this.meGate?.promise;
      return owner
        ? route.fulfill({ json: owner })
        : error(401, "unauthenticated");
    }
    const expected = request.headers()["x-mindgrab-account"];
    if (!owner) return error(401, "unauthenticated");
    if (expected !== String(owner.id)) return error(409, "account_changed");
    if (url.pathname === "/api/listPreferences.php")
      return route.fulfill({
        json: { preferences: [...this.preferencesOf(owner.id).values()] },
      });
    if (url.pathname === "/api/setPreferences.php") {
      const { set = [], clear = [] } = request.postDataJSON() as {
        set?: PreferenceRow[];
        clear?: PreferenceTarget[];
      };
      const rows = this.preferencesOf(owner.id);
      for (const target of clear) rows.delete(preferenceKey(target));
      for (const row of set) rows.set(preferenceKey(row), row);
      return route.fulfill({ json: { saved: true } });
    }
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
      const bytes = new Uint8Array(request.postDataBuffer() as Buffer);
      const before = record.doc.version();
      record.doc.merge(bytes);
      if (record.doc.version() !== before)
        record.updatedAt = new Date(this.clock++).toISOString();
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

async function connectionStyle(name: string) {
  await page.getByRole("radio", { name: new RegExp(`^${name}`) }).check();
}
const cloudPreferences = () => [...backend.preferencesOf(A.id).values()];

test("a map's own connection style follows it into the account, beside the account's style for all maps", async () => {
  await rename("Styled map");
  const id = await call("id");
  await projectMenu("Preferences…");
  await page
    .getByRole("navigation", { name: "Preference sections" })
    .getByRole("button", { name: "Connections" })
    .click();
  await expect(
    page.getByLabel("Applying settings for").inputValue(),
  ).resolves.toBe("map");
  await page.getByText("This map uses your connection style").waitFor();
  await connectionStyle("Square");
  await page.getByText("This map has its own connection style.").waitFor();
  await page.keyboard.press("Escape");

  await login();
  await claimed(id);
  await cloudSaved();
  // Signed in, the copy's own style reaches the account in the cloud.
  await eventually(
    async () =>
      cloudPreferences().some(
        (row) =>
          row.scope === "map" &&
          row.projectId === id &&
          row.name === "linkStyle" &&
          row.value === "square",
      ),
    "the map's connection style to reach the cloud",
  );

  await projectMenu("Preferences…");
  await page
    .getByRole("navigation", { name: "Preference sections" })
    .getByRole("button", { name: "Connections" })
    .click();
  await page.getByText("This map has its own connection style.").waitFor();
  expect(await page.getByRole("radio", { name: /^Square/ }).isChecked()).toBe(
    true,
  );
  // All maps get freeform lines; this one keeps its own until it lets go.
  await page.getByLabel("Applying settings for").selectOption("global");
  await connectionStyle("Freeform");
  await page.getByLabel("Applying settings for").selectOption("map");
  expect(await page.getByRole("radio", { name: /^Square/ }).isChecked()).toBe(
    true,
  );
  await page
    .getByRole("button", { name: "Use the connection style for all maps" })
    .click();
  await page.getByText("This map uses your connection style").waitFor();
  expect(await page.getByRole("radio", { name: /^Freeform/ }).isChecked()).toBe(
    true,
  );
  await eventually(
    async () =>
      JSON.stringify(cloudPreferences()) ===
      JSON.stringify([
        {
          scope: "global",
          projectId: null,
          name: "linkStyle",
          value: "freeform",
        },
      ]),
    "only the style for all maps to stay in the cloud",
  );
  await expectSilence();
});

async function openPreferences(section: string) {
  await projectMenu("Preferences…");
  await page
    .getByRole("navigation", { name: "Preference sections" })
    .getByRole("button", { name: section })
    .click();
}

test("cloud saving off for all maps applies to a map without its own, until the map keeps itself there", async () => {
  await rename("Kept where told");
  const id = await call("id");
  await login();
  await claimed(id);
  await cloudSaved();
  expect(backend.projects.has(id)).toBe(true);

  await openPreferences("Saving");
  await page.getByLabel("Applying settings for").selectOption("global");
  await page.getByRole("switch", { name: "Save in Mindgrab Cloud" }).click();
  // The open map follows: its cloud copy goes, and it stays in this browser.
  await page
    .getByText("Saved locally · cloud saving off", { exact: true })
    .waitFor();
  await eventually(
    async () => !backend.projects.has(id),
    "the cloud copy to be deleted",
  );
  expect(cloudPreferences()).toEqual([
    { scope: "global", projectId: null, name: "saveInCloud", value: false },
  ]);

  await page.getByLabel("Applying settings for").selectOption("map");
  await page.getByText("This map uses your saving for all maps").waitFor();
  expect(
    await page
      .getByRole("switch", { name: "Save in Mindgrab Cloud" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  await page.getByRole("switch", { name: "Save in Mindgrab Cloud" }).click();
  await page.getByText("This map has its own saving.").waitFor();
  await cloudSaved();
  expect(backend.projects.has(id)).toBe(true);
  await eventually(
    async () =>
      cloudPreferences().some(
        (row) =>
          row.scope === "map" &&
          row.projectId === id &&
          row.name === "saveInCloud" &&
          row.value === true,
      ),
    "the map's own cloud saving to reach the cloud",
  );
  await expectSilence();
});
