import { afterEach, expect, test } from "bun:test";
import {
  createChild,
  createProjectDocument,
  projectMindMap,
} from "../src/project-document";
import type { ProjectDocument } from "../src/project-document";
import { EditHistory } from "../src/undo-history";

const docs: ProjectDocument[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

const children = (doc: ProjectDocument) =>
  projectMindMap(doc.view())[0].next?.map((node) => node.text) ?? [];

// Restoring a selection can resume writing, which finishes the current group
// while undo is still running. That must not start a second Loro group.
test("finishing a group from a restore listener keeps undo and redo working", () => {
  const doc = createProjectDocument(crypto.randomUUID(), "Undo", {
    text: "root",
  });
  docs.push(doc);
  const root = doc.view().roots[0];
  const history = new EditHistory(doc);
  history.onRestore(() => history.finishGroup());

  createChild(doc, root, { text: "first" });
  history.finishGroup();
  createChild(doc, root, { text: "second" });
  history.finishGroup();
  expect(children(doc)).toEqual(["first", "second"]);

  expect(() => history.undo()).not.toThrow();
  expect(children(doc)).toEqual(["first"]);
  expect(() => history.undo()).not.toThrow();
  expect(children(doc)).toEqual([]);
  expect(() => history.redo()).not.toThrow();
  expect(children(doc)).toEqual(["first"]);

  // Edits after the restore still form their own undo step.
  createChild(doc, root, { text: "third" });
  history.finishGroup();
  history.undo();
  expect(children(doc)).toEqual(["first"]);
  history.destroy();
});
