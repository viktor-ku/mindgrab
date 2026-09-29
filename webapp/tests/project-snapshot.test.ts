import { describe, expect, test } from "bun:test";
import { readProject } from "../src/project-document";
import {
  normalizeSnapshot,
  openSnapshot,
  snapshotProject,
} from "../src/project-snapshot";
import type { Project } from "../src/projects";

const ID = (n: number) =>
  `20000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

const project: Project = {
  version: 1,
  name: "Ideas",
  nodes: [
    {
      id: ID(1),
      text: "Root",
      color: "teal",
      position: { x: 10, y: -4 },
      next: [
        { id: ID(2), text: "B", color: "blue" },
        { id: ID(3), text: "C\nline", color: "rose", next: [] },
      ],
    },
    { id: ID(4), text: "Second 😀", color: "blue" },
  ],
  anchor: { id: ID(2), centerY: 12 },
  view: { left: 1, top: 2, zoom: 1.5 },
};

describe("project snapshots", () => {
  test("round-trip through a fresh document", () => {
    const { doc, anchor } = openSnapshot(project);
    expect(readProject(doc).status).toBe("ready");
    expect(doc.guid).not.toBe(openSnapshot(project).doc.guid);
    const saved = snapshotProject(doc, anchor, project.view);
    expect(saved).toEqual({
      ...project,
      nodes: [
        {
          ...project.nodes[0],
          next: [
            { id: ID(2), text: "B", color: "blue" },
            { id: ID(3), text: "C\nline", color: "rose" },
          ],
        },
        project.nodes[1],
      ],
    });
  });

  test("replaces non-UUID node IDs and keeps the anchor on its node", () => {
    const legacy: Project = {
      ...project,
      nodes: [{ id: "root", text: "Root", next: [{ id: "a", text: "A" }] }],
      anchor: { id: "a", centerY: 3 },
    };
    const { doc, anchor } = openSnapshot(legacy);
    const [root] = snapshotProject(doc, anchor, legacy.view).nodes;
    const child = root.next?.[0];
    expect(root.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(child?.text).toBe("A");
    expect(anchor).toEqual({ id: child?.id ?? "", centerY: 3 });
  });

  test("normalizes default colors for comparison", () => {
    const uncolored: Project = {
      ...project,
      nodes: [{ id: ID(1), text: "Root" }],
      anchor: undefined,
    };
    expect(normalizeSnapshot(uncolored).nodes).toEqual([
      { id: ID(1), text: "Root", color: "blue" },
    ]);
  });

  test("rejects snapshots the document schema cannot hold", () => {
    expect(() => openSnapshot({ ...project, name: "x".repeat(201) })).toThrow();
  });
});
