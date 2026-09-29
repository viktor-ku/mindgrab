import * as Y from "yjs";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export const SCHEMA_VERSION = 1;
export const LIMITS = {
  nodes: 10_000,
  text: 65_536,
  nameBytes: 200,
  rank: 128,
  updateBytes: 1_048_576,
  recoveryBytes: 10_485_760,
} as const;
export const ORIGIN = {
  create: Symbol("create"),
  local: Symbol("local"),
  remote: Symbol("remote"),
  persistence: Symbol("persistence"),
  import: Symbol("import"),
};
export const COLORS = [
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "violet",
  "slate",
] as const;
export type Placement = { parent: string | null; rank: string };
export type Position = { x: number; y: number };
export type NodeValue = {
  text: string;
  placement: Placement;
  position?: Position;
  color: string;
  deleted: boolean;
};
export type Content = {
  schemaVersion: 1;
  metadata: { name: string };
  nodes: Record<string, NodeValue>;
};
export type ForestNode = {
  id: string;
  text: string;
  color: string;
  position?: Position;
  children: ForestNode[];
};
export type NodeMap = Y.Map<unknown>;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function present<T>(value: T | undefined): T {
  requireValue(value !== undefined, "Missing expected entry");
  return value;
}
export function assertId(id: string) {
  requireValue(uuid.test(id), "Expected a canonical UUID");
}
function object(value: unknown): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected object",
  );
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  requireValue(
    Object.keys(value).every((key) => allowed.includes(key)),
    "Unknown schema field",
  );
}
function validRank(rank: unknown): asserts rank is string {
  requireValue(
    typeof rank === "string" &&
      rank.length <= LIMITS.rank &&
      /^[A-Za-z][0-9A-Za-z]+$/.test(rank),
    "Invalid rank",
  );
  generateKeyBetween(rank, null); // Validates the package's canonical default alphabet/encoding.
}
export function validateContent(value: unknown): Content {
  const root = object(value);
  keys(root, ["schemaVersion", "metadata", "nodes"]);
  requireValue(
    root.schemaVersion === SCHEMA_VERSION,
    "Unsupported schema version",
  );
  const meta = object(root.metadata);
  keys(meta, ["name"]);
  requireValue(
    typeof meta.name === "string" &&
      meta.name.trim().length > 0 &&
      new TextEncoder().encode(meta.name).length <= LIMITS.nameBytes,
    "Invalid name",
  );
  const nodes = object(root.nodes);
  requireValue(Object.keys(nodes).length <= LIMITS.nodes, "Too many nodes");
  for (const [id, raw] of Object.entries(nodes)) {
    assertId(id);
    const node = object(raw);
    keys(node, ["text", "placement", "position", "color", "deleted"]);
    requireValue(
      typeof node.text === "string" && node.text.length <= LIMITS.text,
      "Invalid text",
    );
    requireValue(
      COLORS.includes(node.color as (typeof COLORS)[number]),
      "Invalid color",
    );
    requireValue(typeof node.deleted === "boolean", "Invalid deletion state");
    const placement = object(node.placement);
    keys(placement, ["parent", "rank"]);
    requireValue(
      placement.parent === null || typeof placement.parent === "string",
      "Invalid parent",
    );
    if (typeof placement.parent === "string") assertId(placement.parent);
    validRank(placement.rank);
    if (node.position !== undefined) {
      const p = object(node.position);
      keys(p, ["x", "y"]);
      requireValue(
        typeof p.x === "number" &&
          Number.isFinite(p.x) &&
          typeof p.y === "number" &&
          Number.isFinite(p.y),
        "Invalid position",
      );
    }
  }
  return value as Content;
}
export function createDocument(
  projectId: string,
  name: string,
  clientId?: number,
): Y.Doc {
  assertId(projectId);
  validateContent({ schemaVersion: 1, metadata: { name }, nodes: {} });
  const doc = new Y.Doc({ guid: projectId });
  if (clientId !== undefined) doc.clientID = clientId; // Fixed IDs are only for fixtures.
  doc.transact(() => {
    const root = doc.getMap("project");
    root.set("schemaVersion", SCHEMA_VERSION);
    const metadata = new Y.Map();
    metadata.set("name", name);
    root.set("metadata", metadata);
    root.set("nodes", new Y.Map());
  }, ORIGIN.create);
  return doc;
}
// Accessing a named root is safe. Opening never sets nested shared types or defaults.
export function nodeMap(doc: Y.Doc): Y.Map<NodeMap> {
  const nodes = doc.getMap("project").get("nodes");
  requireValue(nodes instanceof Y.Map, "Document is not initialized");
  return nodes as Y.Map<NodeMap>;
}
export function materialize(doc: Y.Doc): Content {
  requireValue(
    doc.share.size === 1 && doc.share.has("project"),
    "Unexpected document roots",
  );
  const root = doc.getMap("project");
  requireValue(
    root.get("metadata") instanceof Y.Map,
    "Metadata must be a shared map",
  );
  requireValue(
    typeof (root.get("metadata") as Y.Map<unknown>).get("name") === "string",
    "Name must be an atomic string",
  );
  for (const node of nodeMap(doc).values()) {
    requireValue(
      node instanceof Y.Map && node.get("text") instanceof Y.Text,
      "Nodes require shared maps and text",
    );
    requireValue(
      typeof node.get("color") === "string",
      "Color must be an atomic string",
    );
    const text = node.get("text") as Y.Text;
    requireValue(
      text
        .toDelta()
        .every(
          (part: { insert?: unknown; attributes?: unknown }) =>
            typeof part.insert === "string" && !part.attributes,
        ),
      "Plain text only",
    );
    requireValue(
      !(node.get("placement") instanceof Y.AbstractType) &&
        !(node.get("position") instanceof Y.AbstractType),
      "Placement and position must be atomic JSON",
    );
  }
  return validateContent(structuredClone(root.toJSON()));
}
export function openDocument(
  projectId: string,
  update: Uint8Array,
  clientId?: number,
): Y.Doc {
  assertId(projectId);
  requireValue(
    update.length <= LIMITS.recoveryBytes,
    "Document exceeds byte limit",
  );
  const doc = new Y.Doc({ guid: projectId });
  if (clientId !== undefined) doc.clientID = clientId;
  try {
    Y.applyUpdate(doc, update, ORIGIN.persistence);
    materialize(doc);
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}
export function addNode(
  doc: Y.Doc,
  id: string,
  value: NodeValue,
  origin: symbol = ORIGIN.local,
) {
  assertId(id);
  const nodes = nodeMap(doc);
  requireValue(!nodes.has(id), "Node IDs cannot be reused");
  validateContent({
    schemaVersion: 1,
    metadata: { name: "validation" },
    nodes: { [id]: value },
  });
  requireValue(nodes.size < LIMITS.nodes, "Too many nodes");
  doc.transact(() => {
    const node = new Y.Map();
    node.set("text", new Y.Text(value.text));
    node.set("placement", { ...value.placement });
    node.set("deleted", value.deleted);
    node.set("color", value.color);
    if (value.position) node.set("position", { ...value.position });
    nodes.set(id, node);
  }, origin);
}
// Every node gets at most one parent. For each cycle, detach its smallest UUID.
export function effectiveParents(content: Content): Map<string, string | null> {
  const live = Object.keys(content.nodes)
    .filter((id) => !content.nodes[id].deleted)
    .sort(compare);
  const alive = new Set(live);
  const parents = new Map(
    live.map((id) => {
      const parent = content.nodes[id].placement.parent;
      return [
        id,
        parent !== null && alive.has(parent) ? parent : null,
      ] as const;
    }),
  );
  const done = new Set<string>();
  for (const start of live) {
    const path: string[] = [];
    const seen = new Map<string, number>();
    let cursor: string | null = start;
    while (cursor !== null && !done.has(cursor)) {
      const index = seen.get(cursor);
      if (index !== undefined) {
        parents.set(path.slice(index).sort(compare)[0], null);
        break;
      }
      seen.set(cursor, path.length);
      path.push(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    for (const id of path) done.add(id);
  }
  return parents;
}
export function projectForest(content: Content): ForestNode[] {
  const parents = effectiveParents(content);
  const entries = new Map<string, ForestNode>();
  for (const id of parents.keys()) {
    const value = content.nodes[id];
    entries.set(id, {
      id,
      text: value.text,
      color: value.color,
      ...(value.position ? { position: value.position } : {}),
      children: [],
    });
  }
  const roots: ForestNode[] = [];
  for (const [id, parent] of parents)
    (parent === null ? roots : present(entries.get(parent)).children).push(
      present(entries.get(id)),
    );
  const order = (a: ForestNode, b: ForestNode) =>
    compare(
      content.nodes[a.id].placement.rank,
      content.nodes[b.id].placement.rank,
    ) || compare(a.id, b.id);
  roots.sort(order);
  for (const node of entries.values()) node.children.sort(order);
  return roots;
}
export function deleteObservedSubtree(doc: Y.Doc, id: string) {
  const parents = effectiveParents(materialize(doc));
  if (!parents.has(id)) return;
  const children = new Map<string, string[]>();
  for (const [child, parent] of parents)
    if (parent !== null)
      children.set(parent, [...(children.get(parent) ?? []), child]);
  const observed = [id];
  for (let i = 0; i < observed.length; i++)
    observed.push(...(children.get(observed[i]) ?? []));
  doc.transact(() => {
    for (const key of observed)
      present(nodeMap(doc).get(key)).set("deleted", true);
  }, ORIGIN.local);
}
// Explicit user move/insert only. Equal adjacent ranks or exhausted rank space are
// re-spaced in this same command; projection/opening never emits repairs.
export function placeNode(
  doc: Y.Doc,
  id: string,
  parent: string | null,
  index: number,
) {
  if (parent !== null) assertId(parent);
  const content = materialize(doc);
  const parents = effectiveParents(content);
  requireValue(
    parents.has(id) && (parent === null || parents.has(parent)),
    "Missing/deleted node",
  );
  let ancestor = parent;
  while (ancestor !== null) {
    requireValue(ancestor !== id, "Cannot move into own subtree");
    ancestor = parents.get(ancestor) ?? null;
  }
  const siblings = [...parents.keys()]
    .filter((key) => key !== id && parents.get(key) === parent)
    .sort(
      (a, b) =>
        compare(
          content.nodes[a].placement.rank,
          content.nodes[b].placement.rank,
        ) || compare(a, b),
    );
  requireValue(
    Number.isInteger(index) && index >= 0 && index <= siblings.length,
    "Invalid insertion index",
  );
  const left = index ? content.nodes[siblings[index - 1]].placement.rank : null;
  const right =
    index < siblings.length
      ? content.nodes[siblings[index]].placement.rank
      : null;
  const rank =
    left !== null && left === right
      ? undefined
      : generateKeyBetween(left, right);
  doc.transact(() => {
    if (rank && rank.length <= LIMITS.rank)
      present(nodeMap(doc).get(id)).set("placement", { parent, rank });
    else {
      siblings.splice(index, 0, id);
      const ranks = generateNKeysBetween(null, null, siblings.length);
      siblings.forEach((key, i) => {
        present(nodeMap(doc).get(key)).set("placement", {
          parent,
          rank: ranks[i],
        });
      });
    }
  }, ORIGIN.local);
}
export function createUndoManager(doc: Y.Doc) {
  return new Y.UndoManager(doc.getMap("project"), {
    trackedOrigins: new Set([ORIGIN.local]),
    captureTimeout: 0,
  });
}
