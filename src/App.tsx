import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import { connectionPath, deleteNode, layoutMindMap, NODE_MIN_HEIGHT, NODE_MIN_WIDTH, updateNode } from "./mind-map";
import type { MindMapNode, NodeSize } from "./mind-map";

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

function NodeEditor(props: {
  text: string;
  onTextChange: (text: string) => void;
  onAddChild: () => void;
  onFinish: () => void;
}) {
  let input!: HTMLTextAreaElement;
  onMount(() => {
    input.focus();
    input.select();
  });

  return (
    <div class="relative min-w-0">
      <span class="block whitespace-pre-wrap wrap-anywhere invisible" aria-hidden="true">{props.text + "\u200b"}</span>
      <textarea
        ref={input}
        aria-label="Node text"
        rows={1}
        class="absolute inset-0 w-full h-full min-w-0 resize-none overflow-hidden whitespace-pre-wrap wrap-anywhere bg-transparent p-0 text-center outline-none select-text cursor-text"
        value={props.text}
        onInput={(e) => props.onTextChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            props.onAddChild();
          } else if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            props.onFinish();
          }
        }}
      />
    </div>
  );
}

function Node(props: {
  text: string;
  x: number;
  y: number;
  editing: boolean;
  canDelete: boolean;
  onSize: (size: NodeSize) => void;
  onEdit: () => void;
  onFinish: () => void;
  onTextChange: (text: string) => void;
  onAddChild: () => void;
  onDelete: () => void;
}) {
  let container!: HTMLDivElement;
  onMount(() => {
    const observer = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      props.onSize({ width, height });
    });
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      ref={container}
      class={clsx([
        "bg-green-300 border rounded-sm",
        "shadow-sm/40 cursor-pointer",
        "px-2.5 py-0.75 select-none",
        "absolute grid items-center box-border w-max max-w-40 leading-6",
      ])}
      classList={{ "ring-2 ring-green-100": props.editing }}
      data-no-pan
      onClick={(e) => {
        if (!props.editing && e.target === e.currentTarget) props.onEdit();
      }}
      onFocusOut={(e) => {
        const container = e.currentTarget;
        if (e.relatedTarget instanceof Element && container.contains(e.relatedTarget)) return;
        // Switching between the button and input also moves focus.
        queueMicrotask(() => {
          if (!container.contains(document.activeElement)) props.onFinish();
        });
      }}
      style={{
        transform: `translate(${props.x}px, ${props.y}px)`,
        "min-width": `${NODE_MIN_WIDTH}px`,
        "min-height": `${NODE_MIN_HEIGHT}px`,
      }}
      title={props.editing ? "Tab: add child · Enter or Escape: finish editing" : props.text}
    >
      <Show when={props.editing} fallback={
        <button type="button" class="w-full min-w-0 whitespace-pre-wrap wrap-anywhere cursor-pointer" onClick={props.onEdit}>
          {props.text || "New idea"}
        </button>
      }>
        <NodeEditor
          text={props.text}
          onTextChange={props.onTextChange}
          onAddChild={props.onAddChild}
          onFinish={props.onFinish}
        />
        <button
          type="button"
          aria-label="Delete node"
          title={props.canDelete ? "Delete node" : "Cannot delete the only node"}
          disabled={!props.canDelete}
          class="absolute -right-2.5 -top-2.5 flex size-5 items-center justify-center rounded-full border bg-green-100 text-sm leading-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
          onClick={props.onDelete}
        >
          ×
        </button>
      </Show>
    </div>
  );
}

export function App() {
  const [nodes, setNodes] = createSignal<MindMapNode[]>([{ id: crypto.randomUUID(), text: "New idea" }]);
  const [editingId, setEditingId] = createSignal<string>();
  const [nodeSizes, setNodeSizes] = createSignal(new Map<string, NodeSize>());
  const layout = createMemo(() => layoutMindMap(nodes(), nodeSizes()));
  const positionedNodes = createMemo(() => new Map(layout().nodes.map((node) => [node.id, node])));
  const nodeIds = createMemo(() => layout().nodes.map((node) => node.id));
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

        setEditingId(undefined);
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
          transform: `translate(${left() - NODE_MIN_WIDTH / 2}px, ${top() - NODE_MIN_HEIGHT / 2}px)`,
        }}
      >
        <svg
          class="absolute inset-0 w-full h-full overflow-visible pointer-events-none"
          aria-hidden="true"
        >
          <For each={layout().connections}>
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
        <For each={nodeIds()}>
          {(id) => {
            const node = () => positionedNodes().get(id)!;
            return (
              <Node
                text={node().text}
                x={node().x}
                y={node().y}
                editing={editingId() === id}
                canDelete={nodeIds().length > 1}
                onSize={(size) => setNodeSizes((current) => {
                  const previous = current.get(id);
                  if (previous?.width === size.width && previous?.height === size.height) return current;
                  return new Map(current).set(id, size);
                })}
                onEdit={() => setEditingId(id)}
                onFinish={() => {
                  if (editingId() === id) setEditingId(undefined);
                }}
                onTextChange={(text) => setNodes((current) => updateNode(current, id, (node) => ({ ...node, text })))}
                onAddChild={() => {
                  const child: MindMapNode = { id: crypto.randomUUID(), text: "New idea" };
                  setNodes((current) => updateNode(current, id, (node) => ({ ...node, next: [...(node.next ?? []), child] })));
                  setEditingId(child.id);
                }}
                onDelete={() => {
                  if (nodeIds().length <= 1) return;
                  setEditingId(undefined);
                  setNodes((current) => deleteNode(current, id));
                }}
              />
            );
          }}
        </For>
      </div>
    </div>
  );
}
