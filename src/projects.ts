import type { LayoutAnchor, MindMapNode } from "./mind-map";

export interface Project {
  version: 1;
  name: string;
  nodes: MindMapNode[];
  anchor?: LayoutAnchor;
  view: { left: number; top: number; zoom: number };
}

const PREFIX = "proj/";
const LATEST_PROJECT_KEY = "mindgrab/latest-project";

function rememberProject(storage: Storage, key: string) {
  try {
    storage.setItem(LATEST_PROJECT_KEY, key);
  } catch {
    // A failed preference write must not prevent saving or opening a project.
  }
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseProject(json: string): Project {
  const value: unknown = JSON.parse(json);
  const ids = new Set<string>();
  function validNodes(nodes: unknown, depth = 0): nodes is MindMapNode[] {
    return (
      depth < 100 &&
      Array.isArray(nodes) &&
      nodes.every((node: unknown) => {
        if (
          !object(node) ||
          typeof node.id !== "string" ||
          !node.id ||
          ids.has(node.id) ||
          typeof node.text !== "string"
        )
          return false;
        ids.add(node.id);
        return (
          (node.position === undefined ||
            (object(node.position) &&
              finite(node.position.x) &&
              finite(node.position.y))) &&
          (node.next === undefined || validNodes(node.next, depth + 1))
        );
      })
    );
  }
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !validNodes(value.nodes) ||
    !object(value.view) ||
    !finite(value.view.left) ||
    !finite(value.view.top) ||
    !finite(value.view.zoom) ||
    value.view.zoom < 0.25 ||
    value.view.zoom > 2.5 ||
    (value.anchor !== undefined &&
      (!object(value.anchor) ||
        typeof value.anchor.id !== "string" ||
        !finite(value.anchor.centerY)))
  )
    throw new Error(
      "This saved project is invalid or uses an unsupported format.",
    );
  return value as unknown as Project;
}

export function saveProject(storage: Storage, project: Project): string {
  const name = project.name.trim() || "Untitled project";
  const key = PREFIX + name;
  storage.setItem(key, JSON.stringify({ ...project, name }, null, 2));
  rememberProject(storage, key);
  return name;
}

export function listProjects(storage: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys.sort((a, b) => a.localeCompare(b));
}

export function loadProject(storage: Storage, key: string): Project {
  if (!key.startsWith(PREFIX)) throw new Error("Invalid project key.");
  const json = storage.getItem(key);
  if (json === null) throw new Error("This saved project no longer exists.");
  const project = parseProject(json);
  rememberProject(storage, key);
  return project;
}

export function loadLatestProject(storage: Storage): Project | undefined {
  const key = storage.getItem(LATEST_PROJECT_KEY);
  return key === null ? undefined : loadProject(storage, key);
}
