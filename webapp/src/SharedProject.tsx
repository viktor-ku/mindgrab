import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { createQuery } from "@tanstack/solid-query";
import { Node } from "./App";
import { track } from "./analytics";
import {
  BrandMark,
  CloseIcon,
  FitMapIcon,
  MinusIcon,
  OutlineIcon,
  PlusIcon,
} from "./icons";
import { decodeBase64 } from "./loro-api";
import {
  connectionPath,
  layoutMindMap,
  NODE_MIN_HEIGHT,
  nodeDetails,
  visibleMindMap,
} from "./mind-map";
import type { NodeSize } from "./mind-map";
import { NODE_COLORS } from "./node-colors";
import { Outline } from "./Outline";
import {
  ORIGIN,
  openProjectDocument,
  type ProjectDocument,
} from "./project-document";
import { createProjectView } from "./project-view";
import {
  fetchSharedProject,
  SharedProjectError,
  sharedProjectSocket,
} from "./shared-project";

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 2.5;
const VIEW_INSETS = { top: 76, right: 24, bottom: 72, left: 24 } as const;

// A read-only, live view of a project opened from its share link. It keeps
// the document in memory only: nothing touches the viewer's own projects, and
// local changes are impossible because nothing here dispatches commands.
export function SharedProject(props: { token: string }) {
  const [doc, setDoc] = createSignal<ProjectDocument>();
  // Revoked links stay revoked for this page; a new link is a new URL.
  const [revoked, setRevoked] = createSignal(false);
  // Assume a live socket until one closes, so the first load does not poll.
  const [live, setLive] = createSignal(true);
  const [broken, setBroken] = createSignal(false);

  // The query dedupes and cancels overlapping loads. While the socket is down
  // it polls, which both catches up on edits and notices a revoked link.
  const snapshot = createQuery(() => ({
    queryKey: ["shared-project", props.token],
    queryFn: ({ signal }) => fetchSharedProject(props.token, signal),
    enabled: !revoked(),
    staleTime: 0,
    gcTime: 0,
    structuralSharing: false,
    refetchInterval: live() ? false : 5000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  }));
  const refetch = () => {
    if (!untrack(revoked)) void snapshot.refetch();
  };
  createEffect(() => {
    const error = snapshot.error;
    if (error instanceof SharedProjectError && error.kind === "missing")
      setRevoked(true);
  });

  function replace(next?: ProjectDocument) {
    const previous = untrack(doc);
    setDoc(next);
    if (previous && previous !== next) previous.destroy();
  }
  onCleanup(() => replace(undefined));

  // Apply each newer committed snapshot to the in-memory document.
  let revision = -1n;
  createEffect(
    on(
      () => snapshot.data,
      (data) => {
        if (!data || untrack(revoked)) return;
        const next = BigInt(data.revision);
        const current = untrack(doc);
        if (current && next <= revision) return;
        try {
          const bytes = decodeBase64(data.data);
          if (current?.id === data.projectId) {
            try {
              current.merge(bytes, ORIGIN.remote);
            } catch {
              replace(openProjectDocument(data.projectId, [bytes]));
            }
          } else replace(openProjectDocument(data.projectId, [bytes]));
          revision = next;
          setBroken(false);
        } catch {
          setBroken(true);
        }
      },
    ),
  );
  // A revoked link stops showing the project, even in an open tab.
  createEffect(() => {
    if (revoked()) replace(undefined);
  });

  const status = () =>
    revoked()
      ? "missing"
      : doc()
        ? "ready"
        : snapshot.isError || broken()
          ? "error"
          : "loading";
  createEffect(
    on(
      () => status() === "ready",
      (ready) => ready && track("shared_project_viewed"),
      { defer: true },
    ),
  );

  // The socket only says when to refetch. Every successful fetch while it is
  // down (polling, focus, reconnect) opens it again.
  let socket: WebSocket | undefined;
  function closeSocket() {
    const current = socket;
    socket = undefined;
    current?.close();
  }
  onCleanup(closeSocket);
  createEffect(() => {
    void snapshot.dataUpdatedAt;
    if (revoked()) {
      closeSocket();
      return;
    }
    if (status() !== "ready" || socket) return;
    const current = sharedProjectSocket(props.token);
    socket = current;
    current.onopen = () => {
      setLive(true);
      // Catch up on changes made while disconnected.
      refetch();
    };
    current.onmessage = (event) => {
      try {
        const value = JSON.parse(String(event.data)) as { revision?: string };
        if (!value.revision || BigInt(value.revision) > revision) refetch();
      } catch {
        refetch();
      }
    };
    current.onclose = (event) => {
      if (socket !== current) return;
      socket = undefined;
      if (event.code === 1008) setRevoked(true);
      else setLive(false);
    };
  });

  const view = createMemo(() => {
    const current = doc();
    return current ? createProjectView(current) : undefined;
  });
  const name = () => view()?.name() || "Shared map";
  createEffect(() => {
    document.title =
      status() === "ready" ? `${name()} · Mindgrab` : "Shared map · Mindgrab";
  });

  const forest = () => view()?.forest() ?? [];
  const details = createMemo(() => nodeDetails(forest()));
  const [collapsedIds, setCollapsedIds] = createSignal(new Set<string>());
  const visibleForest = createMemo(() =>
    visibleMindMap(forest(), collapsedIds()),
  );
  function toggleCollapse(id: string) {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  // Node sizes arrive from ResizeObservers; publish them once per frame.
  const [nodeSizes, setNodeSizes] = createSignal(new Map<string, NodeSize>());
  const measured = new Map<string, NodeSize>();
  let sizeFrame: number | undefined;
  function measureNode(id: string, size: NodeSize) {
    measured.set(id, size);
    if (sizeFrame !== undefined) return;
    sizeFrame = requestAnimationFrame(() => {
      sizeFrame = undefined;
      setNodeSizes((current) => {
        let next = current;
        for (const [id, size] of measured) {
          const previous = current.get(id);
          if (
            previous?.width === size.width &&
            previous?.height === size.height
          )
            continue;
          if (next === current) next = new Map(current);
          next.set(id, size);
        }
        return next;
      });
      measured.clear();
    });
  }
  onCleanup(() => {
    if (sizeFrame !== undefined) cancelAnimationFrame(sizeFrame);
  });

  const layout = createMemo(() => layoutMindMap(visibleForest(), nodeSizes()));
  const positioned = createMemo(
    () => new Map(layout().nodes.map((node) => [node.id, node])),
  );
  const nodeIds = createMemo(() => layout().nodes.map((node) => node.id));
  const connections = createMemo(
    () =>
      new Map(
        layout().connections.map((connection) => [
          connection.to.id,
          connection,
        ]),
      ),
  );

  const [selectedId, setSelectedId] = createSignal<string>();
  const [notesDismissed, setNotesDismissed] = createSignal(false);
  const [outlineOpen, setOutlineOpen] = createSignal(false);
  const selectedNote = () => {
    const id = selectedId();
    return id && details().has(id) ? (view()?.note(id).trim() ?? "") : "";
  };
  function select(id?: string) {
    batch(() => {
      setSelectedId(id);
      setNotesDismissed(false);
    });
  }
  // Ideas the owner deletes stop being selected.
  createEffect(() => {
    const id = selectedId();
    if (id && !details().has(id)) setSelectedId(undefined);
  });

  let canvas!: HTMLElement;
  const [left, setLeft] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const [zoom, setZoom] = createSignal(1);
  const [easing, setEasing] = createSignal(false);
  const [panning, setPanning] = createSignal(false);
  let easeTimer: number | undefined;
  onCleanup(() => window.clearTimeout(easeTimer));
  function moveView(next: { left: number; top: number; zoom?: number }) {
    window.clearTimeout(easeTimer);
    batch(() => {
      setEasing(true);
      setLeft(next.left);
      setTop(next.top);
      if (next.zoom !== undefined) setZoom(next.zoom);
    });
    easeTimer = window.setTimeout(() => setEasing(false), 220);
  }
  const viewOrigin = () => ({
    x: (layout().nodes[0]?.width ?? 0) / 2,
    y: NODE_MIN_HEIGHT / 2,
  });

  function fitMap() {
    const nodes = layout().nodes;
    if (!nodes.length) return;
    const bounds = {
      minX: Math.min(...nodes.map((node) => node.x)),
      minY: Math.min(...nodes.map((node) => node.y)),
      maxX: Math.max(...nodes.map((node) => node.x + node.width)),
      maxY: Math.max(...nodes.map((node) => node.y + node.height)),
    };
    const width = canvas.clientWidth - VIEW_INSETS.left - VIEW_INSETS.right;
    const height = canvas.clientHeight - VIEW_INSETS.top - VIEW_INSETS.bottom;
    const next = Math.min(
      1,
      Math.max(
        ZOOM_MIN,
        Math.min(
          width / Math.max(1, bounds.maxX - bounds.minX),
          height / Math.max(1, bounds.maxY - bounds.minY),
        ),
      ),
    );
    const origin = viewOrigin();
    moveView({
      zoom: next,
      left:
        (VIEW_INSETS.left - VIEW_INSETS.right) / 2 -
        next * ((bounds.minX + bounds.maxX) / 2 - origin.x),
      top:
        (VIEW_INSETS.top - VIEW_INSETS.bottom) / 2 -
        next * ((bounds.minY + bounds.maxY) / 2 - origin.y),
    });
  }
  // Fit once, after every idea on the first load has measured itself.
  let fitted = false;
  createEffect(() => {
    if (fitted || status() !== "ready") return;
    const ids = nodeIds();
    const sizes = nodeSizes();
    if (!ids.length || !ids.every((id) => sizes.has(id))) return;
    fitted = true;
    untrack(fitMap);
  });

  function centerOn(id: string) {
    const node = positioned().get(id);
    if (!node) return;
    const origin = viewOrigin();
    moveView({
      left: -zoom() * (node.x + node.width / 2 - origin.x),
      top: -zoom() * (node.y + node.height / 2 - origin.y),
    });
  }

  function changeZoom(value: number, clientX?: number, clientY?: number) {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    const bounds = canvas.getBoundingClientRect();
    const x =
      clientX === undefined ? 0 : clientX - bounds.left - bounds.width / 2;
    const y =
      clientY === undefined ? 0 : clientY - bounds.top - bounds.height / 2;
    const ratio = next / zoom();
    const target = {
      left: x - (x - left()) * ratio,
      top: y - (y - top()) * ratio,
      zoom: next,
    };
    if (clientX === undefined) moveView(target);
    else
      batch(() => {
        setLeft(target.left);
        setTop(target.top);
        setZoom(next);
      });
  }

  // Dragging anywhere, including over an idea, pans. A press that barely
  // moves stays a click, so ideas remain selectable.
  let pointer:
    | { id: number; x: number; y: number; left: number; top: number }
    | undefined;
  let suppressClick = false;
  function startPointer(e: PointerEvent) {
    if (
      !e.isPrimary ||
      e.button !== 0 ||
      pointer ||
      (e.target instanceof Element && e.target.closest("[data-toolbar]"))
    )
      return;
    suppressClick = false;
    pointer = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: left(),
      top: top(),
    };
  }
  function movePointer(e: PointerEvent) {
    if (!pointer || e.pointerId !== pointer.id) return;
    const dx = e.clientX - pointer.x;
    const dy = e.clientY - pointer.y;
    if (!panning()) {
      if (Math.hypot(dx, dy) < 4) return;
      canvas.setPointerCapture(e.pointerId);
      setPanning(true);
      suppressClick = true;
    }
    setLeft(pointer.left + dx);
    setTop(pointer.top + dy);
  }
  function stopPointer(e: PointerEvent) {
    if (!pointer || e.pointerId !== pointer.id) return;
    pointer = undefined;
    setPanning(false);
  }

  onMount(() => {
    const wheel = (e: WheelEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-toolbar]"))
        return;
      e.preventDefault();
      const unit =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? canvas.clientHeight
            : 1;
      // Pinches arrive as ctrl+wheel; plain scrolling pans.
      if (e.ctrlKey || e.metaKey)
        changeZoom(
          zoom() *
            Math.exp(-Math.max(-30, Math.min(30, e.deltaY * unit)) * 0.01),
          e.clientX,
          e.clientY,
        );
      else
        batch(() => {
          setLeft(
            left() - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit,
          );
          setTop(top() - (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit);
        });
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => canvas.removeEventListener("wheel", wheel));
  });

  const centered = (content: () => unknown) => (
    <div class="absolute top-1/2 left-1/2 flex w-[22rem] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 text-center">
      {content() as never}
    </div>
  );

  return (
    <section
      ref={canvas}
      tabIndex={-1}
      aria-label="Shared mind map"
      onPointerDown={startPointer}
      onPointerMove={movePointer}
      onPointerUp={stopPointer}
      onPointerCancel={stopPointer}
      onClick={(e) => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        if (
          e.target instanceof Element &&
          !e.target.closest("[data-node-id], [data-toolbar]")
        )
          select(undefined);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (outlineOpen()) setOutlineOpen(false);
          else if (selectedNote() && !notesDismissed()) setNotesDismissed(true);
          else select(undefined);
        }
      }}
      class="map-canvas overflow-hidden w-screen h-screen text-stone-900 relative touch-none select-none outline-none"
      style={{ cursor: panning() ? "grabbing" : "grab" }}
    >
      <Show when={status() === "ready"}>
        <div
          class="map-layer absolute w-full h-full origin-top-left"
          classList={{ "map-layer-easing": easing() }}
          style={{
            left: "50%",
            top: "50%",
            transform: `translate(${left()}px, ${top()}px) scale(${zoom()}) translate(${-(layout().nodes[0]?.width ?? 0) / 2}px, ${-NODE_MIN_HEIGHT / 2}px)`,
          }}
        >
          <svg
            class="map-links absolute inset-0 w-full h-full overflow-visible pointer-events-none"
            aria-hidden="true"
          >
            <For each={nodeIds()}>
              {(id) => (
                <Show when={connections().get(id)}>
                  {(connection) => (
                    <path
                      d={connectionPath(connection())}
                      fill="none"
                      class={
                        (
                          NODE_COLORS.find(
                            (option) => option.value === connection().to.color,
                          ) ?? NODE_COLORS[0]
                        ).lineClass
                      }
                    />
                  )}
                </Show>
              )}
            </For>
          </svg>
          <For each={nodeIds()}>
            {(id) => {
              const node = () => positioned().get(id)!;
              return (
                <Show when={doc()}>
                  {(current) => (
                    <Node
                      doc={current()}
                      readOnly
                      id={id}
                      text={view()?.text(id) ?? ""}
                      color={node().color}
                      x={node().x}
                      y={node().y}
                      selected={selectedId() === id}
                      writing={false}
                      dragging={false}
                      root={!details().get(id)?.parent}
                      note={!!view()?.note(id).trim()}
                      descendants={details().get(id)?.descendants ?? 0}
                      collapsed={collapsedIds().has(id)}
                      onToggleCollapse={() => toggleCollapse(id)}
                      onSize={(size) => measureNode(id, size)}
                      onSelect={() => {
                        if (!suppressClick) select(id);
                      }}
                      onWrite={() => {}}
                      onFinish={() => {}}
                      onTab={() => {}}
                      onSelectionChange={() => {}}
                      onPointerDown={() => {}}
                    />
                  )}
                </Show>
              );
            }}
          </For>
        </div>
        <Show when={!forest().length}>
          {centered(() => (
            <p class="font-display text-xl font-semibold">This map is empty</p>
          ))}
        </Show>
      </Show>

      <Show when={status() === "loading"}>
        {centered(() => (
          <p role="status" class="text-sm text-stone-500">
            Opening shared map…
          </p>
        ))}
      </Show>
      <Show when={status() === "missing"}>
        {centered(() => (
          <>
            <p class="font-display text-2xl font-semibold">
              This link isn’t shared anymore
            </p>
            <p class="text-sm leading-6 text-stone-600">
              The owner turned off sharing or removed the map. Ask them for a
              new link.
            </p>
            <a href="/" class="map-control text-accent-deep">
              Open Mindgrab
            </a>
          </>
        ))}
      </Show>
      <Show when={status() === "error"}>
        {centered(() => (
          <>
            <p class="font-display text-2xl font-semibold">
              Couldn’t open this map
            </p>
            <p class="text-sm leading-6 text-stone-600">
              Check your connection and try again.
            </p>
            <button
              type="button"
              class="map-control text-accent-deep"
              disabled={snapshot.isFetching}
              onClick={refetch}
            >
              Retry
            </button>
          </>
        ))}
      </Show>

      <div class="pointer-events-none absolute top-3 right-3 left-3 z-30 flex items-start justify-between gap-2">
        <section
          data-toolbar
          aria-label="Shared project"
          class="map-toolbar pointer-events-auto flex min-w-0 items-center gap-1 cursor-default"
        >
          <a href="/" class="shrink-0" aria-label="Mindgrab" title="Mindgrab">
            <BrandMark class="mx-1 size-6" />
          </a>
          <Show when={status() === "ready"}>
            <h1 class="project-name truncate hover:bg-transparent!">
              {name()}
            </h1>
            <span class="shrink-0 rounded-md bg-stone-100 px-1.5 py-0.5 text-[11px] font-semibold text-stone-600">
              View only
            </span>
            <Show when={!live()}>
              <span
                role="status"
                class="shrink-0 px-1 text-[11px] text-stone-500"
              >
                Reconnecting…
              </span>
            </Show>
            <span class="toolbar-divider" />
            <button
              type="button"
              class="icon-button"
              aria-label="Outline"
              title="Outline"
              aria-pressed={outlineOpen()}
              onClick={() => setOutlineOpen((open) => !open)}
            >
              <OutlineIcon />
            </button>
          </Show>
        </section>
        <a
          href="/"
          data-toolbar
          class="map-toolbar map-control pointer-events-auto shrink-0 max-sm:hidden"
        >
          Make your own map
        </a>
      </div>

      <Show when={status() === "ready" && outlineOpen()}>
        <div class="pointer-events-none absolute top-[4.5rem] bottom-3 left-3 z-20 flex w-72 max-w-[calc(100%-1.5rem)] flex-col xl:w-80 max-sm:inset-3 max-sm:z-40 max-sm:w-auto max-sm:max-w-none">
          <Outline
            roots={forest()}
            text={(id) => view()?.text(id) ?? ""}
            selectedId={selectedId()}
            collapsed={collapsedIds()}
            onSelect={(id, via) => {
              select(id);
              centerOn(id);
              if (via === "pointer" && canvas.clientWidth < 640)
                setOutlineOpen(false);
            }}
            onToggle={toggleCollapse}
            onEdit={centerOn}
            onClose={() => {
              setOutlineOpen(false);
              canvas.focus({ preventScroll: true });
            }}
          />
        </div>
      </Show>

      <Show when={selectedNote() && !notesDismissed()}>
        <div class="pointer-events-none absolute top-[4.5rem] right-3 bottom-[4.5rem] z-20 flex w-80 max-w-[calc(100%-1.5rem)] flex-col xl:w-96 max-sm:inset-3 max-sm:z-40 max-sm:w-auto max-sm:max-w-none">
          <aside
            data-toolbar
            aria-label="Notes"
            class="map-toolbar notes-panel pointer-events-auto flex flex-col cursor-default"
          >
            <header class="flex items-start justify-between gap-2 border-b border-stone-100 py-2 pr-1.5 pl-3.5">
              <div class="min-w-0">
                <h2 class="panel-title">Notes</h2>
                <p class="truncate text-xs text-stone-500">
                  {view()?.text(selectedId() ?? "") || "New idea"}
                </p>
              </div>
              <button
                type="button"
                class="icon-button size-8!"
                aria-label="Close notes"
                onClick={() => setNotesDismissed(true)}
              >
                <CloseIcon class="size-4" />
              </button>
            </header>
            <p class="min-h-0 flex-1 overflow-y-auto px-3.5 py-3 text-sm leading-6 whitespace-pre-wrap wrap-anywhere text-stone-900 select-text">
              {selectedNote()}
            </p>
          </aside>
        </div>
      </Show>

      <Show when={status() === "ready"}>
        <fieldset
          data-toolbar
          aria-label="Canvas zoom"
          class="map-toolbar absolute right-3 bottom-3 z-20 flex items-center gap-0.5 text-sm cursor-default"
        >
          <button
            type="button"
            class="icon-button"
            aria-label="Zoom out"
            disabled={zoom() <= ZOOM_MIN}
            onClick={() => changeZoom(zoom() / 1.2)}
          >
            <MinusIcon />
          </button>
          <button
            type="button"
            class="map-control min-w-14 px-1! text-xs tabular-nums max-sm:hidden"
            aria-label="Zoom to 100%"
            onClick={() => changeZoom(1)}
          >
            {Math.round(zoom() * 100)}%
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Zoom in"
            disabled={zoom() >= ZOOM_MAX}
            onClick={() => changeZoom(zoom() * 1.2)}
          >
            <PlusIcon />
          </button>
          <span class="toolbar-divider" />
          <button
            type="button"
            class="icon-button"
            aria-label="Fit map"
            disabled={!forest().length}
            onClick={fitMap}
          >
            <FitMapIcon />
          </button>
        </fieldset>
      </Show>
    </section>
  );
}
