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
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import { PROJECT_FILE_VERSION } from "../webapp/src/project-import-export";
import type { Harness } from "./harness";

// The editor in headless Chromium. The harness page mounts the app with a
// linked in-process replica acting as another device.
setDefaultTimeout(30_000);
const webapp = fileURLToPath(new URL("../webapp", import.meta.url));
let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: Error[];

beforeAll(async () => {
  server = await createServer({
    root: webapp,
    configFile: `${webapp}/vite.config.ts`,
    cacheDir: "node_modules/.vite-browser-tests",
    logLevel: "error",
    server: {
      port: 5199,
      strictPort: false,
      fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    },
    optimizeDeps: { entries: [`${import.meta.dir}/harness.html`] },
  });
  await server.listen();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

beforeEach(async () => {
  // Reduced motion turns off view easing, so geometry is final after a frame.
  context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
    reducedMotion: "reduce",
  });
  page = await context.newPage();
  errors = [];
  page.on("pageerror", (error) => errors.push(error));
  const url = server.resolvedUrls?.local[0] ?? "http://localhost:5199/";
  await page.goto(new URL(`/@fs/${import.meta.dir}/harness.html`, url).href);
  await ready();
});

afterEach(async () => {
  expect(errors).toEqual([]);
  await context.close();
});

async function ready() {
  await page.waitForSelector('[data-storage-ready="true"]');
  await page.waitForSelector("[data-node-id]");
}

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
const selected = () =>
  page.locator("[data-selected=true]").getAttribute("data-node-id");
const activeLabel = () =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
const notice = (text: string | RegExp) =>
  page.getByRole("status").filter({ hasText: text });
const nodeData = async (id: string) =>
  (await call("content")).nodes.find((node) => node.id === id);
const textOf = async (id: string) => (await nodeData(id))?.text;
const parentOf = async (id: string) => (await nodeData(id))?.parent;
const childrenOf = async (id: string) => (await nodeData(id))?.children;
const idWithText = async (text: string) =>
  (await call("content")).nodes.find((node) => node.text === text)?.id;

async function addChild(parent: string, text: string) {
  const id = await call("addChild", parent, text);
  if (!id) throw new Error("Child was not created.");
  await node(id).waitFor();
  return id;
}
async function edit(id: string) {
  await node(id).dblclick();
  await editor().waitFor();
}
async function box(id: string) {
  await frame();
  await frame();
  const bounds = await node(id).boundingBox();
  if (!bounds) throw new Error(`Node ${id} is not visible.`);
  return bounds;
}
async function translation(id: string) {
  const transform = await node(id).evaluate((el) => el.style.transform);
  const [x, y] = (transform.match(/-?[\d.]+/g) ?? []).map(Number);
  return { x, y };
}
// Presses the node's center and returns a function that moves the pointer by
// an offset from there.
async function startDrag(id: string) {
  const start = await box(id);
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return async (dx: number, dy: number) =>
    page.mouse.move(x + dx, y + dy, { steps: 4 });
}
// Drags the node's center to a point, without dropping it.
async function dragTo(id: string, to: { x: number; y: number }) {
  const from = await box(id);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
}
async function projectMenu(item: string) {
  await page.getByRole("button", { name: "Project menu" }).click();
  // Menu item names include their shortcut hints, such as "Save now ⌘S".
  await page.getByRole("menuitem", { name: item }).first().click();
}
function clipboard(type: "copy" | "cut" | "paste", text = "") {
  return page.evaluate(
    ([type, text]) => {
      const data = new DataTransfer();
      if (text) data.setData("text/plain", text);
      document.querySelector("[aria-label='Mind map canvas']")?.dispatchEvent(
        new ClipboardEvent(type, {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
      return data.getData("text/plain");
    },
    [type, text] as const,
  );
}
// The notes editor reads a click's caret a moment later; waits until it has.
const caretIn = (text: string) =>
  page.waitForFunction((text) => {
    const editor = document.querySelector<
      HTMLElement & {
        editor?: {
          state: {
            selection: {
              $from: {
                parent: {
                  textBetween(
                    from: number,
                    to: number,
                    block: string,
                    leaf: string,
                  ): string;
                  content: { size: number };
                };
              };
            };
          };
        };
      }
    >('[aria-label="Idea notes"]')?.editor;
    const parent = editor?.state.selection.$from.parent;
    return parent?.textBetween(0, parent.content.size, "", "\n") === text;
  }, text);
async function foldedTree() {
  const root = await rootId();
  const a = await addChild(root, "Alpha");
  const needle = await addChild(a, "Needle one");
  const b = await addChild(root, "Beta");
  const second = await addChild(b, "Needle two");
  for (const id of [a, b]) {
    await node(id).click();
    await page.keyboard.press("Alt+g");
  }
  await node(root).click();
  await node(needle).waitFor({ state: "detached" });
  return { root, a, b, needle, second };
}
async function uploadProject(json: string) {
  await page.evaluate(() =>
    Object.defineProperty(window, "showOpenFilePicker", {
      value: undefined,
      configurable: true,
    }),
  );
  const previous = await call("projectId");
  const chooser = page.waitForEvent("filechooser");
  await projectMenu("Import backup…");
  await (await chooser).setFiles({
    name: "Portable.mindgrab.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await page.waitForFunction(
    (id) => window.harness.projectId() !== id,
    previous,
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
  await projectMenu("Export backup (.json)");
  const saved = await download;
  const path = await saved.path();
  if (!path) throw new Error("No downloaded file.");
  return { name: saved.suggestedFilename(), json: await Bun.file(path).text() };
}

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
    await page.getByRole("button", { name: "Zoom to 100%" }).textContent(),
  ).toBe("120%");
});

test("typing replaces the selected idea, Tab and Shift+Tab keep capturing, and Enter on a central idea adds a child", async () => {
  const root = await rootId();
  expect(await selected()).toBe(root);
  await page.keyboard.type("Plan");
  await editor().waitFor();
  await page.keyboard.press("Tab");
  await page.keyboard.type("Step");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("Phase");
  await page.keyboard.press("Escape");
  expect(await textOf(root)).toBe("Plan");
  const phase = (await idWithText("Phase")) as string;
  const step = (await idWithText("Step")) as string;
  expect(await parentOf(phase)).toBe(root);
  expect(await parentOf(step)).toBe(phase);

  await node(root).click();
  await page.keyboard.press("Enter");
  await editor().waitFor();
  await page.keyboard.type("Second");
  await page.keyboard.press("Escape");
  expect(await parentOf((await idWithText("Second")) as string)).toBe(root);
  expect((await call("content")).roots).toHaveLength(1);

  // With an idea selected even shortcut characters type into it; with
  // nothing selected "/" opens search.
  await node(root).click();
  await page.keyboard.type("/?!");
  await page.keyboard.press("Escape");
  expect(await textOf(root)).toBe("/?!");
  await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  await page.getByRole("searchbox", { name: "Search ideas" }).waitFor();
});

test("typing, newlines, emoji, and paste become incremental operations", async () => {
  const id = await rootId();
  await edit(id);
  await page.keyboard.press("End");
  await page.keyboard.type("!?");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("😀");
  await page.keyboard.press("Backspace");
  await page.evaluate(() => navigator.clipboard.writeText("pasted"));
  await page.keyboard.press("ControlOrMeta+V");
  expect(await call("text", id)).toBe("New idea!?\npasted");
  await page.keyboard.press("Enter");
  await editor().waitFor({ state: "detached" });
  expect(await node(id).textContent()).toBe("New idea!?\npasted");
});

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
  const moved = await translation(child);
  expect(moved.x).toBeCloseTo(start.x + 100, 2);
  expect(moved.y).toBeCloseTo(start.y + 40, 2);
  expect(await call("localUpdates")).toBe(updates);
  await page.mouse.up();

  expect(await call("localUpdates")).toBe(updates + 1);
  const placed = await call("position", child);
  expect(placed?.x).toBeCloseTo(start.x + 100, 2);
  expect(placed?.y).toBeCloseTo(start.y + 40, 2);
  expect(await call("position", grandchild)).toEqual({
    x: 600,
    y: 340,
  });
  expect(await call("text", child)).toBe("Remote Child");
  expect(await call("deleted", gone)).toBe(true);
  expect(await call("position", gone)).toBeUndefined();
});

test("dropping onto an idea's middle reparents, its edges place before or after, and each move undoes", async () => {
  const root = await rootId();
  const a = await addChild(root, "A");
  const b = await addChild(root, "B");
  const c = await addChild(root, "C");

  const target = await box(a);
  await dragTo(c, {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  });
  await page.getByText("Move under “A”", { exact: true }).waitFor();
  await page.mouse.up();
  expect(await parentOf(c)).toBe(a);
  expect(await selected()).toBe(c);
  expect(await call("position", c)).toBeUndefined();
  await notice("Moved “C” under “A”")
    .getByRole("button", { name: "Undo" })
    .click();
  expect(await parentOf(c)).toBe(root);
  expect(await childrenOf(root)).toEqual([a, b, c]);

  const first = await box(a);
  await dragTo(c, { x: first.x + first.width / 2, y: first.y + 3 });
  await page.getByText("Move before “A”", { exact: true }).waitFor();
  await page.mouse.up();
  expect(await childrenOf(root)).toEqual([c, a, b]);

  const second = await box(a);
  await dragTo(c, {
    x: second.x + second.width / 2,
    y: second.y + second.height - 3,
  });
  await page.getByText("Move after “A”", { exact: true }).waitFor();
  await page.mouse.up();
  expect(await childrenOf(root)).toEqual([a, c, b]);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await childrenOf(root)).toEqual([c, a, b]);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await childrenOf(root)).toEqual([a, b, c]);
});

test("search finds an idea inside a folded branch and Enter keeps it", async () => {
  const { b, second } = await foldedTree();
  await page.keyboard.press("ControlOrMeta+f");
  const field = page.getByRole("searchbox", { name: "Search ideas" });
  await field.waitFor();
  await field.fill("two");
  await field.press("Enter");
  await field.waitFor({ state: "detached" });
  expect(await selected()).toBe(second);
  expect(await node(b).getAttribute("data-collapsed")).toBe("false");
  expect(await activeLabel()).toBe("Mind map canvas");
});

test("folded branches survive reopening the project", async () => {
  const root = await rootId();
  const a = await addChild(root, "Alpha");
  const a1 = await addChild(a, "Alpha one");
  const b = await addChild(root, "Beta");
  await addChild(b, "Beta one");
  await node(a).click();
  await page.keyboard.press("Alt+g");
  await node(a1).waitFor({ state: "detached" });
  const project = await call("projectId");
  // The view preference is written shortly after the last change.
  await page.waitForTimeout(600);

  await page.reload();
  await ready();
  expect(await call("projectId")).toBe(project);
  await node(a).waitFor();
  expect(await node(a).getAttribute("data-collapsed")).toBe("true");
  expect(await node(b).getAttribute("data-collapsed")).toBe("false");
  expect(await node(a1).count()).toBe(0);
});

test("notes are rich text kept as Markdown, with a toolbar, shortcuts, undo and remote edits", async () => {
  const root = await rootId();
  await node(root).click();
  await page.keyboard.press("Alt+n");
  const notes = page.getByRole("textbox", { name: "Idea notes" });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Idea notes",
  );
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  const bold = toolbar.getByRole("button", { name: "Bold" });

  // The toolbar formats what comes next and gives the keyboard back.
  await bold.click();
  expect(await activeLabel()).toBe("Idea notes");
  expect(await bold.getAttribute("aria-pressed")).toBe("true");
  await page.keyboard.type("Plan");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type(" for the week");
  expect(await bold.getAttribute("aria-pressed")).toBe("false");
  expect(await call("note", root)).toBe("**Plan** for the week");

  // Markdown shortcuts start lists; the toolbar switches their kind.
  await page.keyboard.press("Enter");
  await page.keyboard.type("- Monday");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Tuesday");
  expect(await call("note", root)).toBe(
    "**Plan** for the week\n\n- Monday\n- Tuesday",
  );
  await toolbar.getByRole("button", { name: "Numbered list" }).click();
  expect(
    await toolbar
      .getByRole("button", { name: "Numbered list" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(await call("note", root)).toBe(
    "**Plan** for the week\n\n1. Monday\n2. Tuesday",
  );

  // Sizes are headings.
  await notes
    .locator("p")
    .first()
    .click({ position: { x: 4, y: 4 } });
  await caretIn("Plan for the week");
  await toolbar
    .getByRole("combobox", { name: "Text size" })
    .selectOption({ label: "Heading 1" });
  expect(await activeLabel()).toBe("Idea notes");
  expect(await call("note", root)).toBe(
    "# **Plan** for the week\n\n1. Monday\n2. Tuesday",
  );
  expect(await notes.locator("h1").innerText()).toBe("Plan for the week");

  // Undo is the map's: it steps the note back and keeps the writer there.
  await page.keyboard.press("ControlOrMeta+z");
  expect(await call("note", root)).toBe(
    "**Plan** for the week\n\n1. Monday\n2. Tuesday",
  );
  expect(await notes.locator("h1").count()).toBe(0);
  expect(await activeLabel()).toBe("Idea notes");

  // Another device's edit shows without moving the caret.
  await notes.locator("li").last().click();
  await caretIn("Tuesday");
  await page.keyboard.press("End");
  await call("editNote", root, 0, 0, "Agenda\n\n");
  await notes.locator("p", { hasText: "Agenda" }).waitFor();
  await page.keyboard.type(" and Wednesday");
  expect(await call("note", root)).toBe(
    "Agenda\n\n**Plan** for the week\n\n1. Monday\n2. Tuesday and Wednesday",
  );
});

test("branches copy as outlines and indented text pastes as a branch", async () => {
  const root = await rootId();
  const child = await addChild(root, "Trip");
  await addChild(child, "Flights");
  await node(child).click();
  expect(await clipboard("copy")).toBe("- Trip\n  - Flights");

  await node(root).click();
  await clipboard("paste", "# Packing\n- Clothes\n  - Socks\n- Camera");
  await notice(/Pasted 4 ideas under/).waitFor();
  const packing = (await idWithText("Packing")) as string;
  expect(await parentOf(packing)).toBe(root);
  expect(await parentOf((await idWithText("Clothes")) as string)).toBe(packing);
  expect(await parentOf((await idWithText("Socks")) as string)).toBe(
    await idWithText("Clothes"),
  );
  await page.keyboard.press("ControlOrMeta+z");
  expect(await idWithText("Packing")).toBeUndefined();

  await node(child).click();
  await clipboard("cut");
  expect(await idWithText("Trip")).toBeUndefined();
});

test("a backup downloads offline and imports twice with fresh identities and empty undo stacks", async () => {
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
  expect(file.version).toBe(PROJECT_FILE_VERSION);
  expect(file.project.nodes[0].text).toBe("Offline\nHäid mõtteid 😀 日本語");
  expect(file.project.nodes[0].position).toEqual({ x: -30, y: 80 });
  const originalNodes = await call("ids");

  await uploadProject(saved.json);
  const firstId = await call("projectId");
  const firstNodes = await call("ids");
  expect(firstId).not.toBe(originalId);
  expect(firstNodes.every((id) => !originalNodes.includes(id))).toBe(true);
  expect(
    await page.getByRole("button", { name: "Undo", exact: true }).count(),
  ).toBe(0);
  expect(
    await page.getByRole("button", { name: "Redo", exact: true }).count(),
  ).toBe(0);

  await uploadProject(saved.json);
  const secondId = await call("projectId");
  const secondNodes = await call("ids");
  expect(new Set([originalId, firstId, secondId]).size).toBe(3);
  expect(secondNodes.every((id) => !firstNodes.includes(id))).toBe(true);
  await edit(secondNodes[0]);
  await editor().fill("Only the second import");
  await page.keyboard.press("Escape");
  await projectMenu("Open map…");
  await page.locator("#saved-projects").waitFor();
  expect(
    await page.getByRole("menuitem", { name: /^Portable · / }).count(),
  ).toBe(3);
  await page
    .getByRole("menuitem", {
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
    await page.getByRole("button", { name: "Undo", exact: true }).count(),
  ).toBe(0);
});
