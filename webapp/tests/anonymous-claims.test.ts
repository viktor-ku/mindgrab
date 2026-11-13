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
import {
  generateProjectName,
  isGeneratedProjectName,
} from "../src/project-names";
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

test("the untouched seed is pristine", () => {
  const doc = seed();
  expect(doc.view().nodes[0].color).toBe("slate");
  expect(pristine(doc)).toBe(true);
});

test("a seed from before slate became the default is still pristine", () => {
  const doc = createProjectDocument(
    crypto.randomUUID(),
    generateProjectName(),
    { text: "New idea", color: "blue" },
  );
  docs.push(doc);
  expect(pristine(doc)).toBe(true);
});

test("choosing the map's colors counts as an edit", () => {
  const doc = seed();
  setColorPreferences(doc, { quick: ["sky-400"], newIdeas: "slate" });
  expect(pristine(doc)).toBe(false);
  setColorPreferences(doc, DEFAULT_COLOR_PREFERENCES);
  expect(pristine(doc)).toBe(true);
});

test("a renamed seed counts as edited", () => {
  const doc = seed();
  renameProject(doc, "Podcast plan");
  expect(pristine(doc)).toBe(false);
});

test("edited text is not pristine, and undoing it back to the seed is", () => {
  const doc = seed();
  const history = new EditHistory(doc);
  editNodeText(doc, root(doc), 8, 0, "!");
  history.finishGroup();
  expect(pristine(doc)).toBe(false);
  history.undo();
  expect(doc.view().nodes[0].text).toBe("New idea");
  expect(pristine(doc)).toBe(true);
});

test("a note makes the seed edited", () => {
  const doc = seed();
  setNodeNote(doc, root(doc), "remember this");
  expect(pristine(doc)).toBe(false);
});

test("a child makes the seed edited", () => {
  const doc = seed();
  createChild(doc, root(doc), { text: "" });
  expect(pristine(doc)).toBe(false);
});

test("a recoloured root or a second root makes the seed edited", () => {
  const coloured = seed();
  setNodeColor(coloured, root(coloured), "teal");
  expect(pristine(coloured)).toBe(false);

  const twoRoots = createProjectDocument(
    crypto.randomUUID(),
    generateProjectName(),
    { text: "New idea" },
  );
  docs.push(twoRoots);
  createRoot(twoRoots, { text: "" });
  expect(pristine(twoRoots)).toBe(false);
  expect(
    isPristineSeed(
      [
        {
          id: "a",
          text: "New idea",
          color: "blue",
          children: [],
          position: { x: 10, y: 10 },
        },
      ],
      generateProjectName(),
    ),
  ).toBe(false);
  expect(isPristineSeed([], generateProjectName())).toBe(false);
});

test("generated names are recognised and typed names are not", () => {
  for (let i = 0; i < 50; i++)
    expect(isGeneratedProjectName(generateProjectName())).toBe(true);
  expect(isGeneratedProjectName("blue otter 07")).toBe(true);
  expect(isGeneratedProjectName("blue otter 99")).toBe(true);
  expect(isGeneratedProjectName("blue otter 00")).toBe(false);
  expect(isGeneratedProjectName("blue otter 7")).toBe(false);
  expect(isGeneratedProjectName("blue otter 100")).toBe(false);
  expect(isGeneratedProjectName("Blue otter 07")).toBe(false);
  expect(isGeneratedProjectName("blue otter 07 ")).toBe(false);
  expect(isGeneratedProjectName("blue dragon 07")).toBe(false);
  expect(isGeneratedProjectName("Podcast plan")).toBe(false);
  expect(isGeneratedProjectName("")).toBe(false);
});
