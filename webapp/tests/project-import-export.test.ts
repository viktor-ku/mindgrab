import { expect, test } from "bun:test";
import {
  DEFAULT_COLOR_PREFERENCES,
  projectForest,
  importProjectDocument,
  deleteSubtree,
} from "../src/project-document";
import type { ColorPreferences } from "../src/project-document";
import type {
  ProjectFile,
  ProjectFileNode,
} from "../src/project-import-export";
import {
  PROJECT_FILE_VERSION,
  parseProjectFile,
  prepareProjectImport,
  projectFileFromContent,
  serializeProjectFile,
} from "../src/project-import-export";

const leaf = (id: string, text = id): ProjectFileNode => ({
  id,
  text,
  color: "blue",
  children: [],
});
const file = (nodes: ProjectFileNode[] = []): ProjectFile => ({
  format: "mindgrab-project",
  version: PROJECT_FILE_VERSION,
  project: { name: "Planning", nodes },
});
const complex = (): ProjectFile => ({
  ...file([
    {
      ...leaf("root", "Ideas\nHäid mõtteid 😀 日本語"),
      color: "teal",
      position: { x: -20.5, y: 14 },
      children: [
        {
          ...leaf("first", "First"),
          children: [leaf("grandchild", "\n")],
        },
        { ...leaf("second", "Second"), position: { x: 230, y: -40 } },
      ],
    },
    leaf("another-root", "Another root"),
  ]),
  preferences: {
    viewport: { left: 10, top: -12, zoom: 1.25 },
    anchor: { id: "root", centerY: 30 },
  },
});

test("export contains canonical live content and omits history and stale preferences", () => {
  const { content } = prepareProjectImport(complex());
  const doc = importProjectDocument(crypto.randomUUID(), content);
  const root = doc.view().roots[0];
  deleteSubtree(doc, root);
  const view = doc.view();
  doc.destroy();
  const exported = projectFileFromContent(view, {
    anchor: { id: root, centerY: 10 },
  });
  expect(exported.preferences?.anchor).toBeUndefined();
  expect(exported.project.nodes).toEqual(projectForest(view));
  expect(exported.project.nodes.map((node) => node.text)).toEqual([
    "Another root",
  ]);
  const json = serializeProjectFile(view);
  for (const forbidden of [
    "owner",
    "credential",
    "token",
    "schemaVersion",
    "placement",
    "rank",
    "deleted",
    "awareness",
    "undo",
    "clientID",
    "clock",
  ])
    expect(json).not.toContain(`"${forbidden}"`);
});

test("a backup round-trips notes and the map's colors", () => {
  const colors = {
    quick: ["sky-400", "slate", "mauve-950"],
    newIdeas: "lime-200",
  } satisfies ColorPreferences;
  const input = {
    ...file([
      {
        ...leaf("root"),
        color: "sky-400",
        note: "Details 🦀\n\nSecond paragraph",
        children: [{ ...leaf("child"), note: "child details" }],
      },
      leaf("empty"),
    ]),
    preferences: { colors, links: "square" },
  } satisfies ProjectFile;
  const { content } = prepareProjectImport(
    parseProjectFile(JSON.stringify(input)),
  );
  const doc = importProjectDocument(crypto.randomUUID(), content);
  try {
    expect(doc.view().colors).toEqual(colors);
    expect(doc.view().links).toBe("square");
    expect(doc.view().nodes[0].color).toBe("sky-400");
    const exported = parseProjectFile(serializeProjectFile(doc.view()));
    expect(exported.version).toBe(PROJECT_FILE_VERSION);
    expect(exported.preferences?.colors).toEqual(colors);
    expect(exported.preferences?.links).toBe("square");
    expect(exported.project.nodes[0].note).toBe(input.project.nodes[0].note);
    expect(exported.project.nodes[0].children[0].note).toBe("child details");
    expect(exported.project.nodes[1]).not.toHaveProperty("note");
    expect(doc.view().nodes[2].note).toBe("");
  } finally {
    doc.destroy();
  }
});

test("version 3 and 4 files still import and export as the current version", () => {
  for (const version of [3, 4]) {
    const old = { ...file([leaf("old")]), version };
    const parsed = parseProjectFile(JSON.stringify(old));
    expect(parsed.version).toBe(PROJECT_FILE_VERSION);
    const { content } = prepareProjectImport(parsed);
    expect(content.nodes[0].note).toBe("");
    expect(content.colors).toEqual(DEFAULT_COLOR_PREFERENCES);
    expect(content.links).toBe("rounded");
    expect(projectFileFromContent(content).version).toBe(PROJECT_FILE_VERSION);
  }
});
