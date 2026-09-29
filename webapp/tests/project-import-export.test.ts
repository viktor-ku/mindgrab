import { expect, test } from "bun:test";
import {
  findDuplicateProject,
  saveImportedProject,
  serializeProjectFile,
} from "../src/project-import-export";
import type { Project } from "../src/projects";
import { parseProject } from "../src/projects";

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
  name: "Planning",
  nodes: [
    {
      id: "root",
      text: "Ideas",
      color: "teal",
      position: { x: -20, y: 14 },
      next: [{ id: "child", text: "Keep this" }],
    },
  ],
  anchor: { id: "root", centerY: 30 },
  view: { left: 10, top: -12, zoom: 1.25 },
};

test("finds an exact project duplicate even when JSON key order differs", () => {
  const local = storage();
  local.setItem(
    "proj/Planning",
    JSON.stringify({
      view: project.view,
      nodes: project.nodes,
      name: project.name,
      version: project.version,
      anchor: project.anchor,
    }),
  );
  expect(findDuplicateProject(local, project)).toBe("proj/Planning");
});

test("exports schema-validated JSON that preserves the full project", () => {
  const json = serializeProjectFile(project);
  expect(json.endsWith("\n")).toBe(true);
  expect(parseProject(json)).toEqual(project);
});

test("loads an exact match or creates a named clone without replacing it", () => {
  const local = storage();
  local.setItem("proj/Planning", JSON.stringify(project));

  expect(saveImportedProject(local, project, false)).toEqual({
    kind: "existing",
    project,
  });
  const clone = saveImportedProject(local, project, true);
  expect(clone).toEqual({
    kind: "clone",
    project: { ...project, name: "Planning (copy)" },
  });
  expect(local.getItem("proj/Planning")).toBe(JSON.stringify(project));
  expect(local.getItem("proj/Planning (copy)")).toContain("Keep this");
});

test("keeps a different same-name project and imports using a unique name", () => {
  const local = storage();
  const existing = { ...project, nodes: [{ id: "other", text: "Local" }] };
  local.setItem("proj/Planning", JSON.stringify(existing));

  expect(findDuplicateProject(local, project)).toBeUndefined();
  const imported = saveImportedProject(local, project, false);
  expect(imported).toEqual({
    kind: "imported",
    project: { ...project, name: "Planning (copy)" },
  });
  expect(local.getItem("proj/Planning")).toBe(JSON.stringify(existing));
});

test("skips a damaged local project while checking for matches", () => {
  const local = storage();
  local.setItem("proj/Broken", "not JSON");
  expect(findDuplicateProject(local, project)).toBeUndefined();
});
