// Generative tests for the portable formats: the clipboard outline, the
// Markdown export and the JSON backup. Seeds and sizes come from fuzz-helpers
// (FUZZ_SEEDS, FUZZ_STEPS, FUZZ_SEED); defaults finish in a few seconds.
//   FUZZ_SEEDS=2000 bun test --conditions browser tests/fuzz-portable.test.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import type { MindMapNode } from "../src/mind-map";
import { NODE_COLORS } from "../src/node-colors";
import type { NodeColor } from "../src/node-colors";
import {
  branchEntry,
  branchOutline,
  parseBranchEntry,
  parseOutline,
} from "../src/outline-text";
import type { OutlineEntry } from "../src/outline-text";
import {
  createChild,
  createProjectDocument,
  createRoot,
  importProjectDocument,
  LIMITS,
  renameProject,
  setNodeNote,
  setSavingPreferences,
} from "../src/project-document";
import type { DocumentView, ProjectDocument } from "../src/project-document";
import {
  exportProjectDocument,
  parseProjectFile,
  prepareProjectImport,
  PROJECT_FILE_MAX_DEPTH,
  ProjectFileError,
  projectMarkdown,
  serializeProjectFile,
} from "../src/project-import-export";
import type { ProjectFile } from "../src/project-import-export";
import {
  checkView,
  FIRST_SEED,
  random,
  SEEDS,
  STEPS,
  tryEdit,
} from "./fuzz-helpers";
import type { Random } from "./fuzz-helpers";

// Large FUZZ_SEEDS runs take minutes; bun's 5 s default would cut them off.
setDefaultTimeout(3_600_000);
const seeds = Array.from({ length: SEEDS }, (_, i) => FIRST_SEED + i);
const COLORS = NODE_COLORS.map((color) => color.value);
const stats: Record<string, number> = {};
const count = (key: string, by = 1) => (stats[key] = (stats[key] ?? 0) + by);

// ---------------------------------------------------------------------------
// Generators

// Pieces that look like markup, plus ordinary and awkward Unicode. Newlines,
// carriage returns and tabs are opt-in because the formats treat them as
// structure.
const PIECES = [
  "idea",
  "Plan",
  "x",
  " ",
  "  ",
  "- ",
  "-",
  "* ",
  "+ ",
  "# ",
  "## ",
  "#",
  "> ",
  ">",
  "1. ",
  "12) ",
  "2024. ",
  "2024.",
  "1234. ",
  "1.",
  "\\",
  "\\\\",
  "\\- ",
  "\\# ",
  "\\1. ",
  "[ ] ",
  "[x] ",
  "[X]",
  "• ",
  "◦ ",
  "▪ ",
  "‣ ",
  "😀",
  "👩‍👩‍👧",
  "é",
  "é",
  "שלום",
  "日本語",
  "​",
  " ",
  " ",
  "﻿",
  "\ud83d",
  "\ude00",
  "<b>",
  '"q"',
  "`",
  "|",
  "_",
  "~",
  "[a](b)",
  "&amp;",
  "\u0000",
];
const randomPieces = (
  rng: Random,
  max: number,
  extra: readonly string[] = [],
) => {
  const pool = [...PIECES, ...extra];
  let out = "";
  for (let i = rng.int(max + 1); i > 0; i--) out += rng.pick(pool) as string;
  return out;
};
const lineText = (rng: Random) => randomPieces(rng, 6);
const multiText = (rng: Random) =>
  randomPieces(rng, 8, ["\n", "\n", "\r\n", "\n  ", "\n\n"]);

let idCounter = 0;
function randomTree(
  rng: Random,
  makeText: (rng: Random) => string,
  options: { notes?: boolean; maxNodes?: number; maxDepth?: number } = {},
) {
  const texts = new Map<string, string>();
  let budget = 1 + rng.int(options.maxNodes ?? 25);
  const build = (depth: number): MindMapNode => {
    budget--;
    const id = `n${idCounter++}`;
    texts.set(id, makeText(rng));
    const node: MindMapNode = { id, text: texts.get(id) as string };
    if (options.notes && rng.chance(0.4)) node.note = multiText(rng) || "note";
    if (rng.chance(0.6)) node.color = rng.pick(COLORS) as NodeColor;
    const children: MindMapNode[] = [];
    // Deep chains are as important as wide trees.
    const maxDepth = options.maxDepth ?? 8;
    while (
      budget > 0 &&
      depth < maxDepth &&
      rng.chance(depth === 0 ? 0.9 : 0.55)
    )
      children.push(build(depth + 1));
    if (children.length) node.next = children;
    return node;
  };
  const roots: MindMapNode[] = [];
  do roots.push(build(0));
  while (budget > 0 && rng.chance(0.7));
  return { roots, text: (id: string) => texts.get(id) as string };
}

interface Shape {
  text: string;
  children: Shape[];
}
const shapeOfNodes = (
  nodes: readonly MindMapNode[],
  text: (id: string) => string,
): Shape[] =>
  nodes.map((node) => ({
    text: text(node.id),
    children: shapeOfNodes(node.next ?? [], text),
  }));
const shapeOfEntries = (entries: readonly OutlineEntry[]): Shape[] =>
  entries.map((entry) => ({
    text: entry.text,
    children: shapeOfEntries(entry.children),
  }));
const oneLine = (text: string) =>
  text.replace(/\s*\n\s*/g, " ").trim() || "New idea";
const expectedCopy = (
  nodes: readonly MindMapNode[],
  text: (id: string) => string,
): Shape[] =>
  nodes.map((node) => ({
    text: oneLine(text(node.id)),
    children: expectedCopy(node.next ?? [], text),
  }));
const show = (value: unknown) => JSON.stringify(value);

// Reports the first seed that fails together with its input.
function forSeeds(name: string, body: (seed: number, rng: Random) => void) {
  const failures: string[] = [];
  for (const seed of seeds) {
    try {
      body(seed, random(seed));
      if (seed % 25 === 0) Bun.gc(true); // big mutated files and WASM documents otherwise pile up between collections
    } catch (error) {
      failures.push(
        `seed ${seed}: ${String(error).slice(0, 700)}${error instanceof Error ? `\n${error.stack?.split("\n").slice(0, 6).join("\n")}` : ""}`,
      );
      if (failures.length >= 3) break;
    }
  }
  count(`${name}: iterations`, seeds.length);
  if (failures.length)
    throw new Error(
      `${failures.length} failing seed(s)\n${failures.join("\n---\n")}`,
    );
}

function wellFormed(entries: readonly OutlineEntry[], limit = Infinity) {
  let total = 0;
  const pending = [...entries];
  for (let entry = pending.pop(); entry; entry = pending.pop()) {
    total++;
    if (typeof entry.text !== "string" || !entry.text)
      throw new Error("empty entry text");
    if (entry.text !== entry.text.trim())
      throw new Error(`untrimmed text ${show(entry.text)}`);
    if (/[\n\r]/.test(entry.text))
      throw new Error(`line break in ${show(entry.text)}`);
    if (!Array.isArray(entry.children))
      throw new Error("children is not an array");
    pending.push(...entry.children);
  }
  if (total > limit) throw new Error(`${total} entries from ${limit} lines`);
  return total;
}

// ---------------------------------------------------------------------------
// 1. Clipboard text

test("copy then paste reproduces the tree (single-line texts)", () => {
  forSeeds("outline round trip", (_, rng) => {
    const { roots, text } = randomTree(rng, lineText, { maxNodes: 30 });
    for (const root of roots) {
      const copied = branchOutline(root, text);
      const parsed = parseOutline(copied);
      expect(shapeOfEntries(parsed), `copied ${show(copied)}`).toEqual(
        expectedCopy([root], text),
      );
    }
  });
});

test("copy then paste: multi-line texts collapse to one line", () => {
  forSeeds("outline multi-line", (_, rng) => {
    const { roots, text } = randomTree(
      rng,
      (r) => randomPieces(r, 8, ["\n", "\n", "\r\n", "\n  ", "\n\n"]),
      { maxNodes: 20 },
    );
    const root = roots[0];
    const copied = branchOutline(root, text);
    expect(
      shapeOfEntries(parseOutline(copied)),
      `copied ${show(copied)}`,
    ).toEqual(expectedCopy([root], text));
  });
});

test("copy then paste survives deep chains", () => {
  forSeeds("outline deep", (_, rng) => {
    const { roots, text } = randomTree(rng, lineText, {
      maxNodes: 300,
      maxDepth: 150,
    });
    const copied = branchOutline(roots[0], text);
    expect(shapeOfEntries(parseOutline(copied))).toEqual(
      expectedCopy([roots[0]], text),
    );
  });
});

test("rich copy reproduces texts, notes and colors exactly", () => {
  forSeeds("rich round trip", (_, rng) => {
    const { roots, text } = randomTree(rng, multiText, {
      notes: true,
      maxNodes: 30,
    });
    for (const root of roots) {
      const entry = branchEntry(root, text);
      const parsed = parseBranchEntry(JSON.stringify(entry));
      expect(parsed).toEqual(entry);
      // Expected content straight from the tree, independent of branchEntry.
      const check = (node: MindMapNode, got: OutlineEntry) => {
        expect(got.text).toBe(text(node.id));
        expect(got.note).toBe(node.note || undefined);
        expect(got.color).toBe(node.color);
        expect(got.children.length).toBe((node.next ?? []).length);
        (node.next ?? []).forEach((child, i) => {
          check(child, got.children[i]);
        });
      };
      check(root, parsed as OutlineEntry);
    }
  });
});

test("parseBranchEntry rejects malformed data without throwing", () => {
  forSeeds("branch garbage", (_, rng) => {
    const { roots, text } = randomTree(rng, lineText, { notes: true });
    const json = JSON.stringify(branchEntry(roots[0], text));
    const mutated = mutateJson(rng, JSON.parse(json));
    for (const data of [
      stringify(mutated),
      json.slice(0, rng.int(json.length)),
      randomPieces(rng, 5),
    ]) {
      const parsed = parseBranchEntry(data);
      if (parsed) wellFormedBranch(parsed);
    }
  });
});
function wellFormedBranch(entry: OutlineEntry) {
  if (typeof entry.text !== "string" || !Array.isArray(entry.children))
    throw new Error("bad branch entry");
  if (
    entry.note !== undefined &&
    (typeof entry.note !== "string" || !entry.note)
  )
    throw new Error("bad note");
  if (entry.color !== undefined && !COLORS.includes(entry.color))
    throw new Error("bad color");
  entry.children.forEach(wellFormedBranch);
}

function garbage(rng: Random) {
  const indents = [
    "",
    "",
    " ",
    "  ",
    "    ",
    "\t",
    "\t\t",
    " \t",
    "      ",
    " ",
    "　",
  ];
  const bullets = [
    "",
    "",
    "- ",
    "* ",
    "+ ",
    "• ",
    "1. ",
    "12) ",
    "999. ",
    "1000. ",
    "[ ] ",
    "[x] ",
    "# ",
    "## ",
    "###### ",
    "####### ",
    "#",
    "-",
    "1.",
    "> ",
    "\\- ",
    "\\\\# ",
  ];
  const eols = ["\n", "\n", "\r\n", "\r", "\n\n", "\n \n", " "];
  let out = "";
  const lines = rng.int(40);
  for (let i = 0; i < lines; i++) {
    const body = rng.chance(0.02)
      ? "x".repeat(1 + rng.int(200_000))
      : rng.chance(0.1)
        ? ""
        : lineText(rng);
    out +=
      (rng.chance(0.04) ? "\t".repeat(rng.int(500)) : rng.pick(indents)) +
      rng.pick(bullets) +
      body +
      rng.pick(eols);
  }
  return out;
}

test("parseOutline never throws and always returns a well-formed tree", () => {
  forSeeds("outline garbage", (_, rng) => {
    const input = garbage(rng);
    const entries = parseOutline(input);
    const lines = input
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .filter((line) => line.trim()).length;
    wellFormed(entries, lines);
    // Pasting what was parsed, and copying it back out, is stable.
    const copy = (entry: OutlineEntry): MindMapNode => {
      const node: MindMapNode = { id: copy.counter++ + "", text: entry.text };
      if (entry.children.length) node.next = entry.children.map(copy);
      return node;
    };
    copy.counter = 0;
    const nodes = entries.map(copy);
    const texts = new Map<string, string>();
    const walk = (node: MindMapNode) => (
      texts.set(node.id, node.text), node.next?.forEach(walk)
    );
    nodes.forEach(walk);
    for (const node of nodes) {
      const again = parseOutline(
        branchOutline(node, (id) => texts.get(id) as string),
      );
      expect(shapeOfEntries(again), `from ${show(input)}`).toEqual(
        shapeOfEntries(entries.filter((_, i) => nodes[i] === node)),
      );
    }
  });
});

test("parseOutline handles very deep nesting and huge lines", () => {
  const depth = 20_000;
  const input = Array.from(
    { length: depth },
    (_, i) => `${" ".repeat(i)}- n${i}`,
  ).join("\n");
  let entries = parseOutline(input);
  let levels = 0;
  while (entries.length) levels++, (entries = entries[0].children);
  expect(levels).toBe(depth);
  expect(parseOutline(`- ${"x".repeat(5_000_000)}`)[0].text.length).toBe(
    5_000_000,
  );
  expect(parseOutline("\t".repeat(100_000) + "a")).toHaveLength(1);
  expect(parseOutline("   \n\t\n\r\n")).toEqual([]);
});

test("documented parseOutline behaviour", () => {
  expect(shapeOfEntries(parseOutline("2024. A good year"))).toEqual([
    { text: "2024. A good year", children: [] },
  ]);
  expect(shapeOfEntries(parseOutline("1234. x"))).toEqual([
    { text: "1234. x", children: [] },
  ]);
  expect(parseOutline("- \n1. \n* \n[ ]\n\n")).toEqual([]);
  expect(shapeOfEntries(parseOutline("# A\n- b\n  - c\n# D\n- e"))).toEqual([
    {
      text: "A",
      children: [{ text: "b", children: [{ text: "c", children: [] }] }],
    },
    { text: "D", children: [{ text: "e", children: [] }] },
  ]);
  expect(shapeOfEntries(parseOutline("a\r\n\tb\r\n\t\tc"))).toEqual([
    {
      text: "a",
      children: [{ text: "b", children: [{ text: "c", children: [] }] }],
    },
  ]);
});

// Known problems found by the properties above.
test("regression: a tab inside idea text becomes four spaces when pasted", () => {
  const node = { id: "a", text: "a\tb" };
  expect(parseOutline(branchOutline(node, () => node.text))[0].text).toBe(
    "a\tb",
  );
});
test("regression: a lone carriage return inside idea text splits the idea when pasted", () => {
  const node = { id: "a", text: "a\rb" };
  expect(parseOutline(branchOutline(node, () => node.text))).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// 2. Markdown export

const outlineNodes = (roots: MindMapNode[]) => roots;

// Inputs for the known export bugs (see the skipped repros below) are steered
// around so the rest of the format keeps being checked.
const BACKSLASH_MARKER = /^\s*\\+(?:[#>+*-]|\d+[.)])/;
const BARE_MARKER = /^\s*(?:[-*+•◦▪‣]|\d{1,3}[.)]|\[[ xX]\])\s*$/;
const BULLET_START = /^\s*(?:[•◦▪‣]|\[[ xX]\])(?:\s|$)/;
const HEADING_START = /^\s*#{2,6}(?:\s|$)/;
const safeFirst = (line: string) =>
  BACKSLASH_MARKER.test(line) ? `x${line}` : line;
const safeName = (name: string) =>
  BARE_MARKER.test(name) || BULLET_START.test(name)
    ? `x${name}`
    : safeFirst(name);
const safeContinuation = (line: string) =>
  BACKSLASH_MARKER.test(line) ||
  BARE_MARKER.test(line) ||
  BULLET_START.test(line) ||
  HEADING_START.test(line)
    ? `x${line}`
    : line;
const safeMulti = (text: string) =>
  text
    .split("\n")
    .map((line, i) => (i ? safeContinuation(line) : safeFirst(line)))
    .join("\n");

test("Markdown export parses back to the same tree under its title (single-line texts)", () => {
  forSeeds("markdown round trip", (_, rng) => {
    const { roots, text } = randomTree(rng, (r) => safeFirst(lineText(r)), {
      maxNodes: 30,
    });
    const name = rng.chance(0.3) ? "Map" : safeName(lineText(rng));
    const markdown = projectMarkdown(name, outlineNodes(roots), text);
    const parsed = shapeOfEntries(parseOutline(markdown));
    const expected = [
      {
        text: name.trim() || "Untitled map",
        children: expectedMarkdown(roots, text),
      },
    ];
    expect(parsed, `markdown ${show(markdown)}`).toEqual(expected);
  });
});
// Texts are trimmed, an empty text reads "New idea".
const expectedMarkdown = (
  nodes: readonly MindMapNode[],
  text: (id: string) => string,
): Shape[] =>
  nodes.map((node) => ({
    text: text(node.id).trim() || "New idea",
    children: expectedMarkdown(node.next ?? [], text),
  }));

test("Markdown export: notes become quote lines before the children, texts survive", () => {
  forSeeds("markdown notes", (_, rng) => {
    const { roots, text } = randomTree(rng, (r) => safeFirst(lineText(r)), {
      notes: true,
      maxNodes: 20,
    });
    // Note line breaks other than \n and \r\n would be read as new lines.
    const clean = (nodes: MindMapNode[]) =>
      nodes.forEach((node) => {
        if (node.note) node.note = node.note.replace(/\r(?!\n)/g, "");
        clean(node.next ?? []);
      });
    clean(roots);
    const markdown = projectMarkdown("Map", roots, text);
    const strip = (
      nodes: readonly MindMapNode[],
      entries: readonly OutlineEntry[],
    ): Shape[] =>
      nodes.map((node, i) => {
        const noteLines = node.note ? node.note.split(/\r?\n/).length : 0;
        const entry = entries[i];
        const quotes = entry.children.slice(0, noteLines);
        for (const quote of quotes)
          if (!quote.text.startsWith(">") || quote.children.length)
            throw new Error(`note line ${show(quote)}`);
        return {
          text: entry.text,
          children: strip(node.next ?? [], entry.children.slice(noteLines)),
        };
      });
    const title = parseOutline(markdown);
    expect(title).toHaveLength(1);
    expect(
      strip(roots, title[0].children),
      `markdown ${show(markdown)}`,
    ).toEqual(expectedMarkdown(roots, text));
  });
});

test("Markdown export: multi-line texts keep every line and the item order", () => {
  forSeeds("markdown multi-line", (_, rng) => {
    const { roots, text } = randomTree(rng, (r) => safeMulti(multiText(r)), {
      maxNodes: 15,
    });
    const markdown = projectMarkdown("Map", roots, text);
    // Continuation lines are read as children of the item; compare the flat
    // preorder of every line instead of the tree.
    const expected: string[] = [];
    const walk = (nodes: readonly MindMapNode[]) => {
      for (const node of nodes) {
        const lines = (text(node.id).trim() || "New idea")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        expected.push(...lines);
        walk(node.next ?? []);
      }
    };
    // Children come after continuation lines in the export.
    walk(roots);
    const flat: string[] = [];
    const flatten = (entries: readonly OutlineEntry[]) =>
      entries.forEach((entry) => {
        flat.push(entry.text);
        flatten(entry.children);
      });
    flatten(parseOutline(markdown)[0].children);
    expect(flat.sort(), `markdown ${show(markdown)}`).toEqual(expected.sort());
  });
});

test("regression: a continuation line that starts with a bullet or bare marker is stripped or dropped when pasted", () => {
  // Lines after the first are not escaped for "• ", "[x] " or a lone "*".
  const texts = ["a\n[x] b", "a\n• b", "a\n*"];
  for (const text of texts) {
    const flat: string[] = [];
    const walk = (entries: OutlineEntry[]) =>
      entries.forEach((entry) => {
        flat.push(entry.text);
        walk(entry.children);
      });
    walk(
      parseOutline(projectMarkdown("Map", [{ id: "a" }], () => text))[0]
        .children,
    );
    expect(flat).toEqual(text.split("\n"));
  }
});
test("regression: a project name containing a line break injects a second line into the outline", () => {
  const markdown = projectMarkdown("Plan\nsecond line", [], () => "");
  expect(parseOutline(markdown).map((entry) => entry.text)).toEqual([
    "Plan second line",
  ]);
});

test("regression: Markdown export of a text starting with a backslash and a marker pastes back with the backslash removed", () => {
  const node = { id: "a" };
  const markdown = projectMarkdown("Map", [node], () => "\\- x");
  expect(parseOutline(markdown)[0].children[0].text).toBe("\\- x");
});
test("regression: a project named with only a list marker loses its title heading", () => {
  const markdown = projectMarkdown("-", [{ id: "a" }], () => "x");
  expect(parseOutline(markdown).map((entry) => entry.text)).toEqual(["-"]);
});
test("regression: a project named with a leading bullet or checkbox loses it from the title heading", () => {
  const markdown = projectMarkdown("• Plan", [], () => "");
  expect(parseOutline(markdown)[0].text).toBe("• Plan");
});

// ---------------------------------------------------------------------------
// 3. Backup round trip

interface Plain {
  text: string;
  note: string;
  color: string;
  position: { x: number; y: number } | null;
  children: Plain[];
}
// The view without ids, as a nested tree in order.
function plain(view: DocumentView) {
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const tree = (id: string): Plain => {
    const node = byId.get(id)!;
    return {
      text: node.text,
      note: node.note,
      color: node.color,
      position: node.position
        ? { x: node.position.x + 0, y: node.position.y + 0 }
        : null,
      children: node.children.map(tree),
    };
  };
  return { name: view.name, saving: view.saving, roots: view.roots.map(tree) };
}
const pathOf = (view: DocumentView, id: string) => {
  const path: number[] = [];
  for (let current = view.nodes.find((node) => node.id === id); current; ) {
    const siblings = current.parent
      ? view.nodes.find((n) => n.id === current!.parent)!.children
      : view.roots;
    path.unshift(siblings.indexOf(current.id));
    current = current.parent
      ? view.nodes.find((n) => n.id === current!.parent)
      : undefined;
  }
  return path;
};

// The document rejects lone surrogates ("unexpected end of hex escape"), so
// generated texts are made well-formed.
const wellFormedText = (text: string) => text.toWellFormed();
function randomDocument(rng: Random, steps: number) {
  const doc = createProjectDocument(
    crypto.randomUUID(),
    "Fuzz",
    rng.chance(0.8) ? { text: wellFormedText(lineText(rng)) } : undefined,
  );
  for (let i = 0; i < steps; i++) tryEdit(rng, doc);
  // Features the edit mix reaches only rarely.
  const view = doc.view();
  const nodes = view.nodes;
  if (nodes.length) {
    const unicode = ["😀", "é", "שלום", "👩‍👩‍👧", "日本語", "\n"];
    for (let i = rng.int(4); i > 0; i--) {
      const parent = (rng.pick(nodes) as (typeof nodes)[number]).id;
      createChild(doc, parent, {
        text: unicode.join(" ").repeat(1 + rng.int(3)),
        note: rng.chance(0.5) ? wellFormedText(lineText(rng)) : undefined,
        color: rng.pick(COLORS) as NodeColor,
        position: rng.chance(0.5)
          ? { x: (rng.next() - 0.5) * 1e6, y: -0 }
          : undefined,
      });
    }
  }
  if (rng.chance(0.3))
    renameProject(doc, "Ünïcödé 😀 name".repeat(1 + rng.int(4)));
  setSavingPreferences(doc, { local: rng.chance(0.5), cloud: rng.chance(0.5) });
  return doc;
}

function randomPreferences(
  rng: Random,
  view: DocumentView,
): ProjectFile["preferences"] {
  const zooms = [0.1, 2.5, 1, 0.1000000001, 2.4999999999, 0.37, 1.25];
  const zoom = rng.chance(0.4)
    ? (rng.pick(zooms) as number)
    : 0.1 + rng.next() * 2.4;
  const anchor =
    view.nodes.length && rng.chance(0.7)
      ? {
          id: (rng.pick(view.nodes) as (typeof view.nodes)[number]).id,
          centerY: (rng.next() - 0.5) * 1e5,
        }
      : undefined;
  return {
    ...(rng.chance(0.9) && {
      viewport: {
        left: (rng.next() - 0.5) * 1e6,
        top: (rng.next() - 0.5) * 1e6,
        zoom,
      },
    }),
    ...(anchor && { anchor }),
  };
}

function roundTrip(
  doc: ProjectDocument,
  preferences?: ProjectFile["preferences"],
) {
  const json = exportProjectDocument(doc, preferences);
  const file = parseProjectFile(json);
  const { content, preferences: imported } = prepareProjectImport(file);
  const copy = importProjectDocument(crypto.randomUUID(), content);
  return { json, file, content, imported, copy };
}

function checkRoundTrip(doc: ProjectDocument, rng: Random) {
  const view = doc.view();
  const preferences = randomPreferences(rng, view);
  const { json, content, imported, copy } = roundTrip(doc, preferences);
  try {
    checkView(copy.view());
    expect(plain(copy.view())).toEqual(plain(view));
    expect(plain(content)).toEqual(plain(view));
    // Preferences come back, with the anchor following its node.
    expect(imported?.viewport).toEqual(preferences?.viewport);
    if (preferences?.anchor) {
      expect(imported?.anchor?.centerY).toBe(preferences.anchor.centerY);
      expect(pathOf(content, imported!.anchor!.id)).toEqual(
        pathOf(view, preferences.anchor.id),
      );
    }
    // Exporting the copy gives the same file apart from ids.
    // importProjectDocument assigns fresh ids; importedIds maps the file's ids to them.
    const remapped = imported && {
      ...imported,
      ...(imported.anchor && {
        anchor: {
          ...imported.anchor,
          id: copy.importedIds!.get(imported.anchor.id) as string,
        },
      }),
    };
    const again = JSON.parse(exportProjectDocument(copy, remapped));
    const first = JSON.parse(json);
    const strip = (nodes: { id?: string; children: unknown[] }[]): void =>
      nodes.forEach((node) => {
        delete node.id;
        strip(node.children as never);
      });
    strip(again.project.nodes);
    strip(first.project.nodes);
    if (first.preferences?.anchor) delete first.preferences.anchor.id;
    if (again.preferences?.anchor) delete again.preferences.anchor.id;
    expect(again).toEqual(first);
  } finally {
    copy.destroy();
  }
}

test("backups of random documents re-import to the same document", () => {
  forSeeds("backup round trip", (_, rng) => {
    const doc = randomDocument(rng, Math.min(STEPS, 60));
    try {
      checkView(doc.view());
      count("backup round trip: nodes", doc.view().nodes.length);
      checkRoundTrip(doc, rng);
    } finally {
      doc.destroy();
    }
  });
});

test("backups keep deep chains, many roots and the extremes of every limit", () => {
  forSeeds("backup extremes", (seed, rng) => {
    if (seed % 3 !== 1) return; // each seed builds hundreds of nodes
    const doc = createProjectDocument(crypto.randomUUID(), "x".repeat(200));
    try {
      // A chain exactly as deep as backups allow.
      let parent = createRoot(doc, {
        text: "top",
        color: "rose",
        position: { x: 1e300, y: -1e-300 },
      });
      for (let depth = 2; depth <= PROJECT_FILE_MAX_DEPTH; depth++)
        parent = createChild(doc, parent, {
          text: `level ${depth} ${wellFormedText(lineText(rng))}`,
          color: rng.pick(COLORS) as NodeColor,
        });
      const extreme = "😀".repeat(LIMITS.text / 2);
      setNodeNote(doc, parent, extreme);
      // Texts at the limit, ending in a surrogate pair that fits exactly.
      createChild(doc, createRoot(doc, { text: "é".repeat(LIMITS.text) }), {
        text: "a".repeat(LIMITS.text - 2) + "😀",
      });
      for (let i = rng.int(25); i > 0; i--)
        createRoot(doc, {
          text: wellFormedText(lineText(rng)),
          color: rng.pick(COLORS) as NodeColor,
        });
      checkRoundTrip(doc, rng);
      // The project name limit is in bytes.
      renameProject(doc, "é".repeat(100));
      checkRoundTrip(doc, rng);
      expect(seed).toBeGreaterThan(0);
    } finally {
      doc.destroy();
    }
  });
});

// Creating nodes through the WASM state costs a few milliseconds each and
// grows with the document, so the full 10,000-node check needs FUZZ_BIG=1.
const BIG = process.env.FUZZ_BIG ? LIMITS.nodes : 400;
test(`backups round trip ${BIG} nodes`, () => {
  const rng = random(7);
  const doc = createProjectDocument(crypto.randomUUID(), "Big");
  try {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: createRoot(doc, { text: `root ${i}` }),
      depth: 1,
    }));
    // Mostly recent parents, so branches get deep, but never past 100 levels.
    doc.batch(() => {
      while (entries.length < BIG) {
        const parent = rng.pick(
          rng.chance(0.8) ? entries.slice(-50) : entries,
        ) as (typeof entries)[number];
        if (parent.depth >= PROJECT_FILE_MAX_DEPTH) continue;
        entries.push({
          id: createChild(doc, parent.id, {
            text: `n${entries.length}`,
            color: rng.pick(COLORS) as NodeColor,
          }),
          depth: parent.depth + 1,
        });
      }
    });
    expect(doc.view().nodes).toHaveLength(BIG);
    const started = performance.now();
    checkRoundTrip(doc, rng);
    count(
      `${BIG} nodes round trip: ms`,
      Math.round(performance.now() - started),
    );
    if (BIG === LIMITS.nodes)
      expect(() => createRoot(doc, { text: "one too many" })).toThrow();
  } finally {
    doc.destroy();
  }
}, 900_000);

test("viewport zoom range survives and out-of-range zoom is rejected clearly", () => {
  const doc = createProjectDocument(crypto.randomUUID(), "Zoom", { text: "a" });
  try {
    const view = doc.view();
    for (const zoom of [
      0.1,
      0.1 + Number.EPSILON,
      1,
      2.5 - Number.EPSILON,
      2.5,
    ]) {
      const back = parseProjectFile(
        serializeProjectFile(view, {
          viewport: { left: -0, top: 5e-324, zoom },
        }),
      );
      expect(back.preferences?.viewport?.zoom).toBe(zoom);
    }
    for (const zoom of [0.0999999, 2.5000001, 0, -1, Number.NaN, Infinity])
      expect(() =>
        serializeProjectFile(view, { viewport: { left: 0, top: 0, zoom } }),
      ).toThrow(ProjectFileError);
  } finally {
    doc.destroy();
  }
});

test("backups the editor can create beyond the limits fail with a clear message", () => {
  const doc = createProjectDocument(crypto.randomUUID(), "Deep", { text: "0" });
  try {
    let parent = doc.view().roots[0];
    for (let depth = 2; depth <= PROJECT_FILE_MAX_DEPTH + 1; depth++)
      parent = createChild(doc, parent, { text: `${depth}` });
    count("editor allows depth 101: yes");
    let error: unknown;
    try {
      serializeProjectFile(doc.view());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProjectFileError);
    expect((error as Error).message).toMatch(/100 levels/);
  } finally {
    doc.destroy();
  }
});

// ---------------------------------------------------------------------------
// 4. Malformed backups

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const JUNK: Json[] = [
  null,
  true,
  false,
  0,
  -1,
  1.5,
  1e308,
  "",
  "x",
  "😀",
  "\ud83d",
  [],
  {},
  [[]],
  { id: "x" },
  [null],
  "blue",
  "BLUE",
  "#ff0000",
  "x".repeat(70_000),
  "é".repeat(200),
  4,
  3,
  2,
  "mindgrab-project",
];
function junk(rng: Random): Json {
  return rng.pick(JUNK) as Json;
}

// Applies a handful of random edits to a JSON value, anywhere inside it.
function mutateJson(rng: Random, root: Json): Json {
  const clone = structuredClone(root) as Json;
  const containers: (Json[] | { [key: string]: Json })[] = [];
  // Iterative and depth-capped: the harness must not overflow on the deep values it builds.
  const collect = (start: Json) => {
    const pending: [Json, number][] = [[start, 0]];
    for (let item = pending.pop(); item; item = pending.pop()) {
      const [value, depth] = item;
      if (!value || typeof value !== "object") continue;
      containers.push(value);
      if (depth < 300)
        for (const child of Object.values(value))
          pending.push([child, depth + 1]);
    }
  };
  let current: Json = clone;
  // Duplicating subtrees repeatedly would otherwise grow a file exponentially.
  const small = (value: Json) => stringify(value).length < 400_000;
  for (let edits = 1 + rng.int(3); edits > 0; edits--) {
    containers.length = 0;
    collect(current);
    const target = rng.pick(containers);
    if (!target || rng.chance(0.05)) {
      current = junk(rng);
      continue;
    }
    const keys = Object.keys(target);
    const key = (rng.pick(keys) as string | undefined) ?? "x";
    const record = target as Record<string, Json>;
    switch (rng.int(14)) {
      case 0: // delete a key / element
        if (Array.isArray(target)) target.splice(Number(key), 1);
        else delete record[key];
        break;
      case 1: // wrong type
      case 2:
        record[key] = junk(rng);
        break;
      case 3: // rename a key
        if (!Array.isArray(target) && key in record) {
          record[
            rng.pick([
              "id",
              "text",
              "note",
              "color",
              "children",
              "position",
              "x",
              "y",
              "name",
              "nodes",
              "extra",
              "zoom",
              "format",
              "version",
            ]) as string
          ] = record[key];
          delete record[key];
        }
        break;
      case 4: // extra key
        // Own property, as JSON.parse creates it (plain assignment to __proto__ would change the prototype).
        if (!Array.isArray(target))
          Object.defineProperty(
            record,
            rng.pick([
              "extra",
              "__proto__",
              "constructor",
              "toString",
              "$schema",
              "",
            ]) as string,
            {
              value: junk(rng),
              enumerable: true,
              writable: true,
              configurable: true,
            },
          );
        break;
      case 5: // duplicate an element (duplicate ids, shared subtrees)
        if (Array.isArray(target) && target.length && small(current))
          target.splice(
            rng.int(target.length + 1),
            0,
            structuredClone(target[rng.int(target.length)]),
          );
        break;
      case 6: // bad numbers
        record[key] = rng.pick([
          -1,
          0,
          0.05,
          3,
          Infinity,
          -Infinity,
          1e308,
          -0,
          5e-324,
          2.5000001,
          0.0999999,
        ]) as number;
        break;
      case 7: // bad color
        record.color = rng.pick([
          "",
          "red",
          "BLUE",
          "#fff",
          " blue",
          "blue ",
          "blue\n",
          1,
          null,
          [],
          {},
        ]) as Json;
        break;
      case 8: // bad position
        record.position = rng.pick([
          { x: 1 },
          { x: "1", y: 2 },
          { x: null, y: 0 },
          { x: 1, y: 2, z: 3 },
          [],
          [1, 2],
          5,
          { x: 1e308, y: -1e308 },
          { x: Infinity, y: 0 },
        ]) as Json;
        break;
      case 9: // huge strings
        record[key] = "x".repeat(
          rng.pick([65_535, 65_536, 65_537, 200_000]) as number,
        );
        break;
      case 10: // surrogate edges at the text limit
        record.text =
          "a".repeat(LIMITS.text - 1) +
          rng.pick(["😀", "\ud83d", "\ude00", "é"]);
        break;
      case 11: // wrong header
        if (!Array.isArray(target)) {
          record.format = rng.pick([
            "mindgrab-project",
            "other",
            1,
            null,
          ]) as Json;
          record.version = rng.pick([
            1,
            2,
            3,
            4,
            5,
            "4",
            null,
            4.5,
            -4,
          ]) as Json;
        }
        break;
      case 12: // nesting
        record[key] = deepChain(
          rng.pick([99, 100, 101, 102, 500, 1200]) as number,
        );
        break;
      default: // a node's children becomes its own ancestor's copy
        if (
          !Array.isArray(target) &&
          Array.isArray(record.children) &&
          small(current)
        )
          record.children.push(structuredClone(clone) as Json);
    }
  }
  return current;
}
// Very deep values can overflow the stack inside JSON.stringify itself; the
// test input is then replaced by a harmless one rather than the code under test blamed.
function stringify(value: Json): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}
function deepChain(depth: number): Json {
  let node: Json = [];
  for (let i = 0; i < depth; i++)
    node = [{ id: `d${i}`, text: "", color: "blue", children: node }];
  return node;
}

// The WASM state throws plain strings (JsValue::from_str); that is tolerated
// from the document layer but not from the parser or validator.
function acceptable(error: unknown, allowWasmString = false) {
  if (allowWasmString && typeof error === "string" && /[a-z]{3}/i.test(error))
    return count("wasm string errors"), undefined;
  if (!(error instanceof Error)) return `threw a non-Error: ${String(error)}`;
  if (error.constructor !== Error && !(error instanceof ProjectFileError))
    return `threw ${error.name}: ${error.message}`;
  if (!error.message.trim()) return "threw an error without a message";
  if (!/[a-z]{3}/i.test(error.message))
    return `unreadable message ${show(error.message)}`;
  return undefined;
}

// Runs the whole import pipeline on one candidate. Returns a problem or undefined.
function runPipeline(input: string | Json | ProjectFile): string | undefined {
  const started = performance.now();
  let doc: ProjectDocument | undefined;
  let stage = "parse";
  try {
    const file =
      typeof input === "string"
        ? parseProjectFile(input)
        : prepareFromObject(input);
    const { content } = prepareProjectImport(file);
    stage = "import";
    doc = importProjectDocument(crypto.randomUUID(), content);
    const view = doc.view();
    checkView(view);
    count("malformed: accepted");
    if (view.nodes.length !== content.nodes.length)
      return "node count changed on import";
    if (plain(view).roots.length !== content.roots.length)
      return "root count changed";
  } catch (error) {
    const problem = acceptable(error, stage === "import");
    if (problem)
      return `${problem}\n${error instanceof Error ? error.stack?.split("\n").slice(0, 4).join("\n") : ""}`;
    count(`malformed: rejected (${(error as Error).name})`);
  } finally {
    doc?.destroy();
  }
  const elapsed = performance.now() - started;
  return elapsed > 3000 ? `took ${Math.round(elapsed)} ms` : undefined;
}
const prepareFromObject = (value: Json | ProjectFile) => {
  // prepareProjectImport accepts objects directly; checkedFile must refuse bad ones.
  prepareProjectImport(value as ProjectFile);
  return value as ProjectFile;
};

test("malformed backups are rejected clearly or imported as valid documents", () => {
  forSeeds("malformed", (_, rng) => {
    const doc = randomDocument(rng, Math.min(STEPS, 40));
    let valid: string;
    try {
      valid = exportProjectDocument(doc, randomPreferences(rng, doc.view()));
    } finally {
      doc.destroy();
    }
    expect(runPipeline(valid)).toBeUndefined();
    for (let round = 0; round < 6; round++) {
      const mutated = mutateJson(rng, JSON.parse(valid));
      const candidates: (string | Json)[] = [stringify(mutated), mutated];
      if (round === 0) candidates.push(valid.slice(0, rng.int(valid.length)));
      if (round === 1)
        candidates.push(
          valid.replace(/"/g, rng.pick(["'", "", '\\"']) as string),
          valid + rng.pick(["x", "{}", "\u0000", "]"]),
          `﻿${valid}`,
        );
      for (const candidate of candidates) {
        const problem = runPipeline(candidate);
        if (problem)
          throw new Error(
            `${problem}\ninput: ${typeof candidate === "string" ? candidate.slice(0, 600) : show(candidate).slice(0, 600)}`,
          );
      }
    }
  });
});

test("backups with other versions, headers and top-level shapes", () => {
  const doc = createProjectDocument(crypto.randomUUID(), "Header", {
    text: "a",
  });
  try {
    const valid = JSON.parse(exportProjectDocument(doc));
    expect(
      runPipeline(JSON.stringify({ ...valid, version: 3 })),
    ).toBeUndefined();
    expect(stats["malformed: accepted"]).toBeGreaterThan(0);
    for (const bad of [
      "",
      " ",
      "{",
      "[]",
      "null",
      "0",
      '"x"',
      "true",
      "{}",
      '{"format":"mindgrab-project"}',
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, version: 5 }),
      JSON.stringify({ ...valid, format: "x" }),
      "# Title\n- a\n",
      "- a",
      "1. a",
    ]) {
      let error: unknown;
      try {
        parseProjectFile(bad);
      } catch (caught) {
        error = caught;
      }
      expect(error, `input ${show(bad)}`).toBeInstanceOf(ProjectFileError);
      expect(acceptable(error)).toBeUndefined();
    }
    // Large and deep files are refused without recursion errors.
    expect(() => parseProjectFile("[".repeat(1_000_000))).toThrow(
      ProjectFileError,
    );
    expect(() => parseProjectFile(" ".repeat(11 * 1024 * 1024))).toThrow(
      ProjectFileError,
    );
    // Built as text: JSON.stringify itself overflows the stack on such a chain.
    for (const levels of [101, 5000, 200_000]) {
      const opening = (i: number) =>
        `{"id":"d${i}","text":"","color":"blue","children":[`;
      let nodes = "";
      for (let i = 0; i < levels; i++) nodes += opening(i);
      nodes += "]}".repeat(levels);
      expect(
        runPipeline(
          `{"format":"mindgrab-project","version":4,"project":{"name":"Deep","nodes":[${nodes}]}}`,
        ),
      ).toBeUndefined();
    }
    const bigDepth = {
      ...valid,
      project: { name: "Deep", nodes: deepChain(100) },
    };
    expect(runPipeline(JSON.stringify(bigDepth))).toBeUndefined();
    // Cycles exist only in memory: a branch that contains itself.
    const cyclic: any = { id: "loop", text: "", color: "blue", children: [] };
    cyclic.children.push(cyclic, cyclic);
    expect(
      runPipeline({
        ...valid,
        project: { name: "Loop", nodes: [cyclic] },
      } as never),
    ).toBeUndefined();
    const flat = Array.from({ length: LIMITS.nodes + 1 }, (_, i) => ({
      id: `${i}`,
      text: "",
      color: "blue",
      children: [],
    }));
    expect(
      runPipeline(
        JSON.stringify({ ...valid, project: { name: "Many", nodes: flat } }),
      ),
    ).toBeUndefined();
    expect(
      runPipeline(
        JSON.stringify({
          ...valid,
          project: { name: "Many", nodes: flat.slice(1) },
        }),
      ),
    ).toBeUndefined();
  } finally {
    doc.destroy();
  }
});

test("importProjectDocument rejects inconsistent views with an Error and leaves nothing behind", () => {
  forSeeds("malformed views", (_, rng) => {
    const doc = randomDocument(rng, Math.min(STEPS, 30));
    const view = doc.view();
    doc.destroy();
    const edit = structuredClone(view) as DocumentView &
      Record<string, unknown>;
    const nodes = edit.nodes;
    const some = () => rng.pick(nodes);
    for (let n = 1 + rng.int(3); n > 0; n--) {
      const node = some();
      switch (rng.int(12)) {
        case 0:
          edit.roots.push(node ? node.id : "ghost");
          break; // a node reachable twice
        case 1:
          if (node) node.children.push(node.id);
          break; // self cycle
        case 2:
          if (node) node.children.push("ghost");
          break;
        case 3:
          edit.roots.splice(rng.int(edit.roots.length + 1), 1);
          break; // orphaned nodes
        case 4:
          if (node)
            node.color = rng.pick(["", "red", "BLUE", 5 as never]) as never;
          break;
        case 5:
          if (node)
            node.position = rng.pick([
              { x: Number.NaN, y: 0 },
              { x: Infinity, y: 0 },
              { x: "1", y: 2 },
              { x: 1 },
              5,
            ]) as never;
          break;
        case 6:
          if (node) node.text = "x".repeat(LIMITS.text + 1);
          break;
        case 7:
          if (node) node.note = "x".repeat(LIMITS.note + 1);
          break;
        case 8:
          edit.name = rng.pick(["", "  ", "x".repeat(201), "é".repeat(101)]);
          break;
        case 9:
          edit.saving = rng.pick([
            { local: 1, cloud: 2 },
            null,
            {},
            { local: true },
          ]) as never;
          break;
        case 10:
          if (node)
            (node as unknown as Record<string, unknown>).text = rng.pick([
              null,
              5,
              undefined,
            ]);
          break;
        default:
          if (node) nodes.push({ ...node }); // duplicate id
      }
    }
    let copy: ProjectDocument | undefined;
    try {
      copy = importProjectDocument(crypto.randomUUID(), edit);
      checkView(copy.view());
      count("malformed views: accepted");
    } catch (error) {
      const problem = acceptable(error, true);
      if (problem)
        throw new Error(
          `${problem}\n${(error as Error).stack?.split("\n").slice(0, 4).join("\n")}`,
        );
      count("malformed views: rejected");
    } finally {
      copy?.destroy();
    }
  });
});

test("report", () => {
  console.log(
    `fuzz-portable seeds=${SEEDS} steps=${STEPS}\n${JSON.stringify(stats, null, 1)}`,
  );
});

test("regression: a backup with a lone surrogate in a text passes the parser, then import throws a raw string", () => {
  const json = JSON.stringify({
    format: "mindgrab-project",
    version: 4,
    project: {
      name: "x",
      nodes: [{ id: "a", text: "\ud83d", color: "blue", children: [] }],
    },
  });
  let thrown: unknown;
  try {
    importProjectDocument(
      crypto.randomUUID(),
      prepareProjectImport(parseProjectFile(json)).content,
    );
  } catch (error) {
    thrown = error;
  }
  // Either parseProjectFile rejects it, or the import fails with an Error.
  expect(thrown === undefined || thrown instanceof Error).toBe(true);
});

test("regression: a continuation line starting with ## is exported unescaped and is read as a heading", () => {
  // escapeMarkdown only escapes a single leading #, so "## b" becomes a heading
  // that swallows the lines below it (and is a heading in any Markdown renderer).
  const markdown = projectMarkdown("Map", [{ id: "a" }, { id: "b" }], (id) =>
    id === "a" ? "a\n## h" : "second",
  );
  expect(parseOutline(markdown)[0].children.map((entry) => entry.text)).toEqual(
    ["a", "second"],
  );
});
