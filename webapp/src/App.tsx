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
  materializeProject,
  ORIGIN,
  projectMindMap,
  renameProject,
  reorderNode,
  setNodeColor,
  translateSubtree,
} from "./project-document";
import { openSnapshot, snapshotProject } from "./project-snapshot";
import { createProjectView } from "./project-view";
import { bindTextarea } from "./text-binding";
import { retainUndoHistory } from "./undo-history";
import {
  ProjectRepository,
  accountNamespace,
  ANONYMOUS_NAMESPACE,
} from "./project-repository";
import type { CatalogEntry, ProjectHandle } from "./project-repository";
import type { Project } from "./project-schema";
import { parseProject } from "./projects";
import { NODE_COLORS } from "./node-colors";
import type { NodeColor } from "./node-colors";
import { generateProjectName } from "./project-names";
import { readProjectFile, writeProjectFile } from "./project-import-export";
import { AccountControls } from "./AccountControls";
import type { User } from "./AccountControls";
import type {
  LayoutAnchor,
  MindMapNode,
  NodePosition,
  NodeSize,
} from "./mind-map";
import { backendEndpoint } from "./backend";

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
  onUndo: () => void;
  onRedo: () => void;
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
          e.stopPropagation();
          if (e.isComposing) return;
          if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const key = e.key.toLowerCase();
            if (key === "z") {
              e.preventDefault();
              if (e.shiftKey) props.onRedo();
              else props.onUndo();
              return;
            }
            if (key === "y" && !e.shiftKey) {
              e.preventDefault();
              props.onRedo();
              return;
            }
          }
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
  onUndo: () => void;
  onRedo: () => void;
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
          onUndo={props.onUndo}
          onRedo={props.onRedo}
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
  const cachedUserKey = "mindgrab/cached-user-id";
  let activeUserId: number | undefined;
  try {
    const cachedUserId = Number(window.localStorage.getItem(cachedUserKey));
    if (Number.isSafeInteger(cachedUserId) && cachedUserId > 0) {
      activeUserId = cachedUserId;
    }
  } catch {
    // Continue with browser storage when account-scoped storage is unavailable.
  }

  const deployment = new URL(backendEndpoint("/")).origin;
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

  function ephemeralDocument() {
    return createProjectDocument(crypto.randomUUID(), generateProjectName([]), {
      text: "New idea",
    });
  }

  async function activate(handle: ProjectHandle, owner = repository) {
    const previous = activeHandle;
    if (previous && previous !== handle) {
      await previous.flush();
      await previous.close();
    }
    stopDurability?.();
    handleRepository = owner;
    activeHandle = handle;
    resetProjectUi();
    setDoc(handle.doc);
    setStorageReady(true);
    setSaveStatus(handle.durability().status === "saved" ? "done" : "saving");
    stopDurability = handle.onDurability((durability) => {
      setSaveStatus(
        durability.status === "saved"
          ? "done"
          : durability.status === "saving"
            ? "saving"
            : "error",
      );
      if (durability.status === "unsaved")
        setStorageMessage(durability.error.message);
      else if (durability.status === "saved") setStorageMessage("");
    });
    try {
      const preference = await owner.preference(`project/${handle.id}/view`);
      if (preference && typeof preference === "object") {
        const view = preference as Project["view"] & { anchor?: LayoutAnchor };
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

  async function accountChanged(user: User | undefined) {
    const nextUserId = user?.id;
    try {
      if (nextUserId)
        window.localStorage.setItem(cachedUserKey, String(nextUserId));
      else window.localStorage.removeItem(cachedUserKey);
    } catch {
      // Authentication remains usable when the cache hint cannot be written.
    }
    if (nextUserId === activeUserId) return;
    activeUserId = nextUserId;
    const previousRepository = repository;
    const nextRepository = new ProjectRepository({
      deployment,
      namespace: nextUserId
        ? accountNamespace(nextUserId)
        : ANONYMOUS_NAMESPACE,
    });
    repository = nextRepository;
    stopCatalog?.();
    stopCatalog = nextRepository.onCatalogChange(() => {
      void nextRepository
        .list()
        .then(setSavedProjects)
        .catch(() => {});
    });
    try {
      await openLatestOrCreate(nextRepository);
    } catch {
      setStorageMessage("Could not open this account’s local projects.");
    }
    await previousRepository.close();
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
      if (handle) void handle.close();
      else current.destroy();
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
    const currentDoc = doc();
    const value: Project["view"] & { anchor?: LayoutAnchor } = {
      left: left(),
      top: top(),
      zoom: zoom(),
      anchor: layoutAnchor(),
    };
    if (!handle || handle.doc !== currentDoc) return;
    window.clearTimeout(viewSaveTimer);
    viewSaveTimer = window.setTimeout(() => {
      void handleRepository
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
    try {
      await activeHandle?.flush();
      const handle = await repository.open(id);
      await activate(handle);
      const state = handle.state();
      setStorageMessage(
        state.status === "ready"
          ? `Loaded “${state.content.metadata.name}”.`
          : "Project is still loading.",
      );
    } catch (error) {
      setStorageMessage(
        error instanceof Error ? error.message : "Could not open this project.",
      );
    }
  }

  async function createNewProject() {
    try {
      await activeHandle?.flush();
      const projects = await repository.list();
      const name = generateProjectName(projects.map((project) => project.name));
      const handle = await repository.create({
        name,
        root: { text: "New idea" },
      });
      await activate(handle);
      setStorageMessage("");
    } catch (error) {
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

  function currentProject(): Project {
    return snapshotProject(session().doc, layoutAnchor(), {
      left: left(),
      top: top(),
      zoom: zoom(),
    });
  }

  async function save() {
    finishWriting();
    finishProjectName();
    if (!activeHandle) {
      setStorageMessage("Project storage is still opening.");
      return;
    }
    setShowLoad(false);
    setSaveStatus("saving");
    try {
      await activeHandle.flush();
      setSaveStatus("done");
      setStorageMessage("Saved locally.");
    } catch (error) {
      setSaveStatus("error");
      setStorageMessage(
        error instanceof Error ? error.message : "Could not save this project.",
      );
    }
  }

  async function saveBeforeAuth() {
    finishWriting();
    finishProjectName();
    clearSaveStatus();
    try {
      await activeHandle?.flush();
      return true;
    } catch {
      setStorageMessage(
        "Could not save your project before leaving. Free up browser storage and try again.",
      );
      return false;
    }
  }

  async function openLoad() {
    clearSaveStatus();
    finishWriting();
    try {
      setSavedProjects(await repository.list());
      setStorageMessage("");
      setShowLoad(true);
    } catch {
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
      const project = currentProject();
      await writeProjectFile(project);
      setStorageMessage(`Exported “${project.name}”.`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStorageMessage("Could not export this project.");
      }
    } finally {
      setFileBusy(false);
    }
  }

  async function importProjectFromFile() {
    finishWriting();
    setFileBusy(true);
    try {
      await activeHandle?.flush();
      const file = await readProjectFile();
      if (!file) return;
      const imported = parseProject(await file.text());
      const existing = await repository.list();
      const baseName = imported.name;
      let name = baseName;
      let suffix = 2;
      while (existing.some((entry) => entry.name === name))
        name = `${baseName} (copy ${suffix++})`;
      const normalized = { ...imported, name };
      const importedDoc = openSnapshot(normalized).doc;
      const content = materializeProject(importedDoc);
      importedDoc.destroy();
      const roots = projectMindMap(content);
      const first = roots[0];
      const handle = await repository.create({
        name,
        root: first && {
          id: first.id,
          text: first.text,
          color: first.color,
          position: first.position,
        },
      });
      const addBranch = (parentId: string, children: MindMapNode[]) => {
        for (const child of children) {
          const id = createChild(handle.doc, parentId, {
            id: child.id,
            text: child.text,
            color: child.color,
            position: child.position,
          });
          if (id) addBranch(id, child.next ?? []);
        }
      };
      if (first) addBranch(first.id, first.next ?? []);
      for (const root of roots.slice(1)) {
        const id = createRoot(handle.doc, {
          id: root.id,
          text: root.text,
          color: root.color,
          position: root.position,
        });
        if (id) addBranch(id, root.next ?? []);
      }
      await handle.flush();
      await activate(handle);
      setStorageMessage(`Imported “${name}”.`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStorageMessage(
          error instanceof Error && error.message.includes("invalid")
            ? "This file is not a valid Mindgrab project or uses an unsupported version."
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

  function undoFromEditor() {
    session().undo.stopCapturing();
    session().undo.undo();
  }

  function redoFromEditor() {
    session().undo.stopCapturing();
    session().undo.redo();
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
    const initialRepository = repository;
    stopCatalog = initialRepository.onCatalogChange(() => {
      void initialRepository
        .list()
        .then(setSavedProjects)
        .catch(() => {});
    });
    void initialRepository
      .list()
      .then(setSavedProjects)
      .catch(() => {});
    void openLatestOrCreate(initialRepository).catch((error) => {
      setStorageMessage(
        error instanceof Error
          ? error.message
          : "Could not open local project storage.",
      );
    });
    onCleanup(() => {
      stopCatalog?.();
      stopDurability?.();
      void repository.close();
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
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "z"
      ) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "y"
      ) {
        e.preventDefault();
        redo();
        return;
      }
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
    // Let the callback decide whether the target accepts text before suppressing
    // the browser's native save dialog.
    createShortcut(["Control", "S"], saveShortcut, { preventDefault: false });
    createShortcut(["Meta", "S"], saveShortcut, { preventDefault: false });
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
          disabled={!storageReady() || fileBusy()}
        >
          <button
            type="button"
            class="map-control"
            onClick={() => void createNewProject()}
          >
            New
          </button>
          <button type="button" class="map-control" onClick={save}>
            Save
          </button>
          <button
            type="button"
            class="map-control"
            aria-label="Undo"
            disabled={!canUndo()}
            onClick={undo}
          >
            Undo
          </button>
          <button
            type="button"
            class="map-control"
            aria-label="Redo"
            disabled={!canRedo()}
            onClick={redo}
          >
            Redo
          </button>
          <button
            type="button"
            class="map-control"
            aria-expanded={showLoad()}
            aria-controls="saved-projects"
            onClick={() => (showLoad() ? setShowLoad(false) : void openLoad())}
          >
            Load
          </button>
          <button
            type="button"
            class="map-control"
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
        <p role="status" class="px-2 text-xs text-stone-600 empty:hidden">
          {storageMessage()}
        </p>
        <AccountControls
          beforeNavigate={saveBeforeAuth}
          onUser={accountChanged}
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
                onSize={(size) =>
                  setNodeSizes((current) => {
                    const previous = current.get(id);
                    if (
                      previous?.width === size.width &&
                      previous?.height === size.height
                    )
                      return current;
                    return new Map(current).set(id, size);
                  })
                }
                onSelect={() => select(id)}
                onWrite={() => write(id)}
                onFinish={() => {
                  if (selectedId() === id) finishWriting();
                }}
                onUndo={undoFromEditor}
                onRedo={redoFromEditor}
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
