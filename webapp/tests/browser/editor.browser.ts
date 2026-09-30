import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";
import type { Harness } from "./harness";

// Interaction tests for the Yjs-bound editor in headless Chromium. The harness
// page mounts the app with a linked in-process replica acting as another device.
setDefaultTimeout(30_000);
const webapp = fileURLToPath(new URL("../..", import.meta.url));
let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    root: webapp,
    configFile: `${webapp}/vite.config.ts`,
    cacheDir: "node_modules/.vite-browser-tests",
    logLevel: "error",
    server: { port: 5199, strictPort: false },
    optimizeDeps: { entries: ["tests/browser/harness.html"] },
  });
  await server.listen();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

beforeEach(async () => {
  context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page = await context.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  const url = server.resolvedUrls?.local[0] ?? "http://localhost:5199/";
  await page.goto(new URL("tests/browser/harness.html", url).href);
  await page.waitForSelector('[data-storage-ready="true"]');
  await page.waitForSelector("[data-node-id]");
  (page as unknown as { errors: Error[] }).errors = errors;
});

afterEach(async () => {
  expect((page as unknown as { errors: Error[] }).errors).toEqual([]);
  await context.close();
});

function call<K extends keyof Harness>(
  name: K,
  ...args: Parameters<Harness[K]>
): Promise<Awaited<ReturnType<Harness[K]>>> {
  return page.evaluate(
    ([name, args]) =>
      (window.harness[name] as (...args: unknown[]) => unknown)(...args),
    [name, args] as const,
  ) as never;
}

const node = (id: string) => page.locator(`[data-node-id="${id}"]`);
const editor = () => page.getByLabel("Node text");
const rootId = async () => (await call("ids"))[0];
const frame = () =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
const selection = () =>
  editor().evaluate((input: HTMLTextAreaElement) => [
    input.value,
    input.selectionStart,
    input.selectionEnd,
  ]);
const select = (start: number, end = start) =>
  editor().evaluate(
    (input: HTMLTextAreaElement, [start, end]) =>
      input.setSelectionRange(start, end),
    [start, end],
  );
async function translation(id: string) {
  const transform = await node(id).evaluate((el) => el.style.transform);
  const [x, y] = (transform.match(/-?[\d.]+/g) ?? []).map(Number);
  return { x, y };
}
async function edit(id: string) {
  await node(id).dblclick();
  await editor().waitFor();
}
async function startDrag(id: string) {
  await frame();
  const box = await node(id).boundingBox();
  if (!box) throw new Error("Node is not visible.");
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return async (dx: number, dy: number) =>
    page.mouse.move(start.x + dx, start.y + dy, { steps: 4 });
}

describe("remote documents", () => {
  test("remote edits render immediately without saving or reloading", async () => {
    const id = await rootId();
    await call("edit", id, 0, 3, "Remote");
    expect(await node(id).textContent()).toBe("Remote idea");
    const child = await call("addChild", id, "From another device");
    expect(await node(child as string).textContent()).toBe(
      "From another device",
    );
    await call("remove", child as string);
    await node(child as string).waitFor({ state: "detached" });
  });

  test("switching projects detaches the previous document", async () => {
    const id = await rootId();
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.waitForFunction((id) => !window.harness.ids().includes(id), id);
    expect((await call("retiredObservers")).every((count) => count === 0)).toBe(
      true,
    );
    await call("editRetired", id, "Stale ");
    await frame();
    expect(await page.getByText("Stale", { exact: false }).count()).toBe(0);
    const next = await rootId();
    await call("edit", next, 0, 0, "Fresh ");
    expect(await node(next).textContent()).toBe("Fresh New idea");
  });
});

describe("text editing", () => {
  test("undo and redo are available in the editor and toolbar", async () => {
    const id = await rootId();
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    expect(await undo.isDisabled()).toBe(true);
    expect(await redo.isDisabled()).toBe(true);

    await edit(id);
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.keyboard.press("Control+z");
    expect(await selection()).toEqual(["New idea", 8, 8]);
    await page.keyboard.press("Control+Shift+z");
    expect((await selection())[0]).toBe("New idea!");
    await page.keyboard.press("Escape");

    await undo.click();
    expect(await node(id).innerText()).toBe("New idea");
    expect(await redo.isEnabled()).toBe(true);
    await redo.click();
    expect(await node(id).innerText()).toBe("New idea!");
    expect(await undo.isEnabled()).toBe(true);
  });

  test("typing, newlines, emoji, and paste become incremental operations", async () => {
    const id = await rootId();
    await edit(id);
    await page.keyboard.press("End");
    call("takeTextDeltas");
    await page.keyboard.type("!?");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.insertText("😀");
    await page.keyboard.press("Backspace");
    await page.evaluate(() => navigator.clipboard.writeText("pasted"));
    await page.keyboard.press("Control+V");
    expect(await call("takeTextDeltas")).toEqual([
      [{ retain: 8 }, { insert: "!" }],
      [{ retain: 9 }, { insert: "?" }],
      [{ retain: 10 }, { insert: "\n" }],
      [{ retain: 11 }, { insert: "😀" }],
      [{ retain: 11 }, { delete: 2 }],
      [{ retain: 11 }, { insert: "pasted" }],
    ]);
    expect(await call("text", id)).toBe("New idea!?\npasted");
    await page.keyboard.press("Enter");
    await editor().waitFor({ state: "detached" });
    expect(await node(id).textContent()).toBe("New idea!?\npasted");
  });

  test("the selection stays on the same characters during remote edits", async () => {
    const id = await rootId();
    await edit(id);
    await page.keyboard.type("hello world");
    await select(5);
    await call("edit", id, 0, 0, "Oh, ");
    expect(await selection()).toEqual(["Oh, hello world", 9, 9]);
    await call("edit", id, 9, 0, "X");
    expect(await selection()).toEqual(["Oh, helloX world", 9, 9]);
    await select(11, 16);
    await call("edit", id, 11, 0, "big ");
    await call("edit", id, 0, 4, "");
    expect(await selection()).toEqual(["helloX big world", 11, 16]);
    await page.keyboard.type("there");
    expect(await call("text", id)).toBe("helloX big there");
  });

  test("composition stays local until committed and keeps remote edits", async () => {
    const id = await rootId();
    await edit(id);
    await page.keyboard.press("End");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "に",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await cdp.send("Input.imeSetComposition", {
      text: "にほ",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await call("edit", id, 0, 0, ">> ");
    expect(await call("text", id)).toBe(">> New idea");
    expect(await selection()).toEqual(["New ideaにほ", 10, 10]);
    await cdp.send("Input.insertText", { text: "日本" });
    expect(await selection()).toEqual([">> New idea日本", 13, 13]);
    expect(await call("text", id)).toBe(">> New idea日本");
    expect(await call("localText", id)).toBe(">> New idea日本");
  });

  test("remote deletion of the node being edited closes the editor", async () => {
    const root = await rootId();
    const child = (await call("addChild", root, "Child")) as string;
    await edit(child);
    await page.keyboard.type("abc");
    expect(await call("text", child)).toBe("abc");
    await call("remove", child);
    await editor().waitFor({ state: "detached" });
    await node(child).waitFor({ state: "detached" });
    expect(await page.locator("[data-selected=true]").count()).toBe(0);
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
    ).toBe("Mind map canvas");
    await page.keyboard.type("zz");
    expect(await call("ids")).toEqual([root]);
    expect(await call("deleted", child)).toBe(true);
  });
});

describe("dragging", () => {
  test("a drag commits once, rebased on remote edits made during it", async () => {
    const root = await rootId();
    const child = (await call("addChild", root, "Child")) as string;
    const grandchild = (await call("addChild", child, "Grandchild")) as string;
    const gone = (await call("addChild", child, "Gone")) as string;
    const start = await translation(child);
    const updates = await call("localUpdates");

    const move = await startDrag(child);
    await move(40, 10);
    await call("edit", child, 0, 0, "Remote ");
    await call("place", grandchild, 500, 300);
    await call("remove", gone);
    await move(100, 40);
    expect(await translation(child)).toEqual({
      x: start.x + 100,
      y: start.y + 40,
    });
    expect(await call("localUpdates")).toBe(updates);
    await page.mouse.up();

    expect(await call("localUpdates")).toBe(updates + 1);
    expect(await call("position", child)).toEqual({
      x: start.x + 100,
      y: start.y + 40,
    });
    expect(await call("position", grandchild)).toEqual({
      x: 600,
      y: 340,
    });
    expect(await call("text", child)).toBe("Remote Child");
    expect(await call("deleted", gone)).toBe(true);
    expect(await call("position", gone)).toBeUndefined();
  });

  test("Escape and pointercancel discard only the preview", async () => {
    const root = await rootId();
    const start = await translation(root);
    const updates = await call("localUpdates");

    let move = await startDrag(root);
    await move(80, 30);
    await call("edit", root, 0, 0, "Remote ");
    const child = (await call("addChild", root, "Remote child")) as string;
    await page.keyboard.press("Escape");
    expect(await translation(root)).toEqual(start);
    await page.mouse.up();

    move = await startDrag(root);
    await move(-60, 20);
    await page.evaluate(() =>
      document
        .querySelector("[aria-label='Mind map canvas']")
        ?.dispatchEvent(
          new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
        ),
    );
    expect(await translation(root)).toEqual(start);
    await page.mouse.up();

    expect(await call("localUpdates")).toBe(updates);
    expect(await call("position", root)).toBeUndefined();
    expect(await node(root).textContent()).toBe("Remote New idea");
    expect(await node(child).textContent()).toBe("Remote child");
  });
});

describe("existing interactions", () => {
  test("automatically saves edits and restores the UUID project after reload", async () => {
    const id = await rootId();
    await node(id).dblclick();
    await editor().fill("Saved without pressing Save");
    expect(await node(id).textContent()).toContain(
      "Saved without pressing Save",
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="status"]')].some(
        (element) => element.textContent?.trim() === "Saved locally",
      ),
    );
    await page.reload();
    await page.waitForSelector('[data-storage-ready="true"]');
    expect(
      await page.locator("[data-node-id]").first().textContent(),
    ).toContain("Saved without pressing Save");
  });

  test("add, edit, navigate, reorder, delete, undo, and zoom", async () => {
    const root = await rootId();
    await node(root).click();
    await page.keyboard.press("Tab");
    await page.keyboard.type("First");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second");
    await page.keyboard.press("Enter");
    const [, first, second] = await call("ids");
    expect(await call("text", first)).toBe("First");
    expect(await call("text", second)).toBe("Second");

    await page.keyboard.press("ArrowUp");
    expect(await node(first).getAttribute("data-selected")).toBe("true");
    await page.keyboard.press("Control+ArrowDown");
    expect(await call("ids")).toEqual([root, second, first]);
    await page.keyboard.press("Delete");
    expect(await call("ids")).toEqual([root, second]);
    await page.keyboard.press("Control+z");
    expect(await call("ids")).toEqual([root, second, first]);
    expect(await node(first).getAttribute("data-selected")).toBe("true");
    await page.keyboard.press("Control+z");
    expect(await call("ids")).toEqual([root, first, second]);
    await page.keyboard.press("Control+z");
    expect(await call("text", second)).toBe("New idea");

    await page.getByRole("button", { name: "Zoom in" }).click();
    expect(
      await page.getByRole("button", { name: "Reset view" }).textContent(),
    ).toBe("120%");
  });
});

async function uploadProject(json: string) {
  await page.evaluate(() =>
    Object.defineProperty(window, "showOpenFilePicker", {
      value: undefined,
      configurable: true,
    }),
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await (await chooser).setFiles({
    name: "Portable.mindgrab.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLFieldSetElement>(
        'fieldset[aria-label="Project actions"]',
      )?.disabled,
  );
}

async function downloadProject() {
  await page.evaluate(() =>
    Object.defineProperty(window, "showSaveFilePicker", {
      value: undefined,
      configurable: true,
    }),
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const saved = await download;
  const path = await saved.path();
  if (!path) throw new Error("No downloaded file.");
  return { name: saved.suggestedFilename(), json: await Bun.file(path).text() };
}

describe("portable file actions", () => {
  test("downloads offline edits and uploads twice with fresh identities and empty undo stacks", async () => {
    await page.getByRole("textbox", { name: "Project name" }).fill("Portable");
    const originalId = await call("projectId");
    const root = await rootId();
    await edit(root);
    await editor().fill("Offline\nHäid mõtteid 😀 日本語");
    await page.keyboard.press("Escape");
    await call("addChild", root, "Child");
    await call("place", root, -30, 80);
    await context.setOffline(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    const saved = await downloadProject();
    expect(saved.name).toBe("Portable.mindgrab.json");
    const file = JSON.parse(saved.json);
    expect(file.format).toBe("mindgrab-project");
    expect(file.version).toBe(2);
    expect(file.project.nodes[0].text).toBe("Offline\nHäid mõtteid 😀 日本語");
    expect(file.project.nodes[0].position).toEqual({ x: -30, y: 80 });
    const originalNodes = await call("ids");

    await uploadProject(saved.json);
    const firstId = await call("projectId");
    const firstNodes = await call("ids");
    expect(firstId).not.toBe(originalId);
    expect(firstNodes.every((id) => !originalNodes.includes(id))).toBe(true);
    expect(
      await page
        .getByRole("button", { name: "Undo", exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(
      await page
        .getByRole("button", { name: "Redo", exact: true })
        .isDisabled(),
    ).toBe(true);

    await uploadProject(saved.json);
    const secondId = await call("projectId");
    const secondNodes = await call("ids");
    expect(new Set([originalId, firstId, secondId]).size).toBe(3);
    expect(secondNodes.every((id) => !firstNodes.includes(id))).toBe(true);
    await edit(secondNodes[0]);
    await editor().fill("Only the second import");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await page.locator("#saved-projects").waitFor();
    expect(
      await page.getByRole("button", { name: /^Portable · / }).count(),
    ).toBe(3);
    await page
      .getByRole("button", {
        name: `Portable · ${firstId.slice(0, 8)}`,
        exact: true,
      })
      .click();
    await page.waitForFunction(
      (id) => window.harness.projectId() === id,
      firstId,
    );
    expect(await call("text", firstNodes[0])).toBe(
      "Offline\nHäid mõtteid 😀 日本語",
    );
    expect(
      await page
        .getByRole("button", { name: "Undo", exact: true })
        .isDisabled(),
    ).toBe(true);
  });

  test("a truncated file leaves the active project and catalog unchanged", async () => {
    const id = await call("projectId");
    const before = await call("content");
    await uploadProject('{"format":');
    expect(await call("projectId")).toBe(id);
    expect(await call("content")).toEqual(before);
    expect(
      await page.getByText("Project file is not valid JSON.").count(),
    ).toBe(1);
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await page.locator("#saved-projects").waitFor();
    expect(await page.locator("#saved-projects li").count()).toBe(1);
  });

  test("failed IndexedDB catalog writes preserve the active project and remove the imported seed", async () => {
    const saved = await downloadProject();
    const id = await call("projectId");
    const before = await call("content");
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      Object.assign(window, {
        restoreWrites: () => {
          IDBObjectStore.prototype.put = original;
        },
      });
      IDBObjectStore.prototype.put = function (...args) {
        const request = original.apply(this, args);
        if (this.name === "projects")
          request.addEventListener("success", () => this.transaction.abort());
        return request;
      };
    });
    await uploadProject(saved.json);
    await page.evaluate(() =>
      (window as unknown as { restoreWrites(): void }).restoreWrites(),
    );
    expect(await call("projectId")).toBe(id);
    expect(await call("content")).toEqual(before);
    expect(
      await page.getByText("The browser did not commit the change.").count(),
    ).toBe(1);
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await page.locator("#saved-projects").waitFor();
    expect(await page.locator("#saved-projects li").count()).toBe(1);
  });

  test("Export stays usable when browser persistence cannot open", async () => {
    await context.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        get() {
          throw new DOMException("Unavailable", "SecurityError");
        },
      });
    });
    await page.reload();
    await page
      .getByText("Browser storage is unavailable.", { exact: true })
      .waitFor();
    expect(
      await page
        .getByRole("button", { name: "Export", exact: true })
        .isEnabled(),
    ).toBe(true);
    const saved = await downloadProject();
    expect(JSON.parse(saved.json).project.nodes[0].text).toBe("New idea");
  });
});
