import { createSignal, For } from "solid-js";
import type { JSX } from "solid-js";
import { connectionPath, layoutMindMap, NODE_HEIGHT, NODE_WIDTH } from "./mind-map";
import type { MindMapNode } from "./mind-map";

function clsx(slices: JSX.DOMAttributes<HTMLDivElement>["class"][]) {
  return slices.join(" ");
}

class Vector2 {
  public x: number;
  public y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  set(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

const content: { nodes: MindMapNode[] } = { nodes: [{ text: "New idea" }] };

const layout = layoutMindMap(content.nodes);

function Node({ text, x, y }: { text: string; x: number; y: number }) {
  return (
    <div
      class={clsx([
        "bg-green-300 border rounded-sm",
        "shadow-sm/40 cursor-pointer",
        "px-2.5 py-0.75 select-none",
        "absolute flex items-center justify-center box-border",
      ])}
      data-no-pan
      style={{
        transform: `translate(${x}px, ${y}px)`,
        width: `${NODE_WIDTH}px`,
        height: `${NODE_HEIGHT}px`,
      }}
      title={text}
    >
      <span class="truncate">{text}</span>
    </div>
  );
}

export function App() {
  const [left, setLeft] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const [moving, setMoving] = createSignal(false);

  const vMouseDown = new Vector2();
  const vPrevPos = new Vector2();
  let activePointerId: number | undefined;

  function stopMoving(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = undefined;
    setMoving(false);
  }

  return (
    <div
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0 || activePointerId !== undefined)
          return;
        if (e.target instanceof Element && e.target.closest("[data-no-pan]"))
          return;

        e.currentTarget.setPointerCapture(e.pointerId);
        activePointerId = e.pointerId;
        vMouseDown.set(e.clientX, e.clientY);
        vPrevPos.set(left(), top());
        setMoving(true);
        e.preventDefault();
      }}
      onPointerUp={stopMoving}
      onPointerCancel={stopMoving}
      onLostPointerCapture={stopMoving}
      onPointerMove={(e) => {
        if (e.pointerId !== activePointerId) return;

        const dx = e.clientX - vMouseDown.x;
        const dy = e.clientY - vMouseDown.y;
        setLeft(vPrevPos.x + dx);
        setTop(vPrevPos.y + dy);
      }}
      class="overflow-hidden w-screen h-screen bg-stone-900 relative touch-none select-none"
      style={{ cursor: moving() ? "grabbing" : "grab" }}
    >
      <div
        class="absolute w-full h-full"
        style={{
          left: "50%",
          top: "50%",
          transform: `translate(${left() - NODE_WIDTH / 2}px, ${top() - NODE_HEIGHT / 2}px)`,
        }}
      >
        <svg
          class="absolute inset-0 w-full h-full overflow-visible pointer-events-none"
          aria-hidden="true"
        >
          <For each={layout.connections}>
            {(connection) => (
              <path
                d={connectionPath(connection)}
                fill="none"
                stroke="#86efac"
                stroke-width="2"
              />
            )}
          </For>
        </svg>
        <For each={layout.nodes}>
          {(node) => <Node text={node.text} x={node.x} y={node.y} />}
        </For>
      </div>
    </div>
  );
}
