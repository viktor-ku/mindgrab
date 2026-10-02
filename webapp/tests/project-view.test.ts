import { describe, expect, test } from "bun:test";
import { createComputed, createRoot } from "solid-js";
import * as Y from "yjs";
import {
  createChild,
  createProjectDocument,
  editNodeText,
  ORIGIN,
  openProjectDocument,
  setNodeColor,
} from "../src/project-document";
import { createProjectView } from "../src/project-view";

// Solid's reactive build is selected with `bun test --conditions browser`.
const PROJECT = "10000000-0000-4000-8000-000000000000";
const ID = (n: number) =>
  `20000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const [A, B] = [1, 2].map(ID);

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

describe("project view", () => {
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
});
