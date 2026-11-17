import type { LinkStyle } from "./generated/mindgrab-state/model";
import type { NodeColor } from "./node-colors";

export interface MindMapNode {
  id: string;
  text: string;
  note?: string;
  color?: NodeColor;
  position?: NodePosition;
  // Empty space kept where ideas were deleted, so the others stay put: above
  // this idea among its siblings, and after its last child.
  gap?: number;
  endGap?: number;
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

// The space a slot `height` tall takes among `siblings` ideas, itself included:
// what deleting it leaves empty, or what a new idea fills.
export const slotSpace = (height: number, siblings: number) =>
  height + (siblings > 1 ? ROW_GAP : 0);
// A new idea's slot before it is measured.
export const newIdeaSpace = (siblings: number) =>
  slotSpace(NODE_MIN_HEIGHT, siblings);

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

// Keeps one idea at a fixed height while the automatic layout changes around
// it. The whole automatic layout shifts together, so an anchor never pulls a
// node out of line with its siblings, however stale it gets. Only automatically
// placed ideas outside dragged branches can anchor; any other anchor is ignored.
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
  // Automatically placed nodes outside any dragged branch: their places follow
  // from the roots alone, so they can shift together.
  const automatic = new Map<string, PositionedNode>();
  // For each node, the nearest such node on its path from the root.
  const anchorIds = new Map<string, string>();

  function sizeOf(node: MindMapNode): NodeSize {
    return (
      sizes.get(node.id) ?? {
        width: DEFAULT_NODE_WIDTH,
        height: NODE_MIN_HEIGHT,
      }
    );
  }

  // A node's children, the gaps above them and its end gap, stacked.
  function childrenHeight(node: MindMapNode) {
    const children = node.next ?? [];
    return (
      children.reduce(
        (sum, child) => sum + (child.gap ?? 0) + subtreeHeights.get(child.id)!,
        0,
      ) +
      Math.max(0, children.length - 1) * ROW_GAP +
      (node.endGap ?? 0)
    );
  }

  function measureSubtree(node: MindMapNode): number {
    for (const child of node.next ?? []) measureSubtree(child);
    const height = Math.max(sizeOf(node).height, childrenHeight(node));
    subtreeHeights.set(node.id, height);
    return height;
  }

  // A node is centered on its own subtree's slot, so growing or shrinking a
  // branch moves its siblings apart or together but leaves it and its
  // ancestors in place.
  function visit(
    node: MindMapNode,
    x: number,
    top: number,
    anchorId: string | undefined,
    placed: boolean,
  ): PositionedNode {
    const size = sizeOf(node);
    const subtreeHeight = subtreeHeights.get(node.id)!;
    const positioned = {
      id: node.id,
      text: node.text,
      color: node.color,
      x,
      y: top + (subtreeHeight - size.height) / 2,
      ...node.position,
      ...size,
    };
    nodes.push(positioned);
    const inPlace = placed || !!node.position;
    if (!inPlace) {
      automatic.set(node.id, positioned);
      anchorId = node.id;
    }
    if (anchorId) anchorIds.set(node.id, anchorId);

    let childTop = positioned.y + (size.height - childrenHeight(node)) / 2;
    for (const child of node.next ?? []) {
      childTop += child.gap ?? 0;
      const childPosition = visit(
        child,
        positioned.x + size.width + COLUMN_GAP,
        childTop,
        anchorId,
        inPlace,
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
    rootTop += root.gap ?? 0;
    visit(root, 0, rootTop, undefined, false);
    rootTop += subtreeHeights.get(root.id)! + ROW_GAP;
  }

  const anchored = anchor && automatic.get(anchor.id);
  const offset = anchored
    ? anchor.centerY - (anchored.y + anchored.height / 2)
    : 0;
  if (offset) for (const node of automatic.values()) node.y += offset;

  // For each node, the anchor that holds it where it is now: itself, or its
  // nearest automatically placed ancestor when it is in a dragged branch.
  const anchors = new Map<string, LayoutAnchor>();
  for (const node of automatic.values())
    anchors.set(node.id, { id: node.id, centerY: node.y + node.height / 2 });
  for (const [id, anchorId] of anchorIds)
    anchors.set(id, anchors.get(anchorId)!);

  return { nodes, connections, anchors, heights: subtreeHeights };
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

// How a map draws the lines to children; see `LinkStyle` in the document.
export type { LinkStyle };
export const DEFAULT_LINK_STYLE: LinkStyle = "rounded";

// The tree's spine runs this far out from the parent, and its rounded turns
// take this radius at most. Freeform curves run straight to each child.
const SPINE_OFFSET = 24;
const TURN_RADIUS = 8;

type Point = [x: number, y: number];

// Straight legs through `points`, each turn rounded by up to `radius`. A turn
// takes at most a whole outer leg and half of the middle one, which it shares
// with the other turn.
function turningPath(points: Point[], radius: number) {
  const length = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const toward = (a: Point, b: Point, distance: number): Point => {
    const total = length(a, b) || 1;
    return [
      a[0] + ((b[0] - a[0]) * distance) / total,
      a[1] + ((b[1] - a[1]) * distance) / total,
    ];
  };
  const last = points.length - 1;
  const parts = [`M ${points[0][0]} ${points[0][1]}`];
  for (let index = 1; index < last; index++) {
    const [before, corner, after] = points.slice(index - 1, index + 2);
    const turn = Math.min(
      radius,
      length(before, corner) / (index === 1 ? 1 : 2),
      length(corner, after) / (index + 1 === last ? 1 : 2),
    );
    if (turn < 1) {
      parts.push(`L ${corner[0]} ${corner[1]}`);
      continue;
    }
    const [inX, inY] = toward(corner, before, turn);
    const [outX, outY] = toward(corner, after, turn);
    parts.push(
      `L ${inX} ${inY}`,
      `Q ${corner[0]} ${corner[1]}, ${outX} ${outY}`,
    );
  }
  parts.push(`L ${points[last][0]} ${points[last][1]}`);
  return parts.join(" ");
}

// A tree's line: out of the parent along `axis` to a spine, along the spine
// level with the child, and into it. Siblings on the same side share the
// spine, so where their lines part is clear however many there are.
function treePath(
  [startX, startY]: Point,
  [endX, endY]: Point,
  axis: "x" | "y",
  style: LinkStyle,
) {
  const radius = style === "rounded" ? TURN_RADIUS : 0;
  if (axis === "x") {
    const spine =
      startX +
      Math.sign(endX - startX) *
        Math.min(SPINE_OFFSET, Math.abs(endX - startX) / 2);
    return turningPath(
      [
        [startX, startY],
        [spine, startY],
        [spine, endY],
        [endX, endY],
      ],
      radius,
    );
  }
  const spine =
    startY +
    Math.sign(endY - startY) *
      Math.min(SPINE_OFFSET, Math.abs(endY - startY) / 2);
  return turningPath(
    [
      [startX, startY],
      [startX, spine],
      [endX, spine],
      [endX, endY],
    ],
    radius,
  );
}

export function connectionPath(
  { from, to }: Connection,
  style: LinkStyle = DEFAULT_LINK_STYLE,
) {
  const fromMiddle = from.y + from.height / 2;
  const toMiddle = to.y + to.height / 2;
  // Children laid out to the right connect side to side, so every branch
  // leaves its parent at the same point.
  if (to.x >= from.x + from.width) {
    const startX = from.x + from.width;
    if (style !== "freeform")
      return treePath([startX, fromMiddle], [to.x, toMiddle], "x", style);
    const middle = (startX + to.x) / 2;
    return `M ${startX} ${fromMiddle} C ${middle} ${fromMiddle}, ${middle} ${toMiddle}, ${to.x} ${toMiddle}`;
  }
  // A child placed by hand to the left runs side to side the other way; one
  // above or below runs between their facing top and bottom edges.
  if (style !== "freeform") {
    if (to.x + to.width <= from.x)
      return treePath(
        [from.x, fromMiddle],
        [to.x + to.width, toMiddle],
        "x",
        style,
      );
    const below = toMiddle >= fromMiddle;
    return treePath(
      [from.x + from.width / 2, below ? from.y + from.height : from.y],
      [to.x + to.width / 2, below ? to.y : to.y + to.height],
      "y",
      style,
    );
  }
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = toMiddle - fromMiddle;
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
  const startY = fromMiddle + dy / fromScale;
  const endX = to.x + to.width / 2 - dx / toScale;
  const endY = toMiddle - dy / toScale;
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
    // A folded idea shows none of its children's space, gaps included.
    ...(collapsed.has(node.id)
      ? { next: [], endGap: undefined }
      : { next: visibleMindMap(node.next ?? [], collapsed) }),
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

export type DropTarget =
  | { kind: "inside"; id: string }
  | { kind: "before" | "after"; id: string };

// A drop over a node's middle makes the dragged branch its last child; a drop
// over its top or bottom edge places the branch before or after it as a
// sibling. Anywhere else is a free placement on the canvas.
export function dropTargetAt(
  nodes: readonly (NodeSize & NodePosition & { id: string })[],
  point: NodePosition,
  excluded: ReadonlySet<string>,
): DropTarget | undefined {
  const MARGIN = 6;
  let best: { target: DropTarget; distance: number } | undefined;
  for (const node of nodes) {
    if (excluded.has(node.id)) continue;
    if (
      point.x < node.x - MARGIN ||
      point.x > node.x + node.width + MARGIN ||
      point.y < node.y - MARGIN ||
      point.y > node.y + node.height + MARGIN
    )
      continue;
    const edge = Math.min(14, node.height / 4);
    const kind =
      point.y < node.y + edge
        ? "before"
        : point.y > node.y + node.height - edge
          ? "after"
          : "inside";
    const distance = Math.hypot(
      point.x - (node.x + node.width / 2),
      point.y - (node.y + node.height / 2),
    );
    if (!best || distance < best.distance)
      best = { target: { kind, id: node.id }, distance };
  }
  return best?.target;
}

// Every id in the branch rooted at `id`, including `id`.
export function branchIds(nodes: readonly MindMapNode[], id: string) {
  const ids = new Set<string>();
  const visit = (branch: readonly MindMapNode[]) => {
    for (const node of branch) {
      ids.add(node.id);
      visit(node.next ?? []);
    }
  };
  const root = findNode(nodes as MindMapNode[], id);
  if (root) visit([root]);
  return ids;
}
