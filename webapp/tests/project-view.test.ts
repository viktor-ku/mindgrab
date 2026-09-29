import { describe, expect, test } from "bun:test";
import { createComputed, createRoot } from "solid-js";
import * as Y from "yjs";
import {
  createChild,
  createProjectDocument,
  deleteSubtree,
  editNodeText,
  openProjectDocument,
  ORIGIN,
  renameProject,
  setNodeColor,
} from "../src/project-document";
import { createProjectView } from "../src/project-view";
import type { ProjectView } from "../src/project-view";

// Solid's reactive build is selected with `bun test --conditions browser`.
const PROJECT = "10000000-0000-4000-8000-000000000000";
const ID = (n: number) =>
  `20000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const [A, B, C] = [1, 2, 3].map(ID);

// Two in-process replicas that exchange every update, as a sync provider would.
function replicas() {
  const local = createProjectDocument(PROJECT, "Ideas", { id: A, text: "A" });
  createChild(local, A, { id: B, text: "B" });
  const remote = openProjectDocument(
    PROJECT,
    [Y.encodeStateAsUpdate(local)],
    ORIGIN.remote,
  );
  local.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== ORIGIN.remote) Y.applyUpdate(remote, update, ORIGIN.remote);
  });
  remote.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== ORIGIN.remote) Y.applyUpdate(local, update, ORIGIN.remote);
  });
  return { local, remote };
}

function mount(doc: Y.Doc) {
  return createRoot((dispose) => {
    const view = createProjectView(doc);
    const counts = { forest: 0, a: 0, b: 0 };
    createComputed(() => {
      view.forest();
      counts.forest++;
    });
    createComputed(() => {
      view.text(A);
      counts.a++;
    });
    createComputed(() => {
      view.text(B);
      counts.b++;
    });
    return { view, counts, dispose };
  });
}

const ids = (view: ProjectView) =>
  view.forest().flatMap(function walk(node): string[] {
    return [node.id, ...(node.next ?? []).flatMap(walk)];
  });
const deepHandlers = (doc: Y.Doc) =>
  (doc.getMap("project") as unknown as { _dEH: { l: unknown[] } })._dEH.l
    .length;

describe("project view", () => {
  test("remote updates render immediately without saving or reloading", () => {
    const { local, remote } = replicas();
    const { view, dispose } = mount(local);
    expect(ids(view)).toEqual([A, B]);

    editNodeText(remote, A, 1, 0, "lpha");
    expect(view.text(A)).toBe("Alpha");
    createChild(remote, B, { id: C, text: "C" });
    expect(ids(view)).toEqual([A, B, C]);
    expect(view.text(C)).toBe("C");
    renameProject(remote, "Plans");
    expect(view.name()).toBe("Plans");
    deleteSubtree(remote, B);
    expect(ids(view)).toEqual([A]);
    dispose();
  });

  test("text edits update only the edited node, without re-projecting", () => {
    const { local, remote } = replicas();
    const { view, counts, dispose } = mount(local);
    const forest = view.forest();
    const before = { ...counts };

    editNodeText(remote, B, 1, 0, "!");
    editNodeText(local, B, 2, 0, "?");
    expect(view.text(B)).toBe("B!?");
    expect(view.forest()).toBe(forest);
    expect(counts).toEqual({ ...before, b: before.b + 2 });

    setNodeColor(remote, A, "rose");
    expect(counts.forest).toBe(before.forest + 1);
    expect(counts.a).toBe(before.a);
    expect(view.forest()[0].color).toBe("rose");
    dispose();
  });

  test("a transaction updates the view once", () => {
    const { local, remote } = replicas();
    const { view, counts, dispose } = mount(local);
    const before = counts.forest;
    remote.transact(() => {
      createChild(remote, A, { id: C, text: "C" });
      setNodeColor(remote, B, "teal");
      editNodeText(remote, A, 0, 1, "Root");
    }, ORIGIN.local);
    expect(counts.forest).toBe(before + 1);
    expect(view.text(A)).toBe("Root");
    expect(ids(view)).toEqual([A, B, C]);
    dispose();
  });

  test("a hydrating document renders nothing until it is ready", () => {
    const { local } = replicas();
    const empty = openProjectDocument(PROJECT);
    const { view, dispose } = mount(empty);
    expect(view.status()).toBe("loading");
    expect(view.forest()).toEqual([]);
    Y.applyUpdate(empty, Y.encodeStateAsUpdate(local), ORIGIN.persistence);
    expect(view.status()).toBe("ready");
    expect(ids(view)).toEqual([A, B]);
    expect(view.text(B)).toBe("B");
    dispose();
  });

  test("disposing detaches the view from its document", () => {
    const { local, remote } = replicas();
    const handlers = deepHandlers(local);
    const { view, counts, dispose } = mount(local);
    expect(deepHandlers(local)).toBe(handlers + 1);
    dispose();
    expect(deepHandlers(local)).toBe(handlers);

    const before = { ...counts };
    editNodeText(remote, A, 0, 1, "Changed");
    createChild(remote, A, { id: C });
    expect(view.text(A)).toBe("A");
    expect(ids(view)).toEqual([A, B]);
    expect(counts).toEqual(before);
  });
});
