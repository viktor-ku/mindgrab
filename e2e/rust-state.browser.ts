import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createServer as createNetServer } from "node:net";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import type { ProjectView } from "../webapp/src/generated/mindgrab-state/model";

// The real app, Rust API, Postgres, and WebSockets. Only the identity provider
// is a local test fixture; it exercises the actual OAuth callback and JWT checks.
setDefaultTimeout(45_000);
const root = new URL("..", import.meta.url).pathname;
let native: ReturnType<typeof Bun.spawn>;
let server: ViteDevServer;
let browser: Browser;
let contexts: BrowserContext[];
let page: Page;
let origin: string;
let nativeUrl = "";
let errors: string[];
async function availablePort() {
  const listener = createNetServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
beforeAll(async () => {
  const build = Bun.spawn(
    [
      "cargo",
      "build",
      "--locked",
      "-p",
      "mindgrab-backend",
      "--example",
      "browser-fixture",
    ],
    { cwd: root, stdout: "ignore", stderr: "inherit" },
  );
  if (await build.exited) throw new Error("Rust fixture build failed");
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  native = Bun.spawn([`${root}/target/debug/examples/browser-fixture`], {
    cwd: root,
    env: { ...process.env, FIXTURE_APP_ORIGIN: origin },
    stdout: "pipe",
    stderr: "inherit",
  });
  if (!(native.stdout instanceof ReadableStream))
    throw new Error("Missing fixture output");
  const reader = native.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!nativeUrl) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Rust fixture exited before listening");
    output += decoder.decode(chunk.value);
    nativeUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
  }
  reader.releaseLock();
  // Point the app's own proxy table at the fixture, so these tests go through it.
  process.env.VITE_BACKEND_URL = nativeUrl;
  server = await createServer({
    root: `${root}/webapp`,
    configFile: `${root}/webapp/vite.config.ts`,
    cacheDir: "node_modules/.vite-rust-app-tests",
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_URL": JSON.stringify("") },
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  browser = await chromium.launch();
}, 90_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
  native?.kill("SIGTERM");
  if (native) await native.exited;
});
beforeEach(async () => {
  contexts = [];
  errors = [];
  page = await newPage();
  await page.goto(origin);
  await page.waitForSelector('[data-storage-ready="true"]');
});
afterEach(async () => {
  for (const context of contexts) await context.close();
  expect(errors).toEqual([]);
});
async function newPage() {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
}
// Waits for the account workspace to settle: the map stays editable through
// sign-in, so without this an edit would land on the untouched map and make
// it a new cloud project instead of opening the account's latest.
async function login(page: Page) {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .locator('[aria-label="Account"] button[aria-haspopup="menu"]')
    .waitFor();
  await page.waitForSelector('[data-storage-ready="true"]');
  await saved(page);
}
async function saved(page: Page) {
  try {
    await page
      .getByText("Saved to cloud", { exact: true })
      .waitFor({ timeout: 12000 });
  } catch (error) {
    console.error("Cloud status:", await page.locator("body").innerText());
    throw error;
  }
}
async function edit(page: Page, text: string) {
  await page.locator("[data-node-id]").first().dblclick();
  await page
    .getByRole("textbox", { name: "Node text", exact: true })
    .fill(text);
  await page.keyboard.press("Enter");
}
async function rpc(page: Page, method: string, args: unknown) {
  return page.evaluate(
    async ([method, args]) => {
      const response = await fetch(`/api/${method}.php`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!response.ok) throw new Error(`RPC ${method}: ${response.status}`);
      return response.json();
    },
    [method, args] as const,
  );
}
async function currentId(page: Page) {
  const list = await rpc(page, "listProjects", { limit: 100 });
  const name = await page
    .getByRole("textbox", { name: "Project name", exact: true })
    .inputValue();
  const project = list.projects.find(
    (project: { name: string }) => project.name === name,
  );
  if (!project) throw new Error("Project missing from native catalog");
  return project.projectId as string;
}
async function openNamed(page: Page, name: string) {
  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Open map…" }).click();
  await page
    .locator("#saved-projects")
    .getByRole("menuitem")
    .filter({ hasText: name })
    .click();
  await saved(page);
}

test("main app signs in, migrates anonymous work silently, reloads durable state, and accepts native Rust commands", async () => {
  await edit(page, "Anonymous work 🦀");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .locator('[aria-label="Account"] button[aria-haspopup="menu"]')
    .waitFor();
  // The map is on screen at once; its copy into the account needs no click.
  await page.getByText("Anonymous work 🦀", { exact: true }).waitFor();
  expect(
    await page
      .getByRole("button", { name: "Add maps to this account" })
      .count(),
  ).toBe(0);
  await saved(page);
  expect(await page.getByRole("alert").count()).toBe(0);
  const id = await currentId(page);
  const view = (await rpc(page, "getProjectState", {
    projectId: id,
  })) as ProjectView;
  expect(view.nodes[0].text).toBe("Anonymous work 🦀");
  await rpc(page, "commandProject", {
    projectId: id,
    command: {
      type: "createNode",
      parent: view.roots[0],
      index: null,
      text: "Created by native Rust",
      color: "teal",
    },
  });
  await page.getByText("Created by native Rust", { exact: true }).waitFor();
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  await page.getByText("Anonymous work 🦀", { exact: true }).waitFor();
  await page.getByText("Created by native Rust", { exact: true }).waitFor();
  await saved(page);
});

test("independent offline devices merge edits and live native notifications converge both editors", async () => {
  await login(page);
  await edit(page, "Shared 🌲");
  await saved(page);
  const name = await page
    .getByRole("textbox", { name: "Project name", exact: true })
    .inputValue();
  const id = await currentId(page);
  const second = await newPage();
  await second.goto(origin);
  await login(second);
  await openNamed(second, name);
  await contexts[0].setOffline(true);
  await contexts[1].setOffline(true);
  await edit(page, "Alice Shared 🌲");
  await edit(second, "Shared 🌲 Bob");
  await contexts[0].setOffline(false);
  await contexts[1].setOffline(false);
  const expected = "Alice Shared 🌲 Bob";
  await page.getByRole("button", { name: expected, exact: true }).waitFor();
  await second.getByRole("button", { name: expected, exact: true }).waitFor();
  await saved(page);
  await saved(second);
  const view = (await rpc(page, "getProjectState", {
    projectId: id,
  })) as ProjectView;
  expect(view.nodes[0].text).toBe(expected);
  await rpc(page, "commandProject", {
    projectId: id,
    command: { type: "setText", id: view.roots[0], text: "Native update 🌲" },
  });
  await page
    .getByRole("button", { name: "Native update 🌲", exact: true })
    .waitFor();
  await second
    .getByRole("button", { name: "Native update 🌲", exact: true })
    .waitFor();
});

test("a failed upload retries without losing unsent local edits", async () => {
  await login(page);
  await saved(page);
  let fail = true;
  let attempts = 0;
  await page.route("**/api/mergeProject.php?**", (route) => {
    attempts++;
    return fail
      ? route.fulfill({ status: 503, json: { error: { code: "unavailable" } } })
      : route.continue();
  });
  await edit(page, "Retained across retries 🦀");
  await page.waitForFunction(() =>
    document.body.textContent?.includes("Cloud saving is unavailable"),
  );
  expect(attempts).toBeGreaterThan(0);
  fail = false;
  await saved(page);
  const id = await currentId(page);
  const view = (await rpc(page, "getProjectState", {
    projectId: id,
  })) as ProjectView;
  expect(view.nodes[0].text).toBe("Retained across retries 🦀");
});

// The owner's stored map keeps its whole edit history, and the owner can step
// back through it. A share link shows only the map as it is now, follows the
// owner's edits live, and cannot change anything.
test("a share link follows the owner's edits live, read-only, without the deleted history the owner keeps", async () => {
  await login(page);
  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "New map" }).click();
  await edit(page, "Team offsite");
  const ideas = (target: Page) =>
    target
      .locator("[data-node-id]")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
  async function addChild(parent: string, text: string) {
    await page.getByRole("button", { name: parent, exact: true }).click();
    await page.keyboard.press("Tab");
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  }
  async function addNote(note: string) {
    await page.keyboard.press("Alt+n");
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Idea notes",
    );
    await page.keyboard.type(note);
    await page.keyboard.press("Escape");
  }

  // A draft the owner deletes before sharing.
  await addChild("Team offsite", "Canary salaries");
  await addNote("Canary password hunter2");
  await saved(page);
  await page
    .getByRole("button", { name: "Canary salaries", exact: true })
    .click();
  await page.keyboard.press("Delete");
  expect(await ideas(page)).toEqual(["Team offsite"]);
  await saved(page);

  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Share link…" }).click();
  await page
    .getByRole("switch", { name: "Anyone with the link can view" })
    .click();
  const link = page.getByRole("textbox", { name: "Share link", exact: true });
  await page.waitForFunction(
    () =>
      (document.querySelector('[aria-label="Share link"]') as HTMLInputElement)
        ?.value,
  );
  const url = new URL(await link.inputValue());
  await page.getByRole("button", { name: "Close sharing" }).click();

  // The viewer has no account and stays on the one open page throughout.
  const viewer = await newPage();
  const writes: string[] = [];
  viewer.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      path.startsWith("/api/") &&
      !["/api/getSharedProject.php", "/api/getMe.php"].includes(path)
    )
      writes.push(path);
  });
  await viewer.goto(`${origin}${url.pathname}`);
  await viewer.getByText("View only", { exact: true }).waitFor();
  await viewer
    .getByRole("button", { name: "Team offsite", exact: true })
    .waitFor();
  const payload = () =>
    viewer.evaluate(async (token) => {
      const response = await fetch("/api/getSharedProject.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        credentials: "omit",
      });
      const { data, revision } = await response.json();
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      return { text: new TextDecoder("latin1").decode(bytes), revision };
    }, url.pathname.split("/").pop());
  expect((await payload()).text).not.toContain("Canary");
  expect(await ideas(viewer)).toEqual(["Team offsite"]);
  // The owner's own copy still holds it, so the check above can see it.
  const owned = await rpc(page, "getProjectSnapshot", {
    projectId: await currentId(page),
  });
  expect(Buffer.from(owned.data, "base64").toString("latin1")).toContain(
    "Canary",
  );

  // Each edit reaches the open viewer.
  await addChild("Team offsite", "Venue: Lisbon");
  await viewer
    .getByRole("button", { name: "Venue: Lisbon", exact: true })
    .waitFor();
  await addChild("Team offsite", "Agenda");
  await addNote("Day one: kickoff");
  await viewer.getByRole("button", { name: "Agenda", exact: true }).waitFor();
  await viewer.getByRole("button", { name: "Agenda", exact: true }).click();
  await viewer.getByText("Day one: kickoff", { exact: true }).waitFor();
  expect(
    await viewer
      .getByRole("textbox", { name: "Idea notes" })
      .getAttribute("contenteditable"),
  ).toBe("false");
  await saved(page);
  expect((await payload()).text).not.toContain("Canary");

  // The viewer cannot change the map.
  await viewer.getByRole("button", { name: "Agenda", exact: true }).dblclick();
  await viewer.keyboard.type("x");
  for (const key of ["Delete", "Backspace", "ControlOrMeta+z"])
    await viewer.keyboard.press(key);
  expect(new URL(viewer.url()).pathname).toBe(url.pathname);
  expect(await viewer.getByRole("textbox", { name: "Node text" }).count()).toBe(
    0,
  );
  expect(await ideas(viewer)).toEqual([
    "Team offsite",
    "Venue: Lisbon",
    "Agenda",
  ]);
  expect(writes).toEqual([]);

  // The owner still has every step, back to the deleted draft; while undone
  // to it, it is the map again, and the viewer sees it.
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  while (!(await ideas(page)).includes("Canary salaries")) {
    expect(await undo.isDisabled()).toBe(false);
    await undo.click();
  }
  await viewer
    .getByRole("button", { name: "Canary salaries", exact: true })
    .waitFor();
  while (!(await redo.isDisabled())) await redo.click();
  expect(await ideas(page)).toEqual([
    "Team offsite",
    "Venue: Lisbon",
    "Agenda",
  ]);
  await saved(page);
  // Uploads are not debounced, so the viewer may pass through steps first.
  await viewer.waitForFunction(
    (expected) =>
      JSON.stringify(
        [...document.querySelectorAll("[data-node-id]")].map((node) =>
          node.textContent?.trim(),
        ),
      ) === expected,
    JSON.stringify(["Team offsite", "Venue: Lisbon", "Agenda"]),
  );
  expect((await payload()).text).not.toContain("Canary");

  // Each revision is a new document, but the viewer keeps one view: a text
  // edit leaves the outline's rows in place.
  await viewer.getByRole("button", { name: "Outline", exact: true }).click();
  const row = viewer.getByRole("treeitem").last();
  await row.evaluate((element) => {
    (element as HTMLElement).dataset.kept = "";
  });
  await page.getByRole("button", { name: "Agenda", exact: true }).dblclick();
  await page
    .getByRole("textbox", { name: "Node text", exact: true })
    .fill("Agenda v2");
  await page.keyboard.press("Enter");
  await viewer
    .getByRole("button", { name: "Agenda v2", exact: true })
    .waitFor();
  expect(await row.innerText()).toContain("Agenda v2");
  expect(await row.getAttribute("data-kept")).toBe("");
  expect(writes).toEqual([]);
});
