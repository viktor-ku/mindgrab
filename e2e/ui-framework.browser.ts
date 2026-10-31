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
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import type { Harness } from "./harness";

// Interaction-framework behaviors from docs/ui-framework.md: deletion and moves
// with undo notices, structure shortcuts, search and focus that restore the
// view, fitting, scrolling, keeping the active node visible, persisted folds
// and layout-independent shortcuts.
setDefaultTimeout(30_000);
const webapp = fileURLToPath(new URL("../webapp", import.meta.url));
const VIEWPORT = { width: 1200, height: 800 };
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
      port: 5196,
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
    viewport: VIEWPORT,
    reducedMotion: "reduce",
  });
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  errors = [];
  page.on("pageerror", (error) => errors.push(error));
  const url = server.resolvedUrls?.local[0] ?? "http://localhost:5196/";
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
const settle = async () => {
  await frame();
  await frame();
};
const selected = () =>
  page.locator("[data-selected=true]").getAttribute("data-node-id");
const zoomLabel = () =>
  page.getByRole("button", { name: "Zoom to 100%" }).textContent();
const notice = (text: string | RegExp) =>
  page.getByRole("status").filter({ hasText: text });

async function addChild(parent: string, text: string) {
  const id = await call("addChild", parent, text);
  if (!id) throw new Error("Child was not created.");
  await node(id).waitFor();
  return id;
}
async function parentOf(id: string) {
  return (await call("content")).nodes.find((node) => node.id === id)?.parent;
}
async function childrenOf(id: string) {
  return (await call("content")).nodes.find((node) => node.id === id)?.children;
}
async function box(id: string) {
  await settle();
  const bounds = await node(id).boundingBox();
  if (!bounds) throw new Error(`Node ${id} is not visible.`);
  return bounds;
}
async function insideViewport(id: string) {
  const bounds = await box(id);
  return (
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= VIEWPORT.width &&
    bounds.y + bounds.height <= VIEWPORT.height
  );
}
// Drags the node's center to a point and drops it there.
async function dragTo(id: string, to: { x: number; y: number }) {
  const from = await box(id);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
}
// A keydown as a non-Latin layout would send it: the typed character differs
// from the physical key.
function pressLayoutKey(
  key: string,
  code: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
) {
  return page.evaluate(
    ([key, code, modifiers]) =>
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        }),
      ),
    [key, code, modifiers] as const,
  );
}

describe("deleting", () => {
  test("selection moves to the next sibling, then the previous, then the parent, and the notice undoes", async () => {
    const root = await rootId();
    const a = await addChild(root, "A");
    const b = await addChild(root, "B");
    const c = await addChild(root, "C");
    await node(b).click();
    await page.keyboard.press("Delete");
    expect(await call("deleted", b)).toBe(true);
    expect(await selected()).toBe(c);
    await notice("Deleted “B”").waitFor();

    await page.keyboard.press("Delete");
    expect(await selected()).toBe(a);
    await notice("Deleted “C”").waitFor();
    await page.keyboard.press("Delete");
    expect(await selected()).toBe(root);
    await notice("Deleted “A”").getByRole("button", { name: "Undo" }).click();
    expect(await call("deleted", a)).toBe(false);
    expect(await notice("Deleted").count()).toBe(0);
    expect(await childrenOf(root)).toEqual([a]);

    const grandchild = await addChild(a, "A1");
    await addChild(grandchild, "A2");
    await node(a).click();
    await page.getByRole("button", { name: "Delete idea" }).click();
    await notice("Deleted “A” and 2 more").waitFor();
    expect(await selected()).toBe(root);
    await notice("Deleted “A” and 2 more")
      .getByRole("button", { name: "Undo" })
      .click();
    expect(await call("ids")).toHaveLength(4);
  });
});

describe("dragging onto ideas", () => {
  test("the middle reparents, the edges place before or after, and each move undoes", async () => {
    const root = await rootId();
    const a = await addChild(root, "A");
    const b = await addChild(root, "B");
    const c = await addChild(root, "C");
    await page.getByRole("button", { name: "Dismiss quick start" }).click();

    const target = await box(a);
    await dragTo(c, {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
    });
    expect(
      await node(c).evaluate((el) => getComputedStyle(el).pointerEvents),
    ).toBe("none");
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
    await notice("Moved “C” under “New idea”").waitFor();

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

  test("a branch cannot be dropped into itself, and empty canvas keeps free placement", async () => {
    const root = await rootId();
    const a = await addChild(root, "A");
    const a1 = await addChild(a, "A1");
    const inner = await box(a1);
    await dragTo(a, {
      x: inner.x + inner.width / 2,
      y: inner.y + inner.height / 2,
    });
    expect(await page.locator(".drag-label").textContent()).toBe(
      "Place here on the canvas",
    );
    await page.mouse.up();
    expect(await parentOf(a)).toBe(root);
    expect(await parentOf(a1)).toBe(a);
    expect(await call("position", a)).toBeDefined();
    expect(await notice("Moved").count()).toBe(0);
  });
});

describe("structure shortcuts", () => {
  test("Ctrl+Right indents, Ctrl+Left outdents, and Shift+Tab inserts a parent", async () => {
    const root = await rootId();
    const a = await addChild(root, "A");
    const b = await addChild(root, "B");
    await node(a).click();
    await page.keyboard.press("Control+ArrowRight");
    expect(await parentOf(a)).toBe(root);
    await node(b).click();
    await page.keyboard.press("Control+ArrowRight");
    expect(await parentOf(b)).toBe(a);
    expect(await selected()).toBe(b);
    await notice("Moved “B” under “A”").waitFor();
    await page.keyboard.press("Control+ArrowLeft");
    expect(await childrenOf(root)).toEqual([a, b]);
    expect(await selected()).toBe(b);

    await page.keyboard.press("Shift+Tab");
    await editor().waitFor();
    const wrapper = await parentOf(b);
    if (!wrapper) throw new Error("No parent was inserted.");
    expect(wrapper).not.toBe(root);
    expect(await parentOf(wrapper)).toBe(root);
    expect(await childrenOf(root)).toEqual([a, wrapper]);
    expect(await editor().inputValue()).toBe("New idea");
    await editor().fill("Wrapper");
    await page.keyboard.press("Enter");
    expect(await call("text", wrapper)).toBe("Wrapper");

    await page.keyboard.press("ControlOrMeta+z");
    expect(await call("text", wrapper)).toBe("New idea");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await childrenOf(root)).toEqual([a, b]);
    expect(await call("deleted", wrapper)).toBe(true);
  });

  test("the context menu offers the same structure actions", async () => {
    const root = await rootId();
    const a = await addChild(root, "A");
    const b = await addChild(root, "B");
    await node(b).click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Node actions" });
    expect(
      await menu.getByRole("menuitem", { name: /Move out/ }).isEnabled(),
    ).toBe(true);
    await menu.getByRole("menuitem", { name: /Move under idea above/ }).click();
    expect(await parentOf(b)).toBe(a);
    await node(a).click({ button: "right" });
    expect(
      await menu
        .getByRole("menuitem", { name: /Move under idea above/ })
        .isDisabled(),
    ).toBe(true);
    await menu.getByRole("menuitem", { name: /Insert parent/ }).click();
    await editor().waitFor();
    expect(await parentOf(a)).not.toBe(root);
  });
});

describe("search", () => {
  async function foldedTree() {
    const root = await rootId();
    const a = await addChild(root, "Alpha");
    const needle = await addChild(a, "Needle one");
    const b = await addChild(root, "Beta");
    const second = await addChild(b, "Needle two");
    for (const id of [a, b]) {
      await node(id).click();
      await page.keyboard.press("g");
    }
    await node(root).click();
    await node(needle).waitFor({ state: "detached" });
    return { root, a, b, needle, second };
  }

  test("previewing results unfolds and selects them, Escape restores folds and selection", async () => {
    const { root, a, b, needle, second } = await foldedTree();
    await page.keyboard.press("/");
    const field = page.getByRole("searchbox", { name: "Search ideas" });
    await field.waitFor();
    await field.fill("needle");
    const results = page.getByRole("listbox", { name: "Search results" });
    expect(await results.getByRole("option").count()).toBe(2);
    await node(needle).waitFor();
    expect(await selected()).toBe(needle);
    expect(await node(a).getAttribute("data-collapsed")).toBe("false");
    expect(await node(b).getAttribute("data-collapsed")).toBe("true");

    await field.press("ArrowDown");
    await node(second).waitFor();
    expect(await selected()).toBe(second);
    // Moving between results does not accumulate unfolded branches.
    expect(await node(a).getAttribute("data-collapsed")).toBe("true");
    expect(await node(needle).count()).toBe(0);

    await field.press("Escape");
    await field.waitFor({ state: "detached" });
    expect(await selected()).toBe(root);
    for (const id of [a, b])
      expect(await node(id).getAttribute("data-collapsed")).toBe("true");
    expect(await node(second).count()).toBe(0);
  });

  test("Enter keeps the result and Mod+F opens search", async () => {
    const { b, second } = await foldedTree();
    await page.keyboard.press("ControlOrMeta+f");
    const field = page.getByRole("searchbox", { name: "Search ideas" });
    await field.waitFor();
    await field.fill("two");
    await field.press("Enter");
    await field.waitFor({ state: "detached" });
    expect(await selected()).toBe(second);
    expect(await node(b).getAttribute("data-collapsed")).toBe("false");
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
    ).toBe("Mind map canvas");

    await page.keyboard.press("/");
    await field.fill("nothing like this");
    await page.getByText("No ideas match", { exact: false }).waitFor();
    await field.press("Enter");
    await field.waitFor({ state: "detached" });
    expect(await selected()).toBe(second);
  });
});

describe("branch focus", () => {
  test("F focuses a branch with breadcrumbs, Escape clears the selection and then leaves focus", async () => {
    const root = await rootId();
    const a = await addChild(root, "Alpha");
    const a1 = await addChild(a, "Alpha one");
    const b = await addChild(root, "Beta");
    await node(a).click();
    await page.keyboard.press("f");
    const breadcrumbs = page.getByRole("navigation", { name: "Branch focus" });
    await breadcrumbs.waitFor();
    expect(
      await breadcrumbs.locator('[aria-current="location"]').textContent(),
    ).toBe("Alpha");
    await breadcrumbs.getByRole("button", { name: "New idea" }).waitFor();
    await node(b).waitFor({ state: "detached" });
    expect(await node(root).count()).toBe(0);
    expect(await node(a1).count()).toBe(1);

    await page.keyboard.press("Escape");
    expect(await page.locator("[data-selected=true]").count()).toBe(0);
    expect(await breadcrumbs.count()).toBe(1);
    await page.keyboard.press("Escape");
    await breadcrumbs.waitFor({ state: "detached" });
    await node(b).waitFor();

    await node(a1).click();
    await page
      .getByRole("region", { name: "Selected idea" })
      .getByRole("button", { name: "More actions" })
      .click();
    expect(
      await page
        .getByRole("menuitem", { name: /Focus on this branch/ })
        .count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    await node(a).click();
    await page.getByRole("button", { name: "Focus branch" }).click();
    await breadcrumbs.waitFor();
    expect(
      await page.getByRole("button", { name: "Leave focus" }).count(),
    ).toBe(1);
    await breadcrumbs.getByRole("button", { name: "Whole map" }).click();
    await breadcrumbs.waitFor({ state: "detached" });
    await node(b).waitFor();
    expect(await selected()).toBe(a);
  });
});

describe("view controls", () => {
  test("Fit map and Fit selection zoom so their content fits", async () => {
    const root = await rootId();
    const near = await addChild(root, "Near");
    const far = await addChild(root, "Far away");
    await call("place", far, 1800, 1400);
    await node(near).click();
    await settle();
    expect(await insideViewport(far)).toBe(false);

    await page.getByRole("button", { name: "Fit map" }).click();
    for (const id of [root, near, far])
      expect(await insideViewport(id)).toBe(true);
    const fitted = Number.parseInt((await zoomLabel()) ?? "", 10);
    expect(fitted).toBeLessThan(100);

    await page.getByRole("button", { name: "Zoom to 100%" }).click();
    // Zooming keeps the selected idea still.
    expect(await zoomLabel()).toBe("100%");
    expect(await insideViewport(near)).toBe(true);
    await page.getByRole("button", { name: "Fit selection" }).click();
    expect(await zoomLabel()).toBe("150%");
    expect(await insideViewport(near)).toBe(true);
    expect(await insideViewport(far)).toBe(false);

    await page.keyboard.press("Shift+Digit1");
    expect(await zoomLabel()).toBe(`${fitted}%`);
    await page.keyboard.press("ControlOrMeta+0");
    expect(await zoomLabel()).toBe("100%");
    await page.keyboard.press("ControlOrMeta+Equal");
    expect(await zoomLabel()).toBe("120%");
    await page.keyboard.press("ControlOrMeta+Minus");
    expect(await zoomLabel()).toBe("100%");
  });

  test("plain wheel pans, pinch zooms around the pointer, and the preference makes the wheel zoom", async () => {
    const root = await rootId();
    const before = await box(root);
    await page.mouse.move(200, 200);
    await page.mouse.wheel(30, 100);
    const panned = await box(root);
    expect(panned.x).toBeCloseTo(before.x - 30, 0);
    expect(panned.y).toBeCloseTo(before.y - 100, 0);
    expect(await zoomLabel()).toBe("100%");

    const center = {
      x: panned.x + panned.width / 2,
      y: panned.y + panned.height / 2,
    };
    await page.mouse.move(center.x, center.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -30);
    await page.keyboard.up("Control");
    expect(Number.parseInt((await zoomLabel()) ?? "", 10)).toBeGreaterThan(100);
    const zoomed = await box(root);
    expect(zoomed.width).toBeGreaterThan(panned.width);
    // The point under the pointer stays put.
    expect(Math.abs(zoomed.x + zoomed.width / 2 - center.x)).toBeLessThan(2);
    expect(Math.abs(zoomed.y + zoomed.height / 2 - center.y)).toBeLessThan(2);

    await page
      .getByRole("button", { name: "Keyboard shortcuts and navigation" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Shortcuts and navigation",
    });
    await dialog.waitFor();
    await dialog.getByRole("radio", { name: /Scroll zooms/ }).check();
    expect(
      await page.evaluate(() => localStorage.getItem("mindgrab:wheel-mode")),
    ).toBe("zoom");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    const label = await zoomLabel();
    await page.mouse.move(200, 200);
    await page.mouse.wheel(0, 100);
    expect(await zoomLabel()).not.toBe(label);

    await page.reload();
    await ready();
    await page
      .getByRole("button", { name: "Keyboard shortcuts and navigation" })
      .click();
    expect(
      await dialog.getByRole("radio", { name: /Scroll zooms/ }).isChecked(),
    ).toBe(true);
  });

  test("the view follows ideas added past the edge of the screen", async () => {
    const root = await rootId();
    await node(root).click();
    await page.keyboard.press("Tab");
    await page.keyboard.type("Item 0");
    await page.keyboard.press("Enter");
    for (let index = 1; index < 18; index++) {
      await page.keyboard.press("Enter");
      await editor().waitFor();
      await page.keyboard.type(`Item ${index}`);
      await page.keyboard.press("Enter");
    }
    const ids = await call("ids");
    expect(ids).toHaveLength(19);
    const last = ids[ids.length - 1];
    expect(await selected()).toBe(last);
    expect(await insideViewport(last)).toBe(true);
    // The children span more than the screen height, so the first one is off it.
    expect(await insideViewport(ids[1])).toBe(false);

    await page.keyboard.press("ArrowLeft");
    expect(await selected()).toBe(root);
    expect(await insideViewport(root)).toBe(true);
  });

  test("the quick start can be dismissed for good", async () => {
    const hint = page.getByRole("complementary", { name: "Getting started" });
    await hint.waitFor();
    await hint.getByRole("button", { name: "Dismiss quick start" }).click();
    await hint.waitFor({ state: "detached" });
    await page.reload();
    await ready();
    expect(await hint.count()).toBe(0);
  });
});

describe("persistence and layouts", () => {
  test("folded branches survive reopening the project", async () => {
    const root = await rootId();
    const a = await addChild(root, "Alpha");
    const a1 = await addChild(a, "Alpha one");
    const b = await addChild(root, "Beta");
    await addChild(b, "Beta one");
    await node(a).click();
    await page.keyboard.press("g");
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

  test("undo, redo and fold follow physical keys on a Cyrillic layout", async () => {
    const root = await rootId();
    await node(root).click();
    await page.keyboard.press("Tab");
    await page.keyboard.type("Child");
    await page.keyboard.press("Enter");
    const child = (await call("ids"))[1];
    expect(await call("text", child)).toBe("Child");
    const mod = { ctrlKey: true };

    await pressLayoutKey("я", "KeyZ", mod);
    expect(await call("text", child)).toBe("New idea");
    await pressLayoutKey("я", "KeyZ", mod);
    expect(await call("deleted", child)).toBe(true);
    await pressLayoutKey("Я", "KeyZ", { ...mod, shiftKey: true });
    expect(await call("deleted", child)).toBe(false);

    await node(root).click();
    await pressLayoutKey("п", "KeyG");
    expect(await node(root).getAttribute("data-collapsed")).toBe("true");
    await pressLayoutKey("п", "KeyG");
    expect(await node(root).getAttribute("data-collapsed")).toBe("false");
  });
});
