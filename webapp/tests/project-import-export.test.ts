import { describe, expect, test } from "bun:test";
import { LIMITS, projectForest } from "../src/project-document";
import type {
  ProjectFile,
  ProjectFileNode,
} from "../src/project-import-export";
import {
  PROJECT_FILE_MAX_BYTES,
  PROJECT_FILE_MAX_DEPTH,
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
