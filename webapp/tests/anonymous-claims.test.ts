import { afterEach, expect, test } from "bun:test";
import {
  createChild,
  createProjectDocument,
  createRoot,
  DEFAULT_COLOR_PREFERENCES,
  editNodeText,
  isPristineSeed,
  projectForest,
  renameProject,
  setColorPreferences,
  setNodeColor,
  setNodeNote,
} from "../src/project-document";
import type { ProjectDocument } from "../src/project-document";
import { generateProjectName } from "../src/project-names";
import { EditHistory } from "../src/undo-history";

const docs: ProjectDocument[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

const seed = () => {
  const doc = createProjectDocument(
    crypto.randomUUID(),
    generateProjectName(),
    {
      text: "New idea",
    },
  );
  docs.push(doc);
  return doc;
};
const pristine = (doc: ProjectDocument) => {
  const view = doc.view();
  return isPristineSeed(projectForest(view), view.name, view.colors);
};
const root = (doc: ProjectDocument) => doc.view().roots[0];

// Only a pristine seed may be dropped when anonymous work is claimed; any
// real edit must keep the map.
test("only an untouched seed is pristine; any edit keeps the map", () => {
  const untouched = seed();
  expect(untouched.view().nodes[0].color).toBe("slate");
  expect(pristine(untouched)).toBe(true);

  const colors = seed();
  setColorPreferences(colors, { quick: ["sky-400"], newIdeas: "slate" });
  expect(pristine(colors)).toBe(false);
  setColorPreferences(colors, DEFAULT_COLOR_PREFERENCES);
  expect(pristine(colors)).toBe(true);

  const renamed = seed();
  renameProject(renamed, "Podcast plan");
  expect(pristine(renamed)).toBe(false);

  const edited = seed();
  const history = new EditHistory(edited);
  editNodeText(edited, root(edited), 8, 0, "!");
  history.finishGroup();
  expect(pristine(edited)).toBe(false);
  history.undo();
  expect(edited.view().nodes[0].text).toBe("New idea");
  expect(pristine(edited)).toBe(true);

  const noted = seed();
  setNodeNote(noted, root(noted), "remember this");
  expect(pristine(noted)).toBe(false);

  const parent = seed();
  createChild(parent, root(parent), { text: "" });
  expect(pristine(parent)).toBe(false);

  const coloured = seed();
  setNodeColor(coloured, root(coloured), "teal");
  expect(pristine(coloured)).toBe(false);

  const twoRoots = seed();
  createRoot(twoRoots, { text: "" });
  expect(pristine(twoRoots)).toBe(false);
  expect(isPristineSeed([], generateProjectName())).toBe(false);
});
