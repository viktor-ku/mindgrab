import { afterEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  createProjectDocument,
  createChild,
  createSibling,
  editNodeNote,
  openProjectDocument,
  projectMindMap,
  setNodeNote,
} from "../src/project-document";
import type { ProjectDocument } from "../src/project-document";
import { createProjectView } from "../src/project-view";
import { bindTextarea } from "../src/text-binding";

const docs: ProjectDocument[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const doc of docs.splice(0)) doc.destroy();
});
function keep(doc: ProjectDocument) {
  docs.push(doc);
  return doc;
}
function fixture(note?: string) {
  const doc = keep(
    createProjectDocument(crypto.randomUUID(), "Notes", { text: "idea", note }),
  );
  return { doc, id: doc.view().roots[0] };
}

// Only the textarea surface used by the binding. Browser behavior is covered
// by the interop suite; these tests exercise real WASM edits and notifications.
class Textarea extends EventTarget {
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection: "forward" | "backward" | "none" = "none";
  setSelectionRange(start: number, end: number, direction = "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction as typeof this.selectionDirection;
  }
  input(value: string, caret = value.length) {
    this.value = value;
    this.setSelectionRange(caret, caret);
    this.dispatchEvent(new Event("input"));
  }
  element() {
    return this as unknown as HTMLTextAreaElement;
  }
}

test("note helpers notify observers, persist, clear, and project optional notes", () => {
  const { doc, id } = fixture();
  const notifications: Uint8Array[] = [];
  doc.on("snapshot", (bytes) => notifications.push(bytes));
  expect(projectMindMap(doc.view())[0]).not.toHaveProperty("note");
  expect(setNodeNote(doc, id, "Details 🦀\nSecond line")).toBe(true);
  expect(setNodeNote(doc, id, "Details 🦀\nSecond line")).toBe(false);
  expect(editNodeNote(doc, id, 8, 2, "🌲")).toBe(true);
  expect(notifications).toHaveLength(2);
  const reopened = keep(openProjectDocument(doc.id, [doc.snapshot()]));
  expect(reopened.view().nodes[0].note).toBe("Details 🌲\nSecond line");
  expect(projectMindMap(reopened.view())[0].note).toBe(
    "Details 🌲\nSecond line",
  );
  expect(reopened.view().nodes[0].text).toBe("idea");
  setNodeNote(doc, id, "");
  expect(projectMindMap(doc.view())[0]).not.toHaveProperty("note");
});

test("new nodes and reactive accessors expose notes", () => {
  const { doc, id } = fixture("initial");
  const child = createChild(doc, id, { note: "child note" });
  const sibling = createSibling(doc, id, { note: "sibling note" });
  createRoot((dispose) => {
    cleanups.push(dispose);
    const view = createProjectView(doc);
    expect(view.note(id)).toBe("initial");
    expect(view.note(child)).toBe("child note");
    expect(view.note(sibling)).toBe("sibling note");
    expect(view.note("unknown")).toBe("");
    setNodeNote(doc, id, "updated");
    expect(view.note(id)).toBe("updated");
    expect(view.forest()[0].note).toBe("updated");
    expect(view.text(id)).toBe("idea");
    setNodeNote(doc, id, "");
    expect(view.note(id)).toBe("");
  });
});

test("note textarea binding handles first edits, remote composition and caret rebasing", () => {
  const { doc, id } = fixture();
  const input = new Textarea();
  const values: string[] = [];
  const unbind = bindTextarea(
    input.element(),
    doc,
    id,
    (value) => values.push(value),
    "note",
  );
  cleanups.push(unbind);
  expect(input.value).toBe("");
  input.input("Hello 🌲");
  expect(doc.view().nodes[0].note).toBe("Hello 🌲");
  input.dispatchEvent(new Event("compositionstart"));
  input.input("Hello 🌲 draft");
  expect(doc.view().nodes[0].note).toBe("Hello 🌲");
  const remote = keep(openProjectDocument(doc.id, [doc.snapshot()]));
  editNodeNote(remote, id, 0, 0, "Remote ");
  doc.merge(remote.snapshot());
  expect(input.value).toBe("Hello 🌲 draft");
  input.dispatchEvent(new Event("compositionend"));
  expect(input.value).toBe("Remote Hello 🌲 draft");
  expect(input.selectionEnd).toBe(input.value.length);
  expect(doc.view().nodes[0].text).toBe("idea");
  input.setSelectionRange(7, 12, "backward");
  editNodeNote(remote, id, 0, 0, "More ");
  doc.merge(remote.snapshot());
  expect(input.value).toBe("More Remote Hello 🌲 draft");
  expect(input.selectionStart).toBe(12);
  expect(input.selectionEnd).toBe(17);
  expect(input.selectionDirection).toBe("backward");
  expect(values.at(-1)).toBe(input.value);
});

test("note textarea rejects invalid drafts and default binding still edits text", () => {
  const { doc, id } = fixture("note");
  const input = new Textarea();
  cleanups.push(bindTextarea(input.element(), doc, id, undefined, "note"));
  input.input("x".repeat(65_537));
  expect(input.value).toBe("note");
  expect(doc.view().nodes[0].note).toBe("note");
  const text = new Textarea();
  cleanups.push(bindTextarea(text.element(), doc, id));
  text.input("updated idea");
  expect(doc.view().nodes[0].text).toBe("updated idea");
  expect(doc.view().nodes[0].note).toBe("note");
});
