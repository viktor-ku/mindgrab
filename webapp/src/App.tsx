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
import {
  normalizeSnapshot,
  openSnapshot,
  snapshotProject,
} from "./project-snapshot";
import { createProjectView } from "./project-view";
import { bindTextarea } from "./text-binding";
import {
  listProjects,
  loadLatestProject,
  loadProject,
  parseProject,
  projectUpdatedAt,
  saveProject,
  userProjectStorage,
} from "./projects";
import type { Project } from "./projects";
import { NODE_COLORS } from "./node-colors";
import type { NodeColor } from "./node-colors";
import { generateProjectName } from "./project-names";
import {
  findDuplicateProject,
  saveImportedProject,
  readProjectFile,
  writeProjectFile,
} from "./project-import-export";
import { AccountControls } from "./AccountControls";
import type { User } from "./AccountControls";
import { syncProjects, uploadProject } from "./project-sync";
import type {
  LayoutAnchor,
  MindMapNode,
  NodePosition,
  NodeSize,
} from "./mind-map";

const ARROW_DIRECTIONS: ReadonlyMap<string, "left" | "right" | "up" | "down"> =
  new Map([
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"],
    ["ArrowUp", "up"],
    ["ArrowDown", "down"],
  ]);

function NodeEditor(props: { doc: Y.Doc; id: string; onFinish: () => void }) {
  let input!: HTMLTextAreaElement;
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
        onKeyDown={(e) => {
          e.stopPropagation();
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
        <NodeEditor doc={props.doc} id={props.id} onFinish={props.onFinish} />
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
  const [signedIn, setSignedIn] = createSignal(false);
  const cachedUserKey = "mindgrab/cached-user-id";
  const anonymousOwnerKey = "mindgrab/anonymous-projects-owner";
  let activeProjectStorage: Storage = window.localStorage;
  let activeUserId: number | undefined;
  try {
    const cachedUserId = Number(window.localStorage.getItem(cachedUserKey));
    if (Number.isSafeInteger(cachedUserId) && cachedUserId > 0) {
      activeProjectStorage = userProjectStorage(
        window.localStorage,
        cachedUserId,
      );
      activeUserId = cachedUserId;
      setSignedIn(true);
    }
  } catch {
    // Continue with browser storage when account-scoped storage is unavailable.
  }

  function projectStorage() {
    return activeProjectStorage;
  }

  let projectSync: Promise<void> | undefined;

  function syncCloudProjects() {
    if (projectSync) return projectSync;
    let restoreFromStorage = false;
    const activeBefore = currentProject();
    let activeWasSaved = false;
    try {
      restoreFromStorage = !loadLatestProject(projectStorage());
      activeWasSaved =
        JSON.stringify(
          normalizeSnapshot(
            loadProject(projectStorage(), `proj/${activeBefore.name}`),
          ),
        ) === JSON.stringify(activeBefore);
    } catch {
      restoreFromStorage = true;
    }
    projectSync = syncProjects(projectStorage())
      .then((changedNames) => {
        if (restoreFromStorage) {
          const latest = loadLatestProject(projectStorage());
          if (latest) replaceProject(latest);
        } else if (
          activeWasSaved &&
          changedNames.includes(activeBefore.name) &&
          JSON.stringify(currentProject()) === JSON.stringify(activeBefore)
        ) {
          const updated = loadProject(
            projectStorage(),
            `proj/${activeBefore.name}`,
          );
          replaceProject(updated);
        }
        setStorageMessage("");
      })
      .catch(() => {
        setStorageMessage(
          "Saved in this browser. Cloud sync will retry on your next save or when you return to the app.",
        );
      })
      .finally(() => {
        projectSync = undefined;
      });
    return projectSync;
  }

  function accountChanged(user: User | undefined) {
    setSignedIn(Boolean(user));
    if (!user) {
      activeProjectStorage = window.localStorage;
      activeUserId = undefined;
      try {
        window.localStorage.removeItem(cachedUserKey);
        const latest = loadLatestProject(window.localStorage);
        if (latest) replaceProject(latest);
      } catch {
        // Keep the current canvas if local storage is unavailable.
      }
      return;
    }

    const userChanged = activeUserId !== user.id;
    const accountStorage = userProjectStorage(window.localStorage, user.id);
    try {
      window.localStorage.setItem(cachedUserKey, String(user.id));
      if (!window.localStorage.getItem(anonymousOwnerKey)) {
        const anonymousProjects = listProjects(window.localStorage).map((key) =>
          loadProject(window.localStorage, key),
        );
        for (const project of anonymousProjects) {
          if (!accountStorage.getItem(`proj/${project.name}`)) {
            saveProject(
              accountStorage,
              project,
              projectUpdatedAt(window.localStorage, project.name) ??
                new Date().toISOString(),
              false,
            );
          }
        }
        const latest = loadLatestProject(window.localStorage);
        if (latest) saveProject(accountStorage, latest);
        window.localStorage.setItem(anonymousOwnerKey, String(user.id));
      }
      activeProjectStorage = accountStorage;
      activeUserId = user.id;
      if (userChanged) {
        const latest = loadLatestProject(accountStorage);
        replaceProject(latest);
      }
    } catch {
      activeProjectStorage = accountStorage;
      activeUserId = user.id;
      setStorageMessage(
        "Could not prepare account storage. Your current project remains available in this browser.",
      );
    }
    void syncCloudProjects();
  }

  function newProjectName(previousName?: string) {
    const used = previousName ? [previousName] : [];
    try {
      used.push(
        ...listProjects(projectStorage()).map((key) =>
          key.slice("proj/".length),
        ),
      );
    } catch {
      // Creating a project also works when browser storage is unavailable.
    }
    return generateProjectName(used);
  }

  function newDocument(previousName?: string) {
    return createProjectDocument(
      crypto.randomUUID(),
      newProjectName(previousName),
      { text: "New idea" },
    );
  }

  // The document is the only writable project content. Everything else here
  // (selection, viewport, measurements, drag previews) is local UI state.
  const [doc, setDoc] = createSignal(newDocument());
  const session = createMemo(() => {
    const current = doc();
    const view = createProjectView(current);
    const undo = new Y.UndoManager(current.getMap("project"), {
      trackedOrigins: new Set([ORIGIN.local]),
      // Steps are separated explicitly: see `command` and text editing.
      captureTimeout: Number.POSITIVE_INFINITY,
    });
    untrack(() => props.onDocument?.(current));
    onCleanup(() => {
      undo.destroy();
      current.destroy();
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
  const [savedKeys, setSavedKeys] = createSignal<string[]>([]);
  const [showLoad, setShowLoad] = createSignal(false);
  const [storageMessage, setStorageMessage] = createSignal("");
  const [saveStatus, setSaveStatus] = createSignal<"" | "saving" | "done">("");
  const [fileBusy, setFileBusy] = createSignal(false);
  let saveTimer: number | undefined;
  let saveStatusTimer: number | undefined;

  function clearSaveStatus() {
    window.clearTimeout(saveTimer);
    window.clearTimeout(saveStatusTimer);
    saveTimer = undefined;
    saveStatusTimer = undefined;
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

  function replaceProject(project?: Project) {
    const opened = project
      ? openSnapshot(project)
      : { doc: newDocument(view().name()), anchor: undefined };
    clearSaveStatus();
    finishWriting();
    cancelPointer();
    suppressClick = false;
    batch(() => {
      setDoc(opened.doc);
      setProjectNameDraft(undefined);
      setSelectedId(undefined);
      setColorScope("node");
      setNodeSizes(new Map());
      setLayoutAnchor(opened.anchor);
      setLeft(project?.view.left ?? 0);
      setTop(project?.view.top ?? 0);
      setZoom(project?.view.zoom ?? 1);
      setShowLoad(false);
    });
    canvas.focus({ preventScroll: true });
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

  function save() {
    if (saveStatus() === "saving") return;
    finishWriting();
    finishProjectName();
    clearSaveStatus();
    const project = currentProject();
    setStorageMessage("");
    setShowLoad(false);
    setSaveStatus("saving");

    // Give the status time to paint without relying on animation frames,
    // which can pause when the page is in the background.
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      try {
        const name = saveProject(projectStorage(), project);
        if (signedIn()) {
          void uploadProject(projectStorage(), { ...project, name }).catch(() =>
            setStorageMessage(
              "Saved in this browser. Cloud sync will retry on your next save or when you return to the app.",
            ),
          );
        }
        setSaveStatus("done");
        saveStatusTimer = window.setTimeout(clearSaveStatus, 1500);
      } catch {
        setSaveStatus("");
        setStorageMessage(
          "Could not save. Browser storage may be full or unavailable.",
        );
      }
    }, 50);
  }

  function saveBeforeAuth() {
    finishWriting();
    finishProjectName();
    clearSaveStatus();
    try {
      saveProject(projectStorage(), currentProject());
      return true;
    } catch {
      setStorageMessage(
        "Could not save your project before leaving. Free up browser storage and try again.",
      );
      return false;
    }
  }

  function openLoad() {
    clearSaveStatus();
    finishWriting();
    try {
      setSavedKeys(listProjects(projectStorage()));
      setStorageMessage("");
      setShowLoad(true);
    } catch {
      setStorageMessage(
        "Could not list projects. Browser storage is unavailable.",
      );
    }
  }

  function load(key: string) {
    try {
      const project = loadProject(projectStorage(), key);
      replaceProject(project);
      setStorageMessage(`Loaded “${project.name}”.`);
    } catch {
      setStorageMessage(
        "Could not load this project. It may be missing, damaged, or unavailable.",
      );
    }
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
      const file = await readProjectFile();
      if (!file) return;
      const imported = parseProject(await file.text());
      const duplicateKey = findDuplicateProject(projectStorage(), imported);
      const clone = duplicateKey
        ? !window.confirm(
            `“${imported.name}” already exists with the same project data. Choose OK to load the existing project, or Cancel to make a clone.`,
          )
        : false;
      const result = saveImportedProject(projectStorage(), imported, clone);
      replaceProject(result.project);
      if (signedIn() && result.kind !== "existing") {
        void uploadProject(projectStorage(), result.project).catch(() =>
          setStorageMessage(
            "Imported in this browser. Cloud sync will retry on your next save or when you return to the app.",
          ),
        );
      }
      setStorageMessage(
        result.kind === "existing"
          ? `Loaded existing project “${result.project.name}”.`
          : result.kind === "clone"
            ? `Created clone “${result.project.name}”.`
            : `Imported “${result.project.name}”.`,
      );
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
    setSelectedId(undefined);
    setColorScope("node");
    command((doc) => deleteSubtree(doc, id));
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
    try {
      const project = loadLatestProject(projectStorage());
      if (project) {
        replaceProject(project);
        setStorageMessage(`Loaded “${project.name}”.`);
      }
    } catch {
      setStorageMessage(
        "Could not restore the latest project. It may be missing, damaged, or unavailable.",
      );
    }

    const keydown = (e: KeyboardEvent) => {
      if (
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
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "z"
      ) {
        e.preventDefault();
        undo();
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
          disabled={saveStatus() === "saving" || fileBusy()}
        >
          <button
            type="button"
            class="map-control"
            onClick={() => {
              replaceProject();
              setStorageMessage(
                "New project. Save to keep it in this browser.",
              );
            }}
          >
            New
          </button>
          <button type="button" class="map-control" onClick={save}>
            Save
          </button>
          <button
            type="button"
            class="map-control"
            aria-expanded={showLoad()}
            aria-controls="saved-projects"
            onClick={() => (showLoad() ? setShowLoad(false) : openLoad())}
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
                : ""}
          </span>
        </fieldset>
        <Show when={showLoad()}>
          <div id="saved-projects" class="border-t border-stone-200 pt-2">
            <p class="px-2 text-xs text-stone-500">Saved in this browser</p>
            <ul class="max-h-60 overflow-y-auto text-sm">
              <For
                each={savedKeys()}
                fallback={
                  <li class="px-2 py-2 text-stone-500">
                    No saved projects yet.
                  </li>
                }
              >
                {(key) => (
                  <li>
                    <button
                      type="button"
                      class="map-control w-full text-left whitespace-normal! break-words"
                      onClick={() => load(key)}
                    >
                      {key.slice("proj/".length)}
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
