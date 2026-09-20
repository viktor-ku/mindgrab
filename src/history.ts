import type { LayoutAnchor, MindMapNode, NodeSize } from "./mind-map";

export interface MapSnapshot {
  nodes: MindMapNode[];
  selectedId?: string;
  anchor?: LayoutAnchor;
  sizes: ReadonlyMap<string, NodeSize>;
}

// Nodes and sizes are updated immutably, so snapshots can share their data.
export function createHistory() {
  const past: MapSnapshot[] = [];
  return {
    record(before: MapSnapshot, after: MindMapNode[]) {
      if (JSON.stringify(before.nodes) === JSON.stringify(after)) return;
      past.push(before);
      if (past.length > 100) past.shift();
    },
    undo: () => past.pop(),
  };
}
