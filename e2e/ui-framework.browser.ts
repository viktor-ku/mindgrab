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
import type { Browser, BrowserContext, Locator, Page } from "playwright";
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
const activeLabel = () =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
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
  modifiers: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  } = {},
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
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: /^Delete/ }).click();
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
    const menu = page.getByRole("menu", { name: "Idea actions" });
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
      await page.keyboard.press("Alt+g");
    }
    await node(root).click();
    await node(needle).waitFor({ state: "detached" });
    return { root, a, b, needle, second };
  }

  test("previewing results unfolds and selects them, Escape restores folds and selection", async () => {
    const { root, a, b, needle, second } = await foldedTree();
    await page.keyboard.press("ControlOrMeta+f");
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

    await page.keyboard.press("ControlOrMeta+f");
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
    await page.keyboard.press("Alt+f");
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
    await page.getByRole("button", { name: "Focus on this branch" }).click();
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
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: /^Fit selection/ }).click();
    expect(await zoomLabel()).toBe("150%");
    expect(await insideViewport(near)).toBe(true);
    expect(await insideViewport(far)).toBe(false);

    await page.keyboard.press("Alt+Digit1");
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
      .getByRole("button", { name: "Shortcuts and navigation" })
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
      .getByRole("button", { name: "Shortcuts and navigation" })
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
});

describe("persistence and layouts", () => {
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
    await pressLayoutKey("©", "KeyG", { altKey: true });
    expect(await node(root).getAttribute("data-collapsed")).toBe("true");
    await pressLayoutKey("©", "KeyG", { altKey: true });
    expect(await node(root).getAttribute("data-collapsed")).toBe("false");
  });
});

const nodeData = async (id: string) =>
  (await call("content")).nodes.find((node) => node.id === id);
const textOf = async (id: string) => (await nodeData(id))?.text;
const idWithText = async (text: string) =>
  (await call("content")).nodes.find((node) => node.text === text)?.id;
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

describe("Escape layers", () => {
  test("Escape closes only the innermost layer and keeps the selection", async () => {
    const root = await rootId();
    expect(await selected()).toBe(root);

    // The filter only appears once there are enough maps to need it.
    for (let count = 0; count < 7; count++) {
      const previous = await call("projectId");
      await page.getByRole("button", { name: "Project menu" }).click();
      await page.getByRole("menuitem", { name: "New map" }).click();
      await page.waitForFunction(
        (id) => window.harness.projectId() !== id,
        previous,
      );
    }
    const current = await rootId();
    expect(await selected()).toBe(current);
    await page.getByRole("button", { name: "Project menu" }).click();
    const menu = page.getByRole("menu", { name: "Project menu" });
    await page.getByRole("menuitem", { name: "Open map…" }).click();
    const filter = page.getByRole("searchbox", { name: "Filter maps" });
    await filter.fill("nothing matches this");
    await filter.press("Escape");
    expect(await filter.inputValue()).toBe("");
    expect(await menu.isVisible()).toBe(true);
    await filter.press("Escape");
    await menu.waitFor({ state: "hidden" });
    expect(await selected()).toBe(current);

    await page.keyboard.press("Alt+n");
    const notes = page.getByRole("complementary", { name: "Notes" });
    await notes.getByRole("textbox").waitFor();
    await notes.getByRole("textbox").press("Escape");
    await notes.waitFor({ state: "hidden" });
    expect(await selected()).toBe(current);

    await page.getByRole("button", { name: "Color", exact: true }).click();
    const colors = page.getByRole("region", {
      name: "Selected node color controls",
    });
    await colors.getByRole("button").first().focus();
    await page.keyboard.press("Escape");
    await colors.waitFor({ state: "hidden" });
    expect(await selected()).toBe(current);
    expect(await page.evaluate(() => document.activeElement?.ariaLabel)).toBe(
      "Color",
    );
  });
});

describe("capture flow", () => {
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

  test("letters edit instead of running commands; Option shortcuts open the outline and notes", async () => {
    const root = await rootId();
    const child = await addChild(root, "Child");
    await addChild(child, "Grandchild");
    await node(child).click();
    await page.keyboard.type("go");
    await page.keyboard.press("Enter");
    expect(await textOf(child)).toBe("go");
    expect(await node(child).getAttribute("data-collapsed")).toBe("false");
    expect(await page.getByRole("tree").count()).toBe(0);

    await page.keyboard.press("Alt+o");
    const tree = page.getByRole("tree", { name: "Map outline" });
    await tree.waitFor();
    expect(
      await tree
        .getByRole("treeitem", { name: "go", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await tree
      .getByRole("treeitem", { name: "Grandchild", exact: true })
      .locator(".outline-row")
      .click();
    expect(await selected()).toBe((await idWithText("Grandchild")) as string);
    await page.keyboard.press("ArrowLeft");
    expect(await selected()).toBe(child);

    await node(child).click();
    await page.keyboard.press("Alt+n");
    const notes = page.getByRole("textbox", { name: "Idea notes" });
    await notes.waitFor();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Idea notes",
    );
    await page.keyboard.type("Details here");
    expect((await nodeData(child))?.note).toBe("Details here");
    await page.keyboard.press("Escape");
    await notes.waitFor({ state: "detached" });
    await node(child).getByRole("img", { name: "Has notes" }).waitFor();
    // The badge is only an indicator: clicking the idea selects it.
    await node(child).click();
    expect(await notes.count()).toBe(0);
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    expect(await notes.inputValue()).toBe("Details here");
  });
});

describe("clipboard", () => {
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
    expect(await parentOf((await idWithText("Clothes")) as string)).toBe(
      packing,
    );
    expect(await parentOf((await idWithText("Socks")) as string)).toBe(
      await idWithText("Clothes"),
    );
    await page.keyboard.press("ControlOrMeta+z");
    expect(await idWithText("Packing")).toBeUndefined();

    await node(child).click();
    await clipboard("cut");
    expect(await idWithText("Trip")).toBeUndefined();
  });

  test("cut and paste keep notes and colors", async () => {
    const root = await rootId();
    const child = await addChild(root, "Carry");
    await node(child).click();
    await page.keyboard.press("Alt+n");
    await page.getByRole("textbox", { name: "Idea notes" }).fill("keep me");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Color" }).click();
    await page.getByRole("button", { name: /^Violet/ }).click();
    await page.keyboard.press("Escape");
    await clipboard("cut");
    expect(await idWithText("Carry")).toBeUndefined();
    await node(root).click();
    // Plain text only, as when a browser drops the custom clipboard type.
    await clipboard("paste", "- Carry");
    const pasted = (await idWithText("Carry")) as string;
    expect(await nodeData(pasted)).toMatchObject({
      note: "keep me",
      color: "violet",
    });
  });

  test("notices go away once history moves past them", async () => {
    const root = await rootId();
    const child = await addChild(root, "Short lived");
    await node(child).click();
    await page.keyboard.press("Backspace");
    await notice(/Deleted “Short lived”/).waitFor();
    await page.keyboard.press("ControlOrMeta+z");
    await notice(/Deleted “Short lived”/).waitFor({ state: "detached" });
    expect(await idWithText("Short lived")).toBe(child);
  });
});

describe("dialogs, panels and search", () => {
  const ideaCount = async () => (await call("ids")).length;

  test("a dialog keeps the wheel, right-click and keys away from the map", async () => {
    const root = await rootId();
    const before = await box(root);
    await page
      .getByRole("button", { name: "Shortcuts and navigation" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Shortcuts and navigation",
    });
    await dialog.waitFor();
    const list = dialog.locator(".scroll-fade");
    const bounds = await list.boundingBox();
    if (!bounds) throw new Error("The shortcut list is not visible.");
    const inside = { x: bounds.x + 40, y: bounds.y + 40 };
    await page.mouse.move(inside.x, inside.y);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(
      () => (document.querySelector(".scroll-fade")?.scrollTop ?? 0) > 0,
    );
    expect(await box(root)).toEqual(before);

    await page.mouse.click(inside.x, inside.y, { button: "right" });
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(await selected()).toBe(root);

    // Page keys scroll the list; the dialog itself, with its header, stays put.
    await page.keyboard.press("PageDown");
    await page.keyboard.press("ArrowDown");
    expect(
      await dialog.evaluate((element) => [
        element.scrollTop,
        element.scrollHeight - element.clientHeight,
      ]),
    ).toEqual([0, 0]);

    // Mod+S never reaches the browser's "Save page" dialog.
    expect(await pressLayoutKey("s", "KeyS", { ctrlKey: true })).toBe(false);
    const close = dialog.getByRole("button", { name: "Close shortcuts" });
    expect(await close.getAttribute("title")).toBe("Close shortcuts (Esc)");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    // The dialog's close event, which focuses the map again, comes a frame late.
    await settle();
    expect(await activeLabel()).toBe("Mind map canvas");
    expect(await pressLayoutKey("s", "KeyS", { ctrlKey: true })).toBe(false);
    await page.locator(".notice", { hasText: "Saved locally" }).waitFor();
    await page.keyboard.type("x");
    expect(await pressLayoutKey("s", "KeyS", { ctrlKey: true })).toBe(false);
    // In a text field the key only holds the browser back; the edit goes on.
    expect(await editor().count()).toBe(1);
  });

  test("side dialogs share the centered header and offer sign-in when signed out", async () => {
    await page.getByRole("button", { name: "Project menu" }).click();
    await page.getByRole("menuitem", { name: "Share link…" }).click();
    const share = page.getByRole("dialog", { name: "Share" });
    await share.waitFor();
    await share.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    expect(
      await share.evaluate((element) => {
        const header = element.querySelector("header") as HTMLElement;
        const title = header.querySelector("h2") as HTMLElement;
        const body = element.querySelector("header + *") as HTMLElement;
        return {
          bleed: header.offsetWidth - element.clientWidth,
          height: header.offsetHeight,
          title:
            title.getBoundingClientRect().left -
            body.getBoundingClientRect().left,
        };
      }),
    ).toEqual({ bleed: 0, height: 69, title: 0 });
    await share.getByRole("button", { name: "Close sharing" }).click();
    await share.waitFor({ state: "hidden" });
    expect(await activeLabel()).toBe("Mind map canvas");

    // Phones keep the account controls in the menu panel, so it opens instead.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".phone-menu-button").click();
    const panel = page.getByRole("dialog", { name: "Project menu" });
    await panel.getByRole("button", { name: "Share link…" }).click();
    await share.getByRole("button", { name: "Sign in", exact: true }).click();
    await share.waitFor({ state: "hidden" });
    await panel.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  });

  test("Escape closes search from its close button, a toolbar and the map", async () => {
    const root = await rootId();
    const child = await addChild(root, "Needle");
    const field = page.getByRole("searchbox", { name: "Search ideas" });
    const open = async () => {
      await page.keyboard.press("ControlOrMeta+f");
      await field.fill("needle");
      expect(await selected()).toBe(child);
    };

    await node(root).click();
    await open();
    await page.keyboard.press("Tab");
    expect(await activeLabel()).toBe("Close search");
    await page.keyboard.press("Escape");
    await field.waitFor({ state: "detached" });
    expect(await selected()).toBe(root);
    expect(await activeLabel()).toBe("Mind map canvas");

    // A click would hand focus to the map; the keyboard leaves it here.
    await open();
    await page.getByRole("button", { name: "Zoom in" }).focus();
    expect(await activeLabel()).toBe("Zoom in");
    await page.keyboard.press("Escape");
    await field.waitFor({ state: "detached" });
    expect(await selected()).toBe(root);

    // A dialog opened over the search returns to a map that still listens.
    await open();
    await page
      .getByRole("button", { name: "Shortcuts and navigation" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Shortcuts and navigation",
    });
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(await field.count()).toBe(1);
    await page.keyboard.press("Escape");
    await field.waitFor({ state: "detached" });
    await page.keyboard.press("ArrowRight");
    expect(await selected()).toBe(child);

    // Opening an idea's menu is working on the map, which ends the search.
    await open();
    await node(child).click({ button: "right" });
    await page.getByRole("menu").waitFor();
    await field.waitFor({ state: "detached" });
    expect(await selected()).toBe(child);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(await selected()).toBe(child);
  });

  test("Escape closes the outline from its close button and keeps the selection", async () => {
    const root = await rootId();
    await page.keyboard.press("Alt+o");
    const outline = page.getByRole("complementary", { name: "Outline" });
    await outline.waitFor();
    await outline.getByRole("button", { name: "Close outline" }).focus();
    await page.keyboard.press("Escape");
    await outline.waitFor({ state: "hidden" });
    expect(await selected()).toBe(root);
    expect(await activeLabel()).toBe("Mind map canvas");

    // A press on a panel's title keeps focus in the panel, so Esc closes it.
    await page.keyboard.press("Alt+o");
    await page.keyboard.press("Alt+n");
    const notes = page.getByRole("complementary", { name: "Notes" });
    for (const panel of [notes, outline]) {
      await panel.getByRole("heading").click();
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "hidden" });
      expect(await selected()).toBe(root);
      expect(await activeLabel()).toBe("Mind map canvas");
    }
  });

  test("F6 enters panels at their content and reaches the zoom island", async () => {
    await page.keyboard.press("Alt+o");
    await page.keyboard.press("Alt+n");
    const notes = page.getByRole("complementary", { name: "Notes" });
    await notes.getByRole("textbox").waitFor();
    expect(
      await notes
        .getByRole("button", { name: "Close notes" })
        .getAttribute("title"),
    ).toBe("Close notes (Esc)");
    await page.keyboard.press("Escape");
    await notes.waitFor({ state: "hidden" });
    await page.keyboard.press("Alt+n");
    await notes.getByRole("textbox").waitFor();
    await page.locator('[aria-label="Mind map canvas"]').focus();

    // Where focus lands in each region, until the cycle returns to the map.
    const stops: string[] = [];
    for (let presses = 0; presses < 12; presses++) {
      await page.keyboard.press("F6");
      const stop = await page.evaluate(() => {
        const active = document.activeElement;
        const region = active?.closest("[data-toolbar][aria-label]");
        return `${region?.getAttribute("aria-label") ?? "canvas"}: ${active?.getAttribute("role") ?? active?.tagName.toLowerCase()}`;
      });
      if (stop.startsWith("canvas")) break;
      stops.push(stop);
    }
    expect(stops).toContain("Notes: textarea");
    expect(stops).toContain("Outline: treeitem");
    expect(stops).toContain("View and help: button");
  });

  test("ideas are not tab stops, and an arrow key selects the first idea", async () => {
    const root = await rootId();
    const child = await addChild(root, "Child");
    await node(child).click();
    await page.keyboard.press("Alt+g");
    await node(root).click();
    await page.keyboard.press("Alt+g");
    expect(
      await page
        .locator("[data-node-id] button")
        .evaluateAll((buttons) =>
          buttons.map((button) => (button as HTMLElement).tabIndex),
        ),
    ).toEqual([-1, -1]);
    await page.keyboard.press("Alt+g");

    // Tabbing on from the last toolbar button passes the map without adding.
    const count = await ideaCount();
    await page.getByRole("button", { name: "More actions" }).focus();
    await page.keyboard.press("Tab");
    expect(await activeLabel()).toBe("Zoom out");
    await page.keyboard.press("Tab");
    expect(await ideaCount()).toBe(count);

    await page.locator('[aria-label="Mind map canvas"]').focus();
    await page.keyboard.press("Escape");
    expect(await page.locator("[data-selected=true]").count()).toBe(0);
    await page.keyboard.press("ArrowDown");
    expect(await selected()).toBe(root);
    expect(await ideaCount()).toBe(count);
  });

  test("focusing an idea outside the view cannot scroll the canvas", async () => {
    const root = await rootId();
    // Past the right and bottom edges, where a scroll container would follow.
    await page.mouse.move(200, 200);
    await page.mouse.wheel(-900, -700);
    expect(await insideViewport(root)).toBe(false);
    expect((await box(root)).x).toBeGreaterThan(VIEWPORT.width);
    expect(
      await node(root)
        .getByRole("button")
        .evaluate((button) => {
          button.focus();
          const canvas = button.closest(
            '[aria-label="Mind map canvas"]',
          ) as HTMLElement;
          canvas.scrollTop = 80;
          return [canvas.scrollLeft, canvas.scrollTop];
        }),
    ).toEqual([0, 0]);
  });
});

describe("menus and popovers", () => {
  const CANVAS = "Mind map canvas";
  const projectMenu = () => page.getByRole("menu", { name: "Project menu" });
  const ideaMenu = () => page.locator("[data-context-menu]");
  const colors = () =>
    page.getByRole("region", { name: "Selected node color controls" });
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  const isActive = (element: Element) => element === document.activeElement;
  // In the padding beside a menu's items, clear of its rounded corners.
  const padding = { position: { x: 2, y: 40 } };

  test("More actions toggles its menu, and disclosure buttons report their state", async () => {
    const root = await rootId();
    const more = button("More actions");
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    await more.click();
    await ideaMenu().waitFor();
    expect(await more.getAttribute("aria-expanded")).toBe("true");
    await more.click();
    await ideaMenu().waitFor({ state: "detached" });
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    expect(await activeLabel()).toBe(CANVAS);

    // A right-click menu is not the button's, and Esc returns to the map.
    await node(root).click({ button: "right" });
    await ideaMenu().waitFor();
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("Escape");
    await ideaMenu().waitFor({ state: "detached" });
    expect(await activeLabel()).toBe(CANVAS);
    expect(await selected()).toBe(root);

    for (const name of ["Outline", "Notes"]) {
      expect(await button(name).getAttribute("aria-expanded")).toBe("false");
      await button(name).click();
      expect(await button(name).getAttribute("aria-expanded")).toBe("true");
      expect(await button(name).getAttribute("aria-pressed")).toBeNull();
    }
  });

  test("a press on a layer's plain content keeps it open and keeps its keys", async () => {
    const root = await rootId();
    await button("Project menu").click();
    await projectMenu().click(padding);
    expect(await projectMenu().isVisible()).toBe(true);
    await page.keyboard.press("ArrowUp");
    expect(
      await projectMenu().getByRole("menuitem").last().evaluate(isActive),
    ).toBe(true);
    await projectMenu().click(padding);
    await page.keyboard.press("ArrowDown");
    expect(
      await projectMenu().getByRole("menuitem").first().evaluate(isActive),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await projectMenu().waitFor({ state: "detached" });

    await button("More actions").click();
    await ideaMenu().click(padding);
    expect(await ideaMenu().isVisible()).toBe(true);
    await page.keyboard.press("ArrowDown");
    expect(
      await ideaMenu().getByRole("menuitem").first().evaluate(isActive),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await ideaMenu().waitFor({ state: "detached" });

    await button("Color").click();
    await colors()
      .getByText(/^Changes only/)
      .click();
    expect(await colors().isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await colors().waitFor({ state: "detached" });
    expect(await activeLabel()).toBe("Color");
    expect(await selected()).toBe(root);
  });

  test("Escape closes a layer from its trigger or the map and returns focus", async () => {
    const root = await rootId();
    await button("Project menu").click();
    await projectMenu().getByRole("menuitem").first().waitFor();
    await page.keyboard.press("Shift+Tab");
    expect(await button("Project menu").evaluate(isActive)).toBe(true);
    await page.keyboard.press("Escape");
    await projectMenu().waitFor({ state: "detached" });
    expect(await button("Project menu").evaluate(isActive)).toBe(true);
    expect(await selected()).toBe(root);

    await button("More actions").focus();
    await page.keyboard.press("Enter");
    await ideaMenu().waitFor();
    await page.keyboard.press("Escape");
    await ideaMenu().waitFor({ state: "detached" });
    expect(await activeLabel()).toBe("More actions");

    await button("Color").click();
    await colors().waitFor();
    await page.locator(`[aria-label="${CANVAS}"]`).focus();
    await page.keyboard.press("Escape");
    await colors().waitFor({ state: "detached" });
    expect(await selected()).toBe(root);
  });

  test("tabbing out closes a menu or popover", async () => {
    await button("More actions").focus();
    await page.keyboard.press("Enter");
    await ideaMenu().waitFor();
    await page.keyboard.press("End");
    await page.keyboard.press("Tab");
    await ideaMenu().waitFor({ state: "detached" });
    expect(await activeLabel()).toBe("Zoom out");

    await button("Color").click();
    await colors().getByRole("button").last().focus();
    await page.keyboard.press("Tab");
    await colors().waitFor({ state: "detached" });

    // The trigger belongs to the menu; the field before it does not.
    await button("Project menu").click();
    await projectMenu().getByRole("menuitem").first().waitFor();
    await page.keyboard.press("Shift+Tab");
    expect(await projectMenu().isVisible()).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await projectMenu().waitFor({ state: "detached" });
    expect(await activeLabel()).toBe("Project name");
  });

  test("the open project menu keeps map shortcuts from acting behind it", async () => {
    await page.keyboard.press("Tab");
    await page.keyboard.type("Step");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    expect(await page.locator("[data-selected=true]").count()).toBe(0);
    const ideas = (await call("ids")).length;
    const search = page.getByRole("searchbox", { name: "Search ideas" });

    await button("Project menu").click();
    await projectMenu().getByRole("menuitem").first().waitFor();
    await page.keyboard.press("/");
    await page.keyboard.press("?");
    await page.keyboard.press("ControlOrMeta+z");
    await settle();
    expect(await search.count()).toBe(0);
    expect(await page.locator("dialog[open]").count()).toBe(0);
    expect((await call("ids")).length).toBe(ideas);
    expect(await projectMenu().isVisible()).toBe(true);

    await page.keyboard.press("Escape");
    await projectMenu().waitFor({ state: "detached" });
    await page.keyboard.press("/");
    await search.waitFor();
  });

  test("the project menu fits a short window, and Enter opens the filtered map", async () => {
    await page.setViewportSize({ width: 1280, height: 640 });
    const name = page.getByRole("textbox", { name: "Project name" });
    await name.fill("Zebra plan");
    await name.press("Enter");
    expect(await activeLabel()).toBe(CANVAS);
    const zebra = await call("projectId");
    for (let count = 0; count < 7; count++) {
      const previous = await call("projectId");
      await button("Project menu").click();
      await page.getByRole("menuitem", { name: "New map" }).click();
      await page.waitForFunction(
        (id) => window.harness.projectId() !== id,
        previous,
      );
    }

    await button("Project menu").click();
    await page.getByRole("menuitem", { name: "Open map…" }).click();
    const filter = page.getByRole("searchbox", { name: "Filter maps" });
    await filter.waitFor();
    const bounds = await projectMenu().boundingBox();
    expect((bounds?.y ?? 0) + (bounds?.height ?? 640)).toBeLessThan(640);
    // The menu scrolls as a whole: the list and dividers keep their size.
    expect(
      await page
        .locator("#saved-projects")
        .evaluate((list) => list.clientHeight),
    ).toBe(240);
    expect(
      await projectMenu()
        .locator(".menu-divider")
        .evaluateAll((lines) => lines.map((line) => line.clientHeight)),
    ).toEqual([1, 1]);
    await page.keyboard.press("End");
    const last = projectMenu().getByRole("menuitem").last();
    expect(await last.evaluate(isActive)).toBe(true);
    const item = await last.boundingBox();
    expect((item?.y ?? 0) + (item?.height ?? 640)).toBeLessThan(640);

    // The filter keeps the arrow keys, not Mod+S or F6.
    await filter.focus();
    await page.keyboard.press("ArrowDown");
    expect(await activeLabel()).toBe("Filter maps");
    expect(await pressLayoutKey("s", "KeyS", { ctrlKey: true })).toBe(false);
    await page.keyboard.press("F6");
    await projectMenu().waitFor({ state: "detached" });
    expect(await activeLabel()).not.toBe("Filter maps");

    // In a small window the menu reaches the selection toolbar and opens
    // over it.
    await page.setViewportSize({ width: 800, height: 600 });
    await node(await rootId()).click();
    await button("Project menu").click();
    await page.getByRole("menuitem", { name: "Open map…" }).click();
    await filter.waitFor();
    await settle();
    expect(
      await projectMenu().evaluate((menu) => {
        const bar = document.querySelector('[aria-label="Selected idea"]');
        if (!bar) throw new Error("The selection toolbar is not shown.");
        const from = menu.getBoundingClientRect();
        const to = bar.getBoundingClientRect();
        const x = Math.max(from.left, to.left) + 8;
        const y = Math.max(from.top, to.top) + 8;
        return {
          overlap: x < from.right && y < from.bottom,
          onTop: menu.contains(document.elementFromPoint(x, y)),
        };
      }),
    ).toEqual({ overlap: true, onTop: true });

    // Enter opens nothing from the unfiltered list, then the first match.
    await filter.press("Enter");
    expect(await projectMenu().isVisible()).toBe(true);
    await filter.fill("zeb");
    await filter.press("Enter");
    await projectMenu().waitFor({ state: "detached" });
    await page.waitForFunction(
      (id) => window.harness.projectId() === id,
      zebra,
    );
  });

  test("view buttons and menu items hand the keyboard back to the map", async () => {
    const root = await rootId();
    const a = await addChild(root, "Alpha");
    await addChild(a, "Alpha one");
    await node(a).click();

    await button("More actions").click();
    await page.getByRole("menuitem", { name: /^Fit selection/ }).click();
    expect(await activeLabel()).toBe(CANVAS);

    for (const name of ["Zoom in", "Zoom to 100%", "Zoom out", "Fit map"]) {
      await button(name).click();
      expect(await activeLabel()).toBe(CANVAS);
    }
    // From the keyboard the button keeps focus, so Enter can repeat it.
    await button("Zoom in").focus();
    await page.keyboard.press("Enter");
    expect(await activeLabel()).toBe("Zoom in");
    await button("Outline").click();
    expect(await activeLabel()).toBe(CANVAS);
    await button("Outline").click();
    await button("Color").click();
    await colors().waitFor();
    await button("Color").click();
    await colors().waitFor({ state: "detached" });
    expect(await activeLabel()).toBe(CANVAS);

    await button("Focus on this branch").click();
    const breadcrumbs = page.getByRole("navigation", { name: "Branch focus" });
    await breadcrumbs.waitFor();
    expect(await activeLabel()).toBe(CANVAS);
    await page.keyboard.press("ArrowRight");
    expect(await selected()).not.toBe(a);
    // An ancestor crumb becomes plain text once it is the focused branch.
    await breadcrumbs.getByRole("button").nth(1).click();
    await node(root).waitFor();
    expect(await activeLabel()).toBe(CANVAS);

    await page.keyboard.press("ControlOrMeta+f");
    await page.getByRole("searchbox", { name: "Search ideas" }).fill("one");
    await page.keyboard.press("Enter");
    await button("Stay here").click();
    expect(await activeLabel()).toBe(CANVAS);
  });

  test("the color popover opens over the notice in its slot", async () => {
    const root = await rootId();
    const child = await addChild(root, "Short-lived");
    await node(child).click();
    await page.keyboard.press("Delete");
    await notice("Deleted “Short-lived”").waitFor();
    expect(await selected()).toBe(root);
    await button("Color").click();
    expect(
      await colors()
        .getByText(/^Changes only/)
        .evaluate((hint) => {
          const box = hint.getBoundingClientRect();
          return hint.contains(
            document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            ),
          );
        }),
    ).toBe(true);
    // And hides it: the popover is not glass like the toolbar it opens from.
    expect(
      await colors().evaluate(
        (popover) => getComputedStyle(popover).backgroundColor,
      ),
    ).toBe("rgb(255, 255, 255)");
  });
});

describe("islands and stacking", () => {
  const region = (name: string) => page.getByRole("region", { name });
  const outline = () => page.getByRole("complementary", { name: "Outline" });
  const notes = () => page.getByRole("complementary", { name: "Notes" });
  const notesButton = () =>
    region("Selected idea").getByRole("button", { name: "Notes" });
  async function edges(target: ReturnType<typeof region>) {
    await settle();
    const bounds = await target.boundingBox();
    if (!bounds) throw new Error("The island is not visible.");
    return {
      left: bounds.x,
      right: bounds.x + bounds.width,
      top: bounds.y,
      bottom: bounds.y + bounds.height,
      center: bounds.x + bounds.width / 2,
    };
  }
  // A chain of ideas, so the last one has a three-level path above it.
  async function chain() {
    const root = await rootId();
    const a = await addChild(root, "Alpha with a long name");
    const b = await addChild(a, "Beta with a long name");
    const c = await addChild(b, "Gamma with a long name");
    return { root, a, b, c, leaf: await addChild(c, "Needle") };
  }

  test("the selection toolbar and its notice keep clear of the zoom island in a small window", async () => {
    const root = await rootId();
    await addChild(root, "Kept");
    const child = await addChild(root, "Short-lived");
    await node(child).click();
    await page.keyboard.press("Delete");
    await notice("Deleted “Short-lived”").waitFor();
    // The central idea has children, so its toolbar is at its widest.
    await node(root).click();
    const toolbar = region("Selected idea");
    const more = toolbar.getByRole("button", { name: "More actions" });
    for (const width of [660, 800]) {
      await page.setViewportSize({ width, height: 600 });
      await more.waitFor();
      const bar = await edges(toolbar);
      expect(bar.right).toBeLessThan(
        (await edges(region("View and help"))).left,
      );
      expect(bar.left).toBeGreaterThanOrEqual(0);
      expect(
        Math.abs((await edges(page.locator(".notice"))).center - bar.center),
      ).toBeLessThan(1);
      // Nothing lies over the last button.
      await more.click({ trial: true });
    }
    await page.setViewportSize({ width: 1024, height: 700 });
    await settle();
    expect(Math.abs((await edges(toolbar)).center - 512)).toBeLessThan(1);
  });

  // The outline docks with an animation, then the map eases to keep the
  // selection in view.
  async function docked() {
    for (const selector of [".outline-dock", ".map-layer"]) {
      await page.evaluate(
        (selector) =>
          Promise.all(
            (document.querySelector(selector)?.getAnimations() ?? []).map(
              (animation) => animation.finished.catch(() => undefined),
            ),
          ),
        selector,
      );
      await settle();
    }
  }

  test("the top bars stack in the strip left of the open panels", async () => {
    await page.setViewportSize({ width: 1024, height: 700 });
    const { c } = await chain();
    await page.keyboard.press("Alt+o");
    await docked();
    await page.getByRole("button", { name: "Fit map" }).click();
    await node(c).click();
    await page.keyboard.press("Alt+f");
    await notesButton().click();
    const crumbs = page.getByRole("navigation", { name: "Branch focus" });
    // The notes open inside the map, left of the docked outline.
    const between = async (bar: ReturnType<typeof region>) => {
      const bounds = await edges(bar);
      expect(bounds.left).toBeGreaterThanOrEqual(12);
      expect(bounds.right).toBeLessThan((await edges(notes())).left);
      return bounds;
    };
    await between(crumbs);
    expect((await edges(notes())).right).toBeLessThan(
      (await edges(outline())).left,
    );
    // The panels' own controls stay in reach.
    await page.getByRole("button", { name: "Close notes" }).click({
      trial: true,
    });
    await page.getByRole("button", { name: "Close outline" }).click({
      trial: true,
    });

    await page.getByRole("button", { name: "Search", exact: true }).click();
    const field = page.getByRole("searchbox", { name: "Search ideas" });
    await field.fill("needle");
    // Search steps aside for the notes it would cover.
    expect(
      (await edges(page.getByRole("search", { name: "Search ideas" }))).right,
    ).toBeLessThan((await edges(notes())).left);
    await field.press("Enter");
    const back = await between(
      page.getByRole("navigation", { name: "Return from search" }),
    );
    expect(back.top).toBeGreaterThan((await between(crumbs)).bottom);

    // With less room the steps above the branch go, then the label of the way
    // out: the focused branch is never clipped away.
    const place = crumbs.locator('[aria-current="location"]');
    for (const [width, height, steps] of [
      [1024, 700, 0],
      [1280, 800, 0],
      [1440, 900, 3],
    ]) {
      await page.setViewportSize({ width, height });
      const bar = await between(crumbs);
      const here = await edges(place);
      expect(here.right).toBeLessThanOrEqual(bar.right);
      expect(here.right - here.left).toBeGreaterThan(60);
      // "Whole map", then a button for each step above the focused branch.
      expect(await crumbs.getByRole("button").count()).toBe(1 + steps);
      await crumbs
        .getByRole("button", { name: "Whole map" })
        .click({ trial: true });
    }
  });

  test("the outline docks beside the map, which pans left to make room", async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const root = await rootId();
    const toggle = page.getByRole("button", { name: "Outline", exact: true });
    const cross = toggle.locator("[data-open]");
    const canvas = page.getByRole("region", { name: "Mind map canvas" });
    const start = await box(root);
    expect(await cross.count()).toBe(0);
    await toggle.click();
    await outline().waitFor();
    await docked();
    expect(await cross.count()).toBe(1);
    expect(await toggle.getAttribute("title")).toContain("Close outline");
    // Full height at the right edge, with the map's canvas narrowed beside it.
    const dock = await edges(page.locator(".outline-dock"));
    expect(dock).toMatchObject({ top: 0, bottom: 720, right: 1280 });
    expect(Math.round(dock.right - dock.left)).toBe(448);
    expect(Math.abs((await edges(canvas)).right - dock.left)).toBeLessThan(1);
    // The toolbar that toggles it moves along with the canvas edge.
    expect((await edges(toggle)).right).toBeLessThan(dock.left);
    // The map keeps its centre in the narrower canvas: it pans half the way.
    expect(Math.abs(start.x - (await box(root)).x - 224)).toBeLessThan(1);

    await page.getByRole("button", { name: "Close outline" }).click();
    await page.locator(".outline-dock").waitFor({ state: "detached" });
    await settle();
    expect(await cross.count()).toBe(0);
    expect((await edges(canvas)).right).toBe(1280);
    expect(Math.abs((await box(root)).x - start.x)).toBeLessThan(1);
  });

  test("a panel that opens over the selected idea moves the map aside", async () => {
    const { leaf } = await chain();
    await page.getByRole("button", { name: "Fit map" }).click();
    await node(leaf).click();
    const before = await box(leaf);
    await notesButton().click();
    const panel = await edges(notes());
    expect(before.x + before.width).toBeGreaterThan(panel.left);
    const after = await box(leaf);
    expect(after.x + after.width).toBeLessThan(panel.left);
    await page.getByRole("button", { name: "Close notes" }).click();

    // The docked outline narrows the map past the idea; once docked, the map
    // follows it back into view.
    await page.getByRole("button", { name: "Fit map" }).click();
    await node(leaf).click();
    await page.keyboard.press("Alt+o");
    await docked();
    const dock = await edges(outline());
    expect(before.x + before.width).toBeGreaterThan(dock.left);
    const beside = await box(leaf);
    expect(beside.x + beside.width).toBeLessThan(dock.left);
  });
});

describe("buttons and controls", () => {
  const ACCENT = "rgb(107, 61, 245)";
  const style = (target: Locator, property: string) =>
    target.evaluate(
      (element, property) =>
        getComputedStyle(element).getPropertyValue(property),
      property,
    );
  // Hover and press colors ease in, so they are waited for.
  async function background(target: Locator, color: string) {
    const element = await target.elementHandle();
    await page.waitForFunction(
      ([element, color]) =>
        getComputedStyle(element as Element).backgroundColor === color,
      [element, color] as const,
    );
  }
  const height = async (target: Locator) =>
    (await target.boundingBox())?.height;

  test("a toggle keeps its on color under the pointer, and a press shows", async () => {
    const outline = page.getByRole("button", { name: "Outline", exact: true });
    await outline.click();
    // The pointer is still on the button.
    await background(outline, "rgb(239, 234, 255)");
    const zoom = page.getByRole("button", { name: "Zoom to 100%" });
    await zoom.hover();
    await page.mouse.down();
    await background(zoom, "rgb(232, 234, 239)");
    await page.mouse.up();
    // The sign-in island is a primary button dressed as an island.
    const signIn = page
      .getByRole("region", { name: "Account" })
      .getByRole("button", { name: "Sign in" });
    await signIn.hover();
    await background(signIn, "rgb(255, 255, 255)");
  });

  test("toolbar rows are 44px with 36px controls, and disabled labels stay readable", async () => {
    const root = await rootId();
    const a = await addChild(root, "Alpha");
    await addChild(a, "Needle");
    await node(a).click();
    await page.keyboard.press("Alt+f");
    const crumbs = page.getByRole("navigation", { name: "Branch focus" });
    await crumbs.waitFor();
    expect(await height(crumbs)).toBe(44);
    expect(
      await height(crumbs.getByRole("button", { name: "Whole map" })),
    ).toBe(36);
    // The focused idea has no sibling to add.
    const sibling = page
      .getByRole("region", { name: "Selected idea" })
      .getByRole("button", { name: /Sibling/ });
    expect(await sibling.isDisabled()).toBe(true);
    expect(await style(sibling, "color")).toBe("rgb(154, 162, 174)");

    await page.keyboard.press("ControlOrMeta+f");
    const field = page.getByRole("searchbox", { name: "Search ideas" });
    await field.fill("needle");
    await field.press("Enter");
    const back = page.getByRole("navigation", { name: "Return from search" });
    await back.waitFor();
    expect(await height(back)).toBe(44);
    expect(await height(back.getByRole("button", { name: "Stay here" }))).toBe(
      36,
    );
    expect(
      await height(page.getByRole("button", { name: "Zoom to 100%" })),
    ).toBe(36);
  });

  test("focus rings follow the keyboard and sit on the card or island around a field", async () => {
    await node(await rootId()).click();
    await page.getByRole("button", { name: "Color" }).click();
    const scopes = page.locator(".color-scope");
    await scopes.nth(1).click();
    expect(await style(scopes.nth(1), "outline-style")).toBe("none");
    await page.keyboard.press("ArrowLeft");
    expect(await style(scopes.nth(0), "outline-color")).toBe(ACCENT);
    await page.keyboard.press("Escape");

    await page.keyboard.press("ControlOrMeta+f");
    const search = page.getByRole("search", { name: "Search ideas" });
    await search.waitFor();
    expect(await style(search, "outline-style")).toBe("solid");
    expect(await style(search, "outline-color")).toBe(ACCENT);
    await search.getByRole("button", { name: "Close search" }).focus();
    expect(await style(search, "outline-style")).toBe("none");
    await page.keyboard.press("Escape");

    await page.keyboard.press("Alt+n");
    const notes = page.getByRole("textbox", { name: "Idea notes" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Idea notes",
    );
    expect(await style(notes, "box-shadow")).toContain(
      `${ACCENT} 0px 0px 0px 2px inset`,
    );
    await page.keyboard.press("Escape");

    await page
      .getByRole("button", { name: "Shortcuts and navigation" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Shortcuts and navigation",
    });
    await dialog.getByRole("radio").first().focus();
    await page.keyboard.press("ArrowDown");
    const card = dialog.locator(".choice-card:has(input:checked)");
    expect(await style(card, "outline-color")).toBe(ACCENT);
    expect(await style(card.locator("input"), "outline-style")).toBe("none");
  });

  test("a saving switch keeps the keyboard while it works", async () => {
    await page.getByRole("button", { name: "Project menu" }).click();
    await page.getByRole("menuitem", { name: "Project preferences…" }).click();
    const dialog = page.getByRole("dialog", { name: "Project preferences" });
    const local = (checked: boolean) =>
      dialog.getByRole("switch", {
        name: "Save locally",
        exact: true,
        checked,
      });
    await local(true).focus();
    await page.keyboard.press("Space");
    await local(false).waitFor();
    await dialog.getByText("This map lives only in memory.").waitFor();
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-labelledby"),
      ),
    ).toBe("saving-local");
    // A secondary action on the dialog's surface is an outlined button, 36px
    // tall whatever the line height of the text around it.
    const exportBackup = dialog.getByRole("button", { name: "Export backup" });
    expect(await style(exportBackup, "border-top-width")).toBe("1px");
    expect(Math.round((await height(exportBackup)) ?? 0)).toBe(36);
    expect(
      Math.round(
        (await height(dialog.getByRole("button", { name: "Sign in" }))) ?? 0,
      ),
    ).toBe(36);
    // Once the change is done, the same key turns it back on.
    await dialog
      .locator('[role="switch"][data-busy]')
      .first()
      .waitFor({ state: "detached" });
    await page.keyboard.press("Space");
    await local(true).waitFor();
  });
});

describe("wording", () => {
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  const ideaMenu = () => page.getByRole("menu", { name: "Idea actions" });

  test("the Enter hint on Sibling shows only where Enter adds a sibling", async () => {
    const root = await rootId();
    const child = await addChild(root, "Child");
    // Enter on a central idea adds a child, so neither control names the key.
    await node(root).click();
    expect(await button("Sibling").getAttribute("title")).toBe(
      "Add a sibling idea",
    );
    await node(root).click({ button: "right" });
    expect(
      await ideaMenu()
        .getByRole("menuitem", { name: /^Add sibling/ })
        .innerText(),
    ).toBe("Add sibling idea");
    await page.keyboard.press("Escape");

    await node(child).click();
    expect(await button("Sibling").getAttribute("title")).toBe(
      "Add a sibling idea (Enter)",
    );
    await node(child).click({ button: "right" });
    expect(
      await ideaMenu()
        .getByRole("menuitem", { name: /^Add sibling/ })
        .innerText(),
    ).toMatch(/^Add sibling idea\s+Enter$/);
  });

  test("menus and the color popover say idea, and tooltips start with the button's name", async () => {
    const root = await rootId();
    // An edit brings Undo and Redo into the toolbar.
    await node(root).click();
    await page.keyboard.press("Tab");
    await editor().press("Enter");
    await node(root).click({ button: "right" });
    await ideaMenu()
      .getByRole("menuitem", { name: /^Add child idea/ })
      .waitFor();
    await page.keyboard.press("Escape");
    const bounds = await box(root);
    await page.mouse.click(bounds.x + bounds.width + 200, bounds.y + 200, {
      button: "right",
    });
    await page
      .getByRole("menu", { name: "Canvas actions" })
      .getByRole("menuitem", { name: "New central idea" })
      .waitFor();
    await page.keyboard.press("Escape");

    await node(root).click();
    await button("Color").click();
    const colors = page.getByRole("region", {
      name: "Selected node color controls",
    });
    await colors.getByText("This idea", { exact: true }).waitFor();
    await colors.getByText("Changes only the selected idea.").waitFor();
    await page.keyboard.press("Escape");

    // An icon button's tooltip is its name, then the key that runs it.
    await button("Search").click();
    const tooltips = await page
      .locator("[data-toolbar] .icon-button[title]")
      .evaluateAll((buttons) =>
        buttons.map((button) => [
          button.getAttribute("aria-label") ?? "",
          button.getAttribute("title") ?? "",
        ]),
      );
    const names = tooltips.map(([name]) => name);
    for (const name of [
      "Close search",
      "Focus on this branch",
      "Shortcuts and navigation",
    ])
      expect(names).toContain(name);
    expect(
      tooltips.filter(
        ([name, title]) => title !== name && !title.startsWith(`${name} (`),
      ),
    ).toEqual([]);
    // Shortcut hints use one style per platform, never a mix of both.
    const redo = (await button("Redo").getAttribute("title")) ?? "";
    expect(redo).toMatch(/^Redo \((⌘⇧|Ctrl\+Shift\+)Z\)$/);
    // "?" types into a selected idea, and the tooltip says so.
    expect(await button("Shortcuts and navigation").getAttribute("title")).toBe(
      "Shortcuts and navigation (? with nothing selected)",
    );
  });

  test("a confirmation notice has no period, and a collapsed badge is named by what it shows", async () => {
    const root = await rootId();
    await addChild(root, "Child");
    await node(root).click();
    await page.getByRole("button", { name: "Project menu" }).click();
    await page.getByRole("menuitem", { name: "Save now" }).click();
    await page
      .locator(".notice")
      .getByText("Saved locally", { exact: true })
      .waitFor();
    await button("Collapse children").click();
    const badge = page.getByRole("button", { name: "Expand 1 idea" });
    expect(await badge.innerText()).toBe("+1 idea");
  });
});

describe("phone layout", () => {
  test("one button opens a panel holding the map controls", async () => {
    // Short enough that the opened sections overflow the panel.
    await page.setViewportSize({ width: 390, height: 460 });
    const menu = page.locator(".phone-menu-button");
    await menu.waitFor();
    for (const name of ["Zoom in", "Fit map", "Search", "Outline", "Sign in"])
      expect(
        await page.getByRole("button", { name, exact: true }).count(),
      ).toBe(0);
    expect(await page.getByLabel("Project name").isVisible()).toBe(false);

    await menu.click();
    const panel = page.getByRole("dialog", { name: "Project menu" });
    await panel.waitFor();
    // Focusing the name field would raise the phone keyboard.
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
    ).toBe("Close project menu");
    await panel.getByRole("button", { name: "Backup and export" }).click();
    await panel.getByRole("button", { name: "Export outline (.md)" }).waitFor();
    await panel.getByRole("button", { name: "Open map…" }).click();
    // The panel scrolls as a whole, so a long menu must not squash this list.
    const saved = await panel.getByLabel("Saved maps").boundingBox();
    expect(saved?.height).toBeGreaterThan(24);
    await panel.getByRole("button", { name: "Fit map" }).click();
    await panel.waitFor({ state: "hidden" });

    await menu.click();
    await panel.waitFor();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });

    await menu.click();
    await panel.waitFor();
    await page.mouse.click(370, 400);
    await panel.waitFor({ state: "hidden" });

    await menu.click();
    await panel.getByRole("button", { name: "Search", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Close search" }).waitFor();
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
    ).toBe("Search ideas");
  });

  test("the desktop controls return on a wider screen", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".phone-menu-button").click();
    await page.getByRole("dialog", { name: "Project menu" }).waitFor();
    await page.setViewportSize(VIEWPORT);
    await page.getByRole("button", { name: "Zoom in" }).waitFor();
    await page.getByLabel("Project name").waitFor();
    expect(await page.getByRole("dialog").count()).toBe(0);
  });
});
