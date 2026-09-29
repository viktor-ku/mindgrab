import { generateNKeysBetween } from "fractional-indexing";
import type * as Y from "yjs";
import type { LayoutAnchor, MindMapNode } from "./mind-map";
import {
  DEFAULT_NODE_COLOR,
  importProjectDocument,
  isNodeId,
  materializeProject,
  projectMindMap,
  SCHEMA_VERSION,
} from "./project-document";
import type { NodeContent } from "./project-document";
import type { Project } from "./projects";

// Browser storage and project files still hold nested snapshots. Each opened
// snapshot becomes a fresh document; IDs that are not canonical UUIDs are
// replaced, and the layout anchor follows its node.
export function openSnapshot(project: Project): {
  doc: Y.Doc;
  anchor?: LayoutAnchor;
} {
  const ids = new Map<string, string>();
  const nodes: Record<string, NodeContent> = {};
  function add(branch: MindMapNode[], parent: string | null) {
    const ranks = generateNKeysBetween(null, null, branch.length);
    branch.forEach((node, index) => {
      const id = isNodeId(node.id) ? node.id : crypto.randomUUID();
      ids.set(node.id, id);
      nodes[id] = {
        text: node.text,
        placement: { parent, rank: ranks[index] },
        ...(node.position && {
          position: { x: node.position.x, y: node.position.y },
        }),
        color: node.color ?? DEFAULT_NODE_COLOR,
        deleted: false,
      };
      add(node.next ?? [], id);
    });
  }
  add(project.nodes, null);
  const doc = importProjectDocument(crypto.randomUUID(), {
    schemaVersion: SCHEMA_VERSION,
    metadata: { name: project.name },
    nodes,
  });
  const { anchor } = project;
  const anchorId = anchor && ids.get(anchor.id);
  return {
    doc,
    anchor: anchor && anchorId ? { ...anchor, id: anchorId } : undefined,
  };
}

export function snapshotProject(
  doc: Y.Doc,
  anchor: LayoutAnchor | undefined,
  view: Project["view"],
): Project {
  const content = materializeProject(doc);
  return {
    version: 1,
    name: content.metadata.name,
    nodes: projectMindMap(content),
    anchor,
    view,
  };
}

// The form a snapshot takes after a document round trip, for comparisons.
export function normalizeSnapshot(project: Project): Project {
  const { doc, anchor } = openSnapshot(project);
  try {
    return snapshotProject(doc, anchor, project.view);
  } finally {
    doc.destroy();
  }
}
