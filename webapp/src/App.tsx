import { ProjectPreferences } from "./ProjectPreferences";
import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import { catalogKey } from "./query-client";
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
import type { ProjectDocument } from "./project-document";
import { EditHistory } from "./undo-history";
import {
  branchIds,
  connectionPath,
  dropTargetAt,
  findNode,
  layoutMindMap,
  navigationTarget,
  NODE_MIN_HEIGHT,
  nodeDetails,
  translateSubtree as translatePreview,
  visibleMindMap,
} from "./mind-map";
import {
  clearPositions,
  createChild,
  createNodeAt,
  createProjectDocument,
  createRoot,
  createSibling,
  deleteSubtree,
  LIMITS,
  moveNode,
  ORIGIN,
  renameProject,
  reorderNode,
  setNodeColor,
  translateSubtree,
} from "./project-document";
import { createProjectView } from "./project-view";
import { bindTextarea } from "./text-binding";
import {
  ProjectRepository,
  accountNamespace,
  ANONYMOUS_NAMESPACE,
} from "./project-repository";
import type { ProjectHandle } from "./project-repository";
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
  projectMarkdown,
  readProjectFile,
  writeMarkdownFile,
  writeProjectFile,
} from "./project-import-export";
import { MOD_LABEL, ShortcutsDialog } from "./ShortcutsDialog";
import { Outline } from "./Outline";
import { branchOutline, outlineSize, parseOutline } from "./outline-text";
import type { OutlineEntry } from "./outline-text";
import {
  ArrowLeftIcon,
  BrandMark,
  ChevronDownIcon,
  ChevronRightIcon,
  ChildIcon,
  CloseIcon,
  FitMapIcon,
  FitSelectionIcon,
  FocusIcon,
  FoldIcon,
  HelpIcon,
  MinusIcon,
  MoreIcon,
  OutlineIcon,
  PlusIcon,
  RedoIcon,
  SearchIcon,
  SiblingIcon,
  TrashIcon,
  UndoIcon,
  UnfoldIcon,
} from "./icons";
import { searchNodes } from "./search";
import { AccountControls } from "./AccountControls";
import { AuthSession } from "./auth-session";
import type { SessionState } from "./auth-session";
import { claimAnonymousProjects, claimCandidates } from "./anonymous-claims";
import { LoroApi, SyncError } from "./loro-api";
import type {
  DropTarget,
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

// Letter shortcuts follow the typed character, falling back to the physical key
// when the active layout does not type Latin letters (for example Cyrillic).
function matchesLetter(event: KeyboardEvent, letter: string) {
  const key = event.key.toLowerCase();
  return (
    key === letter ||
    (!/^[a-z]$/.test(key) && event.code === `Key${letter.toUpperCase()}`)
  );
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
// A device-wide input preference: what a plain scroll wheel does on the canvas.
type WheelMode = "pan" | "zoom";
const WHEEL_MODE_KEY = "mindgrab:wheel-mode";
function storedWheelMode(): WheelMode {
  try {
    return localStorage.getItem(WHEEL_MODE_KEY) === "zoom" ? "zoom" : "pan";
  } catch {
    return "pan";
  }
}
function storeWheelMode(mode: WheelMode) {
  try {
    localStorage.setItem(WHEEL_MODE_KEY, mode);
  } catch {
    // Storage may be unavailable; the choice then lasts for this tab only.
  }
}

const HINT_KEY = "mindgrab:hint-dismissed";
function storedFlag(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function storeFlag(key: string, value = true) {
  try {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Without storage the flag lasts for this tab only.
  }
}

const OUTLINE_KEY = "mindgrab:outline-open";

// Screen space kept clear of floating toolbars and panels when fitting or
// following nodes.
const VIEW_INSETS = { top: 76, right: 24, bottom: 72, left: 24 } as const;

function NodeEditor(props: {
  doc: ProjectDocument;
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
            (matchesLetter(e, "z") || matchesLetter(e, "y"));
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
  doc: ProjectDocument;
  id: string;
  text: string;
  color?: NodeColor;
  x: number;
  y: number;
  selected: boolean;
  writing: boolean;
  dragging: boolean;
  root: boolean;
  descendants: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
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
  const fill = () => (props.root ? color().rootClass : color().nodeClass);
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
      class="map-node cursor-pointer select-none absolute w-max max-w-56 leading-6"
      classList={{
        "map-node-dragging": props.dragging,
        "map-node-root": props.root,
      }}
      data-no-pan
      data-node-id={props.id}
      data-selected={props.selected}
      data-collapsed={props.collapsed}
      onPointerDown={props.onPointerDown}
      onClick={props.onSelect}
      onDblClick={props.onWrite}
      style={{
        transform: `translate(${props.x}px, ${props.y}px)`,
      }}
      title={`Click to select · Double-click to write · Drag to move${props.descendants ? " · G to collapse or expand children" : ""}`}
    >
      <Show when={props.collapsed}>
        <span
          aria-hidden="true"
          class={`absolute inset-0 translate-x-2 translate-y-2 rounded-lg border pointer-events-none ${fill()}`}
        />
        <span
          aria-hidden="true"
          class={`absolute inset-0 translate-x-1 translate-y-1 rounded-lg border pointer-events-none ${fill()}`}
        />
      </Show>
      <div
        class={`map-node-card relative grid items-center box-border border ${fill()}`}
        classList={{
          "grid-cols-[minmax(0,1fr)_auto] gap-x-2": props.collapsed,
          "map-node-selected": props.selected,
        }}
        style={{ "min-height": `${NODE_MIN_HEIGHT}px` }}
      >
        <Show
          when={props.writing}
          fallback={
            <button
              type="button"
              aria-pressed={props.selected}
              aria-expanded={props.descendants ? !props.collapsed : undefined}
              aria-keyshortcuts={props.descendants ? "g" : undefined}
              class="w-full min-w-0 whitespace-pre-wrap wrap-anywhere cursor-pointer outline-none"
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
        <Show when={props.collapsed}>
          <button
            type="button"
            class="rounded px-1.5 text-[10px] leading-4 font-medium whitespace-nowrap cursor-pointer bg-white/35 hover:bg-white/60 focus-visible:outline-2"
            aria-label={`Expand ${props.descendants} hidden ${props.descendants === 1 ? "node" : "nodes"}`}
            title="Expand children (G)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleCollapse();
            }}
          >
            +{props.descendants} {props.descendants === 1 ? "idea" : "ideas"}
          </button>
        </Show>
      </div>
    </div>
  );
}

interface Notice {
  message: string;
  action?: { label: string; run: () => void };
}

const truncate = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;

interface ContextMenuState {
  x: number;
  y: number;
  nodeId?: string;
  rootPosition?: NodePosition;
  // Opens upward from (x, y), for menus anchored to the bottom toolbar.
  above?: boolean;
}

export function App(props: { onDocument?: (doc: ProjectDocument) => void }) {
  const deployment = backendDeployment();
  const queryClient = useQueryClient();
  const auth = new AuthSession(deployment, queryClient);
  const [account, setAccount] = createSignal(auth.state);
  let activeUserId = auth.state.user?.id;
  let repository = new ProjectRepository({
    deployment,
    namespace: activeUserId
      ? accountNamespace(activeUserId)
      : ANONYMOUS_NAMESPACE,
  });
  const [workspace, setWorkspace] = createSignal(repository);
  const catalog = createQuery(() => {
    const owner = workspace();
    return {
      queryKey: catalogKey(owner.names.catalog),
      queryFn: () => owner.list(),
      structuralSharing: false,
    };
  });
  const savedProjects = () => catalog.data ?? [];
  const claims = createQuery(() => ({
    queryKey: ["anonymous-claims", deployment, account().user?.id ?? null],
    enabled: account().status === "authenticated",
    queryFn: async () => {
      const userId = account().user?.id;
      if (!userId) return [];
      const source = new ProjectRepository({
        deployment,
        namespace: ANONYMOUS_NAMESPACE,
      });
      try {
        return await claimCandidates(source, userId);
      } finally {
        await source.close();
      }
    },
  }));
  const claimCount = () =>
    account().status === "authenticated" ? (claims.data?.length ?? 0) : 0;
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
  const [claimMessage, setClaimMessage] = createSignal("");
  const [recoveryPending, setRecoveryPending] = createSignal(false);

  const initializeMutation = createMutation(() => ({
    mutationKey: ["workspace", "initialize"],
    mutationFn: performInitializeWorkspace,
  }));
  const initializeWorkspace = () => initializeMutation.mutateAsync();
  const accountMutation = createMutation(() => ({
    mutationKey: ["workspace", "account"],
    mutationFn: performAccountChanged,
  }));
  const accountChanged = (state: SessionState) =>
    accountMutation.mutateAsync(state);
  const claimMutation = createMutation(() => ({
    mutationKey: ["workspace", "claim"],
    mutationFn: performAddAnonymousProjects,
  }));
  const claiming = () => claimMutation.isPending;
  const addAnonymousProjects = () => {
    if (!claiming()) claimMutation.mutate();
  };
  const openMutation = createMutation(() => ({
    mutationKey: ["project", "open"],
    mutationFn: performOpenProject,
  }));
  const openProject = (id: string) => openMutation.mutateAsync(id);
  const createMutationState = createMutation(() => ({
    mutationKey: ["project", "create"],
    mutationFn: performCreateNewProject,
  }));
  const createNewProject = () => {
    if (!createMutationState.isPending) createMutationState.mutate();
  };
  const saveMutation = createMutation(() => ({
    mutationKey: ["project", "save"],
    mutationFn: performSave,
  }));
  const save = () => {
    if (!saveMutation.isPending) saveMutation.mutate();
  };
  const recoveryMutation = createMutation(() => ({
    mutationKey: ["workspace", "recover"],
    mutationFn: performRetryLocalSaving,
  }));
  const retryLocalSaving = () => recoveryMutation.mutateAsync();
  const loadMutation = createMutation(() => ({
    mutationKey: ["project", "load-menu"],
    mutationFn: performOpenLoad,
  }));
  const openLoad = () => {
    if (!loadMutation.isPending) loadMutation.mutate();
  };
  const exportMutation = createMutation(() => ({
    mutationKey: ["project", "export"],
    mutationFn: performExportCurrentProject,
  }));
  const exportCurrentProject = () => {
    if (!fileBusy()) exportMutation.mutate();
  };
  const importMutation = createMutation(() => ({
    mutationKey: ["project", "import"],
    mutationFn: performImportProjectFromFile,
  }));
  const importProjectFromFile = () => {
    if (!fileBusy()) importMutation.mutate();
  };
  const viewportMutation = createMutation(() => ({
    mutationKey: ["project", "viewport"],
    scope: { id: "viewport" },
    mutationFn: ({
      owner,
      id,
      value,
    }: {
      owner: ProjectRepository;
      id: string;
      value: ViewportPreference;
    }) => owner.setPreference(`project/${id}/view`, value),
  }));

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
        void queryClient.invalidateQueries({
          queryKey: catalogKey(owner.names.catalog),
        });
      },
      undefined,
      queryClient,
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
    setSaveStatus(
      ["saved", "disabled"].includes(handle.durability().status)
        ? "done"
        : "saving",
    );
    stopDurability = handle.onDurability((durability) => {
      if (activeHandle !== handle || repository !== owner || disposed) return;
      setSaveStatus(
        durability.status === "saved" || durability.status === "disabled"
          ? "done"
          : durability.status === "saving"
            ? "saving"
            : "error",
      );
      if (durability.status === "unsaved")
        setStorageMessage(
          `${durability.error.message} Export a copy to keep your changes.`,
        );
      else if (
        durability.status === "saved" ||
        durability.status === "disabled"
      )
        setStorageMessage("");
    });
    if (previous && previous !== handle) await previous.close();
    try {
      const preference = await queryClient.fetchQuery({
        queryKey: ["project-view", owner.names.catalog, handle.id],
        queryFn: async () =>
          (await owner.preference(`project/${handle.id}/view`)) ?? null,
        gcTime: 0,
      });
      if (request !== activation || disposed || owner !== repository) return;
      if (preference && typeof preference === "object") {
        const view = preference as ViewportPreference;
        setLayoutAnchor(view.anchor);
        setLeft(view.left);
        setTop(view.top);
        setZoom(view.zoom);
        if (Array.isArray(view.collapsed))
          setCollapsedIds(
            new Set(view.collapsed.filter((id) => typeof id === "string")),
          );
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

  async function performInitializeWorkspace() {
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
    stopCatalog = owner.onCatalogChange(() => {
      void queryClient.invalidateQueries({
        queryKey: catalogKey(owner.names.catalog),
      });
    });
    void queryClient.invalidateQueries({
      queryKey: catalogKey(owner.names.catalog),
    });
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

  function refreshClaims(owner = repository) {
    if (owner !== repository || disposed) return Promise.resolve();
    return queryClient.invalidateQueries({
      queryKey: ["anonymous-claims", deployment],
    });
  }

  async function performAccountChanged(state: SessionState) {
    if (disposed) return;
    setAccount(state);
    const nextUserId = state.user?.id;
    if (state.status !== "authenticated" || nextUserId !== activeUserId) {
      cloud?.destroy();
      cloud = undefined;
      claimAbort?.abort();
      claimAbort = undefined;
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
    void queryClient.cancelQueries({
      queryKey: catalogKey(previousRepository.names.catalog),
    });
    queryClient.removeQueries({
      queryKey: catalogKey(previousRepository.names.catalog),
    });
    repository = nextRepository;
    setWorkspace(nextRepository);
    handleRepository = nextRepository;
    activeHandle = undefined;
    resetProjectUi();
    setDoc(ephemeralDocument());
    setStorageReady(false);
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

  async function performAddAnonymousProjects() {
    if (auth.state.status !== "authenticated" || !activeUserId) return;
    const owner = repository;
    const userId = activeUserId;
    const abort = new AbortController();
    claimAbort = abort;
    const source = new ProjectRepository({
      deployment,
      namespace: ANONYMOUS_NAMESPACE,
    });
    setClaimMessage("");
    try {
      const ids = await claimAnonymousProjects(
        source,
        owner,
        userId,
        abort.signal,
        new LoroApi(undefined, undefined, userId, queryClient),
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
      throw error;
    } finally {
      await source.close();
      if (claimAbort === abort) {
        claimAbort = undefined;
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
    const undo = new EditHistory<UndoSelection>(current);
    let selectionBefore: UndoSelection = { writing: false };
    const captureSelection = (): UndoSelection => ({
      id: selectedId(),
      writing: writing(),
      ...(editorSelection && { text: { ...editorSelection } }),
    });
    const beforeChange = () => {
      selectionBefore = captureSelection();
    };
    current.on("beforeChange", beforeChange);
    undo.onRecord((entry) => {
      setHistoryRevision((n) => n + 1);
      entry.before = selectionBefore;
      queueMicrotask(() => (entry.after = captureSelection()));
    });
    undo.onRestore(({ entry, direction }) => {
      setHistoryRevision((n) => n + 1);
      const selection = direction === "undo" ? entry.before : entry.after;
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
    untrack(() => props.onDocument?.(current));
    onCleanup(() => {
      undo.destroy();
      current.off("beforeChange", beforeChange);
      // Handle lifetime belongs to the workspace; failed writes stay recoverable.
      if (!handle) current.destroy();
    });
    return { doc: current, view, undo };
  });
  const view = () => session().view;
  const forest = () => view().forest();

  // Each command is its own undo step, never merged with typing around it.
  function command<T>(action: (doc: ProjectDocument) => T): T {
    const { doc, undo } = session();
    undo.finishGroup();
    try {
      return action(doc);
    } finally {
      undo.finishGroup();
    }
  }

  // A short-lived confirmation for actions with broad effects, offering the
  // way back next to what happened.
  const [notice, setNotice] = createSignal<Notice>();
  let noticeTimer: number | undefined;
  function showNotice(next: Notice) {
    window.clearTimeout(noticeTimer);
    setNotice(next);
    noticeTimer = window.setTimeout(() => setNotice(undefined), 6000);
  }
  onCleanup(() => window.clearTimeout(noticeTimer));

  // Undefined while the name field is not being edited.
  const [projectNameDraft, setProjectNameDraft] = createSignal<string>();
  const [showLoad, setShowLoad] = createSignal(false);
  const [showPreferences, setShowPreferences] = createSignal(false);
  const [preferencesBusy, setPreferencesBusy] = createSignal(false);
  const [preferencesError, setPreferencesError] = createSignal("");
  async function changeSaving(
    value: import("./project-document").SavingPreferences,
  ) {
    const handle = activeHandle;
    const owner = repository;
    if (!handle || preferencesBusy()) return;
    setPreferencesBusy(true);
    setPreferencesError("");
    try {
      await owner.updateSaving(handle, value);
      if (!value.cloud && !cloud && (await owner.cloudAttempted(handle.id)))
        setCloudStatus({
          status: "auth",
          message:
            "Cloud deletion pending. Sign in again and reconnect to delete the existing cloud copy. Keep this tab open.",
        });
      cloud?.retry();
    } catch (error) {
      if (handle === activeHandle)
        setPreferencesError(
          `Could not finish updating storage: ${error instanceof Error ? error.message : "Please retry."} Existing copies may remain.`,
        );
    } finally {
      setPreferencesBusy(false);
    }
  }
  const fileBusy = () => importMutation.isPending || exportMutation.isPending;

  function clearSaveStatus() {
    setSaveStatus("");
  }

  onCleanup(clearSaveStatus);
  const [selectedId, setSelectedId] = createSignal<string>();
  const [collapsedIds, setCollapsedIds] = createSignal(new Set<string>());
  const details = createMemo(() => nodeDetails(forest()));
  // Branch focus shows one branch as if it were the whole map. It is a view;
  // the document and every other branch are untouched.
  const [focusId, setFocusId] = createSignal<string>();
  const scopeForest = createMemo(() => {
    const focus = focusId();
    const root = focus ? findNode(forest(), focus) : undefined;
    return root ? [root] : forest();
  });
  const visibleForest = createMemo(() =>
    visibleMindMap(scopeForest(), collapsedIds()),
  );
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
      const live = details();
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
  // Where a node drag would land if released now; undefined means a free
  // placement on the canvas.
  const [dropTarget, setDropTarget] = createSignal<DropTarget>();
  const [dragPointer, setDragPointer] = createSignal<NodePosition>();
  const baseLayout = createMemo(() =>
    layoutMindMap(visibleForest(), nodeSizes(), layoutAnchor()),
  );
  const basePositions = createMemo(() => {
    // Hidden descendants must also move when their folded parent is dragged.
    const full = collapsedIds().size
      ? layoutMindMap(scopeForest(), nodeSizes(), layoutAnchor()).nodes
      : [];
    return new Map(
      [...full, ...baseLayout().nodes].map((node) => [node.id, node]),
    );
  });
  const layout = createMemo(() => {
    const preview = drag();
    if (!preview) return baseLayout();
    return layoutMindMap(
      translatePreview(
        visibleForest(),
        preview.id,
        basePositions(),
        preview.delta,
      ),
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
    visit(visibleForest());
    return ids;
  });
  const selectedNode = createMemo(() => {
    const id = selectedId();
    return id ? findNode(forest(), id) : undefined;
  });
  const nodeIds = createMemo(() => layout().nodes.map((node) => node.id));
  const [left, setLeft] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const [zoom, setZoom] = createSignal(1);
  const [panning, setPanning] = createSignal(false);
  const [wheelMode, setWheelMode] = createSignal<WheelMode>(storedWheelMode());
  createEffect(() => storeWheelMode(wheelMode()));
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

  // Canvas units map to screen pixels relative to the canvas center through
  // `left/top + zoom * (point - origin)`. The origin keeps the first root
  // centered where the map started.
  const viewOrigin = () => ({
    x: (layout().nodes[0]?.width ?? 0) / 2,
    y: NODE_MIN_HEIGHT / 2,
  });
  // Programmatic view changes ease into place; direct manipulation does not.
  const [easingView, setEasingView] = createSignal(false);
  let easeTimer: number | undefined;
  function moveView(next: { left: number; top: number; zoom?: number }) {
    window.clearTimeout(easeTimer);
    batch(() => {
      setEasingView(true);
      setLeft(next.left);
      setTop(next.top);
      if (next.zoom !== undefined) setZoom(next.zoom);
    });
    easeTimer = window.setTimeout(() => setEasingView(false), 220);
  }
  onCleanup(() => window.clearTimeout(easeTimer));

  function nodeBounds(ids?: Iterable<string>) {
    const nodes = ids
      ? [...ids].flatMap((id) => positionedNodes().get(id) ?? [])
      : layout().nodes;
    if (!nodes.length) return;
    return {
      minX: Math.min(...nodes.map((node) => node.x)),
      minY: Math.min(...nodes.map((node) => node.y)),
      maxX: Math.max(...nodes.map((node) => node.x + node.width)),
      maxY: Math.max(...nodes.map((node) => node.y + node.height)),
    };
  }

  function fitBounds(
    bounds: NonNullable<ReturnType<typeof nodeBounds>>,
    maxZoom: number,
  ) {
    const width = canvas.clientWidth - viewInsets().left - viewInsets().right;
    const height = canvas.clientHeight - viewInsets().top - viewInsets().bottom;
    const next = Math.min(
      maxZoom,
      ZOOM_MAX,
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
        (viewInsets().left - viewInsets().right) / 2 -
        next * ((bounds.minX + bounds.maxX) / 2 - origin.x),
      top:
        (viewInsets().top - viewInsets().bottom) / 2 -
        next * ((bounds.minY + bounds.maxY) / 2 - origin.y),
    });
  }

  function fitMap() {
    const bounds = nodeBounds();
    if (bounds) fitBounds(bounds, 1);
  }

  function fitSelection() {
    const id = selectedId();
    if (!id) return fitMap();
    const ids = [id];
    const visit = (nodes: MindMapNode[]) => {
      for (const node of nodes) {
        ids.push(node.id);
        visit(node.next ?? []);
      }
    };
    visit(findNode(visibleForest(), id)?.next ?? []);
    const bounds = nodeBounds(ids);
    if (bounds) fitBounds(bounds, 1.5);
  }

  // Pans by the smallest amount that brings the node fully into view, so
  // writing and keyboard navigation never continue offscreen.
  function keepInView(id: string) {
    const node = positionedNodes().get(id);
    if (!node || !canvas) return;
    const origin = viewOrigin();
    const scale = zoom();
    const halfWidth = canvas.clientWidth / 2;
    const halfHeight = canvas.clientHeight / 2;
    const screenLeft = left() + scale * (node.x - origin.x);
    const screenTop = top() + scale * (node.y - origin.y);
    const screenRight = screenLeft + scale * node.width;
    const screenBottom = screenTop + scale * node.height;
    const shift = (start: number, end: number, min: number, max: number) =>
      end - start > max - min
        ? min - start
        : start < min
          ? min - start
          : end > max
            ? max - end
            : 0;
    const dx = shift(
      screenLeft,
      screenRight,
      -halfWidth + viewInsets().left,
      halfWidth - viewInsets().right,
    );
    const dy = shift(
      screenTop,
      screenBottom,
      -halfHeight + viewInsets().top,
      halfHeight - viewInsets().bottom,
    );
    if (dx || dy) moveView({ left: left() + dx, top: top() + dy });
  }

  createEffect(
    on(
      [
        selectedId,
        // While writing, follow the growing node; otherwise only selection
        // changes move the view so remote edits never pull it around.
        () => {
          const id = selectedId();
          const node = writing() && id ? positionedNodes().get(id) : undefined;
          return node && `${node.x},${node.y},${node.width},${node.height}`;
        },
      ],
      ([id]) => {
        if (id && !pointer) keepInView(id);
      },
    ),
  );

  function centerOn(id: string) {
    const node = positionedNodes().get(id);
    if (!node) return;
    const origin = viewOrigin();
    moveView({
      left:
        (viewInsets().left - viewInsets().right) / 2 -
        zoom() * (node.x + node.width / 2 - origin.x),
      top:
        (viewInsets().top - viewInsets().bottom) / 2 -
        zoom() * (node.y + node.height / 2 - origin.y),
    });
  }

  // Search and branch focus change only the view. Leaving them restores the
  // folds and viewport they started from; content edits are never undone.
  interface ViewSnapshot {
    left: number;
    top: number;
    zoom: number;
    collapsed: ReadonlySet<string>;
    selected?: string;
  }
  const snapshotView = (): ViewSnapshot => ({
    left: left(),
    top: top(),
    zoom: zoom(),
    collapsed: collapsedIds(),
    selected: selectedId(),
  });
  function restoreView(snapshot: ViewSnapshot, selection = true) {
    batch(() => {
      setCollapsedIds(
        new Set(
          [...snapshot.collapsed].filter(
            (id) => details().get(id)?.descendants,
          ),
        ),
      );
      if (selection)
        setSelectedId(
          snapshot.selected && details().has(snapshot.selected)
            ? snapshot.selected
            : undefined,
        );
      moveView(snapshot);
    });
  }

  let focusReturn: ViewSnapshot | undefined;
  function focusBranch(id = selectedId()) {
    if (!id || !details().has(id)) return;
    finishWriting();
    setContextMenu(undefined);
    if (!focusId()) focusReturn = snapshotView();
    batch(() => {
      setFocusId(id);
      setSelectedId(id);
      setCollapsedIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    });
    fitMap();
  }
  function exitFocus() {
    const back = focusReturn;
    focusReturn = undefined;
    const selected = selectedId();
    setFocusId(undefined);
    if (back) restoreView(back, false);
    if (selected) keepInView(selected);
    canvas.focus({ preventScroll: true });
  }
  const focusPath = createMemo(() => {
    const path: string[] = [];
    for (let id = focusId(); id; id = details().get(id)?.parent)
      path.unshift(id);
    return path;
  });
  createEffect(() => {
    const id = focusId();
    if (id && !details().has(id)) untrack(exitFocus);
  });

  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchIndex, setSearchIndex] = createSignal(0);
  let searchInput: HTMLInputElement | undefined;
  let searchReturn: ViewSnapshot | undefined;
  const searchResults = createMemo(() =>
    searchOpen()
      ? searchNodes(scopeForest(), (id) => view().text(id), searchQuery())
      : [],
  );
  function openSearch() {
    finishWriting();
    setContextMenu(undefined);
    if (!searchOpen()) {
      searchReturn = snapshotView();
      setSearchIndex(0);
      setSearchOpen(true);
    }
    queueMicrotask(() => {
      searchInput?.focus();
      searchInput?.select();
    });
  }
  // Reveals the result inside the folds the search started from, so moving
  // between results never accumulates unfolded branches.
  function previewResult(id: string) {
    const next = new Set(searchReturn?.collapsed ?? collapsedIds());
    for (
      let parent = details().get(id)?.parent;
      parent;
      parent = details().get(parent)?.parent
    )
      next.delete(parent);
    batch(() => {
      setCollapsedIds(next);
      setSelectedId(id);
    });
    centerOn(id);
  }
  function closeSearch(keep: boolean) {
    const back = searchReturn;
    searchReturn = undefined;
    batch(() => {
      setSearchOpen(false);
      setSearchQuery("");
    });
    if (!keep && back) restoreView(back);
    canvas.focus({ preventScroll: true });
  }
  createEffect(
    on([searchResults, searchIndex], ([results, index]) => {
      const result = results[Math.min(index, results.length - 1)];
      if (result) untrack(() => previewResult(result.id));
    }),
  );

  const [menuOpen, setMenuOpen] = createSignal(false);
  let projectMenu: HTMLDivElement | undefined;
  createEffect(() => {
    if (menuOpen())
      queueMicrotask(() =>
        projectMenu
          ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
          ?.focus(),
      );
  });
  const [colorOpen, setColorOpen] = createSignal(false);
  createEffect(on(selectedId, () => setColorOpen(false), { defer: true }));

  function menuArrowKeys(e: KeyboardEvent & { currentTarget: HTMLElement }) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  }

  function resetPlacement(id: string) {
    const placed = placedIds(id);
    if (command((doc) => clearPositions(doc, placed)))
      showNotice({
        message: `Returned “${nodeLabel(id)}” to automatic placement`,
        action: { label: "Undo", run: undo },
      });
  }

  const dragLabel = () => {
    const target = dropTarget();
    if (!target) return "Place here on the canvas";
    const name = nodeLabel(target.id);
    return target.kind === "inside"
      ? `Move under “${name}”`
      : `Move ${target.kind} “${name}”`;
  };

  async function exportMarkdown() {
    finishWriting();
    finishProjectName();
    try {
      const name = view().name();
      await writeMarkdownFile(
        name,
        projectMarkdown(name, forest(), (id) => view().text(id)),
      );
      setStorageMessage(`Exported “${name}” as an outline.`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        setStorageMessage(
          error instanceof Error
            ? error.message
            : "Could not export the outline.",
        );
    }
  }

  const [outlineOpen, setOutlineOpen] = createSignal(storedFlag(OUTLINE_KEY));
  createEffect(() => storeFlag(OUTLINE_KEY, outlineOpen()));
  const viewInsets = () =>
    outlineOpen() && canvas.clientWidth >= 640
      ? { ...VIEW_INSETS, left: 316 }
      : VIEW_INSETS;
  // Branches travel through the clipboard as indented Markdown lists, so they
  // paste into other apps and pasted outlines become branches here.
  function pasteOutline(entries: OutlineEntry[]) {
    const parent = selectedId() ?? focusId();
    const count = outlineSize(entries);
    let first: string | undefined;
    try {
      command((doc) => {
        const make = (list: OutlineEntry[], under: string | undefined) => {
          for (const entry of list) {
            const init = { text: entry.text.slice(0, LIMITS.text) };
            const id = under
              ? createChild(doc, under, init)
              : createRoot(doc, init);
            first ??= id;
            make(entry.children, id);
          }
        };
        make(entries, parent);
      });
    } catch (error) {
      showNotice({
        message:
          error instanceof Error
            ? error.message
            : "Could not paste these ideas.",
      });
      return;
    }
    if (!first) return;
    if (parent) revealNode(first);
    setSelectedId(first);
    showNotice({
      message: `Pasted ${count} ${count === 1 ? "idea" : "ideas"}${parent ? ` under “${nodeLabel(parent)}”` : ""}`,
      action: { label: "Undo", run: undo },
    });
  }

  const [showHelp, setShowHelp] = createSignal(false);
  const [hintDismissed, setHintDismissed] = createSignal(storedFlag(HINT_KEY));
  function dismissHint() {
    setHintDismissed(true);
    storeFlag(HINT_KEY);
  }

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
      collapsed: [...collapsedIds()],
    };
    if (!handle || handle.doc !== currentDoc) return;
    window.clearTimeout(viewSaveTimer);
    viewSaveTimer = window.setTimeout(() => {
      if (repository !== owner || activeHandle !== handle) return;
      viewportMutation.mutate({ owner, id: handle.id, value });
    }, 200);
  });
  onCleanup(() => window.clearTimeout(viewSaveTimer));

  // Nodes can disappear through remote edits or undo, including the one being
  // edited; local state that refers to them is released.
  createEffect(() => {
    const ids = details();
    const id = selectedId();
    if (id && !ids.has(id))
      untrack(() => {
        finishWriting();
        setSelectedId(undefined);
        setColorScope("node");
      });
    // Undo or a remote reparenting can select a node inside a folded branch.
    if (id && ids.has(id) && !visibleIds().has(id))
      untrack(() => revealNode(id));
    setCollapsedIds((current) =>
      [...current].every((key) => (ids.get(key)?.descendants ?? 0) > 0)
        ? current
        : new Set(
            [...current].filter((key) => (ids.get(key)?.descendants ?? 0) > 0),
          ),
    );
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
      setDropTarget(undefined);
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
      setCollapsedIds(new Set<string>());
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

  async function performOpenProject(id: string) {
    const target = repository;
    try {
      await activeHandle?.flush();
      const handle = await target.open(id);
      await activate(handle, target);
      if (target !== repository || disposed) return;
      const state = handle.state();
      setStorageMessage(
        state.status === "ready"
          ? `Loaded “${state.view.name}”.`
          : "Project is still loading.",
      );
    } catch (error) {
      if (target !== repository || disposed) return;
      setStorageMessage(
        error instanceof Error ? error.message : "Could not open this project.",
      );
      throw error;
    }
  }

  async function performCreateNewProject() {
    const target = repository;
    try {
      await activeHandle?.flush();
      const projects = await queryClient.fetchQuery({
        queryKey: catalogKey(target.names.catalog),
        queryFn: () => target.list(),
      });
      const name = generateProjectName(projects.map((project) => project.name));
      const handle = await target.create({
        name,
        root: { text: "New idea" },
        saving: view().saving(),
      });
      await activate(handle, target);
      if (target !== repository || disposed) return;
      setStorageMessage("");
    } catch (error) {
      if (target !== repository || disposed) return;
      setStorageMessage(
        error instanceof Error ? error.message : "Could not create a project.",
      );
      throw error;
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

  async function performSave() {
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
      setStorageMessage(
        view().saving().local
          ? "Saved locally."
          : "Local saving is off. Export a copy to keep your work.",
      );
    } catch (error) {
      if (repository !== owner || activeHandle !== handle || disposed) return;
      setSaveStatus("error");
      setStorageMessage(
        error instanceof Error ? error.message : "Could not save this project.",
      );
      throw error;
    }
  }

  async function performRetryLocalSaving() {
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
      const handle = await owner.open(current.id);
      handle.doc.merge(current.snapshot(), ORIGIN.import);
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
        collapsed: [...collapsedIds()],
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

  async function performOpenLoad() {
    clearSaveStatus();
    finishWriting();
    const owner = repository;
    try {
      cloud?.retry();
      await queryClient.fetchQuery({
        queryKey: catalogKey(owner.names.catalog),
        queryFn: () => owner.list(),
      });
      if (repository !== owner || disposed) return;
      setStorageMessage("");
      setShowLoad(true);
    } catch (error) {
      if (repository !== owner || disposed) return;
      setStorageMessage(
        "Could not list projects. Browser storage is unavailable.",
      );
      throw error;
    }
  }

  function load(id: string) {
    openMutation.mutate(id);
  }

  async function performExportCurrentProject() {
    finishWriting();
    finishProjectName();
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
        throw error;
      }
    }
  }

  async function performImportProjectFromFile() {
    finishWriting();
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
      const handle = await owner.importContent({
        ...content,
        saving: preferences?.saving ?? view().saving(),
      });
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
            ...(preferences.anchor &&
              handle.importedIds?.get(preferences.anchor.id) && {
                anchor: {
                  ...preferences.anchor,
                  id: handle.importedIds.get(preferences.anchor.id),
                },
              }),
          })
          .catch(() => {});
      await activate(handle, owner);
      if (owner !== repository || disposed) return;
      await owner.setLatestProject(handle.id).catch(() => {});
      setStorageMessage(`Imported “${content.name}”.`);
    } catch (error) {
      if (owner !== repository || disposed) return;
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStorageMessage(
          error instanceof Error
            ? error.message
            : "Could not import this project file.",
        );
        throw error;
      }
    }
  }

  // Reverts this session's own changes only; remote edits are preserved.
  function undo() {
    const { undo } = session();
    undo.finishGroup();
    undo.undo();
    canvas.focus({ preventScroll: true });
  }

  function redo() {
    const { undo } = session();
    undo.finishGroup();
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

  function revealNode(id: string) {
    const next = new Set(collapsedIds());
    for (
      let parent = details().get(id)?.parent;
      parent;
      parent = details().get(parent)?.parent
    )
      next.delete(parent);
    if (next.size !== collapsedIds().size) setCollapsedIds(next);
  }

  function toggleCollapse(id: string, focusCanvas = true) {
    if (!details().get(id)?.descendants) return;
    cancelPointer();
    const node = positionedNodes().get(id);
    batch(() => {
      if (node) setLayoutAnchor({ id, centerY: node.y + node.height / 2 });
      setCollapsedIds((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    });
    if (focusCanvas) canvas.focus({ preventScroll: true });
  }

  // One editing session is one undo step.
  function finishWriting() {
    if (!writing()) return;
    setWriting(false);
    session().undo.finishGroup();
    canvas.focus({ preventScroll: true });
  }

  function write(id: string) {
    if (writing() && selectedId() === id) return;
    finishWriting();
    revealNode(id);
    if (selectedId() !== id) setColorScope("node");
    setSelectedId(id);
    session().undo.finishGroup();
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
    const menuHeight = nodeId
      ? details().get(nodeId)?.descendants
        ? 144
        : 104
      : 56;
    setContextMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - menuHeight - 8)),
      nodeId,
      rootPosition,
    });
  }

  function add(kind: "child" | "sibling" | "root", position?: NodePosition) {
    finishWriting();
    // Siblings and new roots of a focused branch would appear outside the view.
    if (
      focusId() &&
      (kind === "root" || selectedId() === focusId()) &&
      kind !== "child"
    ) {
      showNotice({
        message: "Leave focus to add ideas beside this branch",
        action: { label: "Leave focus", run: exitFocus },
      });
      return;
    }
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

  const nodeLabel = (id: string) =>
    truncate(view().text(id).trim() || "New idea", 32);
  const childrenOf = (parent: string | undefined) =>
    parent ? (findNode(forest(), parent)?.next ?? []) : forest();
  // Manual offsets are relative to the old surroundings, so a branch that
  // changes parent returns to automatic placement.
  const placedIds = (id: string) =>
    [...branchIds(forest(), id)].filter(
      (key) => findNode(forest(), key)?.position,
    );

  function moveBranch(id: string, target: DropTarget) {
    const parent =
      target.kind === "inside" ? target.id : details().get(target.id)?.parent;
    const siblings = childrenOf(parent).filter((node) => node.id !== id);
    const index =
      target.kind === "inside"
        ? siblings.length
        : siblings.findIndex((node) => node.id === target.id) +
          (target.kind === "after" ? 1 : 0);
    const placed = placedIds(id);
    const moved = command((doc) => {
      const changed = moveNode(doc, id, parent ?? null, index);
      return clearPositions(doc, placed) || changed;
    });
    if (!moved) return;
    setSelectedId(id);
    showNotice({
      message: parent
        ? `Moved “${nodeLabel(id)}” under “${nodeLabel(parent)}”`
        : `Moved “${nodeLabel(id)}” to the top level`,
      action: { label: "Undo", run: undo },
    });
  }

  // Ctrl+Right: become the last child of the previous sibling.
  function indentSelected() {
    const id = selectedId();
    if (!id) return;
    const siblings = childrenOf(details().get(id)?.parent);
    const previous = siblings[siblings.findIndex((node) => node.id === id) - 1];
    if (previous) moveBranch(id, { kind: "inside", id: previous.id });
  }

  // Ctrl+Left: become the sibling just after the current parent.
  function outdentSelected() {
    const id = selectedId();
    const parent = id && details().get(id)?.parent;
    if (id && parent) moveBranch(id, { kind: "after", id: parent });
  }

  // Wraps the selected branch in a new parent at the same place.
  function insertParent() {
    const id = selectedId();
    if (!id) return;
    finishWriting();
    const parent = details().get(id)?.parent;
    const index = childrenOf(parent).findIndex((node) => node.id === id);
    const color = findNode(forest(), id)?.color;
    const placed = placedIds(id);
    const created = command((doc) => {
      const wrapper = createNodeAt(doc, parent ?? null, index, {
        text: "New idea",
        color,
      });
      moveNode(doc, id, wrapper, 0);
      clearPositions(doc, placed);
      return wrapper;
    });
    if (created) write(created);
  }

  // Selection moves to the next sibling, else the previous one, else the
  // parent, so keyboard deletion can continue without reaching for the mouse.
  function removeSelected() {
    const id = selectedId();
    if (!id) return;
    finishWriting();
    const parent = details().get(id)?.parent;
    const siblings = parent
      ? (findNode(visibleForest(), parent)?.next ?? [])
      : visibleForest();
    const index = siblings.findIndex((node) => node.id === id);
    const nextId = siblings[index + 1]?.id ?? siblings[index - 1]?.id ?? parent;
    const text = view().text(id).trim() || "New idea";
    const removed = 1 + (details().get(id)?.descendants ?? 0);
    if (!command((doc) => deleteSubtree(doc, id))) return;
    setSelectedId(nextId);
    setColorScope("node");
    showNotice({
      message:
        removed === 1
          ? `Deleted “${truncate(text, 32)}”`
          : `Deleted “${truncate(text, 32)}” and ${removed - 1} more`,
      action: { label: "Undo", run: undo },
    });
    canvas.focus({ preventScroll: true });
  }

  function colorSelectedNode(color: NodeColor) {
    const id = selectedId();
    if (!id || writing()) return;
    command((doc) => setNodeColor(doc, id, color, colorScope() === "branch"));
  }

  // Pointer zoom keeps the point under the pointer still. Button and keyboard
  // zoom keep the selected node still when it is visible, else the center.
  function changeZoom(value: number, clientX?: number, clientY?: number) {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    const bounds = canvas.getBoundingClientRect();
    let x = 0;
    let y = 0;
    if (clientX !== undefined && clientY !== undefined) {
      x = clientX - bounds.left - bounds.width / 2;
      y = clientY - bounds.top - bounds.height / 2;
    } else {
      const node = positionedNodes().get(selectedId() ?? "");
      if (node) {
        const origin = viewOrigin();
        const nodeX = left() + zoom() * (node.x + node.width / 2 - origin.x);
        const nodeY = top() + zoom() * (node.y + node.height / 2 - origin.y);
        if (
          Math.abs(nodeX) < bounds.width / 2 &&
          Math.abs(nodeY) < bounds.height / 2
        ) {
          x = nodeX;
          y = nodeY;
        }
      }
    }
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
      const id = pointer.nodeId;
      const bounds = canvas.getBoundingClientRect();
      const origin = viewOrigin();
      batch(() => {
        setDrag({
          id,
          delta: { x: dx / pointer!.zoom, y: dy / pointer!.zoom },
        });
        setDropTarget(
          dropTargetAt(
            baseLayout().nodes,
            {
              x:
                (e.clientX - bounds.left - bounds.width / 2 - left()) / zoom() +
                origin.x,
              y:
                (e.clientY - bounds.top - bounds.height / 2 - top()) / zoom() +
                origin.y,
            },
            branchIds(forest(), id),
          ),
        );
        setDragPointer({ x: e.clientX, y: e.clientY });
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
      const target = dropTarget();
      batch(() => {
        if (target) moveBranch(id, target);
        else
          command((doc) => translateSubtree(doc, id, basePositions(), delta));
        setDrag(undefined);
        setDropTarget(undefined);
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
      void queryClient.cancelQueries({
        queryKey: catalogKey(repository.names.catalog),
      });
      queryClient.removeQueries({
        queryKey: catalogKey(repository.names.catalog),
      });
      void queryClient.cancelQueries({
        queryKey: ["anonymous-claims", deployment],
      });
      queryClient.removeQueries({ queryKey: ["anonymous-claims", deployment] });
      stopDurability?.();
      void repository.close();
      for (const recovery of parked) void recovery.repository.close();
    });

    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        repository.hasMemoryOnlyProjects() ||
        (!view().saving().local &&
          (!view().saving().cloud || cloudStatus()?.status !== "saved"))
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", beforeUnload));
    const keydown = (e: KeyboardEvent) => {
      if (showPreferences() || showHelp() || searchOpen()) return;
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
      // Escape steps back one level: a drag, then the selection, then focus.
      if (e.key === "Escape") {
        e.preventDefault();
        if (pointer) cancelPointer();
        else if (selectedId()) {
          setSelectedId(undefined);
          setColorScope("node");
        } else if (focusId()) exitFocus();
        canvas.focus({ preventScroll: true });
        return;
      }
      if (pointer) return;
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        openSearch();
        return;
      }
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShowHelp((open) => !open);
        return;
      }
      if (
        matchesLetter(e, "o") &&
        !e.repeat &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        setOutlineOpen((open) => !open);
        return;
      }
      // Physical keys keep view shortcuts working on every keyboard layout.
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && ["Equal", "NumpadAdd"].includes(e.code)) {
        e.preventDefault();
        changeZoom(zoom() * 1.2);
        return;
      }
      if (mod && !e.altKey && ["Minus", "NumpadSubtract"].includes(e.code)) {
        e.preventDefault();
        changeZoom(zoom() / 1.2);
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === "Digit0") {
        e.preventDefault();
        changeZoom(1);
        return;
      }
      if (e.shiftKey && !mod && !e.altKey && e.code === "Digit1") {
        e.preventDefault();
        fitMap();
        return;
      }
      if (e.shiftKey && !mod && !e.altKey && e.code === "Digit2") {
        e.preventDefault();
        fitSelection();
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
        matchesLetter(e, "g") &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        toggleCollapse(selectedId() as string);
      } else if (
        matchesLetter(e, "f") &&
        !e.repeat &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        if (focusId() === selectedId()) exitFocus();
        else focusBranch();
      } else if (
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
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        if (e.key === "ArrowRight") indentSelected();
        else outdentSelected();
      } else if (
        e.key === "Tab" &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        insertParent();
      } else if (
        arrow &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        const target = navigationTarget(visibleForest(), selectedId()!, arrow);
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
      if (pointer) return;
      const unit =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? canvas.clientHeight
            : 1;
      // Trackpad pinches arrive as ctrl+wheel. Plain scrolling pans, matching
      // two-finger trackpad movement; the preference switches mouse wheels to zoom.
      if (e.ctrlKey || e.metaKey || wheelMode() === "zoom")
        changeZoom(
          // Clamped so a mouse-wheel notch and a pinch both zoom smoothly.
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
        manager.finishGroup();
        if (action === "undo") manager.undo();
        else manager.redo();
      } else if (action === "undo") undo();
      else redo();
    };
    // Let the callback decide whether the target accepts text before suppressing
    // the browser's native save dialog.
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (matchesLetter(event, "f") && !event.shiftKey) {
        if (!storageReady() || showPreferences()) return;
        event.preventDefault();
        openSearch();
        return;
      }
      if (matchesLetter(event, "s") && !event.shiftKey) saveShortcut(event);
      else if (matchesLetter(event, "z"))
        historyShortcut(event, event.shiftKey ? "redo" : "undo");
      else if (matchesLetter(event, "y") && !event.shiftKey)
        historyShortcut(event, "redo");
    };
    window.addEventListener("keydown", shortcuts);
    onCleanup(() => window.removeEventListener("keydown", shortcuts));
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
    const canvasClipboard = (e: ClipboardEvent) =>
      storageReady() &&
      !writing() &&
      !showPreferences() &&
      !showHelp() &&
      !searchOpen() &&
      !(
        e.target instanceof Element &&
        e.target.closest("input, textarea, [contenteditable=true], dialog")
      );
    const copyBranch = (e: ClipboardEvent) => {
      const id = selectedId();
      const node = id && findNode(forest(), id);
      if (!node || !canvasClipboard(e) || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData(
        "text/plain",
        branchOutline(node, (key) => view().text(key)),
      );
      if (e.type === "cut") removeSelected();
      else
        showNotice({
          message: `Copied “${nodeLabel(node.id)}”${node.next?.length ? " with its branch" : ""}`,
        });
    };
    const paste = (e: ClipboardEvent) => {
      if (!canvasClipboard(e) || !e.clipboardData) return;
      const entries = parseOutline(e.clipboardData.getData("text/plain"));
      if (!entries.length) return;
      e.preventDefault();
      pasteOutline(entries);
    };
    window.addEventListener("copy", copyBranch);
    window.addEventListener("cut", copyBranch);
    window.addEventListener("paste", paste);
    onCleanup(() => {
      window.removeEventListener("copy", copyBranch);
      window.removeEventListener("cut", copyBranch);
      window.removeEventListener("paste", paste);
    });
    // Two fingers pinch to zoom and move together to pan. A pinch replaces
    // any one-finger pan or drag already in progress.
    const touches = new Map<number, { x: number; y: number }>();
    let pinch:
      | { distance: number; x: number; y: number; zoom: number }
      | undefined;
    const pinchFrame = () => {
      const [a, b] = [...touches.values()];
      return {
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      };
    };
    const touchDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        cancelPointer();
        pinch = { ...pinchFrame(), zoom: zoom() };
      }
    };
    const touchMove = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinch || touches.size !== 2) return;
      const next = pinchFrame();
      batch(() => {
        setLeft(left() + next.x - pinch!.x);
        setTop(top() + next.y - pinch!.y);
        changeZoom(
          (pinch!.zoom * next.distance) / pinch!.distance,
          next.x,
          next.y,
        );
      });
      pinch = { ...pinch, x: next.x, y: next.y };
    };
    const touchUp = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = undefined;
    };
    canvas.addEventListener("pointerdown", touchDown, { capture: true });
    window.addEventListener("pointermove", touchMove);
    window.addEventListener("pointerup", touchUp);
    window.addEventListener("pointercancel", touchUp);
    onCleanup(() => {
      canvas.removeEventListener("pointerdown", touchDown, { capture: true });
      window.removeEventListener("pointermove", touchMove);
      window.removeEventListener("pointerup", touchUp);
      window.removeEventListener("pointercancel", touchUp);
    });
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
      const element = contextMenuElement;
      if (!element) return;
      // Keep the whole menu on screen whatever its length.
      const bounds = element.getBoundingClientRect();
      const shiftY = Math.min(0, window.innerHeight - 8 - bounds.bottom);
      const shiftX = Math.min(0, window.innerWidth - 8 - bounds.right);
      if (shiftY || shiftX)
        setContextMenu(
          (menu) =>
            menu && {
              ...menu,
              x: Math.max(8, menu.x + shiftX),
              y: Math.max(menu.above ? bounds.height + 8 : 8, menu.y + shiftY),
            },
        );
      element.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
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
      class="map-canvas overflow-hidden w-screen h-screen text-stone-900 relative touch-none select-none outline-none"
      style={{ cursor: panning() || draggingId() ? "grabbing" : "grab" }}
    >
      <ProjectPreferences
        open={showPreferences()}
        onClose={() => setShowPreferences(false)}
        saving={view().saving()}
        onChange={(value) => void changeSaving(value)}
        busy={preferencesBusy()}
        error={preferencesError()}
        cloudStatus={cloudStatus()}
        signedIn={account().status === "authenticated"}
        onExport={exportCurrentProject}
      />
      <div class="pointer-events-none absolute top-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2">
        <section
          data-no-pan
          data-toolbar
          aria-label="Project"
          class="map-toolbar pointer-events-auto flex max-w-full items-center gap-0.5 cursor-default"
        >
          <BrandMark class="mx-1 size-6 shrink-0" />
          <input
            type="text"
            required
            aria-label="Project name"
            class="project-name"
            style={{
              width: `${Math.min(28, Math.max(6, (projectNameDraft() ?? view().name()).length + 1))}ch`,
            }}
            value={projectNameDraft() ?? view().name()}
            onInput={(e) => setProjectNameDraft(e.currentTarget.value)}
            onBlur={finishProjectName}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape")
                e.currentTarget.blur();
            }}
          />
          <button
            type="button"
            class="icon-button"
            aria-label="Project menu"
            title="Project menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
            onClick={() => {
              finishWriting();
              finishProjectName();
              setShowLoad(false);
              setMenuOpen((open) => !open);
            }}
          >
            <ChevronDownIcon />
          </button>
          <span class="mx-1 h-5 w-px shrink-0 bg-stone-200" />
          <fieldset
            aria-label="Project actions"
            class="flex min-w-0 items-center gap-2 pr-2 text-xs text-stone-500"
          >
            <span
              role="status"
              class="save-state"
              data-tone={
                !view().saving().local
                  ? "muted"
                  : saveStatus() === "error"
                    ? "error"
                    : saveStatus() === "saving"
                      ? "busy"
                      : "ok"
              }
            >
              {!view().saving().local
                ? "Local saving off"
                : saveStatus() === "saving"
                  ? "Saving…"
                  : saveStatus() === "error"
                    ? "Save failed"
                    : "Saved locally"}
            </span>
            <Show when={cloudStatus()}>
              {(status) => (
                <span
                  role="status"
                  class="save-state"
                  data-tone={
                    status().status === "saved"
                      ? "ok"
                      : status().status === "saving" ||
                          status().status === "deleting"
                        ? "busy"
                        : status().status === "disabled"
                          ? "muted"
                          : "warn"
                  }
                >
                  {status().status === "disabled"
                    ? "Cloud saving off"
                    : status().status === "deleting"
                      ? "Deleting cloud copy…"
                      : status().status === "saved"
                        ? "Saved to cloud"
                        : status().status === "saving"
                          ? "Saving to cloud…"
                          : status().status === "offline"
                            ? "Offline · cloud save pending"
                            : "message" in status()
                              ? (status() as { message: string }).message
                              : ""}
                </span>
              )}
            </Show>
          </fieldset>
        </section>
        <Show when={menuOpen()}>
          <div
            ref={projectMenu}
            data-no-pan
            data-toolbar
            role="menu"
            aria-label="Project menu"
            class="map-toolbar menu-panel pointer-events-auto w-72 cursor-default"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setMenuOpen(false);
                canvas.focus({ preventScroll: true });
              } else menuArrowKeys(e);
            }}
          >
            <fieldset disabled={fileBusy()} class="contents">
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                disabled={!storageReady()}
                onClick={() => {
                  setMenuOpen(false);
                  createNewProject();
                }}
              >
                New map
              </button>
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                aria-expanded={showLoad()}
                aria-controls="saved-projects"
                disabled={!storageReady()}
                onClick={() =>
                  showLoad() ? setShowLoad(false) : void openLoad()
                }
              >
                Open map…
                <ChevronRightIcon
                  class={`ml-auto size-4 transition-transform ${showLoad() ? "rotate-90" : ""}`}
                />
              </button>
              <Show when={showLoad()}>
                <ul
                  id="saved-projects"
                  aria-label="Available projects"
                  class="mx-1 mb-1 max-h-60 overflow-y-auto rounded-lg bg-stone-50 p-1 text-sm"
                >
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
                          role="menuitem"
                          class="menu-item"
                          aria-label={`${project.name} · ${project.id.slice(0, 8)}`}
                          aria-current={
                            project.id === doc().id ? "true" : undefined
                          }
                          onClick={() => {
                            setMenuOpen(false);
                            load(project.id);
                          }}
                        >
                          <span class="min-w-0 flex-1 truncate">
                            {project.name}
                          </span>
                          <Show when={project.id === doc().id}>
                            <span class="text-xs text-stone-400">Open</span>
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                disabled={!storageReady()}
                onClick={() => {
                  setMenuOpen(false);
                  importProjectFromFile();
                }}
              >
                Import backup…
              </button>
              <div class="menu-divider" />
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                disabled={!storageReady()}
                onClick={() => {
                  setMenuOpen(false);
                  save();
                }}
              >
                Save now
                <kbd class="ml-auto">{MOD_LABEL}S</kbd>
              </button>
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  exportCurrentProject();
                }}
              >
                Export backup (.json)
              </button>
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  void exportMarkdown();
                }}
              >
                Export outline (.md)
              </button>
              <div class="menu-divider" />
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                disabled={!storageReady()}
                aria-haspopup="dialog"
                onClick={() => {
                  setMenuOpen(false);
                  finishWriting();
                  finishProjectName();
                  setShowPreferences(true);
                }}
              >
                Project preferences…
              </button>
            </fieldset>
          </div>
        </Show>
        <Show
          when={
            storageMessage() ||
            recoveryPending() ||
            !storageReady() ||
            saveStatus() === "error" ||
            (!view().saving().local && !view().saving().cloud) ||
            ["retrying", "blocked", "auth"].includes(
              cloudStatus()?.status ?? "",
            )
          }
        >
          <div
            data-no-pan
            data-toolbar
            class="map-toolbar pointer-events-auto flex w-80 max-w-full flex-col gap-1 p-2 text-xs text-stone-600 cursor-default"
          >
            <Show when={!view().saving().local && !view().saving().cloud}>
              <p role="status" class="text-amber-800">
                Memory only · Export before closing this tab.
              </p>
            </Show>
            <p role="status" class="empty:hidden">
              {storageMessage()}
            </p>
            <Show when={recoveryPending()}>
              <p role="status">
                Edits from the previous account could not be saved. They remain
                in memory; retry before leaving.
              </p>
            </Show>
            <div class="flex flex-wrap gap-1 empty:hidden">
              <Show
                when={
                  recoveryPending() ||
                  !storageReady() ||
                  saveStatus() === "error"
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
              <Show
                when={["retrying", "blocked", "auth"].includes(
                  cloudStatus()?.status ?? "",
                )}
              >
                <button
                  type="button"
                  class="map-control text-xs"
                  onClick={() => {
                    if (account().status === "expired") void auth.check();
                    else cloud?.retry();
                  }}
                >
                  Retry
                </button>
              </Show>
            </div>
          </div>
        </Show>
      </div>
      <div class="pointer-events-none absolute top-3 right-3 z-30 flex flex-col items-end gap-2">
        <div class="flex flex-col items-end gap-2 sm:flex-row sm:items-start">
          <nav
            data-no-pan
            data-toolbar
            aria-label="Editing"
            class="map-toolbar pointer-events-auto flex items-center gap-0.5 cursor-default"
          >
            <button
              type="button"
              class="icon-button"
              aria-label="Search"
              title={`Search (${MOD_LABEL}F)`}
              aria-expanded={searchOpen()}
              disabled={!storageReady()}
              onClick={() => (searchOpen() ? closeSearch(false) : openSearch())}
            >
              <SearchIcon />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Outline"
              title="Outline (O)"
              aria-pressed={outlineOpen()}
              disabled={!storageReady()}
              onClick={() => setOutlineOpen((open) => !open)}
            >
              <OutlineIcon />
            </button>
            <span class="mx-0.5 h-5 w-px bg-stone-200" />
            <button
              type="button"
              class="icon-button"
              aria-label="Undo"
              title={`Undo (${MOD_LABEL}Z)`}
              disabled={!storageReady() || !canUndo()}
              onClick={undo}
            >
              <UndoIcon />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Redo"
              title={`Redo (${MOD_LABEL}⇧Z)`}
              disabled={!storageReady() || !canRedo()}
              onClick={redo}
            >
              <RedoIcon />
            </button>
          </nav>
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
        <Show when={searchOpen()}>
          <search
            data-no-pan
            data-toolbar
            aria-label="Search ideas"
            class="map-toolbar pointer-events-auto flex w-80 max-w-[calc(100vw-1.5rem)] flex-col cursor-default"
          >
            <div class="flex items-center gap-2 px-2">
              <SearchIcon class="size-4 shrink-0 text-stone-400" />
              <input
                ref={searchInput}
                type="search"
                aria-label="Search ideas"
                aria-controls="search-results"
                aria-activedescendant={
                  searchResults()[searchIndex()]
                    ? `search-result-${searchIndex()}`
                    : undefined
                }
                placeholder={
                  focusId() ? "Search this branch" : "Search this map"
                }
                class="search-field min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-stone-400"
                value={searchQuery()}
                onInput={(e) => {
                  batch(() => {
                    setSearchQuery(e.currentTarget.value);
                    setSearchIndex(0);
                  });
                }}
                onKeyDown={(e) => {
                  const count = searchResults().length;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeSearch(false);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    closeSearch(count > 0);
                  } else if (
                    count &&
                    (e.key === "ArrowDown" || e.key === "ArrowUp")
                  ) {
                    e.preventDefault();
                    setSearchIndex(
                      (index) =>
                        (index + (e.key === "ArrowDown" ? 1 : -1) + count) %
                        count,
                    );
                  }
                }}
              />
              <button
                type="button"
                class="icon-button -mr-1"
                aria-label="Close search"
                title="Close search and return (Esc)"
                onClick={() => closeSearch(false)}
              >
                <CloseIcon class="size-4" />
              </button>
            </div>
            <Show when={searchQuery().trim()}>
              <div
                id="search-results"
                role="listbox"
                aria-label="Search results"
                class="max-h-80 overflow-y-auto border-t border-stone-100 p-1"
              >
                <For
                  each={searchResults()}
                  fallback={
                    <p class="px-2 py-3 text-center text-xs text-stone-500">
                      No ideas match “{truncate(searchQuery().trim(), 24)}”
                    </p>
                  }
                >
                  {(result, index) => (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: The search field owns keyboard selection through aria-activedescendant.
                    <div
                      id={`search-result-${index()}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index() === searchIndex()}
                      class="search-result"
                      onPointerEnter={() => setSearchIndex(index())}
                      onClick={() => {
                        setSearchIndex(index());
                        closeSearch(true);
                      }}
                    >
                      <span class="block truncate text-sm text-stone-800">
                        {result.text.slice(0, result.match[0])}
                        <mark>
                          {result.text.slice(result.match[0], result.match[1])}
                        </mark>
                        {result.text.slice(result.match[1])}
                      </span>
                      <Show when={result.path.length}>
                        <span class="block truncate text-xs text-stone-400">
                          {result.path
                            .map((part) => truncate(part, 20))
                            .join(" › ")}
                        </span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
              <p class="border-t border-stone-100 px-3 py-1.5 text-[11px] text-stone-400">
                ↑↓ preview · Enter go · Esc return
              </p>
            </Show>
          </search>
        </Show>
      </div>
      <Show when={outlineOpen()}>
        <div class="pointer-events-none absolute top-[4.5rem] bottom-3 left-3 z-20 flex w-72 max-w-[calc(100%-1.5rem)] flex-col">
          <Outline
            roots={scopeForest()}
            text={(id) => view().text(id)}
            selectedId={selectedId()}
            collapsed={collapsedIds()}
            onSelect={(id) => {
              finishWriting();
              setColorScope("node");
              setSelectedId(id);
            }}
            onToggle={(id) => toggleCollapse(id, false)}
            onEdit={write}
            onClose={() => {
              setOutlineOpen(false);
              canvas.focus({ preventScroll: true });
            }}
          />
        </div>
      </Show>
      <Show when={focusId()}>
        <nav
          data-no-pan
          data-toolbar
          aria-label="Branch focus"
          class="map-toolbar absolute top-16 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 text-sm cursor-default"
        >
          <button
            type="button"
            class="map-control flex items-center gap-1.5"
            title="Show the whole map (Esc)"
            onClick={exitFocus}
          >
            <ArrowLeftIcon class="size-4" />
            Whole map
          </button>
          <For each={focusPath()}>
            {(id, index) => (
              <>
                <ChevronRightIcon class="size-3.5 shrink-0 text-stone-400" />
                <Show
                  when={index() < focusPath().length - 1}
                  fallback={
                    <span
                      aria-current="location"
                      class="max-w-48 truncate px-2 font-medium text-stone-800"
                    >
                      {nodeLabel(id)}
                    </span>
                  }
                >
                  <button
                    type="button"
                    class="map-control max-w-36 truncate"
                    onClick={() => focusBranch(id)}
                  >
                    {nodeLabel(id)}
                  </button>
                </Show>
              </>
            )}
          </For>
        </nav>
      </Show>
      <div class="pointer-events-none absolute bottom-[4.5rem] left-1/2 z-20 flex sm:bottom-3 w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col items-center gap-2">
        <Show when={notice()}>
          {(current) => (
            <div
              role="status"
              data-no-pan
              data-toolbar
              class="notice pointer-events-auto flex items-center gap-3 cursor-default"
            >
              <span class="min-w-0 truncate">{current().message}</span>
              <Show when={current().action}>
                {(action) => (
                  <button
                    type="button"
                    class="notice-action"
                    onClick={() => {
                      setNotice(undefined);
                      action().run();
                    }}
                  >
                    {action().label}
                  </button>
                )}
              </Show>
            </div>
          )}
        </Show>
        <Show when={selectedId() && !writing() && !drag()}>
          <section
            data-no-pan
            data-toolbar
            aria-label="Selected idea"
            class="map-toolbar pointer-events-auto relative flex items-center gap-0.5 cursor-default"
          >
            <Show when={colorOpen()}>
              <section
                aria-label="Selected node color controls"
                class="map-toolbar absolute bottom-full left-1/2 mb-2 flex w-64 -translate-x-1/2 flex-col gap-2"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setColorOpen(false);
                    canvas.focus({ preventScroll: true });
                  }
                }}
              >
                <fieldset class="grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1">
                  <legend class="sr-only">Apply color to</legend>
                  <label
                    class="color-scope"
                    classList={{
                      "color-scope-selected": colorScope() === "node",
                    }}
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
                <fieldset class="grid grid-cols-4 gap-1 px-1">
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
                          class={`grid size-7 place-items-center rounded-full border-2 ${color.swatchClass}`}
                        >
                          <Show
                            when={
                              (selectedNode()?.color ?? "blue") === color.value
                            }
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
            <button
              type="button"
              class="tool-button"
              title="Add a child idea (Tab)"
              onClick={() => add("child")}
            >
              <ChildIcon />
              <span class="max-sm:sr-only">Child</span>
            </button>
            <button
              type="button"
              class="tool-button"
              title="Add a sibling idea (Enter)"
              disabled={selectedId() === focusId()}
              onClick={() => add("sibling")}
            >
              <SiblingIcon />
              <span class="max-sm:sr-only">Sibling</span>
            </button>
            <span class="mx-0.5 h-5 w-px bg-stone-200" />
            <button
              type="button"
              class="icon-button"
              aria-label="Color"
              title="Color"
              aria-expanded={colorOpen()}
              onClick={() => setColorOpen((open) => !open)}
            >
              <span
                aria-hidden="true"
                class={`size-4.5 rounded-full border-2 ${(NODE_COLORS.find((color) => color.value === (selectedNode()?.color ?? "blue")) ?? NODE_COLORS[0]).swatchClass}`}
              />
            </button>
            <Show when={details().get(selectedId() ?? "")?.descendants}>
              <button
                type="button"
                class="icon-button"
                aria-label={
                  collapsedIds().has(selectedId() ?? "")
                    ? "Expand children"
                    : "Collapse children"
                }
                title={`${collapsedIds().has(selectedId() ?? "") ? "Expand" : "Collapse"} children (G)`}
                onClick={() => toggleCollapse(selectedId() as string)}
              >
                <Show
                  when={collapsedIds().has(selectedId() ?? "")}
                  fallback={<FoldIcon />}
                >
                  <UnfoldIcon />
                </Show>
              </button>
              <button
                type="button"
                class="icon-button"
                aria-label={
                  focusId() === selectedId() ? "Leave focus" : "Focus branch"
                }
                title={`${focusId() === selectedId() ? "Leave focus" : "Focus on this branch"} (F)`}
                aria-pressed={focusId() === selectedId()}
                onClick={() =>
                  focusId() === selectedId() ? exitFocus() : focusBranch()
                }
              >
                <FocusIcon />
              </button>
            </Show>
            <button
              type="button"
              class="icon-button"
              aria-label="More actions"
              title="More actions"
              aria-haspopup="menu"
              onClick={(e) => {
                const bounds = e.currentTarget.getBoundingClientRect();
                const id = selectedId();
                setContextMenu({
                  x: Math.max(
                    8,
                    Math.min(bounds.left, window.innerWidth - 232),
                  ),
                  y: bounds.top - 8,
                  nodeId: id,
                  above: true,
                });
              }}
            >
              <MoreIcon />
            </button>
            <span class="mx-0.5 h-5 w-px bg-stone-200" />
            <button
              type="button"
              class="icon-button hover:text-rose-700!"
              aria-label="Delete idea"
              title={`Delete with its children (Delete)`}
              onClick={removeSelected}
            >
              <TrashIcon />
            </button>
          </section>
        </Show>
      </div>
      <Show
        when={
          !hintDismissed() &&
          !outlineOpen() &&
          forest().length > 0 &&
          details().size <= 4
        }
      >
        <aside
          data-no-pan
          data-toolbar
          aria-label="Getting started"
          class="map-toolbar absolute bottom-3 left-3 z-10 hidden w-64 cursor-default p-3 text-xs leading-5 text-stone-600 sm:block"
        >
          <div class="mb-1 flex items-center justify-between">
            <p class="text-sm font-semibold text-stone-800">Quick start</p>
            <button
              type="button"
              class="icon-button -mr-1.5 -mt-1.5"
              aria-label="Dismiss quick start"
              onClick={dismissHint}
            >
              <CloseIcon class="size-4" />
            </button>
          </div>
          <ul class="space-y-0.5">
            <li>
              <kbd>Tab</kbd> adds a child, <kbd>Enter</kbd> a sibling
            </li>
            <li>
              Double-click or <kbd>F2</kbd> to edit an idea
            </li>
            <li>Drag an idea onto another to move it under</li>
            <li>
              <kbd>{MOD_LABEL}Z</kbd> undoes anything
            </li>
          </ul>
          <button
            type="button"
            class="mt-2 font-medium text-blue-700 hover:underline"
            onClick={() => setShowHelp(true)}
          >
            All shortcuts
          </button>
        </aside>
      </Show>
      <div
        class="map-layer absolute w-full h-full origin-top-left"
        classList={{ "map-layer-easing": easingView() }}
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
          <For each={layout().connections}>
            {(connection) => (
              <path d={connectionPath(connection)} fill="none" />
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
                root={!details().get(id)?.parent || focusId() === id}
                descendants={details().get(id)?.descendants ?? 0}
                collapsed={collapsedIds().has(id)}
                onToggleCollapse={() => {
                  select(id);
                  toggleCollapse(id);
                }}
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
        <Show when={dropTarget()}>
          {(target) => (
            <Show when={positionedNodes().get(target().id)}>
              {(rect) => (
                <div
                  aria-hidden="true"
                  class="drop-indicator"
                  data-kind={target().kind}
                  style={{
                    transform: `translate(${rect().x}px, ${
                      target().kind === "before"
                        ? rect().y - 8
                        : target().kind === "after"
                          ? rect().y + rect().height + 5
                          : rect().y
                    }px)`,
                    width: `${rect().width}px`,
                    height:
                      target().kind === "inside"
                        ? `${rect().height}px`
                        : undefined,
                  }}
                />
              )}
            </Show>
          )}
        </Show>
      </div>
      <Show when={drag() && dragPointer()}>
        <div
          aria-hidden="true"
          class="drag-label"
          style={{
            left: `${(dragPointer()?.x ?? 0) + 14}px`,
            top: `${(dragPointer()?.y ?? 0) + 16}px`,
          }}
        >
          {dragLabel()}
        </div>
      </Show>
      <Show when={!forest().length}>
        <div
          data-no-pan
          data-toolbar
          class="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 text-center cursor-default"
        >
          <p class="text-lg font-semibold text-stone-800">
            Your canvas is empty
          </p>
          <p class="max-w-64 text-sm text-stone-500">
            Start with the central idea. Press <kbd>Enter</kbd> anytime to add
            one.
          </p>
          <button
            type="button"
            class="primary-button"
            disabled={!storageReady()}
            onClick={() => add("root")}
          >
            Create an idea
          </button>
        </div>
      </Show>
      <Show when={contextMenu()}>
        {(menu) => (
          <div
            ref={contextMenuElement}
            data-no-pan
            data-toolbar
            data-context-menu
            role="menu"
            aria-label={menu().nodeId ? "Node actions" : "Canvas actions"}
            class="map-toolbar menu-panel fixed z-50 w-60 text-sm cursor-default"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
              transform: menu().above ? "translateY(-100%)" : undefined,
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
              menuArrowKeys(e);
            }}
          >
            <Show
              when={menu().nodeId}
              fallback={
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item"
                  onClick={() => {
                    const position = menu().rootPosition;
                    setContextMenu(undefined);
                    add("root", position);
                  }}
                >
                  Create root node
                </button>
              }
            >
              {(nodeId) => {
                const run = (action: () => void) => () => {
                  setContextMenu(undefined);
                  setSelectedId(nodeId());
                  action();
                };
                const siblings = () =>
                  childrenOf(details().get(nodeId())?.parent);
                return (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      onClick={run(() => add("child"))}
                    >
                      Add child node
                      <kbd class="ml-auto">Tab</kbd>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      disabled={nodeId() === focusId()}
                      onClick={run(() => add("sibling"))}
                    >
                      Add sibling
                      <kbd class="ml-auto">Enter</kbd>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      disabled={nodeId() === focusId()}
                      onClick={run(insertParent)}
                    >
                      Insert parent
                      <kbd class="ml-auto">⇧Tab</kbd>
                    </button>
                    <div class="menu-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      disabled={siblings()[0]?.id === nodeId()}
                      onClick={run(indentSelected)}
                    >
                      Move under idea above
                      <kbd class="ml-auto">Ctrl→</kbd>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      disabled={
                        !details().get(nodeId())?.parent ||
                        nodeId() === focusId()
                      }
                      onClick={run(outdentSelected)}
                    >
                      Move out to parent level
                      <kbd class="ml-auto">Ctrl←</kbd>
                    </button>
                    <Show when={placedIds(nodeId()).length}>
                      <button
                        type="button"
                        role="menuitem"
                        class="menu-item"
                        onClick={run(() => resetPlacement(nodeId()))}
                      >
                        Reset placement
                      </button>
                    </Show>
                    <Show when={details().get(nodeId())?.descendants}>
                      <div class="menu-divider" />
                      <button
                        type="button"
                        role="menuitem"
                        class="menu-item"
                        onClick={() => {
                          setContextMenu(undefined);
                          toggleCollapse(nodeId());
                        }}
                      >
                        {collapsedIds().has(nodeId())
                          ? "Expand children"
                          : "Collapse children"}
                        <kbd class="ml-auto">G</kbd>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        class="menu-item"
                        onClick={run(() =>
                          focusId() === nodeId() ? exitFocus() : focusBranch(),
                        )}
                      >
                        {focusId() === nodeId()
                          ? "Leave focus"
                          : "Focus on this branch"}
                        <kbd class="ml-auto">F</kbd>
                      </button>
                    </Show>
                    <div class="menu-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item text-rose-700"
                      onClick={run(removeSelected)}
                    >
                      Delete
                      <kbd class="ml-auto">Del</kbd>
                    </button>
                  </>
                );
              }}
            </Show>
          </div>
        )}
      </Show>
      <div class="pointer-events-none absolute right-3 bottom-3 z-20 flex items-center gap-2">
        <fieldset
          data-no-pan
          data-toolbar
          aria-label="Canvas zoom"
          class="map-toolbar pointer-events-auto flex items-center gap-0.5 text-sm cursor-default"
        >
          <button
            type="button"
            class="icon-button"
            aria-label="Zoom out"
            title={`Zoom out (${MOD_LABEL}−)`}
            disabled={zoom() <= ZOOM_MIN}
            onClick={() => changeZoom(zoom() / 1.2)}
          >
            <MinusIcon />
          </button>
          <button
            type="button"
            class="map-control min-w-14 px-1! text-xs tabular-nums max-sm:hidden"
            aria-label="Zoom to 100%"
            title={`Zoom to 100% (${MOD_LABEL}0)`}
            onClick={() => changeZoom(1)}
          >
            {Math.round(zoom() * 100)}%
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Zoom in"
            title={`Zoom in (${MOD_LABEL}+)`}
            disabled={zoom() >= ZOOM_MAX}
            onClick={() => changeZoom(zoom() * 1.2)}
          >
            <PlusIcon />
          </button>
          <span class="mx-0.5 h-5 w-px bg-stone-200" />
          <button
            type="button"
            class="icon-button"
            aria-label="Fit map"
            title="Fit map (⇧1)"
            disabled={!forest().length}
            onClick={fitMap}
          >
            <FitMapIcon />
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Fit selection"
            title="Fit selection (⇧2)"
            disabled={!selectedId()}
            onClick={fitSelection}
          >
            <FitSelectionIcon />
          </button>
        </fieldset>
        <div
          data-no-pan
          data-toolbar
          class="map-toolbar pointer-events-auto flex cursor-default"
        >
          <button
            type="button"
            class="icon-button"
            aria-label="Keyboard shortcuts and navigation"
            title="Shortcuts and navigation (?)"
            aria-haspopup="dialog"
            onClick={() => setShowHelp(true)}
          >
            <HelpIcon />
          </button>
        </div>
      </div>
      <ShortcutsDialog
        open={showHelp()}
        onClose={() => {
          setShowHelp(false);
          canvas.focus({ preventScroll: true });
        }}
        wheelMode={wheelMode()}
        onWheelMode={setWheelMode}
      />
    </section>
  );
}
