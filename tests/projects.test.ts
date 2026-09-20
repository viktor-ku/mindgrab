import { expect, test } from "bun:test";
import {
  listProjects,
  loadProject,
  parseProject,
  saveProject,
  type Project,
} from "../src/projects";

function storage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => data.clear(),
  };
}
const project: Project = {
  version: 1,
  name: "My ideas",
  nodes: [
    {
      id: "a",
      text: "Root",
      position: { x: -50, y: 90 },
      next: [{ id: "b", text: "Child\nwith details" }],
    },
  ],
  anchor: { id: "a", centerY: 110 },
  view: { left: 120, top: -30, zoom: 1.5 },
};

test("round trips the name, tree, manual positions, anchor, and view as readable JSON", () => {
  const local = storage();
  saveProject(local, project);
  expect(local.getItem("proj/My ideas")).toBe(JSON.stringify(project, null, 2));
  expect(loadProject(local, "proj/My ideas")).toEqual(project);
});

test("lists only projects and updates the same name without affecting others", () => {
  const local = storage();
  local.setItem("other-app", "keep");
  saveProject(local, project);
  saveProject(local, { ...project, name: "Another" });
  saveProject(local, { ...project, nodes: [] });
  expect(listProjects(local)).toEqual(["proj/Another", "proj/My ideas"]);
  expect(loadProject(local, "proj/My ideas").nodes).toEqual([]);
  expect(loadProject(local, "proj/Another")).toEqual({
    ...project,
    name: "Another",
  });
  expect(local.getItem("other-app")).toBe("keep");
});

test("blank names have a usable fallback and names are trimmed", () => {
  const local = storage();
  expect(saveProject(local, { ...project, name: "  " })).toBe(
    "Untitled project",
  );
  expect(saveProject(local, { ...project, name: "  Plans  " })).toBe("Plans");
  expect(loadProject(local, "proj/Plans").name).toBe("Plans");
});

test("rejects malformed, incompatible, and duplicate-ID projects", () => {
  for (const value of [
    null,
    {},
    { ...project, version: 2 },
    { ...project, nodes: [{ id: "a", text: 5 }] },
    { ...project, nodes: [...project.nodes, ...project.nodes] },
    { ...project, view: { left: 0, top: 0, zoom: 0 } },
    {
      ...project,
      nodes: [{ id: "a", text: "Bad", position: { x: null, y: 0 } }],
    },
  ]) {
    expect(() => parseProject(JSON.stringify(value))).toThrow();
  }
  expect(() => parseProject("not JSON")).toThrow();
  expect(() => loadProject(storage(), "proj/missing")).toThrow();
});

test("storage failures propagate so the UI can report failure", () => {
  const local = storage();
  local.setItem = () => {
    throw new Error("Quota exceeded");
  };
  expect(() => saveProject(local, project)).toThrow("Quota exceeded");
});
