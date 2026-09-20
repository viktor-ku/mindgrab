import { batch, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { connectionPath, deleteNode, insertSibling, layoutMindMap, NODE_MIN_HEIGHT, reorderNode, translateSubtree, updateNode } from "./mind-map";
import { createHistory } from "./history";
import type { MapSnapshot } from "./history";
import type { LayoutAnchor, MindMapNode, NodePosition, NodeSize } from "./mind-map";

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
        "z-10": props.dragging,
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
  const [nodeSizes, setNodeSizes] = createSignal(new Map<string, NodeSize>());
  const [layoutAnchor, setLayoutAnchor] = createSignal<LayoutAnchor>();
  const layout = createMemo(() => layoutMindMap(nodes(), nodeSizes(), layoutAnchor()));
  const positionedNodes = createMemo(() => new Map(layout().nodes.map((node) => [node.id, node])));
  const nodeIds = createMemo(() => layout().nodes.map((node) => node.id));
  const [left, setLeft] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const [zoom, setZoom] = createSignal(1);
  const [panning, setPanning] = createSignal(false);
  const [draggingId, setDraggingId] = createSignal<string>();
  let canvas!: HTMLDivElement;
  let pointer: {
    id: number; x: number; y: number; left: number; top: number; zoom: number;
    nodeId?: string;
    nodes: MindMapNode[];
    snapshot: MapSnapshot;
    positions: ReadonlyMap<string, NodePosition>;
  } | undefined;
  let suppressClick = false;
  const history = createHistory();
  let editSnapshot: MapSnapshot | undefined;

  function snapshot(): MapSnapshot {
    return { nodes: nodes(), selectedId: selectedId(), anchor: layoutAnchor(), sizes: nodeSizes() };
  }

  function undo() {
    const previous = history.undo();
    if (!previous) return;
    batch(() => {
      setNodes(previous.nodes);
      setSelectedId(previous.selectedId);
      setLayoutAnchor(previous.anchor);
      setNodeSizes(new Map(previous.sizes));
    });
    canvas.focus({ preventScroll: true });
  }

  function select(id: string) {
    if (suppressClick) return;
    if (selectedId() !== id) finishWriting();
    setSelectedId(id);
  }

  function finishWriting() {
    if (!writing()) return;
    if (editSnapshot) history.record(editSnapshot, nodes());
    editSnapshot = undefined;
    setWriting(false);
    canvas.focus({ preventScroll: true });
  }

  function write(id: string) {
    if (writing() && selectedId() === id) return;
    finishWriting();
    setSelectedId(id);
    editSnapshot = snapshot();
    setWriting(true);
  }

  function add(kind: "child" | "sibling" | "root") {
    finishWriting();
    const before = snapshot();
    const node: MindMapNode = { id: crypto.randomUUID(), text: "New idea" };
    const id = selectedId();
    const anchorId = kind === "sibling"
      ? layout().connections.find(({ to }) => to.id === id)?.from.id ?? id
      : kind === "child" ? id : undefined;
    batch(() => {
      const anchor = positionedNodes().get(anchorId ?? nodes()[0]?.id);
      setLayoutAnchor(anchor && { id: anchor.id, centerY: anchor.y + anchor.height / 2 });
      setNodes((current) => kind === "root" || !id ? [...current, node]
        : kind === "child" ? updateNode(current, id, (parent) => ({ ...parent, next: [...(parent.next ?? []), node] }))
          : insertSibling(current, id, node));
      history.record(before, nodes());
      write(node.id);
    });
  }

  function removeSelected() {
    const id = selectedId();
    if (!id) return;
    finishWriting();
    const before = snapshot();
    setSelectedId(undefined);
    setNodes((current) => deleteNode(current, id));
    history.record(before, nodes());
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
    if (nodeId) {
      finishWriting();
      select(nodeId);
    } else {
      finishWriting();
      setSelectedId(undefined);
    }
    canvas.focus({ preventScroll: true });
    pointer = {
      id: e.pointerId, x: e.clientX, y: e.clientY, left: left(), top: top(), zoom: zoom(), nodeId,
      nodes: nodes(), snapshot: snapshot(), positions: positionedNodes(),
    };
    // Node clicks need their original target for double-click recognition. Capture on drag only.
    if (!nodeId) {
      canvas.setPointerCapture(e.pointerId);
      setPanning(true);
      e.preventDefault();
    }
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
      setNodes(translateSubtree(pointer.nodes, pointer.nodeId, pointer.positions, {
        x: dx / pointer.zoom, y: dy / pointer.zoom,
      }));
    } else {
      setLeft(pointer.left + dx);
      setTop(pointer.top + dy);
    }
  }

  function stopPointer(e: PointerEvent, commit: boolean) {
    if (!pointer || e.pointerId !== pointer.id) return;
    if (draggingId()) {
      if (commit) {
        movePointer(e);
        history.record(pointer.snapshot, nodes());
      } else setNodes(pointer.nodes);
    }
    pointer = undefined;
    setDraggingId(undefined);
    setPanning(false);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  }

  onMount(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.isComposing || writing() || (e.target instanceof Element && e.target.closest("textarea, input, [contenteditable=true]"))) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (pointer) {
          const id = pointer.id;
          if (draggingId()) setNodes(pointer.nodes);
          pointer = undefined;
          setDraggingId(undefined);
          setPanning(false);
          if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
        }
        setSelectedId(undefined);
        canvas.focus({ preventScroll: true });
        return;
      }
      if (pointer) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (!selectedId() || (e.target instanceof Element && e.target.closest("[data-toolbar]"))) return;
      if (!e.shiftKey && !e.ctrlKey && !e.altKey && ((e.key === "Delete" && !e.metaKey) || (e.key === "Backspace" && e.metaKey))) {
        e.preventDefault();
        removeSelected();
      } else if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "Tab" || e.key === "Enter")) {
        e.preventDefault();
        add(e.key === "Tab" ? "child" : "sibling");
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const before = snapshot();
        setNodes((current) => reorderNode(current, selectedId()!, e.key === "ArrowUp" ? -1 : 1));
        history.record(before, nodes());
      } else if (e.key === "F2") {
        e.preventDefault();
        write(selectedId()!);
      }
    };
    const wheel = (e: WheelEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-toolbar], textarea")) return;
      e.preventDefault();
      if (!pointer) changeZoom(zoom() * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
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
          return <Node
            id={id} text={node().text} x={node().x} y={node().y}
            selected={selectedId() === id} writing={selectedId() === id && writing()}
            dragging={draggingId() === id}
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
      <Show when={!nodes().length}>
        <div data-no-pan data-toolbar class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center cursor-default">
          <p class="mb-3">Your canvas is empty.</p>
          <button class="map-control" onClick={() => add("root")}>Create an idea</button>
        </div>
      </Show>
      <div data-no-pan data-toolbar role="group" aria-label="Canvas zoom"
        class="map-toolbar absolute bottom-4 right-4 flex items-center text-sm cursor-default"
      >
        <button class="map-control" aria-label="Zoom out" disabled={zoom() <= 0.25} onClick={() => changeZoom(zoom() / 1.2)}>−</button>
        <button class="map-control min-w-14 tabular-nums" aria-label="Reset view" title="Reset view" onClick={() => { setLeft(0); setTop(0); setZoom(1); }}>{Math.round(zoom() * 100)}%</button>
        <button class="map-control" aria-label="Zoom in" disabled={zoom() >= 2.5} onClick={() => changeZoom(zoom() * 1.2)}>+</button>
      </div>
    </div>
  );
}
