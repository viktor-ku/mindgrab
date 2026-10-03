export * from "@mindgrab/document/mind-map";

import type { MindMapNode } from "@mindgrab/document/mind-map";

// Folding is a local view of the tree; the document retains every descendant.
export function visibleMindMap(
  nodes: MindMapNode[],
  collapsed: ReadonlySet<string>,
): MindMapNode[] {
  return nodes.map((node) => ({
    ...node,
    next: collapsed.has(node.id)
      ? []
      : visibleMindMap(node.next ?? [], collapsed),
  }));
}

export function nodeDetails(nodes: MindMapNode[]) {
  const details = new Map<string, { parent?: string; descendants: number }>();
  function visit(node: MindMapNode, parent?: string): number {
    const descendants = (node.next ?? []).reduce(
      (count, child) => count + 1 + visit(child, node.id),
      0,
    );
    details.set(node.id, { parent, descendants });
    return descendants;
  }
  for (const node of nodes) visit(node);
  return details;
}
