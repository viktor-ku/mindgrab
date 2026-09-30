import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  exportProjectDocument,
  parseProjectFile,
  prepareProjectImport,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_FILE_MAX_DEPTH,
  projectFileFromContent,
  serializeProjectFile,
} from "../src/project-import-export";
import type {
  ProjectFile,
  ProjectFileNode,
} from "../src/project-import-export";
import {
  importProjectDocument,
  LIMITS,
  materializeProject,
  ORIGIN,
  projectForest,
  replaceNodeText,
} from "../src/project-document";

const leaf = (id: string, text = id): ProjectFileNode => ({
  id,
  text,
  color: "blue",
  children: [],
});
const file = (nodes: ProjectFileNode[] = []): ProjectFile => ({
  format: "mindgrab-project",
  version: 2,
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
const semantic = (nodes: ProjectFileNode[]): unknown[] =>
  nodes.map(({ id: _id, children, ...node }) => ({
    ...node,
    children: semantic(children),
  }));

for (const input of [file(), complex()]) {
  test(`round-trips ${input.project.nodes.length ? "a complex Unicode forest" : "an empty forest"}`, () => {
    const imported = prepareProjectImport(
      parseProjectFile(JSON.stringify(input)),
    );
    const json = serializeProjectFile(imported.content, imported.preferences);
    expect(json.endsWith("\n")).toBe(true);
    const exported = parseProjectFile(json);
    expect(exported.project.name).toBe(input.project.name);
    expect(semantic(exported.project.nodes)).toEqual(
      semantic(input.project.nodes),
    );
    expect(exported.preferences?.viewport).toEqual(input.preferences?.viewport);
    if (input.preferences?.anchor)
      expect(exported.preferences?.anchor).toEqual({
        id: exported.project.nodes[0].id,
        centerY: input.preferences.anchor.centerY,
      });
  });
}

test("each import regenerates every node ID and parent reference", () => {
  const input = complex();
  const first = prepareProjectImport(input).content;
  const second = prepareProjectImport(input).content;
  const ids = new Set(Object.keys(first.nodes));
  expect(Object.keys(second.nodes).every((id) => !ids.has(id))).toBe(true);
  expect(
    Object.values(first.nodes).every(
      ({ placement }) => placement.parent === null || ids.has(placement.parent),
    ),
  ).toBe(true);
  expect(Object.keys(first.nodes)).not.toContain("root");
  const one = importProjectDocument(crypto.randomUUID(), first);
  const two = importProjectDocument(crypto.randomUUID(), second);
  expect(one.guid).not.toBe(two.guid);
  const undo = new Y.UndoManager(one.getMap("project"), {
    trackedOrigins: new Set([ORIGIN.local]),
  });
  expect(undo.canUndo()).toBe(false);
  replaceNodeText(one, Object.keys(first.nodes)[0], "Changed only in first");
  expect(undo.canUndo()).toBe(true);
  expect(materializeProject(two).nodes).toEqual(second.nodes);
  undo.destroy();
  one.destroy();
  two.destroy();
});

test("export reads unsaved in-memory edits without modifying or saving the document", () => {
  const prepared = prepareProjectImport(complex());
  const doc = importProjectDocument(crypto.randomUUID(), prepared.content);
  const root = Object.keys(prepared.content.nodes)[0];
  replaceNodeText(doc, root, "Offline\n😀");
  let updates = 0;
  doc.on("update", () => updates++);
  const json = exportProjectDocument(doc);
  expect(updates).toBe(0);
  replaceNodeText(doc, root, "Later edit");
  expect(parseProjectFile(json).project.nodes[0].text).toBe("Offline\n😀");
  expect(
    parseProjectFile(exportProjectDocument(doc)).project.nodes[0].text,
  ).toBe("Later edit");
  doc.destroy();
});

test("export contains canonical live content and omits history and stale preferences", () => {
  const { content } = prepareProjectImport(complex());
  const root = Object.keys(content.nodes)[0];
  content.nodes[root].deleted = true;
  const exported = projectFileFromContent(content, {
    anchor: { id: root, centerY: 10 },
  });
  expect(exported.preferences?.anchor).toBeUndefined();
  // Promoted children can share ranks with roots; UUIDs break those ties.
  expect(exported.project.nodes).toEqual(projectForest(content));
  expect(exported.project.nodes.map((node) => node.text).sort()).toEqual([
    "Another root",
    "First",
    "Second",
  ]);
  expect(
    exported.project.nodes.find((node) => node.text === "First")?.children[0]
      .text,
  ).toBe("\n");
  const json = serializeProjectFile(content);
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
    ["truncated JSON", '{"format":', "not valid JSON"],
    ["malformed JSON", "not JSON", "not valid JSON"],
    ["non-object JSON", "[]", "JSON object"],
    [
      "unknown format",
      JSON.stringify({ ...file(), format: "other" }),
      "not a Mindgrab",
    ],
    [
      "unknown version",
      JSON.stringify({ ...file(), version: 99 }),
      "Unsupported",
    ],
    [
      "legacy v1",
      JSON.stringify({ version: 1, name: "Old", nodes: [] }),
      "not a Mindgrab",
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
    [
      "invalid color",
      JSON.stringify(
        file([{ ...leaf("a"), color: "invalid" } as ProjectFileNode]),
      ),
      "color",
    ],
    [
      "non-finite position",
      JSON.stringify(file([{ ...leaf("a"), position: { x: Infinity, y: 0 } }])),
      "number",
    ],
    [
      "invalid position type",
      JSON.stringify(
        file([
          {
            ...leaf("a"),
            position: { x: "1", y: 0 },
          } as unknown as ProjectFileNode,
        ]),
      ),
      "number",
    ],
    [
      "blank name",
      JSON.stringify({ ...file(), project: { name: "  ", nodes: [] } }),
      "required",
    ],
    [
      "UTF-8 name limit",
      JSON.stringify({
        ...file(),
        project: { name: "😀".repeat(51), nodes: [] },
      }),
      "200 bytes",
    ],
    [
      "text limit",
      JSON.stringify(file([leaf("a", "x".repeat(LIMITS.text + 1))])),
      "65536",
    ],
    [
      "unknown anchor",
      JSON.stringify({
        ...file(),
        preferences: { anchor: { id: "missing", centerY: 0 } },
      }),
      "reference",
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
