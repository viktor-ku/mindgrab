export interface MindMapNode {
  id: string;
  text: string;
  next?: MindMapNode[];
}

export const NODE_MIN_WIDTH = 128;
export const NODE_MIN_HEIGHT = 40;
const COLUMN_GAP = 64;
const ROW_GAP = 24;

export interface NodeSize {
  width: number;
  height: number;
}

interface PositionedNode extends NodeSize {
  id: string;
  text: string;
  x: number;
  y: number;
}

interface Connection {
  from: PositionedNode;
  to: PositionedNode;
}

export function layoutMindMap(roots: MindMapNode[], sizes: ReadonlyMap<string, NodeSize> = new Map()) {
  const nodes: PositionedNode[] = [];
  const connections: Connection[] = [];
  const subtreeHeights = new Map<string, number>();

  function sizeOf(node: MindMapNode): NodeSize {
    return sizes.get(node.id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
  }

  function measureSubtree(node: MindMapNode): number {
    const children = node.next ?? [];
    const childrenHeight = children.reduce((sum, child) => sum + measureSubtree(child), 0)
      + Math.max(0, children.length - 1) * ROW_GAP;
    const height = Math.max(sizeOf(node).height, childrenHeight);
    subtreeHeights.set(node.id, height);
    return height;
  }

  function visit(node: MindMapNode, x: number, top: number): PositionedNode {
    const size = sizeOf(node);
    const subtreeHeight = subtreeHeights.get(node.id)!;
    const positioned = { id: node.id, text: node.text, x, y: top + (subtreeHeight - size.height) / 2, ...size };
    nodes.push(positioned);

    const children = node.next ?? [];
    const childrenHeight = children.reduce((sum, child) => sum + subtreeHeights.get(child.id)!, 0)
      + Math.max(0, children.length - 1) * ROW_GAP;
    let childTop = top + (subtreeHeight - childrenHeight) / 2;
    for (const child of children) {
      const childPosition = visit(child, x + size.width + COLUMN_GAP, childTop);
      connections.push({ from: positioned, to: childPosition });
      childTop += subtreeHeights.get(child.id)! + ROW_GAP;
    }

    return positioned;
  }

  for (const root of roots) measureSubtree(root);
  let rootTop = 0;
  for (const root of roots) {
    visit(root, 0, rootTop);
    rootTop += subtreeHeights.get(root.id)! + ROW_GAP;
  }

  return { nodes, connections };
}

export function updateNode(
  nodes: MindMapNode[],
  id: string,
  update: (node: MindMapNode) => MindMapNode,
): MindMapNode[] {
  return nodes.map((node) =>
    node.id === id
      ? update(node)
      : node.next
        ? { ...node, next: updateNode(node.next, id, update) }
        : node,
  );
}

export function deleteNode(nodes: MindMapNode[], id: string): MindMapNode[] {
  return nodes.filter((node) => node.id !== id).map((node) =>
    node.next ? { ...node, next: deleteNode(node.next, id) } : node,
  );
}

export function findNode(nodes: MindMapNode[], id: string): MindMapNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.next ?? [], id);
    if (child) return child;
  }
}

export function insertSibling(nodes: MindMapNode[], id: string, sibling: MindMapNode): MindMapNode[] {
  return nodes.flatMap((node) => node.id === id
    ? [node, sibling]
    : [node.next ? { ...node, next: insertSibling(node.next, id, sibling) } : node]);
}

export function reorderNode(nodes: MindMapNode[], id: string, direction: -1 | 1): MindMapNode[] {
  const index = nodes.findIndex((node) => node.id === id);
  if (index !== -1) {
    const target = index + direction;
    if (target < 0 || target >= nodes.length) return nodes;
    const reordered = [...nodes];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    return reordered;
  }
  return nodes.map((node) => node.next
    ? { ...node, next: reorderNode(node.next, id, direction) } : node);
}

export type DropTarget = { id: string; placement: "child" | "before" | "after" } | { placement: "root" };

export function canMoveNode(nodes: MindMapNode[], id: string, target: DropTarget): boolean {
  const source = findNode(nodes, id);
  if (!source) return false;
  return target.placement === "root"
    || (!!findNode(nodes, target.id) && !findNode([source], target.id));
}

// Validate before removal: dropping on oneself or a descendant must never lose a subtree.
export function moveNode(nodes: MindMapNode[], id: string, target: DropTarget): MindMapNode[] {
  if (!canMoveNode(nodes, id, target)) return nodes;
  const source = findNode(nodes, id)!;
  const remaining = deleteNode(nodes, id);
  if (target.placement === "root") return [...remaining, source];
  if (target.placement === "child") {
    return updateNode(remaining, target.id, (node) => ({ ...node, next: [...(node.next ?? []), source] }));
  }
  const targetId = target.id;
  function insert(branch: MindMapNode[]): MindMapNode[] {
    return branch.flatMap((node) => node.id === targetId
      ? target.placement === "before" ? [source, node] : [node, source]
      : [node.next ? { ...node, next: insert(node.next) } : node]);
  }
  return insert(remaining);
}

export function connectionPath({ from, to }: Connection) {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const middleX = (startX + endX) / 2;
  return `M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX} ${endY}`;
}
