import { describe, expect, test } from "bun:test";
import {
  DEFAULT_COLOR_PREFERENCES,
  LIMITS,
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
  PROJECT_FILE_MAX_BYTES,
  PROJECT_FILE_MAX_DEPTH,
  parseProjectFile,
  prepareProjectImport,
  projectFileFromContent,
  projectMarkdown,
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

describe("file validation", () => {
  test.each([
    [
      "unknown version",
      JSON.stringify({ ...file(), version: 99 }),
      "Unsupported",
    ],
    [
      "account metadata",
      JSON.stringify({ ...file(), ownerId: "secret" }),
      "Unrecognized",
    ],
    [
      "duplicate IDs",
      JSON.stringify(file([leaf("same"), leaf("same")])),
      "unique",
    ],
  ])("rejects %s", (_name, json, message) => {
    expect(() => parseProjectFile(json)).toThrow(message);
  });

  test("checks UTF-8 byte size before parsing", () => {
    expect(() =>
      parseProjectFile(" ".repeat(PROJECT_FILE_MAX_BYTES + 1)),
    ).toThrow("10 MiB");
    expect(() =>
      parseProjectFile("😀".repeat(PROJECT_FILE_MAX_BYTES / 4 + 1)),
    ).toThrow("10 MiB");
  });

  test("rejects oversized forests before schema traversal", () => {
    const nodes = Array.from({ length: LIMITS.nodes + 1 }, (_, i) =>
      leaf(`${i}`),
    );
    expect(() => parseProjectFile(JSON.stringify(file(nodes)))).toThrow(
      "10000 nodes",
    );
  });

  test("accepts the depth boundary and rejects deeper trees", () => {
    const root = leaf("root");
    let cursor = root;
    for (let i = 1; i < PROJECT_FILE_MAX_DEPTH; i++) {
      const child = leaf(`node-${i}`);
      cursor.children = [child];
      cursor = child;
    }
    expect(
      parseProjectFile(JSON.stringify(file([root]))).project.nodes,
    ).toHaveLength(1);
    cursor.children = [leaf("too-deep")];
    expect(() => parseProjectFile(JSON.stringify(file([root])))).toThrow(
      "100 levels",
    );
  });
});

describe("Markdown outline", () => {
  const texts = new Map([
    ["a", "Plan"],
    ["b", "First line\r\nsecond line\n\n  indented"],
    ["c", "  "],
    ["d", "# not a heading"],
    ["e", "- not a list"],
    ["f", "1. not numbered"],
    ["g", "> quote\n* star"],
    ["h", "Plain #hash and a - dash"],
  ]);
  const text = (id: string) => texts.get(id) ?? "";

  test("nests every node as list items under the project title", () => {
    const roots = [
      {
        id: "a",
        next: [{ id: "b", next: [{ id: "c" }] }, { id: "h" }],
      },
      { id: "d" },
    ];
    expect(projectMarkdown("Roadmap", roots, text)).toBe(
      [
        "# Roadmap",
        "",
        "- Plan",
        "  - First line",
        "    second line",
        "",
        "    indented",
        "    - New idea",
        "  - Plain #hash and a - dash",
        "- \\# not a heading",
        "",
      ].join("\n"),
    );
  });

  test("escapes leading Markdown markers and names untitled maps", () => {
    expect(
      projectMarkdown("  ", [{ id: "e" }, { id: "f" }, { id: "g" }], text),
    ).toBe(
      [
        "# Untitled map",
        "",
        "- \\- not a list",
        "- \\1. not numbered",
        "- \\> quote",
        "  \\* star",
        "",
      ].join("\n"),
    );
    expect(projectMarkdown("# Notes", [], text)).toBe("# \\# Notes\n\n");
  });
});

test("version 4 notes round-trip through project files and newly identified documents", () => {
  const input = file([
    {
      ...leaf("root"),
      note: "Details 🦀\n\nSecond paragraph",
      children: [{ ...leaf("child"), note: "child details" }],
    },
    leaf("empty"),
  ]);
  const { content } = prepareProjectImport(
    parseProjectFile(JSON.stringify(input)),
  );
  const doc = importProjectDocument(crypto.randomUUID(), content);
  try {
    const exported = parseProjectFile(serializeProjectFile(doc.view()));
    expect(exported.version).toBe(PROJECT_FILE_VERSION);
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
    expect(projectFileFromContent(content).version).toBe(PROJECT_FILE_VERSION);
  }
});

test("a map's color choices round-trip through backups and are validated", () => {
  const colors = {
    quick: ["sky-400", "slate", "mauve-950"],
    newIdeas: "lime-200",
  } satisfies ColorPreferences;
  const input = {
    ...file([{ ...leaf("root"), color: "sky-400" }]),
    preferences: { colors },
  } satisfies ProjectFile;
  const { content } = prepareProjectImport(
    parseProjectFile(JSON.stringify(input)),
  );
  const doc = importProjectDocument(crypto.randomUUID(), content);
  try {
    expect(doc.view().colors).toEqual(colors);
    expect(doc.view().nodes[0].color).toBe("sky-400");
    const exported = parseProjectFile(serializeProjectFile(doc.view()));
    expect(exported.preferences?.colors).toEqual(colors);
  } finally {
    doc.destroy();
  }
  for (const bad of [
    { quick: ["blue"], newIdeas: "slate" },
    { quick: ["sky-400", "sky-400"], newIdeas: "slate" },
    { quick: [], newIdeas: "rose" },
    { quick: [], newIdeas: "slate", extra: 1 },
  ])
    expect(() =>
      parseProjectFile(
        JSON.stringify({ ...file([]), preferences: { colors: bad } }),
      ),
    ).toThrow();
});

test("import validates note type and UTF-16 limit", () => {
  for (const note of [null, 42, "😀".repeat(LIMITS.note / 2 + 1)]) {
    expect(() =>
      parseProjectFile(
        JSON.stringify(file([{ ...leaf("root"), note } as ProjectFileNode])),
      ),
    ).toThrow();
  }
  const note = "😀".repeat(LIMITS.note / 2);
  expect(
    parseProjectFile(JSON.stringify(file([{ ...leaf("root"), note }]))).project
      .nodes[0].note,
  ).toBe(note);
});

test("Markdown includes multiline notes under their list item with nested notes", () => {
  const roots = [
    {
      id: "root",
      note: "First\n\n# details",
      next: [{ id: "child", note: "Child details" }],
    },
  ];
  expect(projectMarkdown("Plan", roots, (id) => id)).toBe(
    "# Plan\n\n- root\n  > First\n  >\n  > \\# details\n  - child\n    > Child details\n",
  );
  expect(
    projectMarkdown(
      "Plan",
      [{ id: "root" }],
      () => "root",
      () => "Live note",
    ),
  ).toContain("  > Live note\n");
  expect(projectMarkdown("Plan", [{ id: "root" }], () => "root")).toBe(
    "# Plan\n\n- root\n",
  );
});
