import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as Y from "yjs";
import { layoutMindMap } from "../src/mind-map";
import type { DropTarget, MindMapNode } from "../src/mind-map";
import {
  canMoveNode,
  createChild,
  createProjectDocument,
  createRoot,
  createSibling,
  deleteSubtree,
  editNodeText,
  effectiveParents,
  LIMITS,
  materializeProject,
  moveNode,
  nodeText,
  ORIGIN,
  openProjectDocument,
  ProjectDocumentError,
  projectForest,
  projectMindMap,
  readProject,
  renameProject,
  reorderNode,
  replaceNodeText,
  setNodeColor,
  translateSubtree,
} from "../src/project-document";
import type { ProjectContent } from "../src/project-document";
import { retainUndoHistory } from "../src/undo-history";

const PROJECT = "10000000-0000-4000-8000-000000000000";
const ID = (n: number) =>
  `20000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(ID);

// a(b(c), d), e — the same shape as the immutable tree tests.
function tree() {
  const doc = createProjectDocument(PROJECT, "Ideas", { id: A, text: "A" });
  createChild(doc, A, { id: B, text: "B" });
  createChild(doc, B, { id: C, text: "C" });
  createChild(doc, A, { id: D, text: "D" });
  createRoot(doc, { id: E, text: "E" });
  return doc;
}
const content = (doc: Y.Doc) => materializeProject(doc);
const map = (doc: Y.Doc) => projectMindMap(content(doc));
const outline = (nodes: MindMapNode[]): string =>
  nodes
    .map((node) =>
      node.next ? `${node.text}(${outline(node.next)})` : node.text,
    )
    .join(" ");
const shape = (doc: Y.Doc) => outline(map(doc));
function capture(doc: Y.Doc, action: () => unknown) {
  const updates: Uint8Array[] = [];
  const observer = (update: Uint8Array) => updates.push(update);
  doc.on("update", observer);
  action();
  doc.off("update", observer);
  return updates;
}
const fork = (doc: Y.Doc) =>
  openProjectDocument(PROJECT, [Y.encodeStateAsUpdate(doc)], ORIGIN.remote);
const undoManager = (doc: Y.Doc) =>
  (() => {
    const manager = new Y.UndoManager(doc.getMap("project"), {
      trackedOrigins: new Set([ORIGIN.local]),
      captureTimeout: 0,
    });
    retainUndoHistory(manager);
    return manager;
  })();
function visibleIds(nodes: MindMapNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...visibleIds(node.next ?? [])]);
}
function liveIds(value: ProjectContent) {
  return Object.keys(value.nodes)
    .filter((id) => !value.nodes[id].deleted)
    .sort();
}
function seededRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: T[], random: () => number) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
// Delivers updates in several shuffled orders with duplicates and asserts every
// replica reaches the same content and projected tree.
function expectConvergence(base: Uint8Array, updates: Uint8Array[]) {
  const random = seededRandom(updates.length * 7919);
  const results = [0, 1, 2, 3].map((round) => {
    const doc = openProjectDocument(PROJECT, [base], ORIGIN.remote);
    const delivery = shuffle(
      round ? [...updates, ...updates.slice(0, round)] : updates,
      random,
    );
    for (const update of delivery) Y.applyUpdate(doc, update, ORIGIN.remote);
    const value = content(doc);
    doc.destroy();
    return value;
  });
  for (const value of results) {
    expect(value).toEqual(results[0]);
    expect(projectMindMap(value)).toEqual(projectMindMap(results[0]));
    expect(visibleIds(projectMindMap(value)).sort()).toEqual(liveIds(value));
  }
  return results[0];
}

describe("opening and validation", () => {
  test("creation installs the schema once; opening and projection never write", () => {
    const doc = tree();
    expect(readProject(doc)).toMatchObject({ status: "ready" });
    expect(content(doc).metadata.name).toBe("Ideas");
    expect(content(doc).nodes[B]).toEqual({
      text: "B",
      placement: { parent: A, rank: "a0" },
      color: "blue",
      deleted: false,
    });
    const bytes = Y.encodeStateAsUpdate(doc);
    const opened = openProjectDocument(PROJECT, [bytes]);
    expect(
      capture(opened, () => {
        readProject(opened);
        projectForest(content(opened));
        map(opened);
      }),
    ).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(opened)).toEqual(bytes);
    expect(opened.guid).toBe(PROJECT);
    expect(content(opened)).toEqual(content(doc));
    doc.destroy();
    opened.destroy();
  });

  test("an empty document is loading, never reseeded, and rejects commands", () => {
    const doc = openProjectDocument(PROJECT);
    expect(readProject(doc)).toEqual({ status: "loading" });
    const updates = capture(doc, () => {
      expect(() => createRoot(doc, { text: "New" })).toThrow(
        ProjectDocumentError,
      );
      expect(() => content(doc)).toThrow("not loaded");
    });
    expect(updates).toHaveLength(0);
    // Hydration completes later and the document becomes editable.
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(tree()), ORIGIN.persistence);
    expect(shape(doc)).toBe("A(B(C) D) E");
    doc.destroy();
  });

  test("a document awaiting causal dependencies is loading, not invalid", () => {
    const doc = tree();
    const remote = fork(doc);
    const [first] = capture(remote, () => setNodeColor(remote, A, "rose"));
    // The deletion's delete set applies immediately and removes E's previous
    // `deleted` value while the replacement waits for `first`.
    const [second] = capture(remote, () => deleteSubtree(remote, E));
    Y.applyUpdate(doc, second, ORIGIN.remote);
    expect(readProject(doc)).toEqual({ status: "loading" });
    expect(() => createRoot(doc)).toThrow(ProjectDocumentError);
    Y.applyUpdate(doc, first, ORIGIN.remote);
    expect(readProject(doc).status).toBe("ready");
    expect(shape(doc)).toBe("A(B(C) D)");
    doc.destroy();
    remote.destroy();
  });

  test("an unsupported schema version is reported and stays read-only", () => {
    const doc = tree();
    doc.getMap("project").set("schemaVersion", 2);
    expect(readProject(doc)).toEqual({
      status: "unsupported",
      schemaVersion: 2,
    });
    expect(
      capture(doc, () => {
        expect(() => deleteSubtree(doc, A)).toThrow("Unsupported");
      }),
    ).toHaveLength(0);
    doc.destroy();
  });

  test("invalid content and shared types fail safely without throwing on read", () => {
    const corruptions: [string, (doc: Y.Doc) => void][] = [
      ["unknown field", (doc) => doc.getMap("project").set("view", 1)],
      [
        "extra root",
        (doc) => {
          doc.getMap("other");
        },
      ],
      [
        "rank",
        (doc) =>
          nodes(doc)
            .get(A)
            ?.set("placement", { parent: null, rank: "not a rank" }),
      ],
      ["position", (doc) => nodes(doc).get(A)?.set("position", { x: 1 })],
      ["color", (doc) => nodes(doc).get(A)?.set("color", "pink")],
      ["text", (doc) => nodes(doc).get(A)?.set("text", "not shared")],
      ["rich text", (doc) => nodeText(doc, A)?.format(0, 1, { bold: true })],
      [
        "shared name",
        (doc) =>
          (doc.getMap("project").get("metadata") as Y.Map<unknown>).set(
            "name",
            new Y.Text("Ideas"),
          ),
      ],
      [
        "shared placement",
        (doc) => nodes(doc).get(A)?.set("placement", new Y.Map()),
      ],
      [
        "node id",
        (doc) => {
          const node = nodes(doc).get(A) as Y.Map<unknown>;
          nodes(doc).set("not-a-uuid", node.clone() as Y.Map<unknown>);
        },
      ],
    ];
    for (const [name, corrupt] of corruptions) {
      const doc = tree();
      corrupt(doc);
      const state = readProject(doc);
      expect(state.status, name).toBe("invalid");
      expect(() => setNodeColor(doc, A, "rose"), name).toThrow(
        ProjectDocumentError,
      );
      doc.destroy();
    }
  });

  test("creation validates identity, names, and the initial node", () => {
    expect(() => createProjectDocument("PROJECT", "Ideas")).toThrow("UUID");
    expect(() => createProjectDocument(PROJECT, "  ")).toThrow("name");
    expect(() => createProjectDocument(PROJECT, "😀".repeat(51))).toThrow(
      "name",
    );
    expect(() =>
      createProjectDocument(PROJECT, "Ideas", {
        text: "x".repeat(LIMITS.text + 1),
      }),
    ).toThrow();
    expect(() =>
      createProjectDocument(PROJECT, "Ideas", {
        position: { x: Number.NaN, y: 0 },
      }),
    ).toThrow();
    const empty = createProjectDocument(PROJECT, "Empty");
    expect(map(empty)).toEqual([]);
    empty.destroy();
  });
});

function nodes(doc: Y.Doc) {
  return doc.getMap("project").get("nodes") as Y.Map<Y.Map<unknown>>;
}

describe("projection", () => {
  test("produces the renderer shape with colors, positions, and leaf nodes", () => {
    const doc = tree();
    translateSubtree(doc, C, new Map([[C, { x: 10, y: 20 }]]), { x: 1, y: 2 });
    setNodeColor(doc, D, "teal");
    const [a, e] = map(doc);
    expect(a.next?.[0].next?.[0]).toEqual({
      id: C,
      text: "C",
      color: "blue",
      position: { x: 11, y: 22 },
    });
    expect(a.next?.[1]).toEqual({ id: D, text: "D", color: "teal" });
    expect(e).toEqual({ id: E, text: "E", color: "blue" });
    doc.destroy();
  });

  test("never mutates or aliases its input", () => {
    const doc = tree();
    translateSubtree(doc, A, new Map([[A, { x: 0, y: 0 }]]), { x: 5, y: 5 });
    const value = content(doc);
    const frozen = structuredClone(value);
    const freeze = (item: unknown) => {
      if (item && typeof item === "object") {
        Object.freeze(item);
        for (const child of Object.values(item)) freeze(child);
      }
    };
    freeze(value);
    const projected = projectMindMap(value);
    projectForest(value);
    effectiveParents(value);
    expect(value).toEqual(frozen);
    const position = projected[0].position;
    if (position) position.x = 999;
    projected[0].next?.pop();
    expect(value.nodes[A].position?.x).toBe(5);
    doc.destroy();
  });

  test("orphans, self-cycles, and cycles become roots; equal ranks sort by UUID", () => {
    const doc = createProjectDocument(PROJECT, "Ideas");
    doc.transact(() => {
      const set = (id: string, parent: string | null, rank: string) => {
        const node = new Y.Map<unknown>();
        node.set("text", new Y.Text(id.slice(-1)));
        node.set("placement", { parent, rank });
        node.set("color", "blue");
        node.set("deleted", false);
        nodes(doc).set(id, node);
      };
      set(ID(3), ID(1), "a0");
      set(ID(1), ID(3), "a0");
      set(ID(4), ID(99), "a0");
      set(ID(5), ID(5), "a0");
      set(ID(2), null, "a0");
    });
    expect(shape(doc)).toBe("1(3) 2 4 5");
    doc.destroy();
  });
});

describe("tree commands", () => {
  test("children append, siblings follow their anchor, roots append", () => {
    const doc = tree();
    expect(shape(doc)).toBe("A(B(C) D) E");
    createSibling(doc, B, { text: "X" });
    expect(shape(doc)).toBe("A(B(C) X D) E");
    createSibling(doc, A, { text: "Y", color: "rose" });
    expect(shape(doc)).toBe("A(B(C) X D) Y E");
    const id = createChild(doc, C, { text: "Z", position: { x: 3, y: 4 } });
    expect(shape(doc)).toBe("A(B(C(Z)) X D) Y E");
    expect(content(doc).nodes[id ?? ""]).toMatchObject({
      color: "blue",
      position: { x: 3, y: 4 },
    });
    expect(createChild(doc, ID(99), { text: "lost" })).toBeUndefined();
    expect(createSibling(doc, ID(99), { text: "lost" })).toBeUndefined();
    doc.destroy();
  });

  test("node IDs are generated once and never reused, including tombstones", () => {
    const doc = tree();
    const id = createRoot(doc, { text: "fresh" });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => createRoot(doc, { id: A })).toThrow("reused");
    deleteSubtree(doc, C);
    expect(() => createRoot(doc, { id: C })).toThrow("reused");
    expect(() => createRoot(doc, { id: "C" })).toThrow("UUID");
    doc.destroy();
  });

  test("deleting marks the whole observed subtree and keeps tombstones", () => {
    const doc = tree();
    expect(deleteSubtree(doc, B)).toBe(true);
    expect(shape(doc)).toBe("A(D) E");
    expect(content(doc).nodes[B].deleted).toBe(true);
    expect(content(doc).nodes[C]).toMatchObject({ text: "C", deleted: true });
    expect(deleteSubtree(doc, C)).toBe(false);
    expect(deleteSubtree(doc, ID(99))).toBe(false);
    deleteSubtree(doc, A);
    deleteSubtree(doc, E);
    expect(map(doc)).toEqual([]);
    doc.destroy();
  });

  test("reordering swaps adjacent siblings and keeps descendants", () => {
    const doc = tree();
    expect(reorderNode(doc, B, 1)).toBe(true);
    expect(shape(doc)).toBe("A(D B(C)) E");
    expect(reorderNode(doc, E, -1)).toBe(true);
    expect(shape(doc)).toBe("E A(D B(C))");
    expect(reorderNode(doc, E, -1)).toBe(false);
    expect(reorderNode(doc, B, 1)).toBe(false);
    expect(reorderNode(doc, C, -1)).toBe(false);
    doc.destroy();
  });

  test("reparenting carries descendants; edges insert before and after", () => {
    const doc = tree();
    expect(moveNode(doc, B, { id: E, placement: "child" })).toBe(true);
    expect(shape(doc)).toBe("A(D) E(B(C))");
    expect(moveNode(doc, B, { id: E, placement: "before" })).toBe(true);
    expect(shape(doc)).toBe("A(D) B(C) E");
    expect(moveNode(doc, E, { id: D, placement: "after" })).toBe(true);
    expect(shape(doc)).toBe("A(D E) B(C)");
    expect(moveNode(doc, D, { placement: "root" })).toBe(true);
    expect(shape(doc)).toBe("A(E) B(C) D");
    doc.destroy();
  });

  test("dropping on self, descendants, stale targets, or in place is a no-op", () => {
    const doc = tree();
    const before = Y.encodeStateVector(doc);
    const targets: DropTarget[] = [
      { placement: "root" },
      { id: A, placement: "child" },
      { id: A, placement: "before" },
      { id: A, placement: "after" },
      { id: E, placement: "before" },
      { id: E, placement: "after" },
    ];
    for (const placement of ["child", "before", "after"] as const)
      for (const id of [A, B, C, ID(99)])
        expect(moveNode(doc, A, { id, placement })).toBe(false);
    expect(moveNode(doc, ID(99), { placement: "root" })).toBe(false);
    expect(moveNode(doc, D, { id: B, placement: "after" })).toBe(false);
    expect(moveNode(doc, E, { placement: "root" })).toBe(false);
    expect(moveNode(doc, D, { id: A, placement: "child" })).toBe(false);
    expect(Y.encodeStateVector(doc)).toEqual(before);
    expect(targets.map((target) => canMoveNode(doc, B, target))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(canMoveNode(doc, A, { id: C, placement: "child" })).toBe(false);
    doc.destroy();
  });

  test("detaching then reparenting can invert an ancestor relationship", () => {
    const doc = tree();
    moveNode(doc, B, { placement: "root" });
    expect(shape(doc)).toBe("A(D) E B(C)");
    moveNode(doc, A, { id: B, placement: "child" });
    expect(shape(doc)).toBe("E B(C A(D))");
    doc.destroy();
  });

  test("colors one node or its branch", () => {
    const doc = tree();
    expect(setNodeColor(doc, B, "rose")).toBe(true);
    expect(content(doc).nodes[B].color).toBe("rose");
    expect(content(doc).nodes[C].color).toBe("blue");
    expect(setNodeColor(doc, A, "teal", true)).toBe(true);
    for (const id of [A, B, C, D])
      expect(content(doc).nodes[id].color).toBe("teal");
    expect(content(doc).nodes[E].color).toBe("blue");
    expect(setNodeColor(doc, A, "teal", true)).toBe(false);
    expect(() => setNodeColor(doc, A, "pink" as "rose")).toThrow("color");
    doc.destroy();
  });

  test("translation moves every descendant once and preserves connections", () => {
    const doc = tree();
    const positions = () =>
      new Map(layoutMindMap(map(doc)).nodes.map((node) => [node.id, node]));
    const edges = () =>
      layoutMindMap(map(doc)).connections.map(({ from, to }) => [
        from.id,
        to.id,
      ]);
    const originalEdges = edges();
    translateSubtree(doc, C, positions(), { x: -600, y: -200 });
    const before = positions();
    expect(translateSubtree(doc, A, before, { x: 45.5, y: -32.25 })).toBe(true);
    const after = positions();
    for (const id of [A, B, C, D]) {
      expect(after.get(id)?.x).toBe((before.get(id)?.x ?? 0) + 45.5);
      expect(after.get(id)?.y).toBe((before.get(id)?.y ?? 0) - 32.25);
    }
    expect(after.get(E)).toEqual(before.get(E));
    expect(content(doc).nodes[E].position).toBeUndefined();
    // Stored positions contain exactly the coordinates, not layout sizes.
    expect(Object.keys(content(doc).nodes[A].position ?? {})).toEqual([
      "x",
      "y",
    ]);
    expect(edges()).toEqual(originalEdges);
    expect(translateSubtree(doc, A, after, { x: 0, y: 0 })).toBe(false);
    expect(() =>
      translateSubtree(doc, A, after, { x: Number.POSITIVE_INFINITY, y: 0 }),
    ).toThrow("position");
    doc.destroy();
  });

  test("text edits use UTF-16 offsets and minimal replacements", () => {
    const doc = tree();
    expect(editNodeText(doc, A, 1, 0, " 😀 idea")).toBe(true);
    expect(content(doc).nodes[A].text).toBe("A 😀 idea");
    expect(() => editNodeText(doc, A, 3, 1, "")).toThrow("surrogate");
    expect(() => editNodeText(doc, A, 0, 99, "")).toThrow("range");
    expect(editNodeText(doc, A, 0, 1, "A")).toBe(false);
    expect(replaceNodeText(doc, A, "A 😁 idea!")).toBe(true);
    expect(content(doc).nodes[A].text).toBe("A 😁 idea!");
    expect(replaceNodeText(doc, A, "A 😁 idea!")).toBe(false);
    expect(() => replaceNodeText(doc, A, "x".repeat(LIMITS.text + 1))).toThrow(
      "too long",
    );
    deleteSubtree(doc, E);
    expect(replaceNodeText(doc, E, "hidden")).toBe(false);
    doc.destroy();
  });

  test("minimal replacements preserve concurrent edits elsewhere in the text", () => {
    const doc = createProjectDocument(PROJECT, "Ideas", {
      id: A,
      text: "hello world",
    });
    const remote = fork(doc);
    replaceNodeText(doc, A, "hello brave world");
    replaceNodeText(remote, A, "hello world!");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    expect(content(doc).nodes[A].text).toBe("hello brave world!");
    expect(content(remote)).toEqual(content(doc));
    doc.destroy();
    remote.destroy();
  });

  test("renaming changes only the display name", () => {
    const doc = tree();
    expect(renameProject(doc, "Plans")).toBe(true);
    expect(content(doc).metadata.name).toBe("Plans");
    expect(doc.guid).toBe(PROJECT);
    expect(renameProject(doc, "Plans")).toBe(false);
    expect(() => renameProject(doc, " ")).toThrow("name");
    doc.destroy();
  });

  test("400 insertions into one gap keep order and bounded ranks", () => {
    const doc = createProjectDocument(PROJECT, "Ideas", { id: ID(1) });
    createRoot(doc, { id: ID(2) });
    for (let i = 3; i < 403; i++) createSibling(doc, ID(1), { id: ID(i) });
    const value = content(doc);
    expect(
      projectMindMap(value)
        .slice(0, 3)
        .map((node) => node.id),
    ).toEqual([ID(1), ID(402), ID(401)]);
    expect(projectMindMap(value).at(-1)?.id).toBe(ID(2));
    expect(
      Object.values(value.nodes).every(
        (node) => node.placement.rank.length <= LIMITS.rank,
      ),
    ).toBe(true);
    doc.destroy();
  });
});

describe("atomicity and undo", () => {
  test("undo history keeps at most 100 user actions", () => {
    const doc = tree();
    const undo = undoManager(doc);
    for (let action = 0; action < 101; action++) {
      renameProject(doc, `Ideas ${action}`);
      undo.stopCapturing();
    }
    expect(undo.undoStack).toHaveLength(100);
    undo.destroy();
    doc.destroy();
  });

  const commands: [string, (doc: Y.Doc) => unknown][] = [
    ["create root", (doc) => createRoot(doc, { text: "R" })],
    ["create child", (doc) => createChild(doc, B, { text: "R" })],
    ["create sibling", (doc) => createSibling(doc, B, { text: "R" })],
    ["edit text", (doc) => editNodeText(doc, A, 0, 1, "Alpha")],
    ["replace text", (doc) => replaceNodeText(doc, C, "Changed")],
    ["rename", (doc) => renameProject(doc, "Plans")],
    ["reorder", (doc) => reorderNode(doc, B, 1)],
    ["reparent", (doc) => moveNode(doc, B, { id: E, placement: "child" })],
    ["delete", (doc) => deleteSubtree(doc, B)],
    ["color branch", (doc) => setNodeColor(doc, A, "violet", true)],
    [
      "translate",
      (doc) =>
        translateSubtree(
          doc,
          A,
          new Map(layoutMindMap(map(doc)).nodes.map((node) => [node.id, node])),
          { x: 10, y: 10 },
        ),
    ],
  ];

  test("every semantic command is one transaction and one undo step", () => {
    for (const [name, command] of commands) {
      const doc = tree();
      const undo = undoManager(doc);
      const before = content(doc);
      expect(
        capture(doc, () => command(doc)),
        name,
      ).toHaveLength(1);
      expect(undo.undoStack, name).toHaveLength(1);
      const after = content(doc);
      undo.undo();
      expect(content(doc), name).toEqual(before);
      undo.redo();
      expect(content(doc), name).toEqual(after);
      undo.destroy();
      doc.destroy();
    }
  });

  test("no-op commands produce no update and no undo step", () => {
    const doc = tree();
    const undo = undoManager(doc);
    const noops: (() => unknown)[] = [
      () => reorderNode(doc, E, 1),
      () => moveNode(doc, D, { id: B, placement: "after" }),
      () => moveNode(doc, A, { id: C, placement: "child" }),
      () => setNodeColor(doc, A, "blue"),
      () => renameProject(doc, "Ideas"),
      () => replaceNodeText(doc, A, "A"),
      () => editNodeText(doc, A, 0, 0, ""),
      () => deleteSubtree(doc, ID(99)),
      () => createChild(doc, ID(99)),
      () => translateSubtree(doc, A, new Map(), { x: 5, y: 5 }),
    ];
    for (const noop of noops) {
      expect(capture(doc, noop)).toHaveLength(0);
    }
    expect(undo.undoStack).toHaveLength(0);
    undo.destroy();
    doc.destroy();
  });

  test("undo tracks only local commands and keeps remote work", () => {
    const doc = tree();
    const remote = fork(doc);
    const undo = undoManager(doc);
    deleteSubtree(doc, B);
    const edits = capture(remote, () => replaceNodeText(remote, C, "C edited"));
    for (const update of edits) Y.applyUpdate(doc, update, ORIGIN.remote);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(shape(doc)).toBe("A(B(C edited) D) E");
    undo.destroy();
    doc.destroy();
    remote.destroy();
  });
});

describe("replica convergence", () => {
  test("concurrent moves that form a cycle converge to one valid forest", () => {
    const doc = tree();
    const base = Y.encodeStateAsUpdate(doc);
    const left = fork(doc);
    const right = fork(doc);
    const updates = [
      ...capture(left, () => moveNode(left, A, { id: E, placement: "child" })),
      ...capture(right, () =>
        moveNode(right, E, { id: C, placement: "child" }),
      ),
    ];
    const merged = expectConvergence(base, updates);
    // The cycle A→E→C→B→A detaches its smallest UUID, A.
    expect(outline(projectMindMap(merged))).toBe("A(B(C(E)) D)");
    for (const item of [doc, left, right]) item.destroy();
  });

  test("deletion wins over concurrent edits without resurrecting nodes", () => {
    const doc = tree();
    const base = Y.encodeStateAsUpdate(doc);
    const left = fork(doc);
    const right = fork(doc);
    const undo = undoManager(left);
    const deletion = capture(left, () => deleteSubtree(left, B));
    const edits = capture(right, () => {
      replaceNodeText(right, B, "B edited");
      setNodeColor(right, C, "amber");
      moveNode(right, B, { id: E, placement: "child" });
    });
    const merged = expectConvergence(base, [...deletion, ...edits]);
    expect(outline(projectMindMap(merged))).toBe("A(D) E");
    expect(merged.nodes[B]).toMatchObject({ text: "B edited", deleted: true });
    for (const update of edits) Y.applyUpdate(left, update, ORIGIN.remote);
    undo.undo();
    expect(shape(left)).toBe("A(D) E(B edited(C))");
    expect(content(left).nodes[C].color).toBe("amber");
    undo.destroy();
    for (const item of [doc, left, right]) item.destroy();
  });

  test("a child created under a concurrently deleted parent survives as a root", () => {
    const doc = tree();
    const base = Y.encodeStateAsUpdate(doc);
    const left = fork(doc);
    const right = fork(doc);
    const merged = expectConvergence(base, [
      ...capture(left, () => deleteSubtree(left, B)),
      ...capture(right, () => createChild(right, C, { id: ID(9), text: "X" })),
    ]);
    // X keeps its first-child rank, which sorts between A and E among roots.
    expect(outline(projectMindMap(merged))).toBe("A(D) X E");
    expect(effectiveParents(merged).get(ID(9))).toBeNull();
    for (const item of [doc, left, right]) item.destroy();
  });

  test("rank collisions sort by UUID and later insertions re-space atomically", () => {
    const doc = tree();
    const base = Y.encodeStateAsUpdate(doc);
    const left = fork(doc);
    const right = fork(doc);
    const updates = [
      ...capture(left, () => createRoot(left, { id: ID(8), text: "L" })),
      ...capture(right, () => createRoot(right, { id: ID(7), text: "R" })),
    ];
    const merged = expectConvergence(base, updates);
    expect(merged.nodes[ID(7)].placement).toEqual(
      merged.nodes[ID(8)].placement,
    );
    expect(outline(projectMindMap(merged))).toBe("A(B(C) D) E R L");
    for (const update of updates) Y.applyUpdate(left, update);
    const undo = undoManager(left);
    expect(
      capture(left, () => createSibling(left, ID(7), { text: "M" })),
    ).toHaveLength(1);
    expect(shape(left)).toBe("A(B(C) D) E R M L");
    expect(undo.undoStack).toHaveLength(1);
    const ranks = [E, ID(7), ID(8)].map(
      (id) => content(left).nodes[id].placement.rank,
    );
    expect(new Set(ranks).size).toBe(3);
    undo.destroy();
    for (const item of [doc, left, right]) item.destroy();
  });

  test("non-conflicting edits from every replica are preserved", () => {
    const doc = tree();
    const base = Y.encodeStateAsUpdate(doc);
    const [one, two, three] = [fork(doc), fork(doc), fork(doc)];
    const merged = expectConvergence(base, [
      ...capture(one, () => setNodeColor(one, A, "green")),
      ...capture(one, () => editNodeText(one, E, 1, 0, "!")),
      ...capture(two, () => renameProject(two, "Plans")),
      ...capture(two, () => reorderNode(two, B, 1)),
      ...capture(three, () => createChild(three, D, { text: "F" })),
    ]);
    expect(merged.metadata.name).toBe("Plans");
    expect(merged.nodes[A].color).toBe("green");
    expect(outline(projectMindMap(merged))).toBe("A(D(F) B(C)) E!");
    for (const item of [doc, one, two, three]) item.destroy();
  });

  test("randomized concurrent editing converges to a valid forest", () => {
    for (let seed = 1; seed <= 24; seed++) {
      const random = seededRandom(seed);
      const pick = <T>(items: T[]) =>
        items[Math.floor(random() * items.length)];
      const doc = tree();
      const base = Y.encodeStateAsUpdate(doc);
      const replicas = [fork(doc), fork(doc), fork(doc)];
      const updates: Uint8Array[] = [];
      let next = 100;
      for (let step = 0; step < 30; step++) {
        const replica = pick(replicas);
        const live = liveIds(content(replica));
        const target = live.length ? pick(live) : undefined;
        const other = live.length ? pick(live) : undefined;
        const commands: (() => unknown)[] = [
          () => createRoot(replica, { id: ID(next++), text: `n${step}` }),
          () => target && createChild(replica, target, { id: ID(next++) }),
          () => target && createSibling(replica, target, { id: ID(next++) }),
          () => target && deleteSubtree(replica, target),
          () => target && reorderNode(replica, target, pick([-1, 1])),
          () =>
            target &&
            other &&
            moveNode(replica, target, {
              id: other,
              placement: pick(["child", "before", "after"] as const),
            }),
          () => target && editNodeText(replica, target, 0, 0, `${step}`),
          () => target && setNodeColor(replica, target, pick(["rose", "teal"])),
        ];
        updates.push(...capture(replica, pick(commands)));
        // Occasionally sync one replica from another so later edits observe
        // earlier ones, as the state-vector sync protocol would.
        if (random() < 0.3) {
          const [from, to] = shuffle(replicas, random);
          Y.applyUpdate(
            to,
            Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)),
            ORIGIN.remote,
          );
        }
      }
      expectConvergence(base, updates);
      for (const item of [doc, ...replicas]) item.destroy();
    }
  });
});

describe("contract golden fixtures", () => {
  const directory = new URL(
    "../../tools/yjs-contract/fixtures/",
    import.meta.url,
  );
  const fixtures = readdirSync(directory).filter((name) =>
    name.endsWith(".json"),
  );

  test("fixtures are present", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
  });

  for (const name of fixtures) {
    test(`${name} materializes and projects like the reference`, () => {
      const fixture = JSON.parse(
        readFileSync(new URL(name, directory), "utf8"),
      );
      const doc = openProjectDocument(
        PROJECT,
        fixture.updates.map(
          (file: string) =>
            new Uint8Array(readFileSync(new URL(file, directory))),
        ),
        ORIGIN.remote,
      );
      expect(content(doc)).toEqual(fixture.expected);
      expect(projectForest(content(doc))).toEqual(fixture.forest);
      doc.destroy();
    });
  }
});
