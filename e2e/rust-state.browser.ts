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
  server = await createServer({
    root: `${root}/webapp`,
    configFile: `${root}/webapp/vite.config.ts`,
    cacheDir: "node_modules/.vite-rust-app-tests",
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_URL": JSON.stringify("") },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      proxy: {
        "/api": { target: nativeUrl },
        "/sync": { target: nativeUrl, ws: true },
      },
    },
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
async function login(page: Page) {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await page.waitForSelector('[data-storage-ready="true"]');
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
      const response = await fetch(`/api/${method}`, {
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
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await page.getByRole("button").filter({ hasText: name }).click();
  await saved(page);
}

test("main app signs in, claims anonymous work, reloads durable state, and accepts native Rust commands", async () => {
  await edit(page, "Anonymous work 🦀");
  await login(page);
  await page
    .getByRole("button", { name: "Add anonymous projects to this account" })
    .click();
  await page.getByText("Anonymous work 🦀", { exact: true }).waitFor();
  await saved(page);
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
  await page.route("**/api/mergeProject?**", (route) => {
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
