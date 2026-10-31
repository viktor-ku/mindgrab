// Shared pieces for the document fuzzers: a seeded random source, random
// edits through the same document API the editor uses, and checks that any
// document view must satisfy.
import { NODE_COLORS } from "../src/node-colors";
import {
  clearPositions,
  createChild,
  createNodeAt,
  createRoot,
  createSibling,
  deleteSubtree,
  editNodeNote,
  editNodeText,
  LIMITS,
  moveNode,
  renameProject,
  reorderNode,
  replaceNodeText,
  setNodeColor,
  setNodeNote,
  translateSubtree,
} from "../src/project-document";
import type { DocumentView, ProjectDocument } from "../src/project-document";

// Seeds and lengths can be raised for long runs:
// FUZZ_SEEDS=500 FUZZ_STEPS=1000 bun test --conditions browser tests/fuzz-*
export const SEEDS = Number(process.env.FUZZ_SEEDS ?? 25);
export const STEPS = Number(process.env.FUZZ_STEPS ?? 250);
export const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);

export type Random = ReturnType<typeof random>;

// Mulberry32: small, fast and reproducible from a 32-bit seed.
export function random(seed: number) {
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
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T | undefined =>
      items.length ? items[int(items.length)] : undefined,
  };
}

// Text that exercises Unicode handling: emoji (surrogate pairs), combining
// marks, right-to-left text, newlines and characters that look like markup.
const FRAGMENTS = [
  "idea",
  "Plan",
  " ",
  "\n",
  "😀",
  "👩‍👩‍👧",
  "é",
  "é",
  "שלום",
  "日本語",
  "- ",
  "# ",
  "\\",
  "1. ",
  "​",
  "<b>",
  '"quoted"',
];
export function randomText(rng: Random, max = 4) {
  let text = "";
  for (let i = rng.int(max + 1); i > 0; i--)
    text += rng.pick(FRAGMENTS) as string;
  return text;
}

const ids = (view: DocumentView) => view.nodes.map((node) => node.id);

// One random edit. Failures the API reports for impossible requests (moving a
// branch under itself, editing a node another replica deleted) must leave the
// document untouched, which the caller verifies.
export function randomEdit(rng: Random, doc: ProjectDocument): string {
  const view = doc.view();
  const id = rng.pick(ids(view));
  const color = (rng.pick(NODE_COLORS) as (typeof NODE_COLORS)[number]).value;
  const text = () => randomText(rng);
  const roll = rng.int(19);
  if (!id || roll === 0) {
    createRoot(doc, { text: text(), color });
    return "createRoot";
  }
  const node = view.nodes.find((candidate) => candidate.id === id);
  const length = node?.text.length ?? 0;
  switch (roll) {
    case 1:
    case 2:
      createChild(doc, id, { text: text(), color });
      return "createChild";
    case 3:
      createSibling(doc, id, { text: text() });
      return "createSibling";
    case 4: {
      const parent = rng.chance(0.2) ? null : (rng.pick(ids(view)) ?? null);
      const siblings = parent
        ? (view.nodes.find((candidate) => candidate.id === parent)?.children
            .length ?? 0)
        : view.roots.length;
      createNodeAt(doc, parent, rng.int(siblings + 1), { text: text() });
      return "createNodeAt";
    }
    case 5:
      deleteSubtree(doc, id);
      return "delete";
    case 6:
    case 7: {
      const parent = rng.chance(0.15) ? null : (rng.pick(ids(view)) ?? null);
      const siblings = parent
        ? (view.nodes.find((candidate) => candidate.id === parent)?.children
            .length ?? 0)
        : view.roots.length;
      moveNode(doc, id, parent, rng.int(siblings + 1));
      return "move";
    }
    case 8:
      reorderNode(doc, id, rng.chance(0.5) ? -1 : 1);
      return "reorder";
    case 9:
      setNodeColor(doc, id, color, rng.chance(0.4));
      return "color";
    case 10:
    case 11: {
      // Indices are UTF-16 offsets, like a textarea's selection.
      const index = rng.int(length + 1);
      editNodeText(
        doc,
        id,
        index,
        rng.int(length - index + 1),
        randomText(rng, 2),
      );
      return "editText";
    }
    case 12:
      replaceNodeText(doc, id, text());
      return "setText";
    case 13:
      setNodeNote(doc, id, rng.chance(0.2) ? "" : randomText(rng, 6));
      return "setNote";
    case 14: {
      const note = node?.note ?? "";
      const index = rng.int(note.length + 1);
      editNodeNote(
        doc,
        id,
        index,
        rng.int(note.length - index + 1),
        randomText(rng, 2),
      );
      return "editNote";
    }
    case 15: {
      const positions = new Map(
        view.nodes
          .filter(() => rng.chance(0.5))
          .map((candidate) => [
            candidate.id,
            { x: rng.int(2000) - 1000, y: rng.int(2000) - 1000 },
          ]),
      );
      translateSubtree(doc, id, positions, {
        x: rng.int(400) - 200,
        y: rng.int(400) - 200,
      });
      return "translate";
    }
    case 16:
      clearPositions(
        doc,
        view.nodes
          .filter((candidate) => candidate.position && rng.chance(0.5))
          .map((candidate) => candidate.id),
      );
      return "clearPositions";
    case 17:
      renameProject(doc, randomText(rng, 3).trim() || "Map");
      return "rename";
    default: {
      // Several edits applied as one change, as a paste does.
      const count = 1 + rng.int(4);
      doc.batch(() => {
        let under = id;
        for (let i = 0; i < count; i++)
          under = createChild(doc, under, { text: text() });
      });
      return "batch";
    }
  }
}

// Applies an edit; an error is acceptable only if the document is unchanged.
export function tryEdit(rng: Random, doc: ProjectDocument) {
  const before = canonical(doc);
  try {
    return randomEdit(rng, doc);
  } catch (error) {
    const after = canonical(doc);
    if (after !== before)
      throw new Error(
        `A rejected edit changed the document: ${String(error)}\nbefore ${before}\nafter  ${after}`,
      );
    return `rejected: ${String(error).slice(0, 60)}`;
  }
}

// Views compare as JSON; the project id and saving preferences are excluded
// because replicas share them by construction.
export function canonical(doc: ProjectDocument) {
  const { name, roots, nodes } = doc.view();
  return JSON.stringify({ name, roots, nodes });
}

// Structural rules every view must satisfy, whatever edits and merges led
// to it: one parent per node, children lists agree with parents, every node
// reachable exactly once from a root, depths consistent, values within limits.
export function checkView(view: DocumentView) {
  const fail = (message: string) => {
    throw new Error(`Invalid view: ${message}`);
  };
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  if (byId.size !== view.nodes.length) fail("duplicate node ids");
  const seen = new Set<string>();
  const visit = (id: string, parent: string | null, depth: number) => {
    const node = byId.get(id);
    if (!node) return fail(`missing node ${id}`);
    if (seen.has(id)) return fail(`node ${id} reachable twice (cycle?)`);
    seen.add(id);
    if (node.parent !== parent) fail(`node ${id} parent mismatch`);
    if (node.depth !== depth)
      fail(`node ${id} depth ${node.depth}, expected ${depth}`);
    if (node.text.length > LIMITS.text) fail(`node ${id} text over limit`);
    if (node.note.length > LIMITS.note) fail(`node ${id} note over limit`);
    if (!NODE_COLORS.some((color) => color.value === node.color))
      fail(`node ${id} has color ${node.color}`);
    if (
      node.position &&
      !(Number.isFinite(node.position.x) && Number.isFinite(node.position.y))
    )
      fail(`node ${id} has a non-finite position`);
    for (const child of node.children) visit(child, id, depth + 1);
  };
  for (const root of view.roots) visit(root, null, 0);
  if (seen.size !== view.nodes.length)
    fail(`${view.nodes.length - seen.size} nodes unreachable from roots`);
}
