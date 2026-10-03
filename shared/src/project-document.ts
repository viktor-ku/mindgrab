import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import * as Y from "yjs";
import { z } from "zod";
import type { MindMapNode, NodePosition } from "./mind-map";
import type { NodeColor } from "./node-colors";
import { isNodeColor } from "./node-colors";

import { DOCUMENT_VERSION } from "./offline-contract";

export const SCHEMA_VERSION = DOCUMENT_VERSION;
export const LIMITS = {
  nodes: 10_000,
  text: 65_536,
  nameBytes: 200,
  rank: 128,
} as const;
// Origins are process-local; only `local` is meant to be tracked for undo.
export const ORIGIN = {
  create: Symbol("create"),
  local: Symbol("local"),
  remote: Symbol("remote"),
  persistence: Symbol("persistence"),
  import: Symbol("import"),
} as const;
export const DEFAULT_NODE_COLOR: NodeColor = "blue";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT = "project";

// Case-sensitive ASCII byte order, shared by browser and backend projections.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function isRankEncoding(rank: string) {
  try {
    generateKeyBetween(rank, null);
    return true;
  } catch {
    return false;
  }
}

function isProjectName(name: string) {
  return (
    name.trim().length > 0 &&
    new TextEncoder().encode(name).length <= LIMITS.nameBytes
  );
}

const IdSchema = z.string().regex(UUID, "Expected a canonical UUID.");
const PositionSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});
const PlacementSchema = z.strictObject({
  parent: IdSchema.nullable(),
  rank: z
    .string()
    .max(LIMITS.rank)
    .regex(/^[A-Za-z][0-9A-Za-z]+$/)
    .refine(isRankEncoding, "Invalid rank."),
});
const NodeSchema = z.strictObject({
  text: z.string().max(LIMITS.text),
  placement: PlacementSchema,
  position: PositionSchema.optional(),
  color: z.custom<NodeColor>(isNodeColor, "Invalid color."),
  deleted: z.boolean(),
});
export const SavingPreferencesSchema = z.strictObject({
  local: z.boolean(),
  cloud: z.boolean(),
});
export type SavingPreferences = z.infer<typeof SavingPreferencesSchema>;
export const DEFAULT_SAVING_PREFERENCES: SavingPreferences = {
  local: true,
  cloud: true,
};

export function savingPreferences(doc: Y.Doc): SavingPreferences {
  const metadata = doc.getMap(ROOT).get("metadata");
  const value = metadata instanceof Y.Map ? metadata.get("saving") : undefined;
  return (
    SavingPreferencesSchema.safeParse(value).data ?? {
      ...DEFAULT_SAVING_PREFERENCES,
    }
  );
}

// Privacy choices are deliberately excluded from edit undo/redo.
export function setSavingPreferences(doc: Y.Doc, value: SavingPreferences) {
  const preferences = SavingPreferencesSchema.parse(value);
  const metadata = doc.getMap(ROOT).get("metadata");
  if (!(metadata instanceof Y.Map)) invalid("The project has no metadata.");
  doc.transact(() => metadata.set("saving", preferences), "saving-preferences");
}

const ContentSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  metadata: z.strictObject({
    name: z.string().refine(isProjectName, "Invalid project name."),
    saving: SavingPreferencesSchema.optional(),
  }),
  nodes: z
    .record(IdSchema, NodeSchema)
    .refine(
      (nodes) => Object.keys(nodes).length <= LIMITS.nodes,
      "Too many nodes.",
    ),
});

export type Placement = z.infer<typeof PlacementSchema>;
export type NodeContent = z.infer<typeof NodeSchema>;
// Canonical materialized content: the file and backend parity shape.
export type ProjectContent = z.infer<typeof ContentSchema>;

export interface ForestNode {
  id: string;
  text: string;
  color: NodeColor;
  position?: NodePosition;
  children: ForestNode[];
}

export type ProjectState =
  | { status: "ready"; content: ProjectContent }
  | { status: "loading" }
  | { status: "unsupported"; schemaVersion: unknown }
  | { status: "invalid"; message: string };

export class ProjectDocumentError extends Error {
  readonly reason: Exclude<ProjectState["status"], "ready">;

  constructor(reason: ProjectDocumentError["reason"], message: string) {
    super(message);
    this.name = "ProjectDocumentError";
    this.reason = reason;
  }
}

function invalid(message: string): never {
  throw new ProjectDocumentError("invalid", message);
}

export const isNodeId = (id: string) => UUID.test(id);

function assertId(id: string) {
  if (!isNodeId(id)) invalid("Expected a canonical UUID.");
}

export type DropTarget =
  | { id: string; placement: "child" | "before" | "after" }
  | { placement: "root" };

export interface NewNode {
  id?: string;
  text?: string;
  color?: NodeColor;
  position?: NodePosition;
}

// Explicit creation is the only operation that installs the schema.
export function createProjectDocument(
  projectId: string,
  name: string,
  root?: NewNode,
): Y.Doc {
  assertId(projectId);
  const rootId = root && (root.id ?? crypto.randomUUID());
  const content = parseContent({
    schemaVersion: SCHEMA_VERSION,
    metadata: { name },
    nodes: rootId
      ? {
          [rootId]: nodeContent(root, {
            parent: null,
            rank: generateKeyBetween(null, null),
          }),
        }
      : {},
  });
  return installContent(projectId, content, ORIGIN.create);
}

// Installs validated semantic content into a fresh Yjs lineage.
export function importProjectDocument(
  projectId: string,
  content: ProjectContent,
): Y.Doc {
  assertId(projectId);
  return installContent(projectId, parseContent(content), ORIGIN.import);
}

function installContent(
  projectId: string,
  content: ProjectContent,
  origin: symbol,
) {
  const doc = new Y.Doc({ guid: projectId });
  doc.transact(() => {
    const project = doc.getMap(ROOT);
    project.set("schemaVersion", SCHEMA_VERSION);
    const metadata = new Y.Map<unknown>();
    metadata.set("name", content.metadata.name);
    if (content.metadata.saving)
      metadata.set("saving", { ...content.metadata.saving });
    project.set("metadata", metadata);
    const nodes = new Y.Map<Y.Map<unknown>>();
    for (const [id, node] of Object.entries(content.nodes))
      nodes.set(id, sharedNode(node));
    project.set("nodes", nodes);
  }, origin);
  return doc;
}

// Opening binds the document without writing defaults, even when it is empty.
export function openProjectDocument(
  projectId: string,
  updates: Iterable<Uint8Array> = [],
  origin: unknown = ORIGIN.persistence,
): Y.Doc {
  assertId(projectId);
  const doc = new Y.Doc({ guid: projectId });
  for (const update of updates) Y.applyUpdate(doc, update, origin);
  return doc;
}

function parseContent(value: unknown): ProjectContent {
  const result = ContentSchema.safeParse(value);
  if (!result.success) invalid(result.error.issues[0]?.message ?? "Invalid.");
  return result.data;
}

function nodeContent(init: NewNode, placement: Placement): NodeContent {
  return {
    text: init.text ?? "",
    placement,
    ...(init.position && {
      position: { x: init.position.x, y: init.position.y },
    }),
    color: init.color ?? DEFAULT_NODE_COLOR,
    deleted: false,
  };
}

// Placement and position are assigned as fresh whole values, never mutated.
function sharedNode(node: NodeContent) {
  const map = new Y.Map<unknown>();
  map.set("text", new Y.Text(node.text));
  map.set("placement", { ...node.placement });
  if (node.position) map.set("position", { ...node.position });
  map.set("color", node.color);
  map.set("deleted", node.deleted);
  return map;
}

export function checkSharedTypes(doc: Y.Doc) {
  if (doc.share.size !== 1) invalid("Unexpected document roots.");
  const project = doc.getMap(ROOT);
  if (
    project.size !== 3 ||
    [...project.keys()].some(
      (key) => !["schemaVersion", "metadata", "nodes"].includes(key),
    )
  )
    invalid("Unexpected project fields.");
  const metadata = project.get("metadata");
  if (!(metadata instanceof Y.Map)) invalid("Metadata must be a shared map.");
  if ([...metadata.keys()].some((key) => !["name", "saving"].includes(key)))
    invalid("Unexpected metadata fields.");
  if (metadata.get("saving") instanceof Y.AbstractType)
    invalid("Saving preferences must be atomic.");
  if (typeof metadata.get("name") !== "string")
    invalid("Name must be an atomic string.");
  const nodes = project.get("nodes");
  if (!(nodes instanceof Y.Map)) invalid("Nodes must be a shared map.");
  for (const node of nodes.values()) {
    if (!(node instanceof Y.Map) || !(node.get("text") instanceof Y.Text))
      invalid("Nodes require shared maps and text.");
    if (
      [...node.keys()].some(
        (key) =>
          !["text", "placement", "position", "color", "deleted"].includes(key),
      )
    )
      invalid("Unexpected node fields.");
    if (typeof node.get("color") !== "string")
      invalid("Color must be an atomic string.");
    const text = node.get("text") as Y.Text;
    const plain = text
      .toDelta()
      .every(
        (part: { insert?: unknown; attributes?: unknown }) =>
          typeof part.insert === "string" && !part.attributes,
      );
    if (!plain) invalid("Node text must be plain text.");
    if (
      node.get("placement") instanceof Y.AbstractType ||
      node.get("position") instanceof Y.AbstractType
    )
      invalid("Placement and position must be atomic values.");
  }
}

// Never throws or writes; an empty document is still hydrating, not new. A
// document awaiting causal dependencies can be transiently incomplete (Yjs
// applies an update's deletions before its pending insertions), so it is
// loading rather than invalid until those updates arrive.
export function readProject(doc: Y.Doc): ProjectState {
  const project = doc.getMap(ROOT);
  if (project.size === 0) return { status: "loading" };
  const schemaVersion = project.get("schemaVersion");
  if (schemaVersion !== SCHEMA_VERSION)
    return { status: "unsupported", schemaVersion };
  try {
    checkSharedTypes(doc);
    return { status: "ready", content: parseContent(project.toJSON()) };
  } catch (error) {
    if (doc.store.pendingStructs || doc.store.pendingDs)
      return { status: "loading" };
    return {
      status: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// A cheap read for catalog indexes; it does not validate the document.
export function projectName(doc: Y.Doc): string | undefined {
  const metadata = doc.getMap(ROOT).get("metadata");
  const name = metadata instanceof Y.Map ? metadata.get("name") : undefined;
  return typeof name === "string" ? name : undefined;
}

export function materializeProject(doc: Y.Doc): ProjectContent {
  const state = readProject(doc);
  if (state.status === "ready") return state.content;
  throw new ProjectDocumentError(
    state.status,
    state.status === "invalid"
      ? state.message
      : state.status === "loading"
        ? "The project document has not loaded."
        : "Unsupported project schema version.",
  );
}

// For binding editors to collaborative text; undefined for missing nodes.
export function nodeText(doc: Y.Doc, id: string): Y.Text | undefined {
  const node = sharedNodes(doc).get(id)?.get("text");
  return node instanceof Y.Text ? node : undefined;
}

function sharedNodes(doc: Y.Doc) {
  const nodes = doc.getMap(ROOT).get("nodes");
  if (!(nodes instanceof Y.Map)) invalid("The project has no node map.");
  return nodes as Y.Map<Y.Map<unknown>>;
}

// Deleted or absent parents promote children to roots; each cycle detaches its
// smallest UUID. The result assigns every live node at most one parent.
export function effectiveParents(
  content: ProjectContent,
): Map<string, string | null> {
  const live = Object.keys(content.nodes)
    .filter((id) => !content.nodes[id].deleted)
    .sort(compare);
  const alive = new Set(live);
  const parents = new Map(
    live.map((id) => {
      const parent = content.nodes[id].placement.parent;
      return [id, parent !== null && alive.has(parent) ? parent : null];
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

function siblingGroups(
  content: ProjectContent,
  parents: ReadonlyMap<string, string | null>,
) {
  const groups = new Map<string | null, string[]>();
  for (const [id, parent] of parents) {
    const group = groups.get(parent);
    if (group) group.push(id);
    else groups.set(parent, [id]);
  }
  const order = (a: string, b: string) =>
    compare(content.nodes[a].placement.rank, content.nodes[b].placement.rank) ||
    compare(a, b);
  for (const group of groups.values()) group.sort(order);
  return groups;
}

export interface EffectivePlacement {
  parent: string | null;
  siblingOrder: number;
}

// Flat projection stays bounded for the maximum-depth document and is the
// shared source of ordering for backend read models and browser trees.
export function effectivePlacements(
  content: ProjectContent,
): Record<string, EffectivePlacement> {
  const groups = siblingGroups(content, effectiveParents(content));
  const result: Record<string, EffectivePlacement> = {};
  for (const [parent, ids] of groups)
    ids.forEach((id, siblingOrder) => {
      result[id] = { parent, siblingOrder };
    });
  return result;
}

// Pure projections; they never write repairs and never alias input objects.
export function projectForest(content: ProjectContent): ForestNode[] {
  const parents = effectiveParents(content);
  const entries = new Map<string, ForestNode>();
  for (const id of parents.keys()) {
    const { text, color, position } = content.nodes[id];
    entries.set(id, {
      id,
      text,
      color,
      ...(position && { position: { ...position } }),
      children: [],
    });
  }
  const groups = siblingGroups(content, parents);
  for (const [parent, ids] of groups)
    if (parent !== null)
      entries
        .get(parent)
        ?.children.push(...ids.map((id) => entries.get(id) as ForestNode));
  return (groups.get(null) ?? []).map((id) => entries.get(id) as ForestNode);
}

export function projectMindMap(content: ProjectContent): MindMapNode[] {
  const parents = effectiveParents(content);
  const entries = new Map<string, MindMapNode>();
  for (const id of parents.keys()) {
    const { text, color, position } = content.nodes[id];
    entries.set(id, {
      id,
      text,
      color,
      ...(position && { position: { ...position } }),
    });
  }
  const groups = siblingGroups(content, parents);
  const nodes = (ids: string[]) =>
    ids.map((id) => entries.get(id) as MindMapNode);
  for (const [parent, ids] of groups) {
    const node = parent !== null && entries.get(parent);
    if (node) node.next = nodes(ids);
  }
  return nodes(groups.get(null) ?? []);
}

interface View {
  content: ProjectContent;
  parents: Map<string, string | null>;
  children: Map<string | null, string[]>;
}

function observe(doc: Y.Doc): View {
  const content = materializeProject(doc);
  const parents = effectiveParents(content);
  return { content, parents, children: siblingGroups(content, parents) };
}

function subtree(view: View, id: string) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++)
    ids.push(...(view.children.get(ids[i]) ?? []));
  return ids;
}

function siblingsOf(view: View, id: string) {
  const parent = view.parents.get(id) ?? null;
  return { parent, siblings: view.children.get(parent) ?? [] };
}

// Placements for inserting `id` at `index` among the visible children of
// `parent` (excluding itself), storing `storedParent` for the node. Equal
// neighbors or an exhausted rank re-space the whole sibling list within the same
// command; other siblings keep their stored parents.
function placementsAt(
  view: View,
  id: string,
  parent: string | null,
  index: number,
  storedParent = parent,
): [string, Placement][] {
  const siblings = (view.children.get(parent) ?? []).filter(
    (key) => key !== id,
  );
  const rankOf = (key: string) => view.content.nodes[key].placement.rank;
  const left = index > 0 ? rankOf(siblings[index - 1]) : null;
  const right = index < siblings.length ? rankOf(siblings[index]) : null;
  if (left === null || left !== right) {
    const rank = generateKeyBetween(left, right);
    if (rank.length <= LIMITS.rank)
      return [[id, { parent: storedParent, rank }]];
  }
  siblings.splice(index, 0, id);
  const ranks = generateNKeysBetween(null, null, siblings.length);
  return siblings.flatMap((key, i): [string, Placement][] => {
    const stored = view.content.nodes[key]?.placement;
    const next = {
      parent: key === id || !stored ? storedParent : stored.parent,
      rank: ranks[i],
    };
    return stored?.parent === next.parent && stored.rank === next.rank
      ? []
      : [[key, next]];
  });
}

function writePlacements(doc: Y.Doc, placements: [string, Placement][]) {
  const nodes = sharedNodes(doc);
  for (const [key, placement] of placements)
    nodes.get(key)?.set("placement", { ...placement });
}

function insertNode(
  doc: Y.Doc,
  view: View,
  parent: string | null,
  index: number,
  init: NewNode,
) {
  const id = init.id ?? crypto.randomUUID();
  assertId(id);
  if (id in view.content.nodes) invalid("Node IDs cannot be reused.");
  if (Object.keys(view.content.nodes).length >= LIMITS.nodes)
    invalid("Too many nodes.");
  const placements = placementsAt(view, id, parent, index);
  const [, placement] = placements.find(([key]) => key === id) ?? [];
  const node = nodeContent(init, placement as Placement);
  const result = NodeSchema.safeParse(node);
  if (!result.success) invalid(result.error.issues[0]?.message ?? "Invalid.");
  doc.transact(() => {
    sharedNodes(doc).set(id, sharedNode(node));
    writePlacements(
      doc,
      placements.filter(([key]) => key !== id),
    );
  }, ORIGIN.local);
  return id;
}

export function createRoot(doc: Y.Doc, init: NewNode = {}): string {
  const view = observe(doc);
  return insertNode(
    doc,
    view,
    null,
    view.children.get(null)?.length ?? 0,
    init,
  );
}

// Appends as the last child. Undefined when the parent is missing or deleted.
export function createChild(
  doc: Y.Doc,
  parentId: string,
  init: NewNode = {},
): string | undefined {
  const view = observe(doc);
  if (!view.parents.has(parentId)) return;
  const index = view.children.get(parentId)?.length ?? 0;
  return insertNode(doc, view, parentId, index, init);
}

// Inserts immediately after the sibling, under the same visible parent.
export function createSibling(
  doc: Y.Doc,
  siblingId: string,
  init: NewNode = {},
): string | undefined {
  const view = observe(doc);
  if (!view.parents.has(siblingId)) return;
  const { parent, siblings } = siblingsOf(view, siblingId);
  return insertNode(doc, view, parent, siblings.indexOf(siblingId) + 1, init);
}

export function renameProject(doc: Y.Doc, name: string): boolean {
  if (!isProjectName(name)) invalid("Invalid project name.");
  if (observe(doc).content.metadata.name === name) return false;
  doc.transact(() => {
    (doc.getMap(ROOT).get("metadata") as Y.Map<unknown>).set("name", name);
  }, ORIGIN.local);
  return true;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const splitsPair = (text: string, index: number) =>
  isHighSurrogate(text.charCodeAt(index - 1)) &&
  isLowSurrogate(text.charCodeAt(index));

// Reads only the edited node, so typing never materializes the whole project.
// Visible nodes are exactly the nondeleted ones; deletion covers whole subtrees.
function liveText(doc: Y.Doc, id: string): Y.Text | undefined {
  const project = doc.getMap(ROOT);
  if (project.get("schemaVersion") !== SCHEMA_VERSION) return;
  const nodes = project.get("nodes");
  const node = nodes instanceof Y.Map ? nodes.get(id) : undefined;
  if (!(node instanceof Y.Map) || node.get("deleted") !== false) return;
  const text = node.get("text");
  return text instanceof Y.Text ? text : undefined;
}

export interface TextChange {
  index: number;
  deleteCount: number;
  insert: string;
}

// The smallest single replacement turning `previous` into `next`. With a
// `cursor` (the caret after an input event), the changed range ends at or after
// it, so repeated characters resolve to where the user typed. Never splits a
// surrogate pair.
export function diffText(
  previous: string,
  next: string,
  cursor?: number,
): TextChange {
  const shortest = Math.min(previous.length, next.length);
  let prefix = 0;
  let suffix = 0;
  const matchPrefix = (limit: number) => {
    while (prefix < limit && previous[prefix] === next[prefix]) prefix++;
  };
  const matchSuffix = (limit: number) => {
    while (
      suffix < limit &&
      previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
    )
      suffix++;
  };
  if (cursor === undefined) {
    matchPrefix(shortest);
    matchSuffix(shortest - prefix);
  } else {
    matchSuffix(Math.min(shortest, Math.max(0, next.length - cursor)));
    matchPrefix(shortest - suffix);
  }
  if (prefix && isHighSurrogate(previous.charCodeAt(prefix - 1))) prefix--;
  if (suffix && isLowSurrogate(previous.charCodeAt(previous.length - suffix)))
    suffix--;
  return {
    index: prefix,
    deleteCount: previous.length - prefix - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

// Offsets are UTF-16 code units in browser inputs and backend Y.Text edits.
export function editNodeText(
  doc: Y.Doc,
  id: string,
  index: number,
  deleteCount: number,
  insert: string,
): boolean {
  const text = liveText(doc, id);
  if (!text) return false;
  const current = text.toString();
  const end = index + deleteCount;
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(deleteCount) ||
    index < 0 ||
    deleteCount < 0 ||
    end > current.length
  )
    invalid("Invalid text range.");
  if (splitsPair(current, index) || splitsPair(current, end))
    invalid("Text edits cannot split a surrogate pair.");
  if (current.length - deleteCount + insert.length > LIMITS.text)
    invalid("Node text is too long.");
  if (current.slice(index, end) === insert) return false;
  doc.transact(() => {
    if (deleteCount) text.delete(index, deleteCount);
    if (insert) text.insert(index, insert);
  }, ORIGIN.local);
  return true;
}

// Applies the smallest single replacement, so concurrent edits elsewhere in the
// same text are preserved.
export function replaceNodeText(
  doc: Y.Doc,
  id: string,
  next: string,
  cursor?: number,
) {
  const current = liveText(doc, id)?.toString();
  if (current === undefined || current === next) return false;
  const { index, deleteCount, insert } = diffText(current, next, cursor);
  return editNodeText(doc, id, index, deleteCount, insert);
}

export function setNodeColor(
  doc: Y.Doc,
  id: string,
  color: NodeColor,
  includeDescendants = false,
): boolean {
  if (!isNodeColor(color)) invalid("Invalid color.");
  const view = observe(doc);
  if (!view.parents.has(id)) return false;
  const ids = (includeDescendants ? subtree(view, id) : [id]).filter(
    (key) => view.content.nodes[key].color !== color,
  );
  if (!ids.length) return false;
  doc.transact(() => {
    const nodes = sharedNodes(doc);
    for (const key of ids) nodes.get(key)?.set("color", color);
  }, ORIGIN.local);
  return true;
}

// Marks the observed visible subtree deleted. Maps and text remain as tombstones;
// a concurrently created, unseen child is promoted to a root by projection.
export function deleteSubtree(doc: Y.Doc, id: string): boolean {
  const view = observe(doc);
  if (!view.parents.has(id)) return false;
  doc.transact(() => {
    const nodes = sharedNodes(doc);
    for (const key of subtree(view, id)) nodes.get(key)?.set("deleted", true);
  }, ORIGIN.local);
  return true;
}

// `positions` are the node positions at drag start, so every descendant moves
// by the same delta and the whole gesture commits as one transaction.
export function translateSubtree(
  doc: Y.Doc,
  id: string,
  positions: ReadonlyMap<string, NodePosition>,
  delta: NodePosition,
): boolean {
  const view = observe(doc);
  if (!view.parents.has(id)) return false;
  const changes: [string, NodePosition][] = [];
  for (const key of subtree(view, id)) {
    const start = positions.get(key);
    if (!start) continue;
    const next = { x: start.x + delta.x, y: start.y + delta.y };
    if (!PositionSchema.safeParse(next).success) invalid("Invalid position.");
    const current = view.content.nodes[key].position;
    if (current?.x !== next.x || current.y !== next.y)
      changes.push([key, next]);
  }
  if (!changes.length) return false;
  doc.transact(() => {
    const nodes = sharedNodes(doc);
    for (const [key, position] of changes)
      nodes.get(key)?.set("position", position);
  }, ORIGIN.local);
  return true;
}

// Moves one position among visible siblings; false at either end.
export function reorderNode(
  doc: Y.Doc,
  id: string,
  direction: -1 | 1,
): boolean {
  const view = observe(doc);
  if (!view.parents.has(id)) return false;
  const { parent, siblings } = siblingsOf(view, id);
  const index = siblings.indexOf(id) + direction;
  if (index < 0 || index >= siblings.length) return false;
  const stored = view.content.nodes[id].placement.parent;
  doc.transact(
    () => writePlacements(doc, placementsAt(view, id, parent, index, stored)),
    ORIGIN.local,
  );
  return true;
}

function isWithin(view: View, id: string, ancestor: string) {
  for (let cursor: string | null = id; cursor !== null; ) {
    if (cursor === ancestor) return true;
    cursor = view.parents.get(cursor) ?? null;
  }
  return false;
}

export function canMoveNode(doc: Y.Doc, id: string, target: DropTarget) {
  return moveDestination(observe(doc), id, target) !== undefined;
}

function moveDestination(view: View, id: string, target: DropTarget) {
  if (!view.parents.has(id)) return;
  if (target.placement === "root")
    return { parent: null, index: lastIndex(view, id, null) };
  if (!view.parents.has(target.id) || isWithin(view, target.id, id)) return;
  if (target.placement === "child")
    return { parent: target.id, index: lastIndex(view, id, target.id) };
  const { parent, siblings } = siblingsOf(view, target.id);
  const index = siblings.filter((key) => key !== id).indexOf(target.id);
  return { parent, index: target.placement === "before" ? index : index + 1 };
}

function lastIndex(view: View, id: string, parent: string | null) {
  return (view.children.get(parent) ?? []).filter((key) => key !== id).length;
}

// Reparents or reorders a subtree. Dropping on itself, a descendant, or a stale
// target is a lossless no-op, as is a drop that leaves the node where it is.
export function moveNode(doc: Y.Doc, id: string, target: DropTarget): boolean {
  const view = observe(doc);
  const destination = moveDestination(view, id, target);
  if (!destination) return false;
  const { parent, index } = destination;
  const current = siblingsOf(view, id);
  if (current.parent === parent && current.siblings.indexOf(id) === index)
    return false;
  doc.transact(
    () => writePlacements(doc, placementsAt(view, id, parent, index)),
    ORIGIN.local,
  );
  return true;
}
