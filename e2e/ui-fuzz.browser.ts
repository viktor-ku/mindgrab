import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium, firefox, webkit } from "playwright";
import type { ViteDevServer } from "vite";
import type { Harness } from "./harness";
import { createServer } from "vite";

// Model-based UI fuzzing of the editor through real user input only: keys,
// unforced pointer actions on ideas that are visible and topmost, and
// synthetic clipboard events (headless browsers do not fire native ones).
//
// The oracle is the document itself (window.harness.content()), not the DOM
// text. A model of the undo history mirrors the editor's contract: every
// action that changes the document is one undo step (a writing session, from
// the first keystroke until Escape, Enter or blur, is one step), undo restores
// the exact previous document — structure, text, notes, colors and manual
// positions — and redo re-applies it. Folds, selection and viewport are view
// state and are not compared.
//
// Configuration (environment):
//   FUZZ_BROWSER=chromium|webkit|firefox   FUZZ_SEED=1  FUZZ_SEEDS=6
//   FUZZ_STEPS=60  FUZZ_MINIMIZE=40 (replays spent minimizing; 0 disables)
//   FUZZ_OUT=file.jsonl (appends one line per failure)
//   FUZZ_REPLAY='[...actions]' replays a printed action list.
//   KNOWN holds minimized failures the fuzzer found; they run as regression tests.
// Large run: FUZZ_SEED=100 FUZZ_SEEDS=50 FUZZ_STEPS=200 bun --bun test ./ui-fuzz.browser.ts

const BROWSER = (process.env.FUZZ_BROWSER ?? "chromium") as
  | "chromium"
  | "webkit"
  | "firefox";
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 6);
const STEPS = Number(process.env.FUZZ_STEPS ?? 60);
const MINIMIZE = Number(process.env.FUZZ_MINIMIZE ?? 40);
const OUT = process.env.FUZZ_OUT;
const UNDO_LIMIT = 100;
const VIEWPORT = { width: 1200, height: 800 };
const BRANCH_MIME = "application/x-mindgrab-branch";

setDefaultTimeout(60 * 60_000);
const webapp = fileURLToPath(new URL("../webapp", import.meta.url));
let server: ViteDevServer;
let browser: Browser;
let url: string;

beforeAll(async () => {
  server = await createServer({
    root: webapp,
    configFile: `${webapp}/vite.config.ts`,
    cacheDir: "node_modules/.vite-browser-tests",
    logLevel: "error",
    server: {
      port: 5196,
      strictPort: false,
      // Source edits made while a sweep runs must not reload pages mid-run.
      hmr: false,
      fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    },
    optimizeDeps: { entries: [`${import.meta.dir}/harness.html`] },
  });
  await server.listen();
  browser = await { chromium, webkit, firefox }[BROWSER].launch();
  const base = server.resolvedUrls?.local[0] ?? "http://localhost:5196/";
  url = new URL(`/@fs/${import.meta.dir}/harness.html`, base).href;
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

// ---------------------------------------------------------------------------
// Seeded randomness (Mulberry32) and actions.

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => items[int(items.length)] as T,
    weighted: <T>(items: readonly (readonly [T, number])[]): T => {
      let roll = next() * items.reduce((sum, [, w]) => sum + w, 0);
      for (const [item, weight] of items) {
        roll -= weight;
        if (roll < 0) return item;
      }
      return items[items.length - 1][0];
    },
  };
}
type Random = ReturnType<typeof random>;

// Actions are generated without looking at the page, and refer to ideas by
// index in document order, so any subsequence replays deterministically (the
// basis of minimization). Indices wrap around whatever exists at that point.
type DropMode = "inside" | "before" | "after" | "canvas";
type Action =
  | { k: "type"; t: string }
  | { k: "key"; key: string }
  | { k: "click"; n: number }
  | { k: "dblclick"; n: number }
  | { k: "canvas"; p: number }
  | { k: "drag"; n: number; m: number; mode: DropMode; p: number }
  | { k: "pan"; p: number; dx: number; dy: number }
  | { k: "wheel"; p: number; dy: number; zoom: boolean }
  | { k: "button"; b: number; n: number }
  | { k: "color"; scope: number; c: number }
  | { k: "menu"; n: number; canvas: boolean; item: number; p: number }
  | { k: "outline"; n: number; how: "click" | "dblclick" | "toggle" }
  | { k: "expand"; n: number }
  | { k: "result"; n: number }
  | { k: "copy" }
  | { k: "cut" }
  | { k: "paste"; t?: string };

const FRAGMENTS = [
  "a",
  "Idea",
  "plan B",
  "x",
  " ",
  "é",
  "日本",
  "😀",
  "שלום",
  "- ",
  "1. ",
  "<b>",
  '"q"',
  "\\",
  "ok",
];
const KEYS: (readonly [string, number])[] = [
  ["Tab", 3],
  ["Shift+Tab", 1],
  ["Enter", 3],
  ["Shift+Enter", 1],
  ["Escape", 3],
  ["Backspace", 2.5],
  ["Delete", 1],
  ["F2", 1],
  [" ", 0.7],
  ["ArrowUp", 2],
  ["ArrowDown", 2],
  ["ArrowLeft", 2],
  ["ArrowRight", 2],
  ["Home", 0.3],
  ["End", 0.3],
  ["Alt+ArrowUp", 1.5],
  ["Alt+ArrowDown", 1.5],
  ["Alt+ArrowLeft", 1.5],
  ["Alt+ArrowRight", 1.5],
  ["Alt+KeyG", 1.5],
  ["Alt+KeyF", 1],
  ["Alt+KeyO", 1],
  ["Alt+KeyN", 1.5],
  ["Alt+Digit1", 0.5],
  ["Alt+Digit2", 0.5],
  ["ControlOrMeta+KeyZ", 5],
  ["ControlOrMeta+Shift+KeyZ", 2.5],
  ["ControlOrMeta+KeyY", 0.5],
  ["ControlOrMeta+KeyF", 1],
  ["ControlOrMeta+Equal", 0.3],
  ["ControlOrMeta+Minus", 0.3],
  ["ControlOrMeta+Digit0", 0.2],
  ["F6", 0.3],
];
const OUTLINES = [
  "Pasted",
  "- A\n  - B\n- C",
  "1. One\n2. Two\n   - Two a",
  "# Title\n- item 😀",
  "a\nb\nc",
  "- deep\n  - deeper\n    - deepest\n      - more\n        - most",
];

function generate(rng: Random): Action {
  const big = () => rng.int(1_000_000);
  const kind = rng.weighted([
    ["type", 16],
    ["key", 34],
    ["click", 10],
    ["dblclick", 3],
    ["canvas", 3],
    ["drag", 9],
    ["pan", 1.5],
    ["wheel", 1.5],
    ["button", 7],
    ["color", 3],
    ["menu", 4],
    ["outline", 2],
    ["expand", 1],
    ["result", 1],
    ["copy", 2],
    ["cut", 1.5],
    ["paste", 3],
  ] as const);
  switch (kind) {
    case "type": {
      let t = "";
      for (let i = 1 + rng.int(3); i > 0; i--) t += rng.pick(FRAGMENTS);
      return { k: "type", t };
    }
    case "key":
      return { k: "key", key: rng.weighted(KEYS) };
    case "click":
    case "dblclick":
    case "expand":
    case "result":
      return { k: kind, n: big() };
    case "canvas":
      return { k: "canvas", p: big() };
    case "drag":
      return {
        k: "drag",
        n: big(),
        m: big(),
        mode: rng.weighted([
          ["inside", 4],
          ["before", 2],
          ["after", 2],
          ["canvas", 2],
        ] as const),
        p: big(),
      };
    case "pan":
      return {
        k: "pan",
        p: big(),
        dx: rng.int(400) - 200,
        dy: rng.int(300) - 150,
      };
    case "wheel":
      return {
        k: "wheel",
        p: big(),
        dy: rng.int(600) - 300,
        zoom: rng.next() < 0.5,
      };
    case "button":
      return { k: "button", b: big(), n: big() };
    case "color":
      return { k: "color", scope: rng.int(2), c: rng.int(8) };
    case "menu":
      return {
        k: "menu",
        n: big(),
        canvas: rng.next() < 0.2,
        item: big(),
        p: big(),
      };
    case "outline":
      return {
        k: "outline",
        n: big(),
        how: rng.weighted([
          ["click", 3],
          ["dblclick", 1],
          ["toggle", 1],
        ] as const),
      };
    case "paste":
      return rng.next() < 0.5
        ? { k: "paste" }
        : { k: "paste", t: rng.pick(OUTLINES) };
    default:
      return { k: kind };
  }
}

export function actionsFor(seed: number, steps: number) {
  const rng = random(seed);
  const actions: Action[] = [];
  for (let i = 0; i < steps; i++) {
    const previous = actions[i - 1];
    // Undo and redo come in runs, so redo has something to restore.
    const history =
      previous?.k === "key" &&
      /^ControlOrMeta\+(Shift\+KeyZ|KeyZ|KeyY)$/.test(previous.key);
    const before = actions[i - 2];
    // Searching and the outline get short follow-ups so their lists are used.
    const searched =
      previous?.k === "key" && previous.key === "ControlOrMeta+KeyF";
    const queried =
      previous?.k === "type" &&
      before?.k === "key" &&
      before.key === "ControlOrMeta+KeyF";
    const outlined = previous?.k === "key" && previous.key === "Alt+KeyO";
    if (searched && rng.next() < 0.7) {
      actions.push({ k: "type", t: rng.pick(["a", "i", "Idea", "New", "e"]) });
      continue;
    }
    if (queried && rng.next() < 0.7) {
      actions.push(
        rng.next() < 0.5
          ? { k: "result", n: rng.int(1_000_000) }
          : {
              k: "key",
              key: rng.pick(["ArrowDown", "ArrowUp", "Enter", "Escape"]),
            },
      );
      continue;
    }
    if (outlined && rng.next() < 0.6) {
      actions.push({
        k: "outline",
        n: rng.int(1_000_000),
        how: rng.pick(["click", "dblclick", "toggle"] as const),
      });
      continue;
    }
    actions.push(
      history && rng.next() < 0.45
        ? {
            k: "key",
            key:
              rng.next() < 0.4
                ? "ControlOrMeta+KeyZ"
                : "ControlOrMeta+Shift+KeyZ",
          }
        : generate(rng),
    );
  }
  return actions;
}

// Known failures, minimized, kept as skipped tests until fixed. BUTTONS[23]
// is the notice's action button.
const KNOWN: { name: string; actions: Action[] }[] = [
  {
    // Seed 10329. Pressing the notice's Undo ends the writing session; the
    // "Selected idea" toolbar reappears in the same bottom column and pushes
    // the notice up before the mouse is released, so the click is lost and
    // nothing is undone.
    name: "a notice's Undo pressed while writing an idea undoes",
    actions: [
      { k: "key", key: "Tab" },
      { k: "key", key: "Escape" },
      { k: "key", key: "Delete" },
      { k: "dblclick", n: 0 },
      { k: "button", b: 23, n: 0 },
    ],
  },
  {
    // Seed 10216. Undoing a typing session restores writing on its idea even
    // when a focused branch hides that idea: no editor is drawn, and the
    // hidden writing state makes the editor ignore Mod+Z (and canvas keys).
    name: "undoing writing on an idea outside the focused branch keeps undo working",
    actions: [
      { k: "key", key: "Tab" },
      { k: "key", key: "Escape" },
      { k: "key", key: "Enter" },
      { k: "type", t: "y" },
      { k: "key", key: "Escape" },
      { k: "key", key: "ArrowUp" },
      { k: "key", key: "Alt+KeyF" },
      { k: "key", key: "ControlOrMeta+KeyZ" },
      { k: "key", key: "ControlOrMeta+KeyZ" },
    ],
  },
  {
    // Seeds 40121, 40140. A writing session that ends where it started (type,
    // then delete it) changes nothing, so undo reverts the step before it: here
    // the new idea disappears with one Mod+Z. Loro drops the empty step; the
    // model mirrors that. Same with notes (Alt+N instead of F2).
    name: "undo after typing and deleting the same text reverts the previous real step",
    actions: [
      { k: "key", key: "Tab" },
      { k: "key", key: "Escape" },
      { k: "key", key: "F2" },
      { k: "key", key: "ArrowRight" },
      { k: "type", t: "x" },
      { k: "key", key: "Backspace" },
      { k: "key", key: "Escape" },
      { k: "key", key: "ControlOrMeta+KeyZ" },
    ],
  },
  {
    // WebKit seed 20005 (drag variant), Chromium 40126 (Sibling variant).
    // In branch focus, outdenting a child of the focused idea moves it out
    // of the view while it stays selected; typing then opens an editor that
    // is never drawn, and that hidden writing state makes Mod+Z do nothing.
    name: "moving an idea out of the focused branch keeps it reachable and undo working",
    actions: [
      { k: "key", key: "Tab" },
      { k: "key", key: "Escape" },
      { k: "key", key: "ArrowLeft" },
      { k: "key", key: "Alt+KeyF" },
      { k: "key", key: "ArrowRight" },
      { k: "key", key: "Alt+ArrowLeft" },
      { k: "type", t: "x" },
      { k: "key", key: "ControlOrMeta+KeyZ" },
    ],
  },
  {
    // Seed 60215. With the search panel still open, editing an idea's text
    // re-runs the search, whose effect selects the first result: the open
    // editor jumps to another idea in the middle of typing ("x" lands in the
    // root, "yz" in the child).
    name: "typing while search is open stays in the idea being edited",
    actions: [
      { k: "key", key: "Tab" },
      { k: "type", t: "Idea" },
      { k: "key", key: "Escape" },
      { k: "key", key: "ControlOrMeta+KeyF" },
      { k: "type", t: "Idea" },
      { k: "click", n: 0 },
      { k: "dblclick", n: 0 },
      { k: "type", t: "xyz" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Reading the page: the document from the harness, plus what the UI shows.

interface DocNode {
  id: string;
  parent: string | null;
  children: string[];
  text: string;
  note: string;
  color: string;
  position: { x: number; y: number } | null;
  depth: number;
}
interface Doc {
  name: string;
  roots: string[];
  nodes: DocNode[];
}
interface State {
  ready: boolean;
  projectId: string;
  doc: Doc;
  history: { undo: number; redo: number; canUndo: boolean; canRedo: boolean };
  rendered: { id: string; selected: boolean; collapsed: boolean }[];
  editors: { id?: string; value: string; focused: boolean }[];
  notes?: { value: string; focused: boolean };
  outline?: string[];
  undoDisabled?: boolean;
  redoDisabled?: boolean;
  focus: string;
  contextMenu: boolean;
  dialog: boolean;
  searchOpen: boolean;
  focusMode: boolean;
  nameDraft?: string;
  // The focused button, which Enter or Space would press.
  button?: { label: string; disabled: boolean };
}

function readState(page: Page): Promise<State> {
  return page.evaluate(() => {
    const h: Harness = window.harness;
    const view = h.content();
    const canvas = document.querySelector('[aria-label="Mind map canvas"]');
    const rendered = [
      ...(canvas?.querySelectorAll<HTMLElement>("[data-node-id]") ?? []),
    ].map((el) => ({
      id: el.dataset.nodeId as string,
      selected: el.dataset.selected === "true",
      collapsed: el.dataset.collapsed === "true",
    }));
    const active = document.activeElement;
    const selected = rendered.find((node) => node.selected)?.id;
    const editors = [
      ...document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[aria-label="Node text"]',
      ),
    ].map((t) => ({
      id: t.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId,
      value: t.value,
      focused: active === t,
    }));
    const notesInput = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Idea notes"]',
    );
    const tree = document.querySelector(
      '[role="tree"][aria-label="Map outline"]',
    );
    const undoButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Undo"]',
    );
    const redoButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Redo"]',
    );
    let focus = active?.tagName.toLowerCase() ?? "none";
    if (active?.matches('textarea[aria-label="Node text"]'))
      focus = `text:${active.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId}`;
    else if (active?.matches('textarea[aria-label="Idea notes"]'))
      focus = `note:${selected ?? "?"}`;
    else if (active?.matches("input, textarea, [contenteditable=true]"))
      focus = `input:${active.getAttribute("aria-label")}`;
    else if (active?.closest('[role="tree"]')) focus = "outline";
    else if (active?.closest("[data-context-menu]")) focus = "menu";
    else if (active?.closest('[aria-label="Account"]')) focus = "account";
    else if (active?.closest("[data-toolbar]")) focus = "toolbar";
    else if (active === canvas) focus = "canvas";
    return {
      ready: !!canvas?.matches('[data-storage-ready="true"]'),
      projectId: h.projectId(),
      doc: { name: view.name, roots: view.roots, nodes: view.nodes },
      history: h.history(),
      rendered,
      editors,
      notes: notesInput
        ? { value: notesInput.value, focused: active === notesInput }
        : undefined,
      outline: tree
        ? [...tree.querySelectorAll<HTMLElement>("[data-outline-id]")].map(
            (el) => el.dataset.outlineId as string,
          )
        : undefined,
      undoDisabled: undoButton?.disabled,
      redoDisabled: redoButton?.disabled,
      focus,
      contextMenu: !!document.querySelector("[data-context-menu]"),
      dialog: !!document.querySelector("dialog[open]"),
      searchOpen: !!document.querySelector('input[aria-label="Search ideas"]'),
      focusMode: !!document.querySelector('[aria-label="Branch focus"]'),
      button:
        active instanceof HTMLButtonElement
          ? {
              label: (
                active.getAttribute("aria-label") ??
                active.textContent ??
                ""
              ).trim(),
              disabled: active.disabled,
            }
          : undefined,
      nameDraft: document.querySelector<HTMLInputElement>(
        'input[aria-label="Project name"]',
      )?.value,
    } as never;
  });
}

// Node order inside the view is not meaningful; children and roots order is.
function canonical(doc: Doc) {
  const nodes = [...doc.nodes].sort((a, b) => (a.id < b.id ? -1 : 1));
  return JSON.stringify({ name: doc.name, roots: doc.roots, nodes });
}

function describeDiff(expected: Doc, actual: Doc) {
  const lines: string[] = [];
  if (expected.name !== actual.name)
    lines.push(
      `name ${JSON.stringify(expected.name)} → ${JSON.stringify(actual.name)}`,
    );
  if (JSON.stringify(expected.roots) !== JSON.stringify(actual.roots))
    lines.push(`roots ${expected.roots.join(",")} → ${actual.roots.join(",")}`);
  const a = new Map(expected.nodes.map((n) => [n.id, n]));
  const b = new Map(actual.nodes.map((n) => [n.id, n]));
  for (const [id, node] of a)
    if (!b.has(id))
      lines.push(`missing ${id.slice(0, 8)} ${JSON.stringify(node.text)}`);
  for (const [id, node] of b)
    if (!a.has(id))
      lines.push(`extra ${id.slice(0, 8)} ${JSON.stringify(node.text)}`);
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!y) continue;
    for (const key of Object.keys(x) as (keyof DocNode)[])
      if (JSON.stringify(x[key]) !== JSON.stringify(y[key]))
        lines.push(
          `${id.slice(0, 8)}.${key} ${JSON.stringify(x[key])} → ${JSON.stringify(y[key])}`,
        );
  }
  return lines.slice(0, 12).join("\n  ");
}

const COLORS = [
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "violet",
  "slate",
];
// Structural rules any document must satisfy (as webapp/tests/fuzz-helpers.ts).
function documentProblem(view: Doc): string | undefined {
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  if (byId.size !== view.nodes.length) return "duplicate node ids";
  const seen = new Set<string>();
  const visit = (
    id: string,
    parent: string | null,
    depth: number,
  ): string | undefined => {
    const node = byId.get(id);
    if (!node) return `missing node ${id}`;
    if (seen.has(id)) return `node ${id} reachable twice`;
    seen.add(id);
    if (node.parent !== parent) return `node ${id} parent mismatch`;
    if (node.depth !== depth)
      return `node ${id} depth ${node.depth}, expected ${depth}`;
    if (node.text.length > 65_536 || node.note.length > 65_536)
      return `node ${id} over limit`;
    if (!COLORS.includes(node.color))
      return `node ${id} has color ${node.color}`;
    if (
      node.position &&
      !(Number.isFinite(node.position.x) && Number.isFinite(node.position.y))
    )
      return `node ${id} has a non-finite position`;
    for (const child of node.children) {
      const problem = visit(child, id, depth + 1);
      if (problem) return problem;
    }
  };
  for (const root of view.roots) {
    const problem = visit(root, null, 0);
    if (problem) return problem;
  }
  if (seen.size !== view.nodes.length)
    return `${view.nodes.length - seen.size} nodes unreachable from roots`;
}

// ---------------------------------------------------------------------------
// Running actions.

class Failure extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(`${kind}: ${message}`);
    this.kind = kind;
  }
}

// Where an action's effect lands in the history model.
//   edit: a change, if any, is exactly one new undo step;
//   text: typing in a field; may extend the writing session's step;
//   undo / redo: one step back or forward (nothing when the stack is empty);
//   blocked: an undo shortcut the editor deliberately ignores here.
type Effect = "edit" | "text" | "undo" | "redo" | "blocked";

const UNDO_KEYS = new Set(["ControlOrMeta+KeyZ"]);
const REDO_KEYS = new Set(["ControlOrMeta+Shift+KeyZ", "ControlOrMeta+KeyY"]);
const TEXT_KEYS = new Set(["Backspace", "Delete", "Shift+Enter"]);
const BUTTONS = [
  '[aria-label="Selected idea"] button[title^="Add a child"]',
  '[aria-label="Selected idea"] button[title^="Add a sibling"]',
  '[aria-label="Selected idea"] button[aria-label="Notes"]',
  'button[aria-label="Collapse children"], button[aria-label="Expand children"]',
  'button[aria-label="Focus branch"], button[aria-label="Leave focus"]',
  'button[aria-label="Delete idea"]',
  'button[aria-label="Undo"]',
  'button[aria-label="Undo"]',
  'button[aria-label="Redo"]',
  'button[aria-label="Search"]',
  'button[aria-label="Outline"]',
  'button[aria-label="Zoom in"]',
  'button[aria-label="Zoom out"]',
  'button[aria-label="Zoom to 100%"]',
  'button[aria-label="Fit map"]',
  'button[aria-label="Fit selection"]',
  'button[aria-label="Close notes"]',
  'button[aria-label="Close outline"]',
  'button[aria-label="Close search"]',
  'button[aria-label="Dismiss quick start"]',
  'button[aria-label="Return from search"]',
  'button[aria-label="Stay here"]',
  '[aria-label="Branch focus"] button',
  ".notice button",
  ".notice button",
];

// The name the project name field will commit when it loses focus, if any.
function renameDraft(state: State) {
  if (state.focus !== "input:Project name") return undefined;
  const draft = state.nameDraft?.trim() ?? "";
  return draft &&
    draft !== state.doc.name &&
    new TextEncoder().encode(draft).length <= 200
    ? draft
    : undefined;
}

const isField = (focus: string) =>
  focus.startsWith("text:") || focus.startsWith("note:");
// Mirrors the editor's history shortcut: ignored from other inputs, while a
// menu is open, and while writing with focus elsewhere.
function undoBlocked(state: State) {
  if (!state.ready || state.contextMenu) return true;
  if (state.focus.startsWith("input:")) return true;
  if (state.editors.length && !state.editors.some((e) => e.focused))
    return true;
  return false;
}

interface Point {
  x: number;
  y: number;
}

class Runner {
  page!: Page;
  context!: BrowserContext;
  errors: string[] = [];
  log: string[] = [];
  executed = 0;
  skipped = 0;
  clipboard?: { text: string; rich: string };
  // Documents before each undoable step, and after each undone one.
  past: string[] = [];
  future: string[] = [];
  pastDocs: Doc[] = [];
  futureDocs: Doc[] = [];
  // The writing session ("text:<id>" / "note:<id>") whose typing made the top
  // undo step, while it can still grow.
  session?: string;
  // Set when a pointer action ran while that session's field kept focus:
  // it may have blurred and refocused the field (a new session) or not.
  sessionUnsure = false;
  state!: State;

  async open() {
    this.context = await browser.newContext({
      viewport: VIEWPORT,
      reducedMotion: "reduce",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(5_000);
    this.page.on("pageerror", (error) =>
      this.errors.push(`pageerror: ${error.message}`),
    );
    this.page.on("console", (message) => {
      // The harness answers account requests with 401 (signed out).
      if (
        message.type() === "error" &&
        !/\b401\b|Unauthorized/.test(message.text())
      )
        this.errors.push(`console: ${message.text()}`);
    });
    this.page.on("dialog", (dialog) => void dialog.dismiss());
    await this.page.goto(url);
    await this.page.waitForSelector('[data-storage-ready="true"]', {
      timeout: 20_000,
    });
    await this.page.waitForSelector("[data-node-id]");
    await this.settle();
    this.state = await readState(this.page);
    this.check(this.state);
    if (this.state.history.undo || this.state.history.redo)
      throw new Failure(
        "history",
        `a fresh map has history ${JSON.stringify(this.state.history)}`,
      );
  }

  close() {
    return this.context?.close();
  }

  settle() {
    return this.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(resolve, 0)),
          ),
        ),
    );
  }

  // Ideas currently on the canvas, in document order.
  visible(state = this.state) {
    const shown = new Set(state.rendered.map((node) => node.id));
    const order: string[] = [];
    const byId = new Map(state.doc.nodes.map((node) => [node.id, node]));
    const visit = (id: string) => {
      if (shown.has(id)) order.push(id);
      for (const child of byId.get(id)?.children ?? []) visit(child);
    };
    for (const root of state.doc.roots) visit(root);
    return order;
  }

  // A point on an idea where it is visible and on top (elementFromPoint), or
  // undefined. `where` picks the middle or the top/bottom drop edges.
  hit(id: string, where: "center" | "before" | "after" = "center") {
    return this.page.evaluate(
      ([id, where]) => {
        const el = document.querySelector(
          `[aria-label="Mind map canvas"] [data-node-id="${CSS.escape(id)}"]`,
        );
        if (!el) return undefined;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return undefined;
        const edge = Math.max(1, Math.min(3, r.height / 8));
        const x = r.left + r.width / 2;
        const y =
          where === "before"
            ? r.top + edge
            : where === "after"
              ? r.bottom - edge
              : r.top + r.height / 2;
        if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2)
          return undefined;
        const hit = document.elementFromPoint(x, y);
        if (!hit || hit.closest("[data-node-id]") !== el) return undefined;
        // The fold badge is its own button; a click there expands instead.
        if (hit.closest('button[aria-label^="Expand "]')) return undefined;
        return { x, y };
      },
      [id, where] as const,
    );
  }

  // Brings an idea into view the way a person would (fit selection, then fit
  // map) when it is off screen or covered, as long as keys reach the canvas.
  async reach(id: string, where: "center" | "before" | "after" = "center") {
    let point = await this.hit(id, where);
    if (point) return point;
    for (const key of ["Alt+Digit2", "Alt+Digit1"]) {
      const state = await readState(this.page);
      if (
        isField(state.focus) ||
        state.focus.startsWith("input:") ||
        state.contextMenu ||
        state.dialog ||
        state.searchOpen
      )
        return undefined;
      if (
        key === "Alt+Digit2" &&
        !state.rendered.some((n) => n.selected && n.id === id)
      )
        continue;
      await this.page.keyboard.press(key);
      this.log.push(`  (pressed ${key} to reach ${id.slice(0, 8)})`);
      await this.settle();
      point = await this.hit(id, where);
      if (point) return point;
    }
    return undefined;
  }

  // An empty spot of canvas near a seeded position.
  emptyPoint(p: number) {
    return this.page.evaluate(
      ([p, width, height]) => {
        for (let attempt = 0; attempt < 12; attempt++) {
          const q = (p * (attempt * 7919 + 1)) % 1_000_003;
          const x = 30 + ((q % 1000) / 1000) * (width - 60);
          const y =
            90 + ((Math.floor(q / 1000) % 1000) / 1000) * (height - 180);
          const hit = document.elementFromPoint(x, y);
          if (
            hit?.closest('[aria-label="Mind map canvas"]') &&
            !hit.closest(
              "[data-no-pan], [data-node-id], [data-toolbar], button, dialog",
            )
          )
            return { x, y };
        }
        return undefined;
      },
      [p, VIEWPORT.width, VIEWPORT.height] as const,
    );
  }

  // A visible, topmost element matching the selector (index wraps).
  target(selector: string, index = 0) {
    return this.page.evaluate(
      ([selector, index]) => {
        const all = [
          ...document.querySelectorAll<HTMLElement>(selector),
        ].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!all.length) return undefined;
        const el = all[index % all.length];
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1)
          return undefined;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === el || el.contains(hit))) return undefined;
        return {
          x,
          y,
          disabled: (el as HTMLButtonElement).disabled === true,
          label: (el.getAttribute("aria-label") ?? el.textContent ?? "")
            .trim()
            .slice(0, 40),
        };
      },
      [selector, index] as const,
    );
  }

  pick(n: number, exclude?: string) {
    const ids = this.visible().filter((id) => id !== exclude);
    return ids.length ? ids[n % ids.length] : undefined;
  }

  async clipboardEvent(
    type: "copy" | "cut" | "paste",
    data?: { text: string; rich: string },
  ) {
    return this.page.evaluate(
      ([type, text, rich, mime]) => {
        const target = document.activeElement ?? document.body;
        const transfer = new DataTransfer();
        if (text) transfer.setData("text/plain", text);
        if (rich) transfer.setData(mime, rich);
        const event = new ClipboardEvent(type, {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
        return {
          handled: event.defaultPrevented,
          supported: !!event.clipboardData,
          text: transfer.getData("text/plain"),
          rich: transfer.getData(mime),
        };
      },
      [type, data?.text ?? "", data?.rich ?? "", BRANCH_MIME] as const,
    );
  }

  // Performs one action; returns how it affects history, or "skip" when it
  // does not apply (nothing to click, target covered, and so on).
  async perform(
    action: Action,
  ): Promise<{ effect: Effect; detail: string } | "skip"> {
    const page = this.page;
    const state = this.state;
    switch (action.k) {
      case "type": {
        // On a focused button, Space would press it and the rest would type
        // into whatever that opened: several steps in one action. Single
        // Space and Enter presses cover buttons instead.
        if (["toolbar", "outline", "menu", "button"].includes(state.focus))
          return "skip";
        await page.keyboard.type(action.t);
        return {
          effect: isField(state.focus) ? "text" : "edit",
          detail: `in ${state.focus}`,
        };
      }
      case "key": {
        const key = action.key;
        // Playwright's WebKit still treats Backspace outside text fields as
        // "go back" (Safari dropped that in version 13); the page would unload.
        if (
          BROWSER === "webkit" &&
          key === "Backspace" &&
          !isField(state.focus) &&
          !state.focus.startsWith("input:") &&
          !(
            ["canvas", "body"].includes(state.focus) &&
            state.rendered.some((node) => node.selected) &&
            !state.searchOpen &&
            !state.dialog &&
            !state.contextMenu
          )
        )
          return "skip";
        // Account buttons sign in or out, which leaves the page by design.
        if (state.focus === "account" && (key === "Enter" || key === " "))
          return "skip";
        let effect: Effect = "edit";
        if (UNDO_KEYS.has(key))
          effect = undoBlocked(state) ? "blocked" : "undo";
        else if (REDO_KEYS.has(key))
          effect = undoBlocked(state) ? "blocked" : "redo";
        else if (
          isField(state.focus) &&
          (TEXT_KEYS.has(key) ||
            (state.focus.startsWith("note:") &&
              (key === "Enter" || key === " ")) ||
            (state.focus.startsWith("text:") && key === " "))
        )
          effect = "text";
        else if (
          (key === "Enter" || key === " ") &&
          state.button &&
          !state.button.disabled &&
          /^(Undo|Redo)$/.test(state.button.label)
        )
          // Keyboard activation of a focused Undo or Redo button.
          effect = state.button.label === "Undo" ? "undo" : "redo";
        await page.keyboard.press(key);
        return { effect, detail: `in ${state.focus}` };
      }
      case "click":
      case "dblclick": {
        const id = this.pick(action.n);
        if (!id) return "skip";
        const point = await this.reach(id);
        if (!point) return "skip";
        if (action.k === "click") await page.mouse.click(point.x, point.y);
        else await page.mouse.dblclick(point.x, point.y);
        return { effect: "edit", detail: id.slice(0, 8) };
      }
      case "canvas": {
        const point = await this.emptyPoint(action.p);
        if (!point) return "skip";
        await page.mouse.click(point.x, point.y);
        return {
          effect: "edit",
          detail: `${Math.round(point.x)},${Math.round(point.y)}`,
        };
      }
      case "drag": {
        const id = this.pick(action.n);
        if (!id) return "skip";
        const from = await this.reach(id);
        if (!from) return "skip";
        let to: Point | undefined;
        let onto = "";
        if (action.mode === "canvas") to = await this.emptyPoint(action.p);
        else {
          const target = this.pick(action.m, id);
          if (!target) return "skip";
          to = await this.hit(
            target,
            action.mode === "inside" ? "center" : action.mode,
          );
          onto = target.slice(0, 8);
        }
        if (!to) return "skip";
        // The source must still be on top after any view change above.
        const again = await this.hit(id);
        if (!again) return "skip";
        await page.mouse.move(again.x, again.y);
        await page.mouse.down();
        await page.mouse.move(again.x + 4, again.y + 4, { steps: 2 });
        await page.mouse.move(to.x, to.y, { steps: 8 });
        const label = await page
          .locator(".drag-label")
          .textContent({ timeout: 200 })
          .catch(() => "");
        await page.mouse.up();
        return {
          effect: "edit",
          detail: `${id.slice(0, 8)} → ${action.mode} ${onto} [${label}]`,
        };
      }
      case "pan": {
        const point = await this.emptyPoint(action.p);
        if (!point) return "skip";
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + action.dx, point.y + action.dy, {
          steps: 5,
        });
        await page.mouse.up();
        return { effect: "edit", detail: "" };
      }
      case "wheel": {
        const point = await this.emptyPoint(action.p);
        if (!point) return "skip";
        await page.mouse.move(point.x, point.y);
        if (action.zoom) await page.keyboard.down("Control");
        await page.mouse.wheel(0, action.dy);
        if (action.zoom) await page.keyboard.up("Control");
        return { effect: "edit", detail: "" };
      }
      case "button": {
        const selector = BUTTONS[action.b % BUTTONS.length];
        const target = await this.target(selector, action.n);
        if (!target) return "skip";
        await page.mouse.click(target.x, target.y);
        let effect: Effect = "edit";
        // Pressing Undo commits a pending project name first, which enables
        // the button in time for the click to undo that rename.
        if (
          (!target.disabled || renameDraft(state) !== undefined) &&
          /^Undo$/.test(target.label)
        )
          effect = "undo";
        if (!target.disabled && /^Redo$/.test(target.label)) effect = "redo";
        // Known (reported) behavior: pressing a notice's button first commits
        // a pending project name, which retires the notice before the click
        // lands, so its Undo or Redo never runs.
        if (selector === ".notice button" && renameDraft(state) !== undefined)
          effect = "edit";
        return {
          effect,
          detail: `${target.label}${target.disabled ? " (disabled)" : ""}`,
        };
      }
      case "color": {
        if (
          !state.contextMenu &&
          !(await this.target('[aria-label="Selected node color controls"]'))
        ) {
          const open = await this.target('button[aria-label="Color"]');
          if (!open) return "skip";
          await page.mouse.click(open.x, open.y);
          await this.settle();
        }
        const scope = await this.target(
          '[aria-label="Selected node color controls"] .color-scope',
          action.scope,
        );
        if (!scope) return "skip";
        await page.mouse.click(scope.x, scope.y);
        await this.settle();
        const swatch = await this.target(
          '[aria-label="Selected node color controls"] .color-choice',
          action.c,
        );
        if (!swatch) return "skip";
        await page.mouse.click(swatch.x, swatch.y);
        return { effect: "edit", detail: `${scope.label} ${swatch.label}` };
      }
      case "menu": {
        let point: Point | undefined;
        let detail = "canvas";
        if (action.canvas) point = await this.emptyPoint(action.p);
        else {
          const id = this.pick(action.n);
          if (!id) return "skip";
          point = await this.reach(id);
          detail = id.slice(0, 8);
        }
        if (!point) return "skip";
        await page.mouse.click(point.x, point.y, { button: "right" });
        await this.settle();
        const count = await page
          .locator("[data-context-menu] [role=menuitem]:not(:disabled)")
          .count();
        if (!count) return { effect: "edit", detail: `${detail}: no menu` };
        if (action.item % (count + 1) === count) {
          await page.keyboard.press("Escape");
          return { effect: "edit", detail: `${detail}: Escape` };
        }
        const item = await this.target(
          "[data-context-menu] [role=menuitem]:not(:disabled)",
          action.item % count,
        );
        if (!item) {
          await page.keyboard.press("Escape");
          return { effect: "edit", detail: `${detail}: item covered, Escape` };
        }
        await page.mouse.click(item.x, item.y);
        return { effect: "edit", detail: `${detail}: ${item.label}` };
      }
      case "outline": {
        const selector =
          action.how === "toggle"
            ? "[data-outline-id] > .outline-row > .outline-toggle"
            : "[data-outline-id] > .outline-row";
        const target = await this.target(selector, action.n);
        if (!target) return "skip";
        if (action.how === "dblclick")
          await page.mouse.dblclick(target.x, target.y);
        else await page.mouse.click(target.x, target.y);
        return { effect: "edit", detail: `${action.how} ${target.label}` };
      }
      case "expand": {
        const target = await this.target(
          '[data-node-id] button[aria-label^="Expand "]',
          action.n,
        );
        if (!target) return "skip";
        await page.mouse.click(target.x, target.y);
        return { effect: "edit", detail: target.label };
      }
      case "result": {
        const target = await this.target(
          '[aria-label="Search results"] [role=option]',
          action.n,
        );
        if (!target) return "skip";
        await page.mouse.click(target.x, target.y);
        return { effect: "edit", detail: target.label };
      }
      case "copy":
      case "cut":
      case "paste": {
        // A real paste into a text field inserts text natively, which a
        // synthetic event cannot reproduce.
        if (isField(state.focus) || state.focus.startsWith("input:"))
          return "skip";
        const data =
          action.k === "paste"
            ? action.t !== undefined
              ? { text: action.t, rich: "" }
              : this.clipboard
            : undefined;
        if (action.k === "paste" && !data) return "skip";
        const result = await this.clipboardEvent(action.k, data);
        if (!result.supported) return "skip";
        if (action.k !== "paste" && result.handled)
          this.clipboard = { text: result.text, rich: result.rich };
        return {
          effect: "edit",
          detail: `${result.handled ? "handled" : "ignored"} ${JSON.stringify((data?.text ?? result.text).slice(0, 30))}`,
        };
      }
    }
  }

  // Invariants that hold after every action, whatever it was.
  check(state: State) {
    if (this.errors.length)
      throw new Failure("page-error", this.errors.join("\n"));
    if (!state.ready)
      throw new Failure("not-ready", "storage is no longer ready");
    const problem = documentProblem(state.doc);
    if (problem) throw new Failure("invalid-document", problem);
    const byId = new Map(state.doc.nodes.map((node) => [node.id, node]));
    const shown = state.rendered.map((node) => node.id);
    if (new Set(shown).size !== shown.length)
      throw new Failure(
        "duplicate-render",
        `an idea is drawn twice: ${shown.join(",")}`,
      );
    const ghost = shown.find((id) => !byId.has(id));
    if (ghost)
      throw new Failure(
        "ghost-node",
        `${ghost} is drawn but not in the document`,
      );
    const selected = state.rendered.filter((node) => node.selected);
    if (selected.length > 1)
      throw new Failure(
        "multi-select",
        `${selected.length} ideas are marked selected`,
      );
    if (state.editors.length > 1)
      throw new Failure(
        "multi-editor",
        `${state.editors.length} node editors are open`,
      );
    const editor = state.editors[0];
    if (editor) {
      const node = editor.id ? byId.get(editor.id) : undefined;
      if (!node)
        throw new Failure(
          "editor-orphan",
          `editor for ${editor.id} has no idea`,
        );
      if (editor.value !== node.text)
        throw new Failure(
          "editor-text",
          `editor shows ${JSON.stringify(editor.value)}, document has ${JSON.stringify(node.text)}`,
        );
      if (!selected.some((s) => s.id === editor.id))
        throw new Failure(
          "editor-unselected",
          `editing ${editor.id} which is not selected`,
        );
      if (!editor.focused)
        throw new Failure(
          "editor-unfocused",
          `the editor for ${editor.id} is open but focus is on ${state.focus}`,
        );
    }
    const notesFor = selected[0]?.id;
    if (state.notes && notesFor) {
      const note = byId.get(notesFor)?.note;
      if (state.notes.value !== note)
        throw new Failure(
          "notes-text",
          `notes show ${JSON.stringify(state.notes.value)}, document has ${JSON.stringify(note)}`,
        );
    }
    // What the canvas draws is a whole scope (every root, or one focused
    // branch) with folds respected, and the outline lists exactly that.
    const drawn = new Set(shown);
    const collapsed = new Set(
      state.rendered.filter((n) => n.collapsed).map((n) => n.id),
    );
    const order: string[] = [];
    const visit = (id: string) => {
      order.push(id);
      if (!collapsed.has(id))
        for (const child of byId.get(id)?.children ?? []) visit(child);
    };
    const all = this.visible(state);
    const scope = all.filter((id) => {
      const parent = byId.get(id)?.parent;
      return !parent || !drawn.has(parent);
    });
    if (state.focusMode && scope.length !== 1)
      throw new Failure(
        "focus-scope",
        `focused view draws ${scope.length} branches`,
      );
    const scoped = state.focusMode ? scope : state.doc.roots;
    for (const id of scoped) visit(id);
    if (order.join() !== all.join())
      throw new Failure(
        "canvas-visible",
        `canvas draws ${all.length} ideas, expected ${order.length} (scope ${scoped.length}); missing ${order.filter((id) => !drawn.has(id)).slice(0, 3)} extra ${all.filter((id) => !order.includes(id)).slice(0, 3)}`,
      );
    if (state.outline && state.outline.join() !== order.join())
      throw new Failure(
        "outline-visible",
        `outline lists ${state.outline.length} ideas, canvas shows ${order.length}`,
      );
    if (
      state.undoDisabled !== undefined &&
      state.undoDisabled === state.history.canUndo
    )
      throw new Failure(
        "undo-button",
        `Undo disabled=${state.undoDisabled} but canUndo=${state.history.canUndo}`,
      );
    if (
      state.redoDisabled !== undefined &&
      state.redoDisabled === state.history.canRedo
    )
      throw new Failure(
        "redo-button",
        `Redo disabled=${state.redoDisabled} but canRedo=${state.history.canRedo}`,
      );
  }

  // One new undo step that started from `doc`; the oldest falls off at the
  // editor's limit, and the redo stack is gone.
  record(doc: Doc) {
    this.past.push(canonical(doc));
    this.pastDocs.push(doc);
    while (this.past.length > UNDO_LIMIT) {
      this.past.shift();
      this.pastDocs.shift();
    }
    this.future = [];
    this.futureDocs = [];
  }

  // The history model.
  account(before: State, after: State, effect: Effect, action: Action) {
    if (after.projectId !== before.projectId) {
      // Another map opened (for example from a toolbar reached with F6);
      // history is per map.
      this.past = [];
      this.future = [];
      this.pastDocs = [];
      this.futureDocs = [];
      this.session = undefined;
      if (after.history.undo || after.history.redo)
        throw new Failure("history", "a newly opened map has undo history");
      return;
    }
    // The project name field commits a changed draft as its own step when it
    // loses focus, before the rest of the action takes effect.
    const draft = renameDraft(before);
    // (WebKit's native undo in the field can revert the draft instead, so the
    // rename counts only when the name or the history shows it.)
    if (
      draft !== undefined &&
      after.focus !== before.focus &&
      (after.doc.name === draft ||
        after.history.undo > before.history.undo ||
        after.history.redo > before.history.redo ||
        // Undo pressed with a pending name: the rename, then its undo.
        (effect === "undo" &&
          after.history.undo === before.history.undo &&
          canonical(after.doc) === canonical(before.doc)))
    ) {
      this.record(before.doc);
      before = {
        ...before,
        doc: { ...before.doc, name: draft },
        history: {
          ...before.history,
          undo: Math.min(UNDO_LIMIT, before.history.undo + 1),
          redo: 0,
        },
      };
    }
    const was = canonical(before.doc);
    const now = canonical(after.doc);
    const changed = was !== now;
    // Focus leaving a field (between actions too) ends its writing session.
    if (before.focus !== this.session) this.session = undefined;
    let expectedKind = "history-count";
    if (effect === "undo" || effect === "redo") {
      this.session = undefined;
      expectedKind = `${effect}-count`;
      const [from, to, fromDocs, toDocs] =
        effect === "undo"
          ? [this.past, this.future, this.pastDocs, this.futureDocs]
          : [this.future, this.past, this.futureDocs, this.pastDocs];
      // A step whose edits cancelled out (typed, then deleted the same text)
      // has nothing to revert: Loro drops it and reverts the step before.
      while (from.length > 1 && from[from.length - 1] === was) {
        from.pop();
        fromDocs.pop();
      }
      if (!from.length) {
        if (changed)
          throw new Failure(
            `${effect}-empty`,
            `${effect} with nothing to ${effect} changed the document:\n  ${describeDiff(before.doc, after.doc)}`,
          );
      } else {
        const expected = from.pop() as string;
        const expectedDoc = fromDocs.pop() as Doc;
        if (now !== expected)
          throw new Failure(
            `${effect}-mismatch`,
            `${effect} did not restore the expected document:\n  ${describeDiff(expectedDoc, after.doc)}`,
          );
        to.push(was);
        toDocs.push(before.doc);
      }
    } else if (effect === "blocked") {
      if (changed)
        throw new Failure(
          "blocked-undo-changed",
          `an ignored undo shortcut changed the document:\n  ${describeDiff(before.doc, after.doc)}`,
        );
    } else if (changed) {
      // Typing continues the step its writing session started while the same
      // field keeps focus; anything else is one new step.
      const grows =
        effect === "text" &&
        this.session === before.focus &&
        after.focus === before.focus &&
        this.past.length > 0 &&
        !(this.sessionUnsure && after.history.undo === before.history.undo + 1);
      if (grows) expectedKind = "typing-session-split";
      else {
        expectedKind =
          after.history.undo === before.history.undo
            ? "change-merged-into-previous-step"
            : after.history.undo > before.history.undo + 1
              ? "change-made-several-steps"
              : "history-count";
        this.record(before.doc);
      }
      this.future = [];
      this.futureDocs = [];
      this.session =
        (effect === "text" || action.k === "type") && isField(after.focus)
          ? after.focus
          : undefined;
      if (!grows) this.sessionUnsure = false;
    } else if (
      action.k === "type" &&
      after.history.undo === before.history.undo + 1 &&
      this.session !== before.focus
    ) {
      // Retyping the text an idea already had changes it and back within one
      // action: a real, if invisible, step.
      this.record(before.doc);
      this.session = isField(after.focus) ? after.focus : undefined;
    } else {
      expectedKind =
        after.history.undo !== before.history.undo
          ? "empty-undo-step"
          : "redo-lost-without-change";
    }
    if (!["type", "key", "wheel"].includes(action.k) && this.session)
      this.sessionUnsure = true;
    const { undo, redo } = after.history;
    if (undo !== this.past.length || redo !== this.future.length)
      throw new Failure(
        expectedKind,
        `${effect}: expected undo/redo ${this.past.length}/${this.future.length}, editor has ${undo}/${redo} (before ${before.history.undo}/${before.history.redo}, changed=${changed})${changed ? `\n  ${describeDiff(before.doc, after.doc)}` : ""}`,
      );
  }
}

// Coverage per action kind, printed after a sweep.
const STATS = new Map<string, { run: number; skip: number; changed: number }>();
function tally(action: Action, outcome: "run" | "skip", changed = false) {
  const name =
    action.k === "key"
      ? `key ${action.key}`
      : action.k === "drag"
        ? `drag ${action.mode}`
        : action.k;
  const entry = STATS.get(name) ?? { run: 0, skip: 0, changed: 0 };
  entry[outcome]++;
  if (changed) entry.changed++;
  STATS.set(name, entry);
}

interface Outcome {
  executed: number;
  skipped: number;
  failure?: { kind: string; message: string; index: number };
  log: string[];
}

async function run(
  actions: Action[],
  stopAt = actions.length,
): Promise<Outcome> {
  const runner = new Runner();
  try {
    try {
      await runner.open();
    } catch (error) {
      const kind = error instanceof Failure ? error.kind : "open";
      return {
        executed: 0,
        skipped: 0,
        failure: { kind, message: String(error), index: -1 },
        log: [],
      };
    }
    for (let index = 0; index < Math.min(stopAt, actions.length); index++) {
      const action = actions[index];
      const before = runner.state;
      let detail = "";
      try {
        const result = await runner.perform(action);
        if (result === "skip") {
          runner.skipped++;
          tally(action, "skip");
          runner.log.push(`${index}: ${JSON.stringify(action)} skipped`);
          await runner.settle();
          runner.state = await readState(runner.page);
          runner.check(runner.state);
          runner.account(before, runner.state, "edit", action);
          continue;
        }
        detail = result.detail;
        runner.executed++;
        runner.log.push(
          `${index}: ${JSON.stringify(action)} ${result.effect} ${detail}`,
        );
        await runner.settle();
        const after = await readState(runner.page);
        runner.state = after;
        runner.log[runner.log.length - 1] +=
          ` → ${after.focus} u/r ${after.history.undo}/${after.history.redo}${after.doc.name !== before.doc.name ? ` name ${JSON.stringify(after.doc.name)}` : ""}${after.nameDraft !== before.nameDraft ? ` draft ${JSON.stringify(after.nameDraft)}` : ""}`;
        runner.check(after);
        // Typing stays in the field it started in.
        if (
          action.k === "type" &&
          isField(before.focus) &&
          isField(after.focus) &&
          after.focus !== before.focus
        )
          throw new Failure(
            "editor-jumped",
            `typing started in ${before.focus} and ended in ${after.focus}`,
          );
        runner.account(before, after, result.effect, action);
        tally(
          action,
          "run",
          canonical(before.doc) !== canonical(after.doc) ||
            before.history.undo !== after.history.undo,
        );
      } catch (error) {
        const failure =
          error instanceof Failure
            ? error
            : new Failure(
                "harness",
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
              );
        return {
          executed: runner.executed,
          skipped: runner.skipped,
          failure: { kind: failure.kind, message: failure.message, index },
          log: runner.log,
        };
      }
    }
    return {
      executed: runner.executed,
      skipped: runner.skipped,
      log: runner.log,
    };
  } finally {
    await runner.close();
  }
}

// Delta debugging: drop chunks of the failing prefix while the same kind of
// failure still happens, within a budget of replays.
async function minimize(actions: Action[], kind: string, budget: number) {
  let current = actions;
  let runs = 0;
  const fails = async (candidate: Action[]) => {
    runs++;
    const outcome = await run(candidate);
    if (outcome.failure?.kind !== kind) return undefined;
    return candidate.slice(0, outcome.failure.index + 1);
  };
  let granularity = 2;
  while (current.length > 1 && runs < budget) {
    const size = Math.ceil(current.length / granularity);
    let reduced = false;
    for (
      let start = 0;
      start < current.length && runs < budget;
      start += size
    ) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + size),
      ];
      const smaller = await fails(candidate);
      if (smaller) {
        current = smaller;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (size <= 1) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return { actions: current, runs };
}

interface Report {
  browser: string;
  seed: number;
  kind: string;
  message: string;
  index: number;
  last: string[];
  reproduced: boolean;
  minimized?: Action[];
}

async function fuzzSeed(seed: number) {
  const actions = actionsFor(seed, STEPS);
  const outcome = await run(actions);
  let report: Report | undefined;
  if (outcome.failure) {
    const { kind, message, index } = outcome.failure;
    const prefix = actions.slice(0, index + 1);
    report = {
      browser: BROWSER,
      seed,
      kind,
      message,
      index,
      last: outcome.log.slice(-20),
      reproduced: false,
    };
    if (MINIMIZE > 0 && index >= 0) {
      const again = await run(prefix);
      report.reproduced = again.failure?.kind === kind;
      if (report.reproduced) {
        const { actions: smallest, runs } = await minimize(
          prefix.slice(0, (again.failure?.index ?? index) + 1),
          kind,
          MINIMIZE,
        );
        report.minimized = smallest;
        const final = await run(smallest);
        report.last = final.log.slice(-20);
        report.message = final.failure?.message ?? report.message;
        console.log(
          `  minimized seed ${seed} to ${smallest.length} actions in ${runs} replays`,
        );
      }
    }
    const text = [
      `UI fuzz failure [${BROWSER}] seed ${seed} at action ${index}: ${kind}`,
      report.message,
      `${report.reproduced ? "reproduced" : "NOT reproduced on replay"}; last actions:`,
      ...report.last.map((line) => `  ${line}`),
      report.minimized
        ? `minimized (${report.minimized.length}): FUZZ_REPLAY='${JSON.stringify(report.minimized)}'`
        : "",
    ].join("\n");
    console.log(text);
    if (OUT) appendFileSync(OUT, `${JSON.stringify(report)}\n`);
  }
  return { outcome, report };
}

describe(`UI fuzz (${BROWSER})`, () => {
  if (process.env.FUZZ_REPLAY) {
    test("replay FUZZ_REPLAY", async () => {
      const actions = JSON.parse(process.env.FUZZ_REPLAY as string) as Action[];
      const outcome = await run(actions);
      console.log(outcome.log.join("\n"));
      expect(outcome.failure).toBeUndefined();
    });
    return;
  }

  test(`seeds ${FIRST_SEED}–${FIRST_SEED + SEEDS - 1} × ${STEPS} actions keep the document valid and undo exact`, async () => {
    const started = performance.now();
    let executed = 0;
    let skipped = 0;
    const failures: Report[] = [];
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
      const { outcome, report } = await fuzzSeed(seed);
      executed += outcome.executed;
      skipped += outcome.skipped;
      if (report) failures.push(report);
    }
    console.log(
      `UI fuzz [${BROWSER}] seeds ${FIRST_SEED}..${FIRST_SEED + SEEDS - 1}: ${executed} actions executed, ${skipped} skipped, ${failures.length} failing seeds, ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
    if (process.env.FUZZ_STATS)
      console.log(
        [...STATS]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(
            ([name, s]) =>
              `  ${name.padEnd(30)} run ${String(s.run).padStart(5)}  changed ${String(s.changed).padStart(5)}  skipped ${String(s.skip).padStart(5)}`,
          )
          .join("\n"),
      );
    expect(failures.map((f) => `seed ${f.seed}: ${f.kind}`)).toEqual([]);
  });

  // Minimized failures the fuzzer found, kept as regression tests.
  for (const repro of KNOWN) {
    test(repro.name, async () => {
      const outcome = await run(repro.actions);
      if (outcome.failure) console.log(outcome.log.join("\n"));
      expect(outcome.failure).toBeUndefined();
    });
  }
});
