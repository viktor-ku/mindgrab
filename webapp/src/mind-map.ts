import type { NodeColor } from "./node-colors";

export interface MindMapNode {
  id: string;
  text: string;
  color?: NodeColor;
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
  color?: NodeColor;
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
    return (
      sizes.get(node.id) ?? {
        width: DEFAULT_NODE_WIDTH,
        height: NODE_MIN_HEIGHT,
      }
    );
  }

  function measureSubtree(node: MindMapNode): number {
    const children = node.next ?? [];
    const childrenHeight =
      children.reduce((sum, child) => sum + measureSubtree(child), 0) +
      Math.max(0, children.length - 1) * ROW_GAP;
    const height = Math.max(sizeOf(node).height, childrenHeight);
    subtreeHeights.set(node.id, height);
    return height;
  }

  function visit(node: MindMapNode, x: number, top: number): PositionedNode {
    const size = sizeOf(node);
    const subtreeHeight = subtreeHeights.get(node.id)!;
    // Anchor before placing children so they spread around the parent. A manual
    // position takes precedence, allowing the anchored node to be dragged freely.
    const y =
      node.id === anchor?.id
        ? anchor.centerY - size.height / 2
        : top + (subtreeHeight - size.height) / 2;
    const positioned = {
      id: node.id,
      text: node.text,
      color: node.color,
      x,
      y,
      ...node.position,
      ...size,
    };
    nodes.push(positioned);

    const children = node.next ?? [];
    const childrenHeight =
      children.reduce((sum, child) => sum + subtreeHeights.get(child.id)!, 0) +
      Math.max(0, children.length - 1) * ROW_GAP;
    let childTop = positioned.y + (size.height - childrenHeight) / 2;
    for (const child of children) {
      const childPosition = visit(
        child,
        positioned.x + size.width + COLUMN_GAP,
        childTop,
      );
      connections.push({ from: positioned, to: childPosition });
      childTop += subtreeHeights.get(child.id)! + ROW_GAP;
    }

    return positioned;
  }

  for (const root of roots) measureSubtree(root);
  let rootTop = roots.length
    ? (NODE_MIN_HEIGHT - subtreeHeights.get(roots[0].id)!) / 2
    : 0;
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
      ...(position && {
        position: { x: position.x + delta.x, y: position.y + delta.y },
      }),
      ...(node.next && { next: node.next.map(translate) }),
    };
  }
  function preview(branch: MindMapNode[]): MindMapNode[] {
    return branch.map((node) =>
      node.id === id
        ? translate(node)
        : node.next
          ? { ...node, next: preview(node.next) }
          : node,
    );
  }
  return preview(nodes);
}

export function findNode(
  nodes: MindMapNode[],
  id: string,
): MindMapNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.next ?? [], id);
    if (child) return child;
  }
}

// Arrow-key navigation: right to the first child, left to the parent, up/down
// to adjacent siblings. Undefined when that relative does not exist.
export function navigationTarget(
  nodes: MindMapNode[],
  id: string,
  direction: "left" | "right" | "up" | "down",
): string | undefined {
  function search(
    branch: MindMapNode[],
    parent?: MindMapNode,
  ): { hit: boolean; target?: string } {
    const index = branch.findIndex((node) => node.id === id);
    if (index !== -1) {
      if (direction === "right")
        return { hit: true, target: branch[index].next?.[0]?.id };
      if (direction === "left") return { hit: true, target: parent?.id };
      return {
        hit: true,
        target: branch[index + (direction === "up" ? -1 : 1)]?.id,
      };
    }
    for (const node of branch) {
      if (!node.next) continue;
      const result = search(node.next, node);
      if (result.hit) return result;
    }
    return { hit: false };
  }
  return search(nodes).target;
}

export function connectionPath({ from, to }: Connection) {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  // Attach to the facing borders, even when a child is above or left of its parent.
  const fromScale =
    Math.max(
      Math.abs(dx) / (from.width / 2),
      Math.abs(dy) / (from.height / 2),
    ) || 1;
  const toScale =
    Math.max(Math.abs(dx) / (to.width / 2), Math.abs(dy) / (to.height / 2)) ||
    1;
  const startX = from.x + from.width / 2 + dx / fromScale;
  const startY = from.y + from.height / 2 + dy / fromScale;
  const endX = to.x + to.width / 2 - dx / toScale;
  const endY = to.y + to.height / 2 - dy / toScale;
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(32, Math.hypot(endX - startX, endY - startY) * 0.15);
  const controlX = (startX + endX) / 2 - (dy / length) * bend;
  const controlY = (startY + endY) / 2 + (dx / length) * bend;
  return `M ${startX} ${startY} Q ${controlX} ${controlY}, ${endX} ${endY}`;
}

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
