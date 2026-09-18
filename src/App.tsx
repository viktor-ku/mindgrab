import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { canMoveNode, connectionPath, deleteNode, insertSibling, layoutMindMap, moveNode, NODE_MIN_HEIGHT, reorderNode, updateNode } from "./mind-map";
import type { DropTarget, MindMapNode, NodeSize } from "./mind-map";

function NodeEditor(props: {
  text: string;
  onTextChange: (text: string) => void;
  onFinish: () => void;
}) {
  let input!: HTMLTextAreaElement;
  onMount(() => {
    input.focus();
    input.select();
  });

  return (
    <div class="relative min-w-px">
      <span class="block whitespace-pre-wrap wrap-anywhere invisible" aria-hidden="true">{props.text + "\u200b"}</span>
      <textarea
        ref={input}
        aria-label="Node text"
        rows={1}
        class="absolute inset-0 w-full h-full min-w-0 resize-none overflow-hidden whitespace-pre-wrap wrap-anywhere bg-transparent p-0 text-center outline-none select-text cursor-text"
        value={props.text}
        onInput={(e) => props.onTextChange(e.currentTarget.value)}
        onBlur={props.onFinish}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.isComposing) return;
          if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey)) {
            e.preventDefault();
            props.onFinish();
          }
        }}
      />
    </div>
  );
}

function Node(props: {
  id: string;
  text: string;
  x: number;
  y: number;
  selected: boolean;
  writing: boolean;
  dragging: boolean;
  dropPlacement?: "child" | "before" | "after";
  onSize: (size: NodeSize) => void;
  onSelect: () => void;
  onWrite: () => void;
  onFinish: () => void;
  onPointerDown: (event: PointerEvent) => void;
  onTextChange: (text: string) => void;
}) {
  let container!: HTMLDivElement;
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      // Layout sizes stay in canvas units even when the viewport is zoomed.
      const size = entry.borderBoxSize[0];
      props.onSize({ width: size.inlineSize, height: size.blockSize });
    });
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      ref={container}
      class="bg-blue-300 text-blue-950 border border-blue-500 rounded-sm shadow-sm/10 cursor-pointer px-2.5 py-0.75 select-none absolute grid items-center box-border w-max max-w-40 leading-6"
      classList={{
        "ring-2 ring-blue-500 ring-offset-2 ring-offset-stone-200": props.selected,
        "opacity-40": props.dragging,
        "drop-child": props.dropPlacement === "child",
        "drop-before": props.dropPlacement === "before",
        "drop-after": props.dropPlacement === "after",
      }}
      data-no-pan
      data-node-id={props.id}
      data-selected={props.selected}
      onPointerDown={props.onPointerDown}
      onClick={props.onSelect}
      onDblClick={props.onWrite}
      style={{
        transform: `translate(${props.x}px, ${props.y}px)`,
        "min-height": `${NODE_MIN_HEIGHT}px`,
      }}
      title="Click to select · Double-click to write · Drag to move"
    >
      <Show when={props.writing} fallback={
        <button type="button" aria-pressed={props.selected} class="w-full min-w-0 whitespace-pre-wrap wrap-anywhere cursor-pointer">
          {props.text || "New idea"}
        </button>
      }>
        <NodeEditor text={props.text} onTextChange={props.onTextChange} onFinish={props.onFinish} />
      </Show>
    </div>
  );
}

export function App() {
  const [nodes, setNodes] = createSignal<MindMapNode[]>([{ id: crypto.randomUUID(), text: "New idea" }]);
  const [selectedId, setSelectedId] = createSignal<string>();
  const [writing, setWriting] = createSignal(false);
  const mode = () => writing() ? "Writing" : selectedId() ? "Editing" : "Normal";
  const [nodeSizes, setNodeSizes] = createSignal(new Map<string, NodeSize>());
  const layout = createMemo(() => layoutMindMap(nodes(), nodeSizes()));
  const positionedNodes = createMemo(() => new Map(layout().nodes.map((node) => [node.id, node])));
  const nodeIds = createMemo(() => layout().nodes.map((node) => node.id));
  const [left, setLeft] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const [zoom, setZoom] = createSignal(1);
  const [panning, setPanning] = createSignal(false);
  const [draggingId, setDraggingId] = createSignal<string>();
  const [dropTarget, setDropTarget] = createSignal<DropTarget>();
  let canvas!: HTMLDivElement;
  let pointer: { id: number; x: number; y: number; left: number; top: number; nodeId?: string } | undefined;
  let suppressClick = false;

  function select(id: string) {
    if (suppressClick) return;
    if (selectedId() !== id) setWriting(false);
    setSelectedId(id);
  }

  function finishWriting() {
    if (!writing()) return;
    setWriting(false);
    canvas.focus({ preventScroll: true });
  }

  function write(id: string) {
    setSelectedId(id);
    setWriting(true);
  }

  function add(kind: "child" | "sibling" | "root") {
    const node: MindMapNode = { id: crypto.randomUUID(), text: "New idea" };
    const id = selectedId();
    setNodes((current) => kind === "root" || !id ? [...current, node]
      : kind === "child" ? updateNode(current, id, (parent) => ({ ...parent, next: [...(parent.next ?? []), node] }))
        : insertSibling(current, id, node));
    write(node.id);
  }

  function removeSelected() {
    const id = selectedId();
    if (!id) return;
    setWriting(false);
    setSelectedId(undefined);
    setNodes((current) => deleteNode(current, id));
    setNodeSizes((current) => new Map([...current].filter(([key]) => nodeIds().includes(key))));
    canvas.focus({ preventScroll: true });
  }

  function changeZoom(value: number, clientX?: number, clientY?: number) {
    const next = Math.min(2.5, Math.max(0.25, value));
    const bounds = canvas.getBoundingClientRect();
    const x = (clientX ?? bounds.left + bounds.width / 2) - bounds.left - bounds.width / 2;
    const y = (clientY ?? bounds.top + bounds.height / 2) - bounds.top - bounds.height / 2;
    const ratio = next / zoom();
    setLeft(x - (x - left()) * ratio);
    setTop(y - (y - top()) * ratio);
    setZoom(next);
  }

  function startPointer(e: PointerEvent, nodeId?: string) {
    if (!e.isPrimary || e.button !== 0 || pointer || (nodeId && writing() && selectedId() === nodeId)) return;
    suppressClick = false;
    if (nodeId) select(nodeId);
    else {
      setWriting(false);
      setSelectedId(undefined);
    }
    canvas.focus({ preventScroll: true });
    pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, left: left(), top: top(), nodeId };
    // Node clicks need their original target for double-click recognition. Capture on drag only.
    if (!nodeId) {
      canvas.setPointerCapture(e.pointerId);
      setPanning(true);
      e.preventDefault();
    }
  }

  function targetAt(e: PointerEvent): DropTarget | undefined {
    const element = document.elementFromPoint(e.clientX, e.clientY);
    if (!element || !canvas.contains(element) || element.closest("[data-toolbar]")) return;
    const node = element.closest<HTMLElement>("[data-node-id]");
    if (!node) return { placement: "root" };
    const bounds = node.getBoundingClientRect();
    const fraction = (e.clientY - bounds.top) / bounds.height;
    return { id: node.dataset.nodeId!, placement: fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : "child" };
  }

  function movePointer(e: PointerEvent) {
    if (!pointer || e.pointerId !== pointer.id) return;
    const dx = e.clientX - pointer.x;
    const dy = e.clientY - pointer.y;
    if (pointer.nodeId) {
      if (!draggingId() && Math.hypot(dx, dy) < 6) return;
      canvas.setPointerCapture(e.pointerId);
      setDraggingId(pointer.nodeId);
      suppressClick = true;
      const target = targetAt(e);
      setDropTarget(target && canMoveNode(nodes(), pointer.nodeId, target) ? target : undefined);
    } else {
      setLeft(pointer.left + dx);
      setTop(pointer.top + dy);
    }
  }

  function stopPointer(e: PointerEvent, commit: boolean) {
    if (!pointer || e.pointerId !== pointer.id) return;
    const id = draggingId();
    const target = dropTarget();
    if (commit && id && target) setNodes((current) => moveNode(current, id, target));
    pointer = undefined;
    setDraggingId(undefined);
    setDropTarget(undefined);
    setPanning(false);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  }

  onMount(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.isComposing || writing() || (e.target instanceof Element && e.target.closest("textarea, input, [contenteditable=true], [data-toolbar]"))) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (pointer) {
          const id = pointer.id;
          pointer = undefined;
          setDraggingId(undefined);
          setDropTarget(undefined);
          setPanning(false);
          if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
        }
        setSelectedId(undefined);
        canvas.focus({ preventScroll: true });
        return;
      }
      if (!selectedId()) return;
      if (!e.shiftKey && !e.ctrlKey && !e.altKey && ((e.key === "Delete" && !e.metaKey) || (e.key === "Backspace" && e.metaKey))) {
        e.preventDefault();
        removeSelected();
      } else if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "Tab" || e.key === "Enter")) {
        e.preventDefault();
        add(e.key === "Tab" ? "child" : "sibling");
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        setNodes((current) => reorderNode(current, selectedId()!, e.key === "ArrowUp" ? -1 : 1));
      } else if (e.key === "F2") {
        e.preventDefault();
        write(selectedId()!);
      }
    };
    const wheel = (e: WheelEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-toolbar], textarea")) return;
      e.preventDefault();
      changeZoom(zoom() * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("pointerup", stopOutside);
    canvas.addEventListener("wheel", wheel, { passive: false });
    function stopOutside(e: PointerEvent) { stopPointer(e, true); }
    onCleanup(() => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("pointerup", stopOutside);
      canvas.removeEventListener("wheel", wheel);
    });
  });

  const dropDescription = () => {
    const target = dropTarget();
    if (!target) return "Drop cancelled: choose another node or empty canvas";
    if (target.placement === "root") return "Release to make a root node";
    const text = positionedNodes().get(target.id)?.text || "New idea";
    return target.placement === "child" ? `Release to add inside “${text}”` : `Release to place ${target.placement} “${text}”`;
  };

  return (
    <div
      ref={canvas}
      tabIndex={-1}
      aria-label="Mind map canvas"
      onPointerDown={(e) => {
        if (e.target instanceof Element && e.target.closest("[data-no-pan]")) return;
        startPointer(e);
      }}
      onPointerMove={movePointer}
      onPointerUp={(e) => stopPointer(e, true)}
      onPointerCancel={(e) => stopPointer(e, false)}
      onLostPointerCapture={(e) => stopPointer(e, false)}
      class="overflow-hidden w-screen h-screen bg-stone-200 text-stone-900 relative touch-none select-none outline-none"
      style={{ cursor: panning() || draggingId() ? "grabbing" : "grab" }}
    >
      <div class="absolute w-full h-full origin-top-left" style={{
        left: "50%", top: "50%",
        transform: `translate(${left()}px, ${top()}px) scale(${zoom()}) translate(${-(layout().nodes[0]?.width ?? 0) / 2}px, ${-NODE_MIN_HEIGHT / 2}px)`,
      }}>
        <svg class="absolute inset-0 w-full h-full overflow-visible pointer-events-none stroke-stone-700" aria-hidden="true">
          <For each={layout().connections}>{(connection) => <path d={connectionPath(connection)} fill="none" stroke-width="1" />}</For>
        </svg>
        <For each={nodeIds()}>{(id) => {
          const node = () => positionedNodes().get(id)!;
          const placement = () => {
            const target = dropTarget();
            return target && target.placement !== "root" && target.id === id ? target.placement : undefined;
          };
          return <Node
            id={id} text={node().text} x={node().x} y={node().y}
            selected={selectedId() === id} writing={selectedId() === id && writing()}
            dragging={draggingId() === id} dropPlacement={placement()}
            onSize={(size) => setNodeSizes((current) => {
              const previous = current.get(id);
              if (previous?.width === size.width && previous?.height === size.height) return current;
              return new Map(current).set(id, size);
            })}
            onSelect={() => select(id)} onWrite={() => write(id)}
            onFinish={() => { if (selectedId() === id) finishWriting(); }}
            onPointerDown={(e) => startPointer(e, id)}
            onTextChange={(text) => setNodes((current) => updateNode(current, id, (node) => ({ ...node, text })))}
          />;
        }}</For>
      </div>
      <div data-no-pan data-toolbar class="absolute top-4 left-4 right-4 flex flex-wrap items-center gap-2 text-sm cursor-default">
        <span class="rounded bg-white px-3 py-2 shadow-sm" role="status"><strong>{mode()}</strong> mode</span>
        <button class="map-control" onClick={() => add("root")}>Add root</button>
        <Show when={selectedId()}>
          <button class="map-control" onClick={() => write(selectedId()!)}>Write</button>
          <button class="map-control" onClick={() => add("child")}>Add child</button>
          <button class="map-control" onClick={() => add("sibling")}>Add sibling</button>
          <button class="map-control" onClick={removeSelected}>Delete subtree</button>
        </Show>
        <div class="ml-auto flex gap-2 items-center">
          <button class="map-control" aria-label="Zoom out" onClick={() => changeZoom(zoom() / 1.2)}>−</button>
          <span class="min-w-12 text-center">{Math.round(zoom() * 100)}%</span>
          <button class="map-control" aria-label="Zoom in" onClick={() => changeZoom(zoom() * 1.2)}>+</button>
          <button class="map-control" onClick={() => { setLeft(0); setTop(0); setZoom(1); }}>Reset view</button>
        </div>
      </div>
      <Show when={!nodes().length}>
        <div data-no-pan data-toolbar class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center cursor-default">
          <p class="mb-3">Your canvas is empty.</p>
          <button class="map-control" onClick={() => add("root")}>Create an idea</button>
        </div>
      </Show>
      <div data-no-pan class="absolute bottom-4 left-4 right-4 rounded bg-white/90 px-3 py-2 text-sm cursor-default pointer-events-none" aria-live="polite">
        {draggingId() ? dropDescription() : writing()
          ? "Writing · Enter or Escape: finish · Shift+Enter: new line · Text keys only change text"
          : selectedId()
            ? "Editing · Tab: child · Enter: sibling · Delete / ⌘⌫: delete subtree · Ctrl+↑/↓: reorder · Double-click / F2: write · Escape: overview"
            : "Normal · Drag canvas to pan · Scroll to zoom · Click a node to select · Double-click to write"}
        <Show when={selectedId() && !writing() && !draggingId()}>
          <span class="block text-stone-600">Drag to a node’s center to reparent, its top/bottom edge to reorder, or empty canvas to make a root.</span>
        </Show>
      </div>
    </div>
  );
}
