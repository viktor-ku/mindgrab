export interface MindMapNode {
  text: string;
  next?: MindMapNode[];
}

export const NODE_WIDTH = 128;
export const NODE_HEIGHT = 40;
const COLUMN_GAP = 64;
const ROW_GAP = 24;

interface PositionedNode {
  text: string;
  x: number;
  y: number;
}

interface Connection {
  from: PositionedNode;
  to: PositionedNode;
}

export function layoutMindMap(roots: MindMapNode[]) {
  const nodes: PositionedNode[] = [];
  const connections: Connection[] = [];
  let nextLeafY = 0;

  function visit(node: MindMapNode, depth: number): PositionedNode {
    const positioned = { text: node.text, x: depth * (NODE_WIDTH + COLUMN_GAP), y: 0 };
    nodes.push(positioned);

    const children = (node.next ?? []).map((child) => visit(child, depth + 1));
    if (children.length) {
      positioned.y = (children[0].y + children[children.length - 1].y) / 2;
      for (const child of children) {
        connections.push({ from: positioned, to: child });
      }
    } else {
      positioned.y = nextLeafY;
      nextLeafY += NODE_HEIGHT + ROW_GAP;
    }

    return positioned;
  }

  for (const root of roots) visit(root, 0);

  return { nodes, connections };
}

export function connectionPath({ from, to }: Connection) {
  const startX = from.x + NODE_WIDTH;
  const startY = from.y + NODE_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + NODE_HEIGHT / 2;
  const middleX = (startX + endX) / 2;
  return `M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX} ${endY}`;
}
