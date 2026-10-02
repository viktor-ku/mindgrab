import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { createShortcut } from "@solid-primitives/keyboard";
import * as Y from "yjs";
import {
  connectionPath,
  findNode,
  layoutMindMap,
  navigationTarget,
  NODE_MIN_HEIGHT,
  translateSubtree as translatePreview,
} from "./mind-map";
import {
  createChild,
  createProjectDocument,
  createRoot,
  createSibling,
  deleteSubtree,
  LIMITS,
  ORIGIN,
  renameProject,
  reorderNode,
  setNodeColor,
  translateSubtree,
} from "./project-document";
import { createProjectView } from "./project-view";
import { bindTextarea } from "./text-binding";
import { retainUndoHistory } from "./undo-history";
import {
  ProjectRepository,
  accountNamespace,
  ANONYMOUS_NAMESPACE,
} from "./project-repository";
import type { CatalogEntry, ProjectHandle } from "./project-repository";
import type { ViewportPreference } from "./project-import-export";
import { NODE_COLORS } from "./node-colors";
import type { NodeColor } from "./node-colors";
import { generateProjectName } from "./project-names";
import {
  exportProjectDocument,
  parseProjectFile,
  prepareProjectImport,
  PROJECT_FILE_MAX_BYTES,
  ProjectFileError,
  readProjectFile,
  writeProjectFile,
} from "./project-import-export";
import { AccountControls } from "./AccountControls";
import { AuthSession } from "./auth-session";
import type { SessionState } from "./auth-session";
import { claimAnonymousProjects, claimCandidates } from "./anonymous-claims";
import { SyncError } from "./crdt-api";
import type {
  LayoutAnchor,
  MindMapNode,
  NodePosition,
  NodeSize,
} from "./mind-map";
import { backendDeployment } from "./backend";
import { CloudWorkspace } from "./project-sync";
import type { CloudStatus } from "./project-sync";

const ARROW_DIRECTIONS: ReadonlyMap<string, "left" | "right" | "up" | "down"> =
  new Map([
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"],
    ["ArrowUp", "up"],
    ["ArrowDown", "down"],
  ]);

function NodeEditor(props: {
  doc: Y.Doc;
  id: string;
  onFinish: () => void;
  onSelectionChange: (selection: TextSelection) => void;
}) {
  let input!: HTMLTextAreaElement;
  const reportSelection = () =>
    props.onSelectionChange({
      id: props.id,
      start: input.selectionStart,
      end: input.selectionEnd,
      direction: input.selectionDirection,
      writing: true,
    });
  const [value, setValue] = createSignal("");
  onMount(() => {
    onCleanup(bindTextarea(input, props.doc, props.id, setValue));
    const canvas = input.closest<HTMLElement>("[aria-label='Mind map canvas']");
    const scrollLeft = canvas?.scrollLeft ?? 0;
    const scrollTop = canvas?.scrollTop ?? 0;
    input.focus({ preventScroll: true });
    input.select();
    if (canvas) {
      canvas.scrollLeft = scrollLeft;
      canvas.scrollTop = scrollTop;
    }
  });

  return (
    <div class="relative min-w-px">
      <span
        class="block whitespace-pre-wrap wrap-anywhere invisible"
        aria-hidden="true"
      >
        {value() + "\u200b"}
      </span>
      <textarea
        ref={input}
        aria-label="Node text"
        rows={1}
        maxLength={LIMITS.text}
        class="absolute inset-0 w-full h-full min-w-0 resize-none overflow-hidden whitespace-pre-wrap wrap-anywhere bg-transparent p-0 text-center outline-none select-text cursor-text"
        onBlur={props.onFinish}
        onInput={reportSelection}
        onSelect={reportSelection}
        onKeyUp={reportSelection}
        onKeyDown={(e) => {
          const historyShortcut =
            (e.ctrlKey || e.metaKey) &&
            !e.altKey &&
            (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y");
          if (!historyShortcut) e.stopPropagation();
          if (e.isComposing) return;
          if (
            e.key === "Escape" ||
            (e.key === "Enter" &&
              !e.shiftKey &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey)
          ) {
            e.preventDefault();
            props.onFinish();
          }
        }}
      />
    </div>
  );
}

interface TextSelection {
  id: string;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
  writing: boolean;
}

interface UndoSelection {
  id?: string;
  writing: boolean;
  text?: TextSelection;
}

function Node(props: {
  doc: Y.Doc;
  id: string;
  text: string;
  color?: NodeColor;
  x: number;
  y: number;
  selected: boolean;
  writing: boolean;
  dragging: boolean;
  onSize: (size: NodeSize) => void;
  onSelect: () => void;
  onWrite: () => void;
  onFinish: () => void;
  onSelectionChange: (selection: TextSelection) => void;
  onPointerDown: (event: PointerEvent) => void;
}) {
  let container!: HTMLDivElement;
  const color = () =>
    NODE_COLORS.find((option) => option.value === props.color) ??
    NODE_COLORS[0];
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: The child button provides keyboard activation through event bubbling.
    // biome-ignore lint/a11y/noStaticElementInteractions: The wrapper handles pointer dragging and bubbled clicks from its button.
    <div
      ref={container}
      class={`border rounded-sm shadow-sm/10 cursor-pointer px-2.5 py-0.75 select-none absolute grid items-center box-border w-max max-w-40 leading-6 ${color().nodeClass}`}
      classList={{
        "ring-2 ring-blue-500 ring-offset-2 ring-offset-stone-200":
          props.selected,
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
      <Show
        when={props.writing}
        fallback={
          <button
            type="button"
            aria-pressed={props.selected}
            class="w-full min-w-0 whitespace-pre-wrap wrap-anywhere cursor-pointer"
          >
            {props.text || "New idea"}
          </button>
        }
      >
        <NodeEditor
          doc={props.doc}
          id={props.id}
          onFinish={props.onFinish}
          onSelectionChange={props.onSelectionChange}
        />
      </Show>
    </div>
  );
}

interface ContextMenuState {
  x: number;
  y: number;
  nodeId?: string;
  rootPosition?: NodePosition;
}

export function App(props: { onDocument?: (doc: Y.Doc) => void }) {
  const deployment = backendDeployment();
  const auth = new AuthSession(deployment);
  const [account, setAccount] = createSignal(auth.state);
  let activeUserId = auth.state.user?.id;
  let repository = new ProjectRepository({
    deployment,
    namespace: activeUserId
      ? accountNamespace(activeUserId)
      : ANONYMOUS_NAMESPACE,
  });
  let handleRepository = repository;
  let activeHandle: ProjectHandle | undefined;
  let stopDurability: (() => void) | undefined;
  let stopCatalog: (() => void) | undefined;
  let cloud: CloudWorkspace | undefined;
  let authNavigationPending = false;
  let disposed = false;
  let activation = 0;
  let claimAbort: AbortController | undefined;
  const parked = new Set<{
    repository: ProjectRepository;
    handle: ProjectHandle;
  }>();
  const [cloudStatus, setCloudStatus] = createSignal<CloudStatus>();
  const [claimCount, setClaimCount] = createSignal(0);
  const [claiming, setClaiming] = createSignal(false);
  const [claimMessage, setClaimMessage] = createSignal("");
  const [recoveryPending, setRecoveryPending] = createSignal(false);

  function startCloud() {
    if (
      auth.state.status !== "authenticated" ||
      cloud ||
      disposed ||
      authNavigationPending
    )
      return;
    const owner = repository;
    cloud = new CloudWorkspace(
      owner,
      (status) => {
        if (repository !== owner || disposed) return;
        setCloudStatus(status);
        if (status?.status === "auth") {
          auth.expire();
          // A cookie may now belong to another account. Only /me can decide
          // whether to switch workspaces or keep this account expired.
          void auth.check();
        }
      },
      () => {
        void owner
          .list()
          .then((entries) => {
            if (repository === owner && !disposed) setSavedProjects(entries);
          })
          .catch(() => {});
      },
    );
    if (activeHandle && handleRepository === owner)
      cloud.activate(activeHandle);
  }

  function ephemeralDocument() {
    return createProjectDocument(crypto.randomUUID(), generateProjectName([]), {
      text: "New idea",
    });
  }

  async function activate(handle: ProjectHandle, owner = repository) {
    const request = ++activation;
    if (disposed || owner !== repository) {
      await handle.close();
      return;
    }
    cloud?.detach();
    const previous = activeHandle;
    try {
      if (previous && previous !== handle) await previous.flush();
    } catch (error) {
      await handle.close();
      if (owner === repository && previous) cloud?.activate(previous);
      throw error;
    }
    if (disposed || request !== activation || owner !== repository) {
      await handle.close();
      return;
    }
    stopDurability?.();
    handleRepository = owner;
    activeHandle = handle;
    resetProjectUi();
    setDoc(handle.doc);
    setStorageReady(true);
    cloud?.activate(handle);
    setSaveStatus(handle.durability().status === "saved" ? "done" : "saving");
    stopDurability = handle.onDurability((durability) => {
      if (activeHandle !== handle || repository !== owner || disposed) return;
      setSaveStatus(
        durability.status === "saved"
          ? "done"
          : durability.status === "saving"
            ? "saving"
            : "error",
      );
      if (durability.status === "unsaved")
        setStorageMessage(
          `${durability.error.message} Export a copy to keep your changes.`,
        );
      else if (durability.status === "saved") setStorageMessage("");
    });
    if (previous && previous !== handle) await previous.close();
    try {
      const preference = await owner.preference(`project/${handle.id}/view`);
      if (request !== activation || disposed || owner !== repository) return;
      if (preference && typeof preference === "object") {
        const view = preference as ViewportPreference;
        setLayoutAnchor(view.anchor);
        setLeft(view.left);
        setTop(view.top);
        setZoom(view.zoom);
      }
    } catch {
      // A missing local viewport preference does not prevent opening content.
    }
  }

  async function openLatestOrCreate(target = repository) {
    const latest = await target.latestProject();
    if (target !== repository || disposed) return;
    if (latest) {
      await activate(await target.open(latest), target);
      return;
    }
    await activate(
      await target.create({
        name: generateProjectName([]),
        root: { text: "New idea" },
      }),
      target,
    );
  }

  async function initializeWorkspace() {
    await auth.hydrate();
    if (disposed) return;
    if (auth.state.user?.id !== activeUserId) await accountChanged(auth.state);
    else {
      setAccount(auth.state);
      watchCatalog(repository);
      await openLatestOrCreate(repository);
    }
    if (!disposed) auth.start();
  }

  function watchCatalog(owner: ProjectRepository) {
    const refresh = () => {
      void owner
        .list()
        .then((entries) => {
          if (repository === owner && !disposed) setSavedProjects(entries);
        })
        .catch(() => {});
    };
    stopCatalog = owner.onCatalogChange(refresh);
    refresh();
  }

  async function retireWorkspace(
    owner: ProjectRepository,
    handle?: ProjectHandle,
  ) {
    owner.detach();
    if (handle) {
      try {
        await handle.flush();
      } catch {
        parked.add({ repository: owner, handle });
        if (!disposed) setRecoveryPending(true);
        return;
      }
      await handle.close();
    }
    await owner.close();
  }

  async function refreshClaims(owner = repository) {
    const userId = activeUserId;
    if (!userId || auth.state.status !== "authenticated") return;
    const anonymous = new ProjectRepository({
      deployment,
      namespace: ANONYMOUS_NAMESPACE,
    });
    try {
      const entries = await claimCandidates(anonymous, userId);
      if (owner === repository && !disposed) setClaimCount(entries.length);
    } catch {
      // An unavailable anonymous catalog must not hide cached account content.
    } finally {
      await anonymous.close();
    }
  }

  async function accountChanged(state: SessionState) {
    if (disposed) return;
    setAccount(state);
    const nextUserId = state.user?.id;
    if (state.status !== "authenticated" || nextUserId !== activeUserId) {
      cloud?.destroy();
      cloud = undefined;
      claimAbort?.abort();
      claimAbort = undefined;
      setClaiming(false);
      setClaimCount(0);
      setCloudStatus(
        state.status === "expired"
          ? { status: "auth", message: state.message ?? "Sign in again." }
          : undefined,
      );
    }
    if (nextUserId === activeUserId) {
      startCloud();
      void refreshClaims();
      return;
    }
    activation++;
    window.clearTimeout(viewSaveTimer);
    stopCatalog?.();
    stopDurability?.();
    finishWriting();
    finishProjectName();
    const previousRepository = repository;
    const previousHandle = activeHandle;
    activeUserId = nextUserId;
    const nextRepository = new ProjectRepository({
      deployment,
      namespace: nextUserId
        ? accountNamespace(nextUserId)
        : ANONYMOUS_NAMESPACE,
    });
    repository = nextRepository;
    handleRepository = nextRepository;
    activeHandle = undefined;
    resetProjectUi();
    setDoc(ephemeralDocument());
    setStorageReady(false);
    setSavedProjects([]);
    setStorageMessage("");
    setClaimMessage("");
    watchCatalog(nextRepository);
    void retireWorkspace(previousRepository, previousHandle);
    try {
      await openLatestOrCreate(nextRepository);
    } catch {
      if (repository === nextRepository && !disposed)
        setStorageMessage(
          "Could not open this account’s local projects. Retry local saving.",
        );
    }
    if (repository === nextRepository && !disposed) {
      startCloud();
      void refreshClaims(nextRepository);
    }
  }

  async function addAnonymousProjects() {
    if (claiming() || auth.state.status !== "authenticated" || !activeUserId)
      return;
    const owner = repository;
    const userId = activeUserId;
    const abort = new AbortController();
    claimAbort = abort;
    const source = new ProjectRepository({
      deployment,
      namespace: ANONYMOUS_NAMESPACE,
    });
    setClaiming(true);
    setClaimMessage("");
    try {
      const ids = await claimAnonymousProjects(
        source,
        owner,
        userId,
        abort.signal,
      );
      if (owner !== repository || disposed || abort.signal.aborted) return;
      setClaimMessage(
        `Added ${ids.length} anonymous ${ids.length === 1 ? "project" : "projects"} to this account. Cloud saving will continue automatically.`,
      );
      await refreshClaims(owner);
      cloud?.retry();
      if (ids[0]) await openProject(ids[0]);
    } catch (error) {
      if (owner !== repository || disposed || abort.signal.aborted) return;
      setClaimMessage(
        "Could not finish adding anonymous projects. Your local work is retained; retry to continue.",
      );
      await refreshClaims(owner);
      if (error instanceof SyncError && error.kind === "auth") {
        auth.expire();
        void auth.check();
      }
    } finally {
      await source.close();
      if (claimAbort === abort) {
        claimAbort = undefined;
        setClaiming(false);
      }
    }
  }

  // The document is the only writable project content. Everything else here
  // (selection, viewport, measurements, drag previews) is local UI state.
  const [doc, setDoc] = createSignal(ephemeralDocument());
  const [historyRevision, setHistoryRevision] = createSignal(0);
  let editorSelection: TextSelection | undefined;
  const [storageReady, setStorageReady] = createSignal(false);
  const [saveStatus, setSaveStatus] = createSignal<
    "" | "saving" | "done" | "error"
  >("");
  const [storageMessage, setStorageMessage] = createSignal("");
  const session = createMemo(() => {
    const current = doc();
    const handle = activeHandle?.doc === current ? activeHandle : undefined;
    const view = createProjectView(current);
    const undo = new Y.UndoManager(current.getMap("project"), {
      trackedOrigins: new Set([ORIGIN.local]),
      // Commands are separate steps; typing groups for one focus session.
      captureTimeout: Number.POSITIVE_INFINITY,
    });
    const releaseHistoryLimit = retainUndoHistory(undo);
    let selectionBefore: UndoSelection = { writing: false };
    const captureSelection = (): UndoSelection => ({
      id: selectedId(),
      writing: writing(),
      ...(editorSelection && { text: { ...editorSelection } }),
    });
    const beforeTransaction = () => {
      selectionBefore = captureSelection();
    };
    current.on("beforeTransaction", beforeTransaction);
    undo.on("stack-item-added", ({ stackItem }) => {
      setHistoryRevision((n) => n + 1);
      stackItem.meta.set("selection-before", selectionBefore);
      queueMicrotask(() =>
        stackItem.meta.set("selection-after", captureSelection()),
      );
    });
    undo.on("stack-item-popped", ({ stackItem, type }) => {
      setHistoryRevision((n) => n + 1);
      const selection = stackItem.meta.get(
        type === "undo" ? "selection-before" : "selection-after",
      ) as UndoSelection | undefined;
      if (!selection) return;
      setSelectedId(selection.id);
      setWriting(selection.writing);
      editorSelection = selection.text;
      if (selection.writing && selection.text) {
        queueMicrotask(() => {
          const editor = canvas.querySelector<HTMLTextAreaElement>(
            '[aria-label="Node text"]',
          );
          if (!editor) return;
          editor.focus({ preventScroll: true });
          const start = Math.min(
            selection.text?.start ?? 0,
            editor.value.length,
          );
          const end = Math.min(
            selection.text?.end ?? start,
            editor.value.length,
          );
          editor.setSelectionRange(start, end, selection.text?.direction);
        });
      }
    });
    undo.on("stack-cleared", () => setHistoryRevision((n) => n + 1));
    untrack(() => props.onDocument?.(current));
    onCleanup(() => {
      undo.destroy();
      releaseHistoryLimit();
      current.off("beforeTransaction", beforeTransaction);
      // Handle lifetime belongs to the workspace; failed writes stay recoverable.
      if (!handle) current.destroy();
    });
    return { doc: current, view, undo };
  });
  const view = () => session().view;
  const forest = () => view().forest();

  // Each command is its own undo step, never merged with typing around it.
  function command<T>(action: (doc: Y.Doc) => T): T {
    const { doc, undo } = session();
    undo.stopCapturing();
    try {
      return action(doc);
    } finally {
      undo.stopCapturing();
    }
  }

  // Undefined while the name field is not being edited.
  const [projectNameDraft, setProjectNameDraft] = createSignal<string>();
  const [savedProjects, setSavedProjects] = createSignal<CatalogEntry[]>([]);
  const [showLoad, setShowLoad] = createSignal(false);
  const [fileBusy, setFileBusy] = createSignal(false);

  function clearSaveStatus() {
    setSaveStatus("");
  }

  onCleanup(clearSaveStatus);
  const [selectedId, setSelectedId] = createSignal<string>();
  const [colorScope, setColorScope] = createSignal<"node" | "branch">("node");
  const [writing, setWriting] = createSignal(false);
  const [contextMenu, setContextMenu] = createSignal<
    ContextMenuState | undefined
  >();
  const [nodeSizes, setNodeSizes] = createSignal(new Map<string, NodeSize>());
  const measuredSizes = new Map<string, NodeSize>();
  let sizeFrame: number | undefined;
  // ResizeObserver delivers one callback per mounted node. Publish their sizes
  // once per frame so opening a large map performs one layout, not N layouts.
  function measureNode(id: string, size: NodeSize) {
    measuredSizes.set(id, size);
    if (sizeFrame !== undefined) return;
    sizeFrame = requestAnimationFrame(() => {
      sizeFrame = undefined;
      const live = visibleIds();
      setNodeSizes((current) => {
        let next = current;
        for (const [id, size] of measuredSizes) {
          if (!live.has(id)) continue;
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
      measuredSizes.clear();
    });
  }
  onCleanup(() => {
    if (sizeFrame !== undefined) cancelAnimationFrame(sizeFrame);
    measuredSizes.clear();
  });
  const [layoutAnchor, setLayoutAnchor] = createSignal<LayoutAnchor>();
  // A drag renders as a local preview over the current document and commits
  // once on release.
  const [drag, setDrag] = createSignal<{ id: string; delta: NodePosition }>();
  const draggingId = () => drag()?.id;
  const baseLayout = createMemo(() =>
    layoutMindMap(forest(), nodeSizes(), layoutAnchor()),
  );
  const basePositions = createMemo(
    () => new Map(baseLayout().nodes.map((node) => [node.id, node])),
  );
  const layout = createMemo(() => {
    const preview = drag();
    if (!preview) return baseLayout();
    return layoutMindMap(
      translatePreview(forest(), preview.id, basePositions(), preview.delta),
      nodeSizes(),
      layoutAnchor(),
    );
  });
  const positionedNodes = createMemo(
    () => new Map(layout().nodes.map((node) => [node.id, node])),
  );
  const visibleIds = createMemo(() => {
    const ids = new Set<string>();
    const visit = (nodes: MindMapNode[]) => {
      for (const node of nodes) {
        ids.add(node.id);
        visit(node.next ?? []);
      }
    };
    visit(forest());
    return ids;
  });
  const selectedNode = createMemo(() => {
    const id = selectedId();
    return id ? findNode(forest(), id) : undefined;
  });
  const selectedText = () => {
    const id = selectedId();
    return id ? view().text(id) : "";
  };
  const nodeIds = createMemo(() => layout().nodes.map((node) => node.id));
  const [left, setLeft] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const [zoom, setZoom] = createSignal(1);
  const [panning, setPanning] = createSignal(false);
  let canvas!: HTMLDivElement;
  let contextMenuElement: HTMLDivElement | undefined;
  let pointer:
    | {
        id: number;
        x: number;
        y: number;
        left: number;
        top: number;
        zoom: number;
        nodeId?: string;
      }
    | undefined;
  let suppressClick = false;

  let viewSaveTimer: number | undefined;
  createEffect(() => {
    const handle = activeHandle;
    const owner = handleRepository;
    const currentDoc = doc();
    const value: ViewportPreference = {
      left: left(),
      top: top(),
      zoom: zoom(),
      anchor: layoutAnchor(),
    };
    if (!handle || handle.doc !== currentDoc) return;
    window.clearTimeout(viewSaveTimer);
    viewSaveTimer = window.setTimeout(() => {
      if (repository !== owner || activeHandle !== handle) return;
      void owner
        .setPreference(`project/${handle.id}/view`, value)
        .catch(() => {});
    }, 200);
  });
  onCleanup(() => window.clearTimeout(viewSaveTimer));

  // Nodes can disappear through remote edits or undo, including the one being
  // edited; local state that refers to them is released.
  createEffect(() => {
    const ids = visibleIds();
    const id = selectedId();
    if (id && !ids.has(id))
      untrack(() => {
        finishWriting();
        setSelectedId(undefined);
        setColorScope("node");
      });
    setNodeSizes((current) =>
      [...current.keys()].every((key) => ids.has(key))
        ? current
        : new Map([...current].filter(([key]) => ids.has(key))),
    );
  });

  // Discards only the local preview; the document is left untouched.
  function cancelPointer() {
    if (!pointer) return;
    const id = pointer.id;
    pointer = undefined;
    batch(() => {
      setDrag(undefined);
      setPanning(false);
    });
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }

  function resetProjectUi() {
    clearSaveStatus();
    finishWriting();
    editorSelection = undefined;
    cancelPointer();
    suppressClick = false;
    batch(() => {
      setProjectNameDraft(undefined);
      setSelectedId(undefined);
      setColorScope("node");
      setNodeSizes(new Map());
      setLayoutAnchor(undefined);
      setLeft(0);
      setTop(0);
      setZoom(1);
      setShowLoad(false);
    });
    canvas.focus({ preventScroll: true });
  }

  async function openProject(id: string) {
    const target = repository;
    try {
      await activeHandle?.flush();
      const handle = await target.open(id);
      await activate(handle, target);
      if (target !== repository || disposed) return;
      const state = handle.state();
      setStorageMessage(
        state.status === "ready"
          ? `Loaded “${state.content.metadata.name}”.`
          : "Project is still loading.",
      );
    } catch (error) {
      if (target !== repository || disposed) return;
      setStorageMessage(
        error instanceof Error ? error.message : "Could not open this project.",
      );
    }
  }

  async function createNewProject() {
    const target = repository;
    try {
      await activeHandle?.flush();
      const projects = await target.list();
      const name = generateProjectName(projects.map((project) => project.name));
      const handle = await target.create({
        name,
        root: { text: "New idea" },
      });
      await activate(handle, target);
      if (target !== repository || disposed) return;
      setStorageMessage("");
    } catch (error) {
      if (target !== repository || disposed) return;
      setStorageMessage(
        error instanceof Error ? error.message : "Could not create a project.",
      );
    }
  }

  function finishProjectName() {
    const name = projectNameDraft()?.trim();
    setProjectNameDraft(undefined);
    if (!name) return;
    try {
      command((doc) => renameProject(doc, name));
    } catch {
      setStorageMessage("Project names can be at most 200 bytes long.");
    }
  }

  async function save() {
    finishWriting();
    finishProjectName();
    if (!activeHandle) {
      setStorageMessage("Project storage is still opening.");
      return;
    }
    const owner = repository;
    const handle = activeHandle;
    setShowLoad(false);
    setSaveStatus("saving");
    try {
      await handle.flush();
      if (repository !== owner || activeHandle !== handle || disposed) return;
      setSaveStatus("done");
      setStorageMessage("Saved locally.");
    } catch (error) {
      if (repository !== owner || activeHandle !== handle || disposed) return;
      setSaveStatus("error");
      setStorageMessage(
        error instanceof Error ? error.message : "Could not save this project.",
      );
    }
  }

  async function retryLocalSaving() {
    if (!activeHandle) await initializeWorkspace();
    for (const recovery of [...parked]) {
      await recovery.handle.flush();
      await recovery.handle.close();
      await recovery.repository.close();
      parked.delete(recovery);
    }
    setRecoveryPending(parked.size > 0);
    if (activeHandle) await activeHandle.flush();
    else {
      const owner = repository;
      const current = doc();
      const handle = await owner.open(current.guid);
      Y.applyUpdate(handle.doc, Y.encodeStateAsUpdate(current), ORIGIN.import);
      await handle.flush();
      await handle.refreshMetadata();
      await activate(handle, owner);
    }
  }

  async function saveBeforeAuth(action: "login" | "logout") {
    finishWriting();
    finishProjectName();
    clearSaveStatus();
    const owner = repository;
    const handle = activeHandle;
    if (!handle || claiming()) {
      setStorageMessage("Wait for local project storage before leaving.");
      return false;
    }
    authNavigationPending = true;
    cloud?.destroy();
    cloud = undefined;
    owner.setRelaysPaused(true);
    let leaving = false;
    try {
      await retryLocalSaving();
      if (repository !== owner || activeHandle !== handle || disposed)
        return false;
      await handle.refreshMetadata();
      await owner.setLatestProject(handle.id);
      await owner.setPreference(`project/${handle.id}/view`, {
        left: left(),
        top: top(),
        zoom: zoom(),
        anchor: layoutAnchor(),
      });
      await handle.flush();
      if (repository !== owner || activeHandle !== handle || disposed)
        return false;
      await auth.prepareNavigation(action);
      leaving = true;
      return true;
    } catch {
      if (repository !== owner || disposed) return false;
      setStorageMessage(
        "Could not save your project before leaving. Free up browser storage and try again.",
      );
      return false;
    } finally {
      if (!leaving) {
        authNavigationPending = false;
        owner.setRelaysPaused(false);
        startCloud();
      }
    }
  }

  async function openLoad() {
    clearSaveStatus();
    finishWriting();
    const owner = repository;
    try {
      cloud?.retry();
      const entries = await owner.list();
      if (repository !== owner || disposed) return;
      setSavedProjects(entries);
      setStorageMessage("");
      setShowLoad(true);
    } catch {
      if (repository !== owner || disposed) return;
      setStorageMessage(
        "Could not list projects. Browser storage is unavailable.",
      );
    }
  }

  function load(id: string) {
    void openProject(id);
  }

  async function exportCurrentProject() {
    finishWriting();
    finishProjectName();
    setFileBusy(true);
    try {
      const name = view().name();
      const json = exportProjectDocument(session().doc, {
        viewport: { left: left(), top: top(), zoom: zoom() },
        ...(layoutAnchor() && { anchor: layoutAnchor() }),
      });
      await writeProjectFile(name, json);
      setStorageMessage(`Exported “${name}”.`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStorageMessage(
          error instanceof Error
            ? error.message
            : "Could not export this project.",
        );
      }
    } finally {
      setFileBusy(false);
    }
  }

  async function importProjectFromFile() {
    finishWriting();
    setFileBusy(true);
    const owner = repository;
    try {
      const file = await readProjectFile();
      if (!file || owner !== repository || disposed) return;
      if (file.size > PROJECT_FILE_MAX_BYTES)
        throw new ProjectFileError(
          "Project file exceeds the 10 MiB size limit.",
        );
      const imported = parseProjectFile(await file.text());
      if (owner !== repository || disposed) return;
      const { content, preferences } = prepareProjectImport(imported);
      await activeHandle?.flush();
      if (owner !== repository || disposed) return;
      const handle = await owner.importContent(content);
      if (owner !== repository || disposed) {
        await handle.close();
        return;
      }
      if (preferences)
        await owner
          .setPreference(`project/${handle.id}/view`, {
            left: 0,
            top: 0,
            zoom: 1,
            ...preferences.viewport,
            ...(preferences.anchor && { anchor: preferences.anchor }),
          })
          .catch(() => {});
      await activate(handle, owner);
      if (owner !== repository || disposed) return;
      await owner.setLatestProject(handle.id).catch(() => {});
      setStorageMessage(`Imported “${content.metadata.name}”.`);
    } catch (error) {
      if (owner !== repository || disposed) return;
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStorageMessage(
          error instanceof Error
            ? error.message
            : "Could not import this project file.",
        );
      }
    } finally {
      setFileBusy(false);
    }
  }

  // Reverts this session's own changes only; remote edits are preserved.
  function undo() {
    const { undo } = session();
    undo.stopCapturing();
    undo.undo();
    canvas.focus({ preventScroll: true });
  }

  function redo() {
    const { undo } = session();
    undo.stopCapturing();
    undo.redo();
    canvas.focus({ preventScroll: true });
  }

  const canUndo = () => {
    historyRevision();
    return session().undo.canUndo();
  };
  const canRedo = () => {
    historyRevision();
    return session().undo.canRedo();
  };

  function recordEditorSelection(selection: TextSelection) {
    editorSelection = selection;
  }

  function select(id: string) {
    if (suppressClick) return;
    if (selectedId() !== id) {
      finishWriting();
      setColorScope("node");
    }
    setSelectedId(id);
  }

  // One editing session is one undo step.
  function finishWriting() {
    if (!writing()) return;
    setWriting(false);
    session().undo.stopCapturing();
    canvas.focus({ preventScroll: true });
  }

  function write(id: string) {
    if (writing() && selectedId() === id) return;
    finishWriting();
    if (selectedId() !== id) setColorScope("node");
    setSelectedId(id);
    session().undo.stopCapturing();
    setWriting(true);
  }

  function openContextMenu(e: MouseEvent) {
    const target = e.target instanceof Element ? e.target : undefined;
    const toolbar = target?.closest("[data-toolbar]");
    const nodeElement = target?.closest<HTMLElement>("[data-node-id]");
    if (toolbar) {
      setContextMenu(undefined);
      return;
    }

    e.preventDefault();
    finishWriting();
    const nodeId = nodeElement?.dataset.nodeId;
    setSelectedId(nodeId);

    const bounds = canvas.getBoundingClientRect();
    const rootPosition = nodeId
      ? undefined
      : {
          x:
            (e.clientX -
              bounds.left -
              bounds.width / 2 -
              left() +
              canvas.scrollLeft) /
            zoom(),
          y:
            (e.clientY -
              bounds.top -
              bounds.height / 2 -
              top() +
              canvas.scrollTop) /
            zoom(),
        };

    const menuWidth = 208;
    const menuHeight = nodeId ? 104 : 56;
    setContextMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - menuHeight - 8)),
      nodeId,
      rootPosition,
    });
  }

  function add(kind: "child" | "sibling" | "root", position?: NodePosition) {
    finishWriting();
    const init = { text: "New idea", ...(position && { position }) };
    const id = selectedId();
    const anchorId =
      kind === "sibling"
        ? (layout().connections.find(({ to }) => to.id === id)?.from.id ?? id)
        : kind === "child"
          ? id
          : undefined;
    batch(() => {
      const anchor = positionedNodes().get(anchorId ?? forest()[0]?.id);
      setLayoutAnchor(
        anchor && { id: anchor.id, centerY: anchor.y + anchor.height / 2 },
      );
      const created = command((doc) =>
        kind === "root" || !id
          ? createRoot(doc, init)
          : kind === "child"
            ? createChild(doc, id, init)
            : createSibling(doc, id, init),
      );
      if (created) write(created);
    });
  }

  function removeSelected() {
    const id = selectedId();
    if (!id) return;
    finishWriting();
    command((doc) => deleteSubtree(doc, id));
    setSelectedId(undefined);
    setColorScope("node");
    canvas.focus({ preventScroll: true });
  }

  function colorSelectedNode(color: NodeColor) {
    const id = selectedId();
    if (!id || writing()) return;
    command((doc) => setNodeColor(doc, id, color, colorScope() === "branch"));
  }

  function changeZoom(value: number, clientX?: number, clientY?: number) {
    const next = Math.min(2.5, Math.max(0.25, value));
    const bounds = canvas.getBoundingClientRect();
    const x =
      (clientX ?? bounds.left + bounds.width / 2) -
      bounds.left -
      bounds.width / 2;
    const y =
      (clientY ?? bounds.top + bounds.height / 2) -
      bounds.top -
      bounds.height / 2;
    const ratio = next / zoom();
    setLeft(x - (x - left()) * ratio);
    setTop(y - (y - top()) * ratio);
    setZoom(next);
  }

  function startPointer(e: PointerEvent, nodeId?: string) {
    if (
      !storageReady() ||
      !e.isPrimary ||
      e.button !== 0 ||
      pointer ||
      (nodeId && writing() && selectedId() === nodeId)
    )
      return;
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
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: left(),
      top: top(),
      zoom: zoom(),
      nodeId,
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
      if (!drag() && Math.hypot(dx, dy) < 6) return;
      canvas.setPointerCapture(e.pointerId);
      suppressClick = true;
      setDrag({
        id: pointer.nodeId,
        delta: { x: dx / pointer.zoom, y: dy / pointer.zoom },
      });
    } else {
      setLeft(pointer.left + dx);
      setTop(pointer.top + dy);
    }
  }

  // The commit starts from the document's current positions, so remote moves
  // made during the drag survive and remotely deleted nodes are skipped.
  function stopPointer(e: PointerEvent, commit: boolean) {
    if (!pointer || e.pointerId !== pointer.id) return;
    if (commit && drag()) {
      movePointer(e);
      const { id, delta } = drag() as { id: string; delta: NodePosition };
      batch(() => {
        command((doc) => translateSubtree(doc, id, basePositions(), delta));
        setDrag(undefined);
      });
    }
    cancelPointer();
  }

  onMount(() => {
    const stopAuth = auth.subscribe((state) => void accountChanged(state));
    void initializeWorkspace().catch((error) => {
      if (disposed) return;
      setStorageMessage(
        error instanceof Error
          ? error.message
          : "Could not open local project storage.",
      );
    });
    onCleanup(() => {
      disposed = true;
      activation++;
      claimAbort?.abort();
      stopAuth();
      auth.destroy();
      cloud?.destroy();
      stopCatalog?.();
      stopDurability?.();
      void repository.close();
      for (const recovery of parked) void recovery.repository.close();
    });

    const keydown = (e: KeyboardEvent) => {
      if (
        !storageReady() ||
        e.isComposing ||
        writing() ||
        (e.target instanceof Element &&
          e.target.closest("textarea, input, [contenteditable=true]"))
      )
        return;
      if (contextMenu()) {
        if (e.key === "Escape") {
          e.preventDefault();
          setContextMenu(undefined);
          canvas.focus({ preventScroll: true });
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelPointer();
        setSelectedId(undefined);
        setColorScope("node");
        canvas.focus({ preventScroll: true });
        return;
      }
      if (pointer) return;
      if (
        !selectedId() &&
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !(e.target instanceof Element && e.target.closest("[data-toolbar]"))
      ) {
        e.preventDefault();
        add("root");
        return;
      }
      if (
        !selectedId() ||
        (e.target instanceof Element && e.target.closest("[data-toolbar]"))
      )
        return;
      const arrow = ARROW_DIRECTIONS.get(e.key);
      if (
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        ((e.key === "Delete" && !e.metaKey) ||
          (e.key === "Backspace" && e.metaKey))
      ) {
        e.preventDefault();
        removeSelected();
      } else if (
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.key === "Tab" || e.key === "Enter")
      ) {
        e.preventDefault();
        add(e.key === "Tab" ? "child" : "sibling");
      } else if (
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        e.preventDefault();
        const id = selectedId() as string;
        command((doc) => reorderNode(doc, id, e.key === "ArrowUp" ? -1 : 1));
      } else if (
        arrow &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        const target = navigationTarget(forest(), selectedId()!, arrow);
        if (target) {
          setColorScope("node");
          setSelectedId(target);
        }
      } else if (e.key === "F2") {
        e.preventDefault();
        write(selectedId()!);
      }
    };
    const wheel = (e: WheelEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest("[data-toolbar], textarea")
      )
        return;
      e.preventDefault();
      if (!pointer)
        changeZoom(zoom() * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
    };
    const saveShortcut = (event: KeyboardEvent | null) => {
      if (
        !event ||
        event.isComposing ||
        writing() ||
        (event.target instanceof Element &&
          event.target.closest("textarea, input, [contenteditable=true]"))
      )
        return;
      event.preventDefault();
      save();
    };
    const historyShortcut = (
      event: KeyboardEvent | null,
      action: "undo" | "redo",
    ) => {
      if (
        !event ||
        event.isComposing ||
        !storageReady() ||
        contextMenu() ||
        pointer
      )
        return;
      const target = event.target;
      const textEditor =
        target instanceof Element &&
        target.matches('textarea[aria-label="Node text"]');
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable=true]") &&
        !textEditor
      )
        return;
      if (writing() && !textEditor) return;
      event.preventDefault();
      if (textEditor) {
        const manager = session().undo;
        manager.stopCapturing();
        if (action === "undo") manager.undo();
        else manager.redo();
      } else if (action === "undo") undo();
      else redo();
    };
    // Let the callback decide whether the target accepts text before suppressing
    // the browser's native save dialog.
    createShortcut(["Control", "S"], saveShortcut, { preventDefault: false });
    createShortcut(["Meta", "S"], saveShortcut, { preventDefault: false });
    createShortcut(
      ["Control", "Z"],
      (event) => historyShortcut(event, "undo"),
      { preventDefault: false },
    );
    createShortcut(["Meta", "Z"], (event) => historyShortcut(event, "undo"), {
      preventDefault: false,
    });
    createShortcut(
      ["Control", "Shift", "Z"],
      (event) => historyShortcut(event, "redo"),
      { preventDefault: false },
    );
    createShortcut(
      ["Meta", "Shift", "Z"],
      (event) => historyShortcut(event, "redo"),
      { preventDefault: false },
    );
    createShortcut(
      ["Control", "Y"],
      (event) => historyShortcut(event, "redo"),
      { preventDefault: false },
    );
    createShortcut(["Meta", "Y"], (event) => historyShortcut(event, "redo"), {
      preventDefault: false,
    });
    window.addEventListener("keydown", keydown);
    const dismissContextMenu = (e: PointerEvent) => {
      if (
        !(e.target instanceof Element) ||
        !e.target.closest("[data-context-menu]")
      )
        setContextMenu(undefined);
    };
    window.addEventListener("pointerdown", dismissContextMenu);
    window.addEventListener("pointerup", stopOutside);
    canvas.addEventListener("wheel", wheel, { passive: false });
    function stopOutside(e: PointerEvent) {
      stopPointer(e, true);
    }
    onCleanup(() => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("pointerdown", dismissContextMenu);
      window.removeEventListener("pointerup", stopOutside);
      canvas.removeEventListener("wheel", wheel);
    });
  });

  createEffect(() => {
    if (!contextMenu()) return;
    queueMicrotask(() => {
      contextMenuElement
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
    });
  });

  return (
    <section
      ref={canvas}
      tabIndex={-1}
      aria-label="Mind map canvas"
      data-storage-ready={storageReady()}
      onPointerDown={(e) => {
        if (e.target instanceof Element && e.target.closest("[data-no-pan]"))
          return;
        startPointer(e);
      }}
      onPointerMove={movePointer}
      onPointerUp={(e) => stopPointer(e, true)}
      onPointerCancel={(e) => stopPointer(e, false)}
      onLostPointerCapture={(e) => stopPointer(e, false)}
      onContextMenu={openContextMenu}
      class="overflow-hidden w-screen h-screen bg-stone-200 text-stone-900 relative touch-none select-none outline-none"
      style={{ cursor: panning() || draggingId() ? "grabbing" : "grab" }}
    >
      <div
        data-no-pan
        data-toolbar
        class="map-toolbar absolute top-4 left-4 z-20 flex w-64 max-w-[calc(100%-2rem)] flex-col gap-1 cursor-default"
      >
        <label class="flex flex-col gap-1">
          <span class="px-2 pt-1 text-xs font-medium text-stone-500">
            Project name
          </span>
          <input
            type="text"
            required
            class="min-w-0 rounded-md px-2 py-1 text-base select-text cursor-text outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            value={projectNameDraft() ?? view().name()}
            onInput={(e) => setProjectNameDraft(e.currentTarget.value)}
            onBlur={finishProjectName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        <fieldset
          class="flex flex-wrap items-center text-sm"
          aria-label="Project actions"
          disabled={fileBusy()}
        >
          <button
            type="button"
            class="map-control"
            disabled={!storageReady()}
            onClick={() => void createNewProject()}
          >
            New
          </button>
          <button
            type="button"
            class="map-control"
            disabled={!storageReady()}
            onClick={save}
          >
            Save
          </button>
          <button
            type="button"
            class="map-control"
            aria-label="Undo"
            disabled={!storageReady() || !canUndo()}
            onClick={undo}
          >
            Undo
          </button>
          <button
            type="button"
            class="map-control"
            aria-label="Redo"
            disabled={!storageReady() || !canRedo()}
            onClick={redo}
          >
            Redo
          </button>
          <button
            type="button"
            class="map-control"
            aria-expanded={showLoad()}
            aria-controls="saved-projects"
            disabled={!storageReady()}
            onClick={() => (showLoad() ? setShowLoad(false) : void openLoad())}
          >
            Load
          </button>
          <button
            type="button"
            class="map-control"
            disabled={!storageReady()}
            onClick={() => void importProjectFromFile()}
          >
            Import
          </button>
          <button
            type="button"
            class="map-control"
            onClick={() => void exportCurrentProject()}
          >
            Export
          </button>
          <span role="status" class="ml-auto px-2 text-xs text-stone-500">
            {saveStatus() === "saving"
              ? "Saving…"
              : saveStatus() === "done"
                ? "Saved locally"
                : saveStatus() === "error"
                  ? "Save failed"
                  : ""}
          </span>
        </fieldset>
        <Show when={cloudStatus()}>
          {(status) => (
            <div class="flex items-center gap-1 px-2 py-1 text-xs text-stone-500">
              <span role="status">
                {status().status === "saved"
                  ? "Saved to cloud"
                  : status().status === "saving"
                    ? "Saving to cloud…"
                    : status().status === "offline"
                      ? "Offline · cloud save pending"
                      : "message" in status()
                        ? (status() as { message: string }).message
                        : ""}
              </span>
              <Show
                when={["retrying", "blocked", "auth"].includes(status().status)}
              >
                <button
                  type="button"
                  class="map-control"
                  onClick={() => {
                    if (account().status === "expired") void auth.check();
                    else cloud?.retry();
                  }}
                >
                  Retry
                </button>
              </Show>
            </div>
          )}
        </Show>
        <Show when={showLoad()}>
          <div id="saved-projects" class="border-t border-stone-200 pt-2">
            <p class="px-2 text-xs text-stone-500">Saved in this browser</p>
            <ul class="max-h-60 overflow-y-auto text-sm">
              <For
                each={savedProjects()}
                fallback={
                  <li class="px-2 py-2 text-stone-500">
                    No saved projects yet.
                  </li>
                }
              >
                {(project) => (
                  <li>
                    <button
                      type="button"
                      class="map-control w-full text-left whitespace-normal! break-words"
                      onClick={() => load(project.id)}
                    >
                      {project.name} · {project.id.slice(0, 8)}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={view().status() === "unsupported"}>
          <p role="alert" class="px-2 text-xs text-stone-600">
            This project needs a newer application version. Its local data is
            retained. Reconnect, wait for Saved locally, then close all Mindgrab
            tabs and reopen to update. Do not clear browser storage.
          </p>
        </Show>
        <p role="status" class="px-2 text-xs text-stone-600 empty:hidden">
          {storageMessage()}
        </p>
        <Show when={recoveryPending()}>
          <p role="status" class="px-2 text-xs text-stone-600">
            Edits from the previous account could not be saved. They remain in
            memory; retry before leaving.
          </p>
        </Show>
        <Show
          when={
            recoveryPending() || !storageReady() || saveStatus() === "error"
          }
        >
          <button
            type="button"
            class="map-control text-xs"
            onClick={() =>
              void retryLocalSaving().catch(() =>
                setStorageMessage(
                  "Browser storage is still unavailable. Free up space and retry.",
                ),
              )
            }
          >
            Retry local saving
          </button>
        </Show>
        <AccountControls
          state={account()}
          beforeNavigate={saveBeforeAuth}
          onRetry={() => void auth.check()}
          claimCount={claimCount()}
          claiming={claiming()}
          claimMessage={claimMessage()}
          onClaim={() => void addAnonymousProjects()}
        />
      </div>
      <Show when={selectedId() && !writing()}>
        <section
          data-no-pan
          data-toolbar
          aria-label="Selected node color controls"
          class="node-color-panel map-toolbar absolute top-4 right-4 z-20 flex flex-col gap-2 cursor-default"
        >
          <div class="px-2 pt-1">
            <p class="text-xs font-medium text-stone-500">Node color</p>
            <p class="max-w-60 truncate text-sm font-semibold text-stone-800">
              {selectedText() || "New idea"}
            </p>
          </div>
          <fieldset class="grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1">
            <legend class="sr-only">Apply color to</legend>
            <label
              class="color-scope"
              classList={{ "color-scope-selected": colorScope() === "node" }}
            >
              <input
                class="sr-only"
                type="radio"
                name="node-color-scope"
                value="node"
                checked={colorScope() === "node"}
                onChange={() => setColorScope("node")}
              />
              <span>This node</span>
            </label>
            <label
              class="color-scope"
              classList={{
                "color-scope-selected": colorScope() === "branch",
              }}
            >
              <input
                class="sr-only"
                type="radio"
                name="node-color-scope"
                value="branch"
                checked={colorScope() === "branch"}
                onChange={() => setColorScope("branch")}
              />
              <span>This branch</span>
            </label>
          </fieldset>
          <fieldset class="grid grid-cols-4 gap-1 px-1 pb-1">
            <legend class="sr-only">
              Choose a color for{" "}
              {colorScope() === "node" ? "this node" : "this branch"}
            </legend>
            <For each={NODE_COLORS}>
              {(color) => (
                <button
                  type="button"
                  class="color-choice"
                  aria-label={`${color.label}${(selectedNode()?.color ?? "blue") === color.value ? ", selected" : ""}`}
                  aria-pressed={
                    (selectedNode()?.color ?? "blue") === color.value
                  }
                  title={`${color.label} · ${colorScope() === "node" ? "This node" : "This branch"}`}
                  onClick={() => colorSelectedNode(color.value)}
                >
                  <span
                    aria-hidden="true"
                    class={`grid size-8 place-items-center rounded-full border-2 ${color.swatchClass}`}
                  >
                    <Show
                      when={(selectedNode()?.color ?? "blue") === color.value}
                    >
                      <svg
                        viewBox="0 0 20 20"
                        fill="none"
                        class="size-4 text-slate-950"
                        aria-hidden="true"
                      >
                        <path
                          d="m4 10 4 4 8-8"
                          stroke="currentColor"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2.5"
                        />
                      </svg>
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </fieldset>
          <p class="px-2 pb-1 text-xs text-stone-500">
            {colorScope() === "node"
              ? "Changes only the selected node."
              : "Changes this node and all its descendants."}
          </p>
        </section>
      </Show>
      <div
        class="absolute w-full h-full origin-top-left"
        style={{
          left: "50%",
          top: "50%",
          transform: `translate(${left()}px, ${top()}px) scale(${zoom()}) translate(${-(layout().nodes[0]?.width ?? 0) / 2}px, ${-NODE_MIN_HEIGHT / 2}px)`,
        }}
      >
        <svg
          class="absolute inset-0 w-full h-full overflow-visible pointer-events-none stroke-stone-700"
          aria-hidden="true"
        >
          <For each={layout().connections}>
            {(connection) => (
              <path
                d={connectionPath(connection)}
                fill="none"
                stroke-width="1"
              />
            )}
          </For>
        </svg>
        <For each={nodeIds()}>
          {(id) => {
            const node = () => positionedNodes().get(id)!;
            return (
              <Node
                doc={session().doc}
                id={id}
                text={view().text(id)}
                color={node().color}
                x={node().x}
                y={node().y}
                selected={selectedId() === id}
                writing={selectedId() === id && writing()}
                dragging={draggingId() === id}
                onSize={(size) => measureNode(id, size)}
                onSelect={() => select(id)}
                onWrite={() => write(id)}
                onFinish={() => {
                  if (selectedId() === id) finishWriting();
                }}
                onSelectionChange={recordEditorSelection}
                onPointerDown={(e) => startPointer(e, id)}
              />
            );
          }}
        </For>
      </div>
      <Show when={!forest().length}>
        <div
          data-no-pan
          data-toolbar
          class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center cursor-default"
        >
          <p class="mb-3">Your canvas is empty.</p>
          <button type="button" class="map-control" onClick={() => add("root")}>
            Create an idea
          </button>
        </div>
      </Show>
      <Show when={contextMenu()}>
        <div
          ref={contextMenuElement}
          data-no-pan
          data-toolbar
          data-context-menu
          role="menu"
          aria-label={contextMenu()?.nodeId ? "Node actions" : "Canvas actions"}
          class="map-toolbar fixed z-50 flex min-w-52 flex-col gap-1 text-sm cursor-default"
          style={{
            left: `${contextMenu()?.x ?? 0}px`,
            top: `${contextMenu()?.y ?? 0}px`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu(undefined);
              canvas.focus({ preventScroll: true });
              return;
            }
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]',
              ),
            );
            const current = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const direction = e.key === "ArrowDown" ? 1 : -1;
            items[(current + direction + items.length) % items.length]?.focus();
          }}
        >
          <Show
            when={contextMenu()?.nodeId}
            fallback={
              <button
                type="button"
                role="menuitem"
                class="map-control w-full text-left"
                onClick={() => {
                  const position = contextMenu()?.rootPosition;
                  setContextMenu(undefined);
                  add("root", position);
                }}
              >
                Create root node
              </button>
            }
          >
            <button
              type="button"
              role="menuitem"
              class="map-control w-full text-left"
              onClick={() => {
                const id = contextMenu()?.nodeId;
                setContextMenu(undefined);
                if (id) {
                  setSelectedId(id);
                  removeSelected();
                }
              }}
            >
              Delete
            </button>
            <button
              type="button"
              role="menuitem"
              class="map-control w-full text-left"
              onClick={() => {
                const id = contextMenu()?.nodeId;
                setContextMenu(undefined);
                if (id) {
                  setSelectedId(id);
                  add("child");
                }
              }}
            >
              Add child node
            </button>
          </Show>
        </div>
      </Show>
      <fieldset
        data-no-pan
        data-toolbar
        aria-label="Canvas zoom"
        class="map-toolbar absolute bottom-4 right-4 flex items-center text-sm cursor-default"
      >
        <button
          type="button"
          class="map-control"
          aria-label="Zoom out"
          disabled={zoom() <= 0.25}
          onClick={() => changeZoom(zoom() / 1.2)}
        >
          −
        </button>
        <button
          type="button"
          class="map-control min-w-14 tabular-nums"
          aria-label="Reset view"
          title="Reset view"
          onClick={() => {
            setLeft(0);
            setTop(0);
            setZoom(1);
          }}
        >
          {Math.round(zoom() * 100)}%
        </button>
        <button
          type="button"
          class="map-control"
          aria-label="Zoom in"
          disabled={zoom() >= 2.5}
          onClick={() => changeZoom(zoom() * 1.2)}
        >
          +
        </button>
      </fieldset>
    </section>
  );
}
