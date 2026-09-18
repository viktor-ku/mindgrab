export interface MindMapNode {
  id: string;
  text: string;
  position?: NodePosition;
  next?: MindMapNode[];
}

export interface NodePosition {
  x: number;
  y: number;
}

// Used only until ResizeObserver supplies the node's content-sized width.
const DEFAULT_NODE_WIDTH = 128;
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

export interface LayoutAnchor {
  id: string;
  centerY: number;
}

export function layoutMindMap(
  roots: MindMapNode[],
  sizes: ReadonlyMap<string, NodeSize> = new Map(),
  anchor?: LayoutAnchor,
) {
  const nodes: PositionedNode[] = [];
  const connections: Connection[] = [];
  const subtreeHeights = new Map<string, number>();

  function sizeOf(node: MindMapNode): NodeSize {
    return sizes.get(node.id) ?? { width: DEFAULT_NODE_WIDTH, height: NODE_MIN_HEIGHT };
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
    // Anchor before placing children so they spread around the parent. A manual
    // position takes precedence, allowing the anchored node to be dragged freely.
    const y = node.id === anchor?.id
      ? anchor.centerY - size.height / 2
      : top + (subtreeHeight - size.height) / 2;
    const positioned = { id: node.id, text: node.text, x, y, ...node.position, ...size };
    nodes.push(positioned);

    const children = node.next ?? [];
    const childrenHeight = children.reduce((sum, child) => sum + subtreeHeights.get(child.id)!, 0)
      + Math.max(0, children.length - 1) * ROW_GAP;
    let childTop = positioned.y + (size.height - childrenHeight) / 2;
    for (const child of children) {
      const childPosition = visit(child, positioned.x + size.width + COLUMN_GAP, childTop);
      connections.push({ from: positioned, to: childPosition });
      childTop += subtreeHeights.get(child.id)! + ROW_GAP;
    }

    return positioned;
  }

  for (const root of roots) measureSubtree(root);
  let rootTop = roots.length ? (NODE_MIN_HEIGHT - subtreeHeights.get(roots[0].id)!) / 2 : 0;
  for (const root of roots) {
    visit(root, 0, rootTop);
    rootTop += subtreeHeights.get(root.id)! + ROW_GAP;
  }

  return { nodes, connections };
}

// Use the positions at drag start so every descendant moves by the same delta,
// including descendants that have already been placed manually.
export function translateSubtree(
  nodes: MindMapNode[],
  id: string,
  positions: ReadonlyMap<string, NodePosition>,
  delta: NodePosition,
): MindMapNode[] {
  function translate(node: MindMapNode): MindMapNode {
    const position = positions.get(node.id);
    return {
      ...node,
      ...(position && { position: { x: position.x + delta.x, y: position.y + delta.y } }),
      ...(node.next && { next: node.next.map(translate) }),
    };
  }
  return updateNode(nodes, id, translate);
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
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  // Attach to the facing borders, even when a child is above or left of its parent.
  const fromScale = Math.max(Math.abs(dx) / (from.width / 2), Math.abs(dy) / (from.height / 2)) || 1;
  const toScale = Math.max(Math.abs(dx) / (to.width / 2), Math.abs(dy) / (to.height / 2)) || 1;
  const startX = from.x + from.width / 2 + dx / fromScale;
  const startY = from.y + from.height / 2 + dy / fromScale;
  const endX = to.x + to.width / 2 - dx / toScale;
  const endY = to.y + to.height / 2 - dy / toScale;
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(32, Math.hypot(endX - startX, endY - startY) * 0.15);
  const controlX = (startX + endX) / 2 - dy / length * bend;
  const controlY = (startY + endY) / 2 + dx / length * bend;
  return `M ${startX} ${startY} Q ${controlX} ${controlY}, ${endX} ${endY}`;
}
