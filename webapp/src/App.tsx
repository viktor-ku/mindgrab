import { makeEventListener } from "@solid-primitives/event-listener";
import { debounce } from "@solid-primitives/scheduled";
import { Dialog } from "./Dialog";
import { ProjectPreferences } from "./ProjectPreferences";
import { ShareDialog } from "./ShareDialog";
import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import { catalogKey, QUICK_RETRIES, saveRetryDelay } from "./query-client";
import {
  batch,
  createEffect,
  createMemo,
  createRoot as createReactiveRoot,
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
  DEFAULT_NODE_COLOR,
  deleteSubtree,
  isPristineSeed,
  LIMITS,
  moveNode,
  ORIGIN,
  setNodeNote,
  renameProject,
  setSavingPreferences,
  reorderNode,
  setNodeColor,
  translateSubtree,
} from "./project-document";
import { createProjectView } from "./project-view";
import { bindTextarea, composing } from "./text-binding";
import {
  ProjectRepository,
  accountNamespace,
  ANONYMOUS_NAMESPACE,
} from "./project-repository";
import type {
  CatalogEntry,
  ProjectHandle,
  RepositoryScope,
} from "./project-repository";
import type { ViewportPreference } from "./project-import-export";
import { NODE_COLORS } from "./node-colors";
import type { NodeColor } from "./node-colors";
import { generateProjectName } from "./project-names";
import {
  exportProjectDocument,
  parseProjectFile,
  prepareProjectImport,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_FILE_MAX_DEPTH as MAX_DEPTH,
  ProjectFileError,
  projectMarkdown,
  readProjectFile,
  writeMarkdownFile,
  writeProjectFile,
} from "./project-import-export";
import { closeOnEscape } from "./escape-key";
import { inOpenMenu, menuArrowKeys, transientLayer } from "./transient-layer";
import {
  ALT_LABEL,
  DELETE_LABEL,
  MOD_LABEL,
  SHIFT_LABEL,
  ShortcutsDialog,
} from "./ShortcutsDialog";
import { Outline } from "./Outline";
import { NotesPanel } from "./NotesPanel";
import {
  BRANCH_MIME,
  branchEntry,
  branchOutline,
  outlineSize,
  parseBranchEntry,
  parseOutline,
} from "./outline-text";
import type { OutlineEntry } from "./outline-text";
import {
  ArrowLeftIcon,
  BrandMark,
  ChevronDownIcon,
  ChevronRightIcon,
  ChildIcon,
  CloseIcon,
  FitMapIcon,
  FocusIcon,
  FoldIcon,
  HelpIcon,
  MinusIcon,
  MoreIcon,
  NoteIcon,
  OutlineIcon,
  PlusIcon,
  RedoIcon,
  SearchIcon,
  MenuIcon,
  SiblingIcon,
  UndoIcon,
  UnfoldIcon,
} from "./icons";
import { searchNodes } from "./search";
import { AccountControls } from "./AccountControls";
import {
  analyticsEnabled,
  consentOpen,
  identify,
  reviewConsent,
  track,
} from "./analytics";
import { AnalyticsConsent } from "./AnalyticsConsent";
import { AuthSession } from "./auth-session";
import type { SessionState } from "./auth-session";
import {
  claimAnonymousProjects,
  claimCandidates,
  flagLateEdits,
  waitingToCopy,
} from "./anonymous-claims";
import { LoroApi, SyncError } from "./loro-api";
import type {
  DropTarget,
  LayoutAnchor,
  MindMapNode,
  NodePosition,
  NodeSize,
} from "./mind-map";
import { backendDeployment } from "./backend";
import { CloudWorkspace, openLatestCloudProject } from "./project-sync";
import type { CloudStatus } from "./project-sync";
import { createLocalSave } from "./local-save";
import { SaveErrorDialog } from "./SaveErrorDialog";
import { saveIndicator } from "./save-indicator";
import { createPresence } from "./presence";
import { type SideTab, SidePanel } from "./SidePanel";
import { panelEdges, panelInsets } from "./view-insets";
import { press } from "./press";

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

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 2.5;
// How long a new browser waits for the account's cloud maps before falling
// back to this device's own projects.
const CLOUD_CATALOG_TIMEOUT_MS = 10_000;
const CLOUD_LOOKUP_KEY = ["latest-cloud-project"] as const;
// How long a failed migration waits between the slow retries that follow
// its quick ones.
const MIGRATION_RETRY_INTERVAL_MS = 30_000;
const newestFirst = (a: CatalogEntry, b: CatalogEntry) =>
  b.createdAt.localeCompare(a.createdAt);
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

function storedFlag(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function storeFlag(key: string, value: boolean) {
  try {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Without storage the flag lasts for this tab only.
  }
}

const OUTLINE_KEY = "mindgrab:outline-open";

function NodeEditor(props: {
  doc: ProjectDocument;
  id: string;
  onFinish: () => void;
  onTab: (shift: boolean) => void;
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
  // The doc changes under an open editor when the placeholder is adopted;
  // the merged doc holds everything typed so far, so only the binding moves.
  createEffect(
    on(
      () => props.doc,
      (doc) => {
        const { selectionStart, selectionEnd, selectionDirection } = input;
        onCleanup(bindTextarea(input, doc, props.id, setValue));
        input.setSelectionRange(
          selectionStart,
          selectionEnd,
          selectionDirection,
        );
      },
    ),
  );
  onMount(() => {
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
    <div class="relative min-w-px flex-1">
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
        class="absolute inset-0 w-full h-full min-w-0 resize-none overflow-hidden whitespace-pre-wrap wrap-anywhere bg-transparent p-0 text-left outline-none select-text cursor-text"
        onBlur={props.onFinish}
        onInput={reportSelection}
        onSelect={reportSelection}
        onKeyUp={reportSelection}
        onKeyDown={(e) => {
          // Keys still reach the window so app shortcuts (search, undo, F6)
          // work while writing; the canvas handler ignores text fields.
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
          } else if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
            // Keep capturing: Tab adds a child and Shift+Tab a parent, both
            // already in writing mode, instead of moving focus away.
            e.preventDefault();
            props.onTab(e.shiftKey);
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

export function Node(props: {
  doc: ProjectDocument;
  // Shared views only select and read ideas.
  readOnly?: boolean;
  id: string;
  text: string;
  color?: NodeColor;
  x: number;
  y: number;
  selected: boolean;
  // Pointed out from elsewhere, such as its outline row under the pointer.
  hinted?: boolean;
  writing: boolean;
  dragging: boolean;
  root: boolean;
  note: boolean;
  descendants: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSize: (size: NodeSize) => void;
  onSelect: () => void;
  onWrite: () => void;
  onFinish: () => void;
  onTab: (shift: boolean) => void;
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
      // biome-ignore lint/plugin: A press already selects through onPointerDown; this click is Enter or Space on the idea's button.
      onClick={props.onSelect}
      onDblClick={props.onWrite}
      style={{
        transform: `translate(${props.x}px, ${props.y}px)`,
      }}
      title={
        props.readOnly
          ? undefined
          : `Click to select · Double-click to write · Drag to move${props.descendants ? ` · ${ALT_LABEL}G to collapse or expand children` : ""}`
      }
    >
      <Show when={props.collapsed}>
        <span
          aria-hidden="true"
          class={`absolute inset-0 translate-x-2 translate-y-2 rounded-[0.625rem] border pointer-events-none ${fill()}`}
        />
        <span
          aria-hidden="true"
          class={`absolute inset-0 translate-x-1 translate-y-1 rounded-[0.625rem] border pointer-events-none ${fill()}`}
        />
      </Show>
      <div
        class={`map-node-card relative flex items-center gap-2 box-border border ${fill()}`}
        classList={{
          "map-node-selected": props.selected,
          "map-node-hinted": props.hinted && !props.selected,
        }}
        style={{ "min-height": `${NODE_MIN_HEIGHT}px` }}
      >
        <Show
          when={props.writing}
          fallback={
            <button
              type="button"
              // The editor picks ideas with the arrow keys: as tab stops they
              // would add a child at every Tab. Shared views only have Tab.
              tabIndex={props.readOnly ? undefined : -1}
              aria-pressed={props.selected}
              aria-expanded={props.descendants ? !props.collapsed : undefined}
              aria-keyshortcuts={
                props.descendants && !props.readOnly ? "Alt+G" : undefined
              }
              class={`min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere text-left cursor-pointer ${
                props.readOnly
                  ? "rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                  : "outline-none"
              }`}
            >
              {props.text || "New idea"}
            </button>
          }
        >
          <NodeEditor
            doc={props.doc}
            id={props.id}
            onFinish={props.onFinish}
            onTab={props.onTab}
            onSelectionChange={props.onSelectionChange}
          />
        </Show>
        <Show when={props.note && !props.writing}>
          {/* An indicator only: short ideas are mostly badge, so a clickable
              badge would open notes when people meant to select the idea. */}
          <span
            role="img"
            class="note-badge"
            aria-label="Has notes"
            title={
              props.readOnly
                ? "Has notes"
                : `Has notes · open them with ${ALT_LABEL}N`
            }
          >
            <NoteIcon class="size-3.5" />
          </span>
        </Show>
        <Show when={props.collapsed}>
          <button
            type="button"
            tabIndex={props.readOnly ? undefined : -1}
            class="rounded-md border border-current/15 bg-white/60 px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap cursor-pointer hover:bg-white/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
            aria-label={`Expand ${props.descendants} ${props.descendants === 1 ? "idea" : "ideas"}`}
            title={
              props.readOnly
                ? "Expand children"
                : `Expand children (${ALT_LABEL}G)`
            }
            onPointerDown={(e) => e.stopPropagation()}
            {...press((e) => {
              e.stopPropagation();
              props.onToggleCollapse();
            })}
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
  // The history position the notice describes; later edits or undo make it
  // stale, so it is dismissed rather than offering the wrong Undo.
  revision?: number;
}

const formatDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "earlier"
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() !== new Date().getFullYear() && {
          year: "numeric",
        }),
      });
};

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
  // While an account is signed in, this tab's one anonymous repository: it
  // owns the maps made before sign-in until each has migrated.
  const [anonymousRepo, setAnonymousRepo] = createSignal<ProjectRepository>();
  // Which repository owns the open map; everything owner-sensitive follows it.
  const [activeOwner, setActiveOwner] = createSignal(repository);
  // A query whose key changes while it has no data suspends the route and
  // detaches the canvas, which ends an edit in progress; the previous list
  // stands in until the new one arrives.
  const keepList = (previous: CatalogEntry[] | undefined) => previous ?? [];
  const catalog = createQuery(() => {
    const owner = workspace();
    return {
      queryKey: catalogKey(owner.names.catalog),
      queryFn: () => owner.list(),
      placeholderData: keepList,
      structuralSharing: false,
    };
  });
  // Nothing durable keeps this project: local saving is off and cloud saving
  // is off or cannot run without an account. An anonymous map kept open under
  // an account never attaches to that account's cloud.
  const memoryOnly = () =>
    !view().saving().local &&
    (!view().saving().cloud ||
      account().status !== "authenticated" ||
      activeOwner() !== workspace());
  let handleRepository = repository;
  let activeHandle: ProjectHandle | undefined;
  let stopCatalog: (() => void) | undefined;
  let stopAnonymousCatalog: (() => void) | undefined;
  let cloud: CloudWorkspace | undefined;
  const [authNavigationPending, setAuthNavigationPending] = createSignal(false);
  let disposed = false;
  let activation = 0;
  // The placeholder's version when it was made; any other version is an edit.
  let draftVersion = "";
  // Work that could not be saved when it left the screen, held with the
  // repository it belongs to until a retry gets it stored.
  const parked = new Set<{
    repository: ProjectRepository;
    save: () => Promise<void>;
  }>();
  const saveAndClose = (handle: ProjectHandle) => async () => {
    await handle.flush();
    await handle.close();
  };
  // A draft keeps its own account: it is stored under the scope it was written
  // in, never under whoever signs in next. A retired workspace refuses to open
  // anything, so this goes through a repository of its own.
  const saveDraft =
    (scope: RepositoryScope, id: string, snapshot: Uint8Array) => async () => {
      const owner = new ProjectRepository(scope);
      try {
        const handle = await owner.open(id, { remember: false });
        try {
          handle.doc.merge(snapshot, ORIGIN.import);
          await handle.flush();
          await handle.refreshMetadata();
        } finally {
          await handle.close();
        }
      } finally {
        await owner.close();
      }
    };
  const [cloudStatus, setCloudStatus] = createSignal<CloudStatus>();
  const [recoveryPending, setRecoveryPending] = createSignal(false);
  const owned = (owner: ProjectRepository) =>
    owner === repository || owner === anonymousRepo();
  const migrationKey = ["anonymous-migration", deployment] as const;
  // The anonymous repository lives as long as the signed-in session. Its
  // catalog channel brings other tabs' claim markers, which drive the
  // candidates.
  function keepAnonymous(source: ProjectRepository) {
    stopAnonymousCatalog?.();
    stopAnonymousCatalog = source.onCatalogChange(() => {
      void queryClient.invalidateQueries({
        queryKey: ["anonymous-claims", deployment],
      });
    });
    setAnonymousRepo(source);
  }
  if (activeUserId)
    keepAnonymous(
      new ProjectRepository({ deployment, namespace: ANONYMOUS_NAMESPACE }),
    );

  const initializeMutation = createMutation(() => ({
    mutationKey: ["workspace", "initialize"],
    mutationFn: performInitializeWorkspace,
  }));
  const initializeWorkspace = () => initializeMutation.mutateAsync();
  const accountMutation = createMutation(() => ({
    mutationKey: ["workspace", "account"],
    mutationFn: performAccountChanged,
  }));
  const accountChanged = (state: SessionState) => {
    if (state.status === "authenticated" || state.status === "anonymous")
      identify(state.user);
    return accountMutation.mutateAsync(state);
  };
  const swapMutation = createMutation(() => ({
    mutationKey: ["workspace", "swap"],
    mutationFn: performSwap,
  }));
  const switchMutation = createMutation(() => ({
    mutationKey: ["workspace", "switch"],
    mutationFn: performSwitch,
  }));
  const openMutation = createMutation(() => ({
    mutationKey: ["project", "open"],
    mutationFn: performOpenProject,
  }));
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
  const retryLocal = () =>
    void retryLocalSaving().catch(() =>
      setStorageMessage(
        "Browser storage is still unavailable. Free up space and retry.",
      ),
    );
  const retryCloud = () => {
    if (account().status === "expired") void auth.check();
    else cloud?.retry();
  };
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
      authNavigationPending()
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
    const draft = createProjectDocument(
      crypto.randomUUID(),
      generateProjectName([]),
      { text: "New idea" },
    );
    draftVersion = draft.version();
    return draft;
  }

  // The one commit point for putting a map on screen. Nothing async runs
  // between the `unless` check, the merge and setDoc, so what the user sees
  // is never a moment behind what is saved. Returns whether it committed.
  async function activate(
    handle: ProjectHandle,
    owner = repository,
    {
      keepView = false,
      merge,
      unless,
      adopted = false,
    }: {
      // Keep selection, folds and viewport: the map on screen stays the same.
      keepView?: boolean;
      merge?: () => Uint8Array;
      unless?: () => boolean;
      adopted?: boolean;
    } = {},
  ): Promise<boolean> {
    const request = ++activation;
    if (disposed || !owned(owner)) {
      await handle.close();
      return false;
    }
    cloud?.detach();
    const previous = activeHandle;
    const previousOwner = handleRepository;
    // Set when this map is not going on screen after all. Checked before the
    // project name is touched, so a map that is turned away interrupts nothing.
    const declined = () => {
      if (unless?.()) {
        if (previous && previousOwner === repository) cloud?.activate(previous);
        return handle.close().then(() => false);
      }
      // An edited placeholder is the user's map: it is kept, and the map that
      // was about to open stays in the Load list. The adopted handle shares
      // the placeholder's UUID, which ends the recursion.
      if (
        !adopted &&
        !activeHandle &&
        doc().version() !== draftVersion &&
        handle.id !== doc().id
      )
        return handle.close().then(() => adoptDraft(repository));
    };
    const early = declined();
    if (early) return early;
    if (!keepView) finishProjectName();
    let unsaved = false;
    try {
      if (previous && previous !== handle) await previous.flush();
    } catch (error) {
      // A swap carries the edits through the merge below, so the old handle
      // is parked for recovery instead of giving up.
      if (!keepView) {
        await handle.close();
        if (previous && previousOwner === repository) cloud?.activate(previous);
        throw error;
      }
      unsaved = true;
    }
    if (composing()) await until(() => !composing());
    if (disposed || request !== activation || !owned(owner)) {
      await handle.close();
      return false;
    }
    // A name typed during the flush commits into the current map and counts
    // as an edit.
    if (!keepView) finishProjectName();
    const late = declined();
    if (late) return late;
    if (merge) handle.doc.merge(merge(), ORIGIN.import);
    // The session memo decides ownership of the new doc inside setDoc, so the
    // handle must already be the active one.
    handleRepository = owner;
    activeHandle = handle;
    batch(() => {
      setActiveOwner(owner);
      if (!keepView) resetProjectUi();
      setDoc(handle.doc);
      setStorageReady(true);
      if (owner === repository) cloud?.activate(handle);
      setSavingHandle(handle);
    });
    if (previous && previous !== handle) {
      if (unsaved) {
        parked.add({
          repository: previousOwner,
          save: saveAndClose(previous),
        });
        setRecoveryPending(true);
      } else await previous.close();
    }
    if (adopted) {
      await handle.flush();
      await handle.refreshMetadata();
    }
    if (keepView) return true;
    try {
      const preference = await queryClient.fetchQuery({
        queryKey: ["project-view", owner.names.catalog, handle.id],
        queryFn: async () =>
          (await owner.preference(`project/${handle.id}/view`)) ?? null,
        gcTime: 0,
      });
      if (request !== activation || disposed || !owned(owner)) return true;
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
    return true;
  }

  // Persists the placeholder under its own UUID and keeps it on screen. The
  // snapshot is taken at the commit point, so keystrokes typed while the
  // project opened are included.
  async function adoptDraft(owner: ProjectRepository, remember = true) {
    const current = doc();
    const handle = await owner.open(current.id, { remember });
    return activate(handle, owner, {
      adopted: true,
      keepView: true,
      merge: () => current.snapshot(),
      // A stored map that arrived meanwhile has already replaced the draft.
      unless: () => doc() !== current,
    });
  }

  // A new map opens with its first idea selected, ready for typing or Tab.
  function selectFirstIdea() {
    const root = forest()[0]?.id;
    if (root) setSelectedId(root);
  }

  // A new browser has no local projects for an account, so its cloud catalog
  // decides which map opens; otherwise every sign-in on a new device added an
  // empty map. Null means the account has no cloud maps; undefined, that the
  // lookup could not run.
  async function openLatestCloud(target: ProjectRepository) {
    const ownerId = activeUserId;
    if (
      target !== repository ||
      disposed ||
      !ownerId ||
      target.scope.namespace !== accountNamespace(ownerId) ||
      navigator.onLine === false
    )
      return;
    const deadline = AbortSignal.timeout(CLOUD_CATALOG_TIMEOUT_MS);
    try {
      return await queryClient.fetchQuery({
        queryKey: [...CLOUD_LOOKUP_KEY, target.names.catalog],
        queryFn: ({ signal }) =>
          openLatestCloudProject(
            target,
            new LoroApi(undefined, undefined, ownerId, queryClient),
            AbortSignal.any([signal, deadline]),
          ),
        retry: (count, error) =>
          count < 2 &&
          !deadline.aborted &&
          !(error instanceof SyncError && error.kind !== "retry"),
        retryDelay: (attempt) => 500 * 2 ** attempt,
        gcTime: 0,
      });
    } catch {
      return;
    }
  }

  // The first of these maps that can be read. One damaged map must not stand
  // between the user and the rest; only when none opens does the error surface.
  async function openFirstReadable(owner: ProjectRepository, ids: string[]) {
    let failure: unknown;
    for (const id of ids) {
      if (!owned(owner) || disposed) return;
      try {
        return await owner.open(id);
      } catch (error) {
        failure = error;
      }
    }
    if (failure && owned(owner) && !disposed) throw failure;
  }

  // The map that opens first replaces the whole screen, so it waits while the
  // user is busy on the placeholder. An edit ends the wait: the placeholder is
  // then the map, whether or not the user has left the editor.
  function untilFree() {
    const placeholder = untrack(doc);
    return until(() => {
      historyRevision();
      return (
        doc() !== placeholder || doc().version() !== draftVersion || !occupied()
      );
    });
  }
  // Save or another action may put the placeholder in storage while the first
  // map is still opening; that map then stays where it is.
  const adopted = () => !!activeHandle;
  async function arrive(handle: ProjectHandle, owner: ProjectRepository) {
    await untilFree();
    return activate(handle, owner, { unless: adopted });
  }

  // Opens one of this browser's anonymous maps under the account: the
  // remembered one when it is among them, else the first. The migration
  // swaps it to its account copy later.
  async function openAnonymous(
    source: ProjectRepository,
    entries: CatalogEntry[],
  ) {
    const remembered = await source.latestProject();
    const handle = await openFirstReadable(
      source,
      entries
        .map((entry) => entry.id)
        .sort((a, b) => +(b === remembered) - +(a === remembered)),
    ).catch(() => undefined);
    if (!handle) return false;
    if (!owned(source) || disposed) {
      await handle.close();
      return false;
    }
    setLookupArmed(true);
    await arrive(handle, source);
    return true;
  }

  async function openLatestOrCreate(target = repository) {
    const latest = await target.latestProject();
    if (target !== repository || disposed) return;
    const local = (await target.list()).sort(newestFirst);
    if (target !== repository || disposed) return;
    let unreadable = false;
    const stored = [
      ...new Set([...(latest ? [latest] : []), ...local.map(({ id }) => id)]),
    ];
    if (stored.length) {
      // None readable: the cases below still give the user a map to work in.
      const handle = await openFirstReadable(target, stored).catch(
        () => undefined,
      );
      if (handle) {
        await arrive(handle, target);
        return;
      }
      if (target !== repository || disposed) return;
      unreadable = true;
    }
    const source = anonymousRepo();
    const userId = activeUserId;
    if (source && userId) {
      // Pending anonymous work opens before anything is created: a reload
      // after sign-in lands here while the copy into the account is still
      // hidden.
      const candidates = await claimCandidates(source, userId);
      if (target !== repository || disposed || activeHandle) return;
      if (
        await openAnonymous(
          source,
          candidates.filter((entry) => entry.claim?.phase !== "complete"),
        )
      )
        return;
      const existing = await openLatestCloud(target);
      // A placeholder adopted during the lookup is the user's map now.
      if (target !== repository || disposed || activeHandle) {
        await existing?.close();
        return;
      }
      if (existing) {
        await arrive(existing, target);
        return;
      }
      // An untouched anonymous map is a better first map than another empty
      // one. It becomes the account's first if the cloud has none, and can
      // still be swapped for the latest if the lookup got no answer.
      if (
        await openAnonymous(
          source,
          (await source.list()).filter(
            (entry) => entry.saving?.local !== false,
          ),
        )
      )
        return;
      if (target !== repository || disposed || activeHandle) return;
    }
    await untilFree();
    if (activeHandle) return;
    // The placeholder is the first map, so nothing can race it into a second.
    const untouched = doc().version() === draftVersion;
    // Stored maps that did not open may only be slow, so an empty stand-in
    // does not take over as the map the next visit opens.
    await adoptDraft(target, !(unreadable && untouched));
    if (target !== repository || disposed) return;
    if (untouched && !occupied()) {
      focusMap();
      selectFirstIdea();
    }
    track("project_created", { trigger: "first_open" });
  }

  async function performInitializeWorkspace() {
    await auth.hydrate();
    if (disposed) return;
    try {
      if (auth.state.user?.id !== activeUserId)
        await accountChanged(auth.state);
      else {
        setAccount(auth.state);
        watchCatalog(repository);
        await openLatestOrCreate(repository);
      }
    } finally {
      // After the first open, so a sign-in finds the map it has to keep; but
      // a map that cannot open must not stop the session check.
      if (!disposed) auth.start();
    }
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
    save?: () => Promise<void>,
  ) {
    owner.detach();
    if (save)
      try {
        await save();
      } catch {
        parked.add({ repository: owner, save });
        if (!disposed) setRecoveryPending(true);
        return;
      }
    await owner.close();
  }

  function refreshClaims() {
    if (disposed) return Promise.resolve();
    return queryClient.invalidateQueries({
      queryKey: ["anonymous-claims", deployment],
    });
  }

  // Signing in from an untouched map opens the account's own latest map
  // instead of copying the seed: this device's newest, else the cloud's,
  // looked up in the background. Local state is read before discovery can
  // fill the catalog with imports, which would hide the most recent map.
  async function settleSignIn(target: ProjectRepository) {
    if (!openPristine()) return;
    const localLatest = await target.latestProject();
    const local = (await target.list()).sort(newestFirst);
    if (target !== repository || disposed || !openPristine()) return;
    const ids = [
      ...new Set([
        ...(localLatest ? [localLatest] : []),
        ...local.map(({ id }) => id),
      ]),
    ];
    if (!ids.length) {
      setLookupArmed(true);
      return;
    }
    // The commit waits for a pause in typing; cloud discovery need not.
    if (!switchMutation.isPending) switchMutation.mutate(ids);
  }

  async function performAccountChanged(state: SessionState) {
    if (disposed) return;
    setAccount(state);
    const nextUserId = state.user?.id;
    if (state.status !== "authenticated" || nextUserId !== activeUserId) {
      cloud?.destroy();
      cloud = undefined;
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
    // Ends a new browser's cloud lookup and a running migration when their
    // account leaves; a key change alone would not stop them.
    void queryClient.cancelQueries({ queryKey: CLOUD_LOOKUP_KEY });
    void queryClient.cancelQueries({ queryKey: migrationKey });
    saveView.clear();
    stopCatalog?.();
    const previousRepository = repository;
    const previousHandle = activeHandle;
    const previousOwner = handleRepository;
    const previousAnonymous = anonymousRepo();
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
    setStorageMessage("");
    setLookupNull(false);
    setLookupArmed(false);
    if (
      nextUserId &&
      previousHandle &&
      previousOwner.scope.namespace === ANONYMOUS_NAMESPACE
    ) {
      // Signing in keeps the map the user is looking at: it stays open and
      // saving locally while its copy into the account is made behind the
      // scenes, and the swap to that copy waits for a pause in typing.
      if (previousRepository !== previousOwner)
        void retireWorkspace(previousRepository);
      keepAnonymous(previousOwner);
      watchCatalog(nextRepository);
      await settleSignIn(nextRepository);
      if (repository === nextRepository && !disposed) {
        startCloud();
        void refreshClaims();
      }
      return;
    }
    finishWriting();
    finishProjectName();
    handleRepository = nextRepository;
    activeHandle = undefined;
    setActiveOwner(nextRepository);
    setSavingHandle(undefined);
    // An edited placeholder is the user's map. Signing in carries an anonymous
    // one into the account; any other change of account leaves it behind.
    const edited = !previousHandle && doc().version() !== draftVersion;
    const followsSignIn =
      edited &&
      !!nextUserId &&
      previousRepository.scope.namespace === ANONYMOUS_NAMESPACE;
    const leftBehind =
      edited && !followsSignIn
        ? saveDraft(previousRepository.scope, doc().id, doc().snapshot())
        : undefined;
    if (!followsSignIn) {
      resetProjectUi();
      setDoc(ephemeralDocument());
    }
    setStorageReady(false);
    stopAnonymousCatalog?.();
    stopAnonymousCatalog = undefined;
    setAnonymousRepo(undefined);
    const saveOn = (owner: ProjectRepository) =>
      previousHandle && previousOwner === owner
        ? saveAndClose(previousHandle)
        : undefined;
    void retireWorkspace(
      previousRepository,
      saveOn(previousRepository) ?? leftBehind,
    );
    if (previousAnonymous && previousAnonymous !== previousRepository)
      void retireWorkspace(previousAnonymous, saveOn(previousAnonymous));
    if (nextUserId)
      keepAnonymous(
        new ProjectRepository({ deployment, namespace: ANONYMOUS_NAMESPACE }),
      );
    watchCatalog(nextRepository);
    try {
      await openLatestOrCreate(nextRepository);
    } catch {
      if (repository === nextRepository && !disposed)
        setStorageMessage(
          "Could not open this account’s local maps. Retry local saving.",
        );
    }
    if (repository === nextRepository && !disposed) {
      startCloud();
      void refreshClaims();
    }
  }

  function until(ready: () => boolean) {
    return new Promise<void>((resolve) => {
      createReactiveRoot((dispose) => {
        createEffect(() => {
          if (!ready()) return;
          dispose();
          resolve();
        });
      });
    });
  }
  // The swap waits for a pause in typing rather than interrupting the user.
  const typing = () => writing() || projectNameDraft() !== undefined;
  const untilIdle = () => until(() => !typing());
  // Opening another map replaces the whole screen, so it also waits for the
  // search or panel the user is in.
  const occupied = () =>
    typing() ||
    fieldFocused() ||
    searchOpen() ||
    showLoad() ||
    overlayOpen() ||
    composing();

  // Moves the screen from the anonymous map to its account copy without the
  // user noticing: between two keystrokes, keeping selection and viewport.
  // Edits made since the copy travel with the merge.
  async function performSwap({
    sourceId,
    targetId,
  }: {
    sourceId: string;
    targetId: string;
  }) {
    const source = anonymousRepo();
    const owner = repository;
    const anonymousHandle = activeHandle;
    if (
      !source ||
      !anonymousHandle ||
      anonymousHandle.id !== sourceId ||
      handleRepository !== source
    )
      return;
    // A sign-out being saved must not find the screen changed under it.
    const unchanged = () =>
      !disposed &&
      !authNavigationPending() &&
      repository === owner &&
      activeHandle === anonymousHandle &&
      handleRepository === source;
    while (unchanged()) {
      await untilIdle();
      if (!unchanged()) return;
      const target = await owner.open(targetId);
      if (
        await activate(target, owner, {
          keepView: true,
          merge: () => anonymousHandle.doc.snapshot(),
          unless: () => authNavigationPending() || typing(),
        })
      )
        return;
    }
  }

  // Opens the account's latest map in place of an untouched anonymous one,
  // between two keystrokes rather than never: a refusal while the user is
  // typing is retried at the next pause, as the swap does.
  async function performSwitch(ids: string[]) {
    const owner = repository;
    const source = anonymousRepo();
    const seed = activeHandle;
    const unchanged = () =>
      !disposed &&
      repository === owner &&
      activeHandle === seed &&
      handleRepository === source &&
      openPristine();
    while (unchanged()) {
      await until(() => !occupied());
      if (!unchanged()) return;
      const handle = await openFirstReadable(owner, ids).catch(() => undefined);
      // Nothing readable here: the seed stays, and only the cloud can decide.
      if (!handle) {
        setLookupArmed(true);
        return;
      }
      // activate closes the handle itself when it refuses.
      if (await activate(handle, owner, { unless: pristineUnless })) return;
    }
  }

  // The document is the only writable project content. Everything else here
  // (selection, viewport, measurements, drag previews) is local UI state.
  const [doc, setDoc] = createSignal(ephemeralDocument());
  const [historyRevision, setHistoryRevision] = createSignal(0);
  // Read synchronously, even inside a batch, to tie notices to history.
  let historyCount = 0;
  let editorSelection: TextSelection | undefined;
  // Whether a stored map is on screen. Until then the canvas shows a
  // placeholder that is a real draft: its first edit makes it the map.
  const [storageReady, setStorageReady] = createSignal(false);
  const [savingHandle, setSavingHandle] = createSignal<ProjectHandle>();
  const localSave = createLocalSave(savingHandle);
  const [storageMessage, setStorageMessage] = createSignal("");
  const saveDot = () =>
    saveIndicator({
      local: view().saving().local && storageReady(),
      localStatus: localSave.status(),
      cloud: cloudStatus(),
      recovering: recoveryPending(),
    });
  const cloudProblem = () => {
    const status = cloudStatus();
    return status && "message" in status ? status.message : "";
  };
  const [saveErrorOpen, setSaveErrorOpen] = createSignal(false);
  // A retry that turns the dot yellow leaves the details open; a save closes them.
  createEffect(() => {
    if (saveDot().tone !== "error" && saveDot().tone !== "saving")
      setSaveErrorOpen(false);
  });
  const saveProblems = () =>
    [
      localSave.message() &&
        `${localSave.message()} Export a backup to keep your changes.`,
      cloudProblem(),
      recoveryPending() &&
        "Edits from the previous account could not be saved. They remain in memory; retry before leaving.",
    ].filter((problem) => !!problem) as string[];
  createEffect(
    on(
      localSave.status,
      (status) => {
        if (status === "done" && view().saving().local) setStorageMessage("");
      },
      { defer: true },
    ),
  );
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
      historyCount++;
      setHistoryRevision((n) => n + 1);
      entry.before = selectionBefore;
      queueMicrotask(() => (entry.after = captureSelection()));
    });
    undo.onRestore(({ entry, direction }) => {
      historyCount++;
      setHistoryRevision((n) => n + 1);
      const selection = direction === "undo" ? entry.before : entry.after;
      if (!selection) return;
      // Undo from inside the notes panel keeps the person writing there
      // instead of reopening the idea's title editor on the map.
      const resumeWriting =
        selection.writing &&
        !document.activeElement?.matches(
          'textarea[aria-label="Idea notes"], textarea[aria-label="Idea title"]',
        );
      setSelectedId(selection.id);
      setWriting(resumeWriting);
      editorSelection = selection.text;
      if (resumeWriting && selection.text) {
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

  // The map on screen while it is still the seed every map starts from. Node
  // edits change no catalog entry, so this memo on the live doc, not a catalog
  // event, is what re-evaluates the migration candidates.
  const openPristine = createMemo(() => {
    const source = anonymousRepo();
    if (!source || activeOwner() !== source) return false;
    const roots = forest();
    const [root] = roots;
    if (roots.length !== 1 || !root || root.next?.length) return false;
    return isPristineSeed(
      [
        {
          id: root.id,
          text: view().text(root.id),
          note: view().note(root.id),
          color: root.color ?? DEFAULT_NODE_COLOR,
          ...(root.position && { position: root.position }),
          children: [],
        },
      ],
      view().name(),
    );
  });
  // Set once the cloud lookup has said the account has no maps at all: the
  // seed then migrates to become its first one.
  const [lookupNull, setLookupNull] = createSignal(false);
  // Set when the account has no local maps, so only the cloud can decide.
  const [lookupArmed, setLookupArmed] = createSignal(false);
  const pristineUnless = () => !openPristine() || occupied();
  // The open map, when it is one of the anonymous maps.
  const openId = createMemo(() => {
    const source = anonymousRepo();
    return source && activeOwner() === source
      ? (savingHandle()?.id ?? null)
      : null;
  });
  const openInclude = () => !openPristine() || lookupNull();
  // The waiting maps are local, so listing them never depends on the account
  // check getting through; only copying them does.
  const claims = createQuery(() => {
    const userId = account().user?.id ?? activeUserId ?? null;
    const source = anonymousRepo();
    const id = openId();
    const include = openInclude();
    return {
      queryKey: ["anonymous-claims", deployment, userId, id, include],
      enabled: !!userId && !!source,
      placeholderData: keepList,
      queryFn: () =>
        userId && source
          ? claimCandidates(source, userId, id ? { open: { id, include } } : {})
          : [],
    };
  });
  createQuery(() => {
    const userId = account().user?.id;
    const source = anonymousRepo();
    return {
      queryKey: ["anonymous-late-edits", deployment, userId ?? null],
      enabled: account().status === "authenticated" && !!userId && !!source,
      staleTime: Number.POSITIVE_INFINITY,
      queryFn: () => (userId && source ? flagLateEdits(source, userId) : false),
    };
  });
  const candidateCount = () => claims.data?.filter(waitingToCopy).length ?? 0;
  // Memory-only anonymous maps never migrate, but they stay reachable: leaving
  // one for another map must not strand it.
  const anonymousInMemory = createQuery(() => {
    const source = anonymousRepo();
    return {
      queryKey: ["anonymous-claims", deployment, "in-memory"],
      enabled: !!source,
      placeholderData: keepList,
      queryFn: async () =>
        (await source?.list())?.filter(
          (entry) => entry.saving?.local === false,
        ) ?? [],
    };
  });
  // While signed in, Load also lists the maps still waiting to migrate.
  const savedProjects = createMemo(() => {
    const own = catalog.data ?? [];
    const waiting = [
      ...(claims.data ?? []).filter(
        (entry) => entry.claim?.phase !== "complete",
      ),
      ...(anonymousInMemory.data ?? []),
    ].filter((entry) => !own.some((project) => project.id === entry.id));
    return waiting.length ? [...own, ...waiting] : own;
  });
  // Copies every anonymous map into the account, silently. The open map's
  // claim pauses before completing so this tab can swap to the copy; a
  // run repeats until it claims nothing, so a candidate that appeared mid-run
  // is not left for the next trigger.
  const migration = createQuery(() => {
    const userId = account().user?.id;
    const source = anonymousRepo();
    const destination = workspace();
    return {
      queryKey: [...migrationKey, userId ?? null],
      enabled:
        account().status === "authenticated" &&
        !!source &&
        !authNavigationPending() &&
        candidateCount() > 0,
      queryFn: async ({ signal }) => {
        if (!userId || !source) return 0;
        const api = new LoroApi(undefined, undefined, userId, queryClient);
        let total = 0;
        for (;;) {
          const open = untrack(() => {
            const id = openId();
            return id ? { id, include: openInclude() } : undefined;
          });
          const ids = await claimAnonymousProjects(
            source,
            destination,
            userId,
            signal,
            api,
            open
              ? {
                  open: {
                    ...open,
                    beforeComplete: (sourceId, targetId) =>
                      swapMutation.mutateAsync({ sourceId, targetId }),
                  },
                }
              : {},
          );
          total += ids.length;
          if (!ids.length) break;
        }
        return total;
      },
      // Quick retries, then the slow poll and focus refetch below take over.
      retry: (count, error) =>
        count < QUICK_RETRIES &&
        !(error instanceof SyncError && error.kind === "auth"),
      retryDelay: saveRetryDelay,
      refetchInterval: (state) =>
        state.state.status === "error" ? MIGRATION_RETRY_INTERVAL_MS : false,
      refetchOnWindowFocus: (state) => state.state.status === "error",
      refetchOnReconnect: true,
      gcTime: 0,
    };
  });
  // Candidates that appear later (another tab, an edit to the seed) start a
  // new run; a copy in progress is never cut short for them.
  createEffect(
    on(
      () => claims.data,
      (entries) => {
        if (!entries?.some(waitingToCopy)) return;
        void queryClient.invalidateQueries(
          { queryKey: migrationKey },
          { cancelRefetch: false },
        );
      },
      { defer: true },
    ),
  );
  // A tab that did not run the claim (it lost the lock, or signed in through
  // another tab) swaps once the marker says its open map is done.
  createEffect(
    on(
      () => [claims.data, authNavigationPending()] as const,
      ([entries, pending]) => {
        // A sign-out being saved leaves the screen alone; the swap follows
        // once that is abandoned.
        if (pending) return;
        const source = anonymousRepo();
        const userId = account().user?.id;
        const done = entries?.find(
          (entry) =>
            entry.id === activeHandle?.id &&
            handleRepository === source &&
            entry.claim?.phase === "complete" &&
            entry.claim.ownerId === userId,
        );
        const targetId = done?.claim?.targetId;
        if (done && targetId && !swapMutation.isPending)
          swapMutation.mutate({ sourceId: done.id, targetId });
      },
    ),
  );
  createEffect(
    on(
      () => migration.dataUpdatedAt,
      () => {
        const total = migration.data;
        if (!total) return;
        track("anonymous_maps_claimed", { count: total });
        void refreshClaims();
        cloud?.retry();
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => migration.errorUpdatedAt,
      () => {
        const error = migration.error;
        if (!error) return;
        void refreshClaims();
        // The maps that did copy still have to sync.
        cloud?.retry();
        if (error instanceof SyncError && error.kind === "auth") {
          auth.expire();
          void auth.check();
        }
      },
      { defer: true },
    ),
  );
  // A new browser's cloud lookup, retried on reconnect: the account's most
  // recently changed map replaces the untouched seed, and a definite "none"
  // lets the seed become the account's first map.
  const latestLookup = createQuery(() => {
    const owner = workspace();
    const userId = account().user?.id;
    const source = anonymousRepo();
    return {
      queryKey: [...CLOUD_LOOKUP_KEY, owner.names.catalog, userId ?? null],
      enabled:
        account().status === "authenticated" &&
        !!userId &&
        !!source &&
        lookupArmed() &&
        activeOwner() === source &&
        openPristine() &&
        !lookupNull(),
      queryFn: async ({ signal }) => {
        if (!userId) return null;
        const handle = await openLatestCloudProject(
          owner,
          new LoroApi(undefined, undefined, userId, queryClient),
          AbortSignal.any([
            signal,
            AbortSignal.timeout(CLOUD_CATALOG_TIMEOUT_MS),
          ]),
        );
        if (!handle) return null;
        await handle.close();
        return { id: handle.id };
      },
      networkMode: "online" as const,
      retry: (_count, error) =>
        !(error instanceof SyncError && error.kind === "auth"),
      retryDelay: saveRetryDelay,
      refetchOnReconnect: true,
      gcTime: 0,
    };
  });
  createEffect(
    on(
      () => latestLookup.dataUpdatedAt,
      () => {
        const result = latestLookup.data;
        if (result === undefined) return;
        if (result === null) setLookupNull(true);
        else if (!switchMutation.isPending) switchMutation.mutate([result.id]);
      },
      { defer: true },
    ),
  );

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
  const hideNotice = debounce(() => setNotice(undefined), 6000);
  function showNotice(next: Notice) {
    setNotice({ ...next, revision: historyCount });
    hideNotice();
  }
  createEffect(
    on(
      historyRevision,
      () => {
        if (notice() && notice()?.revision !== historyCount)
          setNotice(undefined);
      },
      { defer: true },
    ),
  );

  // Undefined while the name field is not being edited.
  const [projectNameDraft, setProjectNameDraft] = createSignal<string>();
  const [showLoad, setShowLoad] = createSignal(false);
  const [showBackup, setShowBackup] = createSignal(false);
  const [showPreferences, setShowPreferences] = createSignal(false);
  const [showShare, setShowShare] = createSignal(false);
  // Share sends people to the preferences to turn cloud saving on, and takes
  // them back once it is. An effect, not the dialog's onClose, which fires
  // twice per close. Leaving the preferences for another task clears the flag.
  let returnToShare = false;
  createEffect(
    on(
      showPreferences,
      (open) => {
        if (open || !returnToShare) return;
        returnToShare = false;
        if (view().saving().cloud) setShowShare(true);
      },
      { defer: true },
    ),
  );
  const [menuOpen, setMenuOpen] = createSignal(false);
  // Phones get one button: everything else lives in the panel it opens.
  const phoneQuery = window.matchMedia("(max-width: 639px)");
  const [isPhone, setIsPhone] = createSignal(phoneQuery.matches);
  makeEventListener(phoneQuery, "change", (e) => setIsPhone(e.matches));
  const itemRole = () => (isPhone() ? undefined : "menuitem");
  // An open overlay owns the keyboard; the canvas stays out of its way.
  const overlayOpen = () =>
    showPreferences() ||
    showShare() ||
    showHelp() ||
    saveErrorOpen() ||
    (isPhone() && menuOpen());
  const savingMutation = createMutation(() => ({
    mutationKey: ["project", "saving"],
    mutationFn: performChangeSaving,
  }));
  const preferencesError = () =>
    savingMutation.error
      ? `Could not finish updating storage: ${savingMutation.error.message || "Please retry."} Existing copies may remain.`
      : "";
  async function performChangeSaving(
    value: import("./project-document").SavingPreferences,
  ) {
    const handle = activeHandle;
    const owner = handleRepository;
    // On the placeholder a switch is an edit like any other: the placeholder
    // becomes the map, and the map that was opening stays in the list, its
    // own switches untouched.
    if (!handle) {
      setSavingPreferences(doc(), value);
      return;
    }
    try {
      await owner.updateSaving(handle, value);
      track("saving_changed", { local: value.local, cloud: value.cloud });
      if (!value.cloud && !cloud && (await owner.cloudAttempted(handle.id)))
        setCloudStatus({
          status: "auth",
          message:
            "Cloud deletion pending. Sign in again and reconnect to delete the existing cloud copy. Keep this tab open.",
        });
      cloud?.retry();
    } catch (error) {
      if (handle === activeHandle) throw error;
    }
  }
  const fileBusy = () => importMutation.isPending || exportMutation.isPending;

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
    // Over a drop target the branch stays put, so the target and its
    // surroundings remain readable; the label and indicator show the move.
    if (!preview || dropTarget()) return baseLayout();
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
  const connections = createMemo(
    () =>
      new Map(
        layout().connections.map((connection) => [
          connection.to.id,
          connection,
        ]),
      ),
  );
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

  // Read from a ResizeObserver so following the selection while typing never
  // forces a synchronous layout of the whole map.
  const [canvasSize, setCanvasSize] = createSignal({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  onMount(() => {
    const observer = new ResizeObserver(([entry]) =>
      setCanvasSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(canvas);
    onCleanup(() => observer.disconnect());
  });

  // Canvas units map to screen pixels relative to the canvas center through
  // `left/top + zoom * (point - origin)`. The origin keeps the first root
  // centered where the map started.
  const viewOrigin = () => ({
    x: (layout().nodes[0]?.width ?? 0) / 2,
    y: NODE_MIN_HEIGHT / 2,
  });
  // Programmatic view changes ease into place; direct manipulation does not.
  const [easingView, setEasingView] = createSignal(false);
  const stopEasingView = debounce(() => setEasingView(false), 160);
  function moveView(next: { left: number; top: number; zoom?: number }) {
    batch(() => {
      setEasingView(true);
      setLeft(next.left);
      setTop(next.top);
      if (next.zoom !== undefined) setZoom(next.zoom);
    });
    stopEasingView();
  }

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
    const width = canvasSize().width - viewInsets().left - viewInsets().right;
    const height = canvasSize().height - viewInsets().top - viewInsets().bottom;
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

  function fitSelection(id = selectedId()) {
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
    const halfWidth = canvasSize().width / 2;
    const halfHeight = canvasSize().height / 2;
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
    canvas.focus({ preventScroll: true });
  }
  function exitFocus() {
    if (notice()?.action?.label === "Leave focus") setNotice(undefined);
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
    // An idea outside the branch (selected by undo, a remote move or search)
    // would be edited invisibly; show the whole map instead.
    else if (
      id &&
      selectedId() &&
      !untrack(() => inFocus(selectedId() as string))
    )
      untrack(exitFocus);
  });

  const [searchOpen, setSearchOpen] = createSignal(false);
  // After jumping to a search result, a chip offers the view the search began
  // from, including its folds, until the user moves on.
  const [returnView, setReturnView] = createSignal<ViewSnapshot>();
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchIndex, setSearchIndex] = createSignal(0);
  let searchInput: HTMLInputElement | undefined;
  let searchReturn: ViewSnapshot | undefined;
  // One extra hit tells whether the list was cut off at the display limit.
  const SEARCH_LIMIT = 50;
  const searchHits = createMemo(() =>
    searchOpen()
      ? searchNodes(
          scopeForest(),
          (id) => view().text(id),
          searchQuery(),
          SEARCH_LIMIT + 1,
        )
      : [],
  );
  const searchResults = createMemo(() => searchHits().slice(0, SEARCH_LIMIT));
  // Moving on from a kept search result retires the way back.
  createEffect(
    on(
      selectedId,
      () => {
        if (!searchOpen()) setReturnView(undefined);
      },
      { defer: true },
    ),
  );
  function openSearch() {
    finishWriting();
    setContextMenu(undefined);
    if (!searchOpen()) {
      searchReturn = snapshotView();
      setReturnView(undefined);
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
    if (searchQuery().trim()) track("search_used", { kept_result: keep });
    const back = searchReturn;
    searchReturn = undefined;
    setReturnView(keep ? back : undefined);
    batch(() => {
      setSearchOpen(false);
      setSearchQuery("");
    });
    if (!keep && back) restoreView(back);
    canvas.focus({ preventScroll: true });
  }
  createEffect(
    // Preview follows the query and the highlighted result only. Edits made
    // while searching also change the results, but must not move the
    // selection (or the editor) to another idea.
    on([searchQuery, searchIndex], ([, index]) => {
      const results = untrack(searchResults);
      const result = results[Math.min(index, results.length - 1)];
      if (result) untrack(() => previewResult(result.id));
    }),
  );

  const projectMenuButton = () =>
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Project menu"]',
    );
  function closeProjectMenu() {
    setMenuOpen(false);
    projectMenuButton()?.focus({ preventScroll: true });
  }
  const [mapFilter, setMapFilter] = createSignal("");
  createEffect(on(showLoad, () => setMapFilter(""), { defer: true }));
  // Newest first; the filter matches names ignoring case.
  const listedProjects = createMemo(() => {
    const query = mapFilter().trim().toLowerCase();
    return [...savedProjects()]
      .filter((project) => project.name.toLowerCase().includes(query))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  let projectMenu: HTMLDivElement | undefined;
  createEffect(() => {
    if (menuOpen())
      queueMicrotask(() =>
        projectMenu
          ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
          ?.focus(),
      );
  });
  const [colorOpen, setColorOpen] = createSignal(false);
  createEffect(on(selectedId, () => setColorOpen(false), { defer: true }));
  // Keyboard users land on the current color when the popover opens.
  createEffect(
    on(
      colorOpen,
      (open) =>
        open &&
        queueMicrotask(() =>
          document
            .querySelector<HTMLButtonElement>(
              '[aria-label="Selected node color controls"] .color-choice[aria-pressed="true"]',
            )
            ?.focus(),
        ),
      { defer: true },
    ),
  );

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
      showNotice({ message: `Exported “${truncate(name, 40)}” as an outline` });
      track("project_exported", {
        format: "markdown",
        idea_count: details().size,
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        setStorageMessage(
          error instanceof Error
            ? error.message
            : "Could not export the outline.",
        );
    }
  }

  // The side panel on the right, open on one of its tabs: the outline or the
  // selected idea's notes.
  // The idea whose outline row is under the pointer, pointed out on the map.
  const [hintedId, setHintedId] = createSignal<string>();
  const [sideTab, setSideTab] = createSignal<SideTab | undefined>(
    storedFlag(OUTLINE_KEY) ? "outline" : undefined,
  );
  const sideOpen = () => sideTab() !== undefined;
  const outlineOpen = () => sideTab() === "outline";
  const notesOpen = () => sideTab() === "notes";
  // Opening a tab shows it in the panel; closing it closes the panel only
  // while that tab is showing.
  const showTab = (tab: SideTab, open: boolean) => {
    if (open) setSideTab(tab);
    else if (sideTab() === tab) setSideTab(undefined);
  };
  const setOutlineOpen = (open: boolean | ((open: boolean) => boolean)) =>
    showTab("outline", typeof open === "function" ? open(outlineOpen()) : open);
  // A field can be in use before anything is typed into it.
  const [fieldFocused, setFieldFocused] = createSignal(false);
  const isTextField = (target: EventTarget) =>
    target instanceof Element &&
    target.matches(
      'textarea[aria-label="Idea notes"], textarea[aria-label="Idea title"], input[aria-label="Project name"]',
    );
  // Chrome that closes while it holds focus (a panel, a menu item, a banner
  // button, a breadcrumb) hands focus back to the map, so keyboard users never
  // land on the page body.
  createEffect(
    on(
      () => [
        outlineOpen(),
        notesOpen(),
        menuOpen(),
        overlayOpen(),
        !!contextMenu(),
        colorOpen(),
        !!returnView(),
        focusId(),
        consentOpen(),
        // "Check account again" goes away once the check succeeds.
        account().status === "unavailable" || account().status === "expired",
      ],
      () => {
        if (!document.activeElement || document.activeElement === document.body)
          canvas?.focus({ preventScroll: true });
      },
      { defer: true },
    ),
  );
  // A mouse click on a button that only changes the view hands the keyboard
  // back to the map. Pressed from the keyboard (detail 0) it keeps focus, so
  // Enter can zoom again.
  const backToCanvas = (e: MouseEvent) => {
    if (e.detail > 0) canvas.focus({ preventScroll: true });
  };
  // Opening notes from the keyboard moves focus into them; closing returns it.
  function toggleNotes(open = !notesOpen()) {
    finishWriting();
    showTab("notes", open);
    if (open && selectedId())
      queueMicrotask(() =>
        document
          .querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="Idea notes"]',
          )
          ?.focus(),
      );
    else canvas.focus({ preventScroll: true });
  }
  createEffect(() => storeFlag(OUTLINE_KEY, outlineOpen()));
  // The panel stays while it slides out.
  const sidePanel = createPresence(sideOpen, {
    restoreFocus: () => canvas.focus({ preventScroll: true }),
  });
  const viewInsets = () => panelInsets(canvasSize().width, sideOpen());
  // A panel that opens over the selected idea moves the map aside, as
  // selecting that idea with the panel already open would.
  createEffect(
    on(
      sideOpen,
      (open) => {
        const id = selectedId();
        if (id && open && !isPhone()) keepInView(id);
      },
      { defer: true },
    ),
  );
  // "Show on map" in the notes: the idea, unfolded and centred beside the
  // panel. On phones the panel covers the map, so it closes first.
  function showOnMap(id: string) {
    if (isPhone()) setSideTab(undefined);
    revealNode(id);
    queueMicrotask(() => centerOn(id));
  }
  // Centred chrome sits in a strip of the canvas, given as its distance from
  // the left and right edges.
  interface Strip {
    left: number;
    right: number;
  }
  const stripStyle = (strip: Strip) => ({
    left: `${strip.left}px`,
    right: `${strip.right}px`,
  });
  // The top bars keep to the strip between the open panels, 8px clear of
  // each, so they never cover a panel's header.
  const panelStrip = (): Strip => {
    const edges = panelEdges(canvasSize().width, sideOpen());
    return {
      left: edges.left ? edges.left + 8 : 12,
      right: edges.right ? edges.right + 8 : 12,
    };
  };
  // Beside open panels the breadcrumb keeps the focused branch readable: it
  // drops the steps above it first, then the label of the way out.
  const crumbRoom = () =>
    isPhone()
      ? Number.POSITIVE_INFINITY
      : canvasSize().width - panelStrip().left - panelStrip().right;
  const crumbs = () =>
    crumbRoom() < 480 ? focusPath().slice(-1) : focusPath();
  // Under about 900px the centred selection toolbar would run under the zoom
  // island, so it centres in the room left of it: the island's 241px, its
  // 12px margin and an 8px gap.
  const bottomStrip = (): Strip => {
    const width = canvasSize().width;
    return { left: 12, right: width >= 640 && width < 900 ? 261 : 12 };
  };
  // The notice stays centred over the toolbar and narrows until it is clear
  // of the open panels. Where that leaves too little to read, it centres
  // between the panels instead; with no room there either, it covers a
  // panel's edge for the few seconds it shows.
  const noticeStrip = (): Strip => {
    const row = bottomStrip();
    const panels = panelStrip();
    const inset = Math.max(0, panels.left - row.left, panels.right - row.right);
    const narrowed = { left: row.left + inset, right: row.right + inset };
    const fits = (strip: Strip) =>
      canvasSize().width - strip.left - strip.right >= 240;
    return fits(narrowed) ? narrowed : fits(panels) ? panels : row;
  };
  // Branches travel through the clipboard as indented Markdown lists, so they
  // paste into other apps and pasted outlines become branches here.
  // Levels from the top (1 for a central idea) and the levels a branch spans.
  function depthOf(id: string) {
    let depth = 1;
    for (let p = details().get(id)?.parent; p; p = details().get(p)?.parent)
      depth++;
    return depth;
  }
  function branchHeight(id: string) {
    const height = (node: MindMapNode): number =>
      1 + Math.max(0, ...(node.next ?? []).map(height));
    const node = findNode(forest(), id);
    return node ? height(node) : 1;
  }
  function tooDeep() {
    showNotice({
      message: `Maps can be at most ${MAX_DEPTH} levels deep, so backups stay readable.`,
    });
  }

  function pasteOutline(entries: OutlineEntry[]) {
    const parent = selectedId() ?? focusId();
    const count = outlineSize(entries);
    if (details().size + count > LIMITS.nodes) {
      showNotice({
        message: `A map holds at most ${LIMITS.nodes.toLocaleString()} ideas; this paste would add ${count.toLocaleString()}.`,
      });
      return;
    }
    const start = parent ? depthOf(parent) + 1 : 1;
    if (start > MAX_DEPTH) return tooDeep();
    let first: string | undefined;
    // Backups keep at most MAX_DEPTH levels; deeper lines join the deepest
    // allowed level instead of making the map impossible to back up.
    let flattened = false;
    let shortened = false;
    try {
      command((doc) =>
        doc.batch(() => {
          const make = (
            list: OutlineEntry[],
            under: string | undefined,
            depth: number,
          ) => {
            for (const entry of list) {
              if (entry.text.length > LIMITS.text) shortened = true;
              const init = {
                text: entry.text.slice(0, LIMITS.text),
                ...(entry.color && { color: entry.color }),
              };
              const id = under
                ? createChild(doc, under, init)
                : createRoot(doc, init);
              if (entry.note)
                setNodeNote(doc, id, entry.note.slice(0, LIMITS.note));
              first ??= id;
              if (entry.children.length && depth >= MAX_DEPTH) flattened = true;
              if (depth >= MAX_DEPTH) make(entry.children, under, depth);
              else make(entry.children, id, depth + 1);
            }
          };
          make(entries, parent, start);
        }),
      );
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
    track("outline_pasted", { idea_count: count, flattened });
    if (parent) revealNode(first);
    setSelectedId(first);
    // Show what arrived once the new ideas have been measured.
    if (count > 1) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => (parent ? fitSelection(parent) : fitMap())),
      );
    }
    showNotice({
      message: `Pasted ${count} ${count === 1 ? "idea" : "ideas"}${parent ? ` under “${nodeLabel(parent)}”` : ""}${
        flattened
          ? ` · levels past ${MAX_DEPTH} were flattened`
          : shortened
            ? ` · long text was shortened to ${LIMITS.text.toLocaleString()} characters`
            : ""
      }`,
      action: { label: "Undo", run: undo },
    });
  }

  // Past the first or last sibling, Up/Down continue to the closest idea above
  // or below on screen, preferring ideas in the same column.
  function nearbyIdea(id: string, arrow: "left" | "right" | "up" | "down") {
    if (arrow !== "up" && arrow !== "down") return;
    const from = positionedNodes().get(id);
    if (!from) return;
    const center = (node: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => ({
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
    });
    const start = center(from);
    let best: { id: string; score: number } | undefined;
    for (const node of layout().nodes) {
      const point = center(node);
      const dy = point.y - start.y;
      if (arrow === "up" ? dy >= -1 : dy <= 1) continue;
      const score = Math.abs(dy) + Math.abs(point.x - start.x) * 2;
      if (!best || score < best.score) best = { id: node.id, score };
    }
    return best?.id;
  }

  // F6 / Shift+F6 cycle focus between the canvas and each labelled toolbar
  // or panel, the conventional escape hatch for widgets that use Tab.
  function cycleRegions(direction: 1 | -1) {
    const focusable =
      'button:not(:disabled), input:not(:disabled), textarea, [tabindex="0"]';
    const regions: HTMLElement[] = [
      canvas,
      ...Array.from(
        canvas.querySelectorAll<HTMLElement>("[data-toolbar][aria-label]"),
      ).filter(
        (region) =>
          !region.parentElement?.closest("[data-toolbar][aria-label]") &&
          region.querySelector(focusable),
      ),
    ];
    const active = document.activeElement;
    const current = Math.max(
      0,
      regions.findIndex(
        (region, index) => index > 0 && active && region.contains(active),
      ),
    );
    const next =
      regions[(current + direction + regions.length) % regions.length];
    if (next === canvas) canvas.focus({ preventScroll: true });
    // A panel is entered at its content, not at its close button.
    else
      (
        next.querySelector<HTMLElement>(
          'textarea[aria-label="Idea notes"], [role="tree"] [tabindex="0"]',
        ) ?? next.querySelector<HTMLElement>(focusable)
      )?.focus();
  }

  const [showHelp, setShowHelp] = createSignal(false);
  // Feature discovery: count each opening, however it happened.
  for (const [opened, event] of [
    [outlineOpen, "outline_opened"],
    [notesOpen, "notes_opened"],
    [showHelp, "shortcuts_opened"],
    [() => Boolean(focusId()), "branch_focused"],
  ] as const)
    createEffect(on(opened, (open) => open && track(event), { defer: true }));

  const saveView = debounce(
    (
      owner: ProjectRepository,
      handle: ProjectHandle,
      value: ViewportPreference,
    ) => {
      if (handleRepository !== owner || activeHandle !== handle) return;
      viewportMutation.mutate({ owner, id: handle.id, value });
    },
    200,
  );
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
    saveView(owner, handle, value);
  });

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
      setReturnView(undefined);
      setFocusId(undefined);
    });
    focusMap();
  }

  function focusMap() {
    // A first visit opens a project after the analytics banner has appeared;
    // keep "Accept all" focused until the visitor chooses.
    const banner = consentOpen()
      ? document.querySelector<HTMLButtonElement>(
          '[aria-label="Analytics choice"] button',
        )
      : null;
    (banner ?? canvas).focus({ preventScroll: true });
  }

  async function performOpenProject({
    id,
    owner,
  }: {
    id: string;
    owner: ProjectRepository;
  }) {
    const target = owner;
    try {
      await activeHandle?.flush();
      const handle = await target.open(id);
      await activate(handle, target);
      if (!owned(target) || disposed) return;
      // An edited placeholder was adopted instead; the chosen map stays in
      // the Load list.
      if (activeHandle !== handle) return;
      const state = handle.state();
      if (state.status === "ready") {
        track("project_opened", { idea_count: details().size });
        setStorageMessage("");
        showNotice({ message: `Opened “${truncate(state.view.name, 40)}”` });
      } else setStorageMessage("Map is still loading.");
    } catch (error) {
      if (!owned(target) || disposed) return;
      setStorageMessage(
        error instanceof Error ? error.message : "Could not open this map.",
      );
      throw error;
    }
  }

  // Puts a map the user just made on screen. A placeholder edited while it
  // was made is adopted at that commit, and the new map opens with a second
  // one. Returns whether the new map is on screen.
  async function activateCreated(
    handle: ProjectHandle,
    owner: ProjectRepository,
  ) {
    const committed = await activate(handle, owner);
    if (!committed || activeHandle === handle) return committed;
    if (!owned(owner) || disposed) return false;
    const again = await owner.open(handle.id);
    await activate(again, owner);
    return activeHandle === again;
  }

  async function performCreateNewProject() {
    const target = repository;
    try {
      await activeHandle?.flush();
      // An edited placeholder is saved first, so the new map opens beside it
      // instead of being adopted away.
      if (!activeHandle && doc().version() !== draftVersion) {
        await adoptDraft(target);
        if (target !== repository || disposed) return;
      }
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
      if (!(await activateCreated(handle, target))) return;
      if (target !== repository || disposed) return;
      setStorageMessage("");
      selectFirstIdea();
      track("project_created", {
        trigger: "menu",
        project_count: projects.length + 1,
      });
    } catch (error) {
      if (target !== repository || disposed) return;
      setStorageMessage(
        error instanceof Error ? error.message : "Could not create a map.",
      );
      throw error;
    }
  }

  function finishProjectName() {
    const name = projectNameDraft()?.trim();
    setProjectNameDraft(undefined);
    if (!name) return;
    try {
      if (command((doc) => renameProject(doc, name))) track("project_renamed");
    } catch {
      setStorageMessage("Project names can be at most 200 bytes long.");
    }
  }

  async function performSave() {
    finishWriting();
    finishProjectName();
    if (!activeHandle) await adoptDraft(repository);
    const owner = handleRepository;
    const handle = activeHandle;
    if (!handle) return;
    setShowLoad(false);
    try {
      await localSave.save();
      if (handleRepository !== owner || activeHandle !== handle || disposed)
        return;
      track("project_saved", { local: view().saving().local });
      if (view().saving().local) {
        setStorageMessage("");
        showNotice({ message: "Saved locally" });
      } else
        setStorageMessage(
          "Local saving is off. Export a backup to keep your work.",
        );
    } catch (error) {
      if (handleRepository !== owner || activeHandle !== handle || disposed)
        return;
      throw error;
    }
  }

  async function performRetryLocalSaving() {
    if (!activeHandle) await initializeWorkspace();
    for (const recovery of [...parked]) {
      await recovery.save();
      parked.delete(recovery);
      // A repository still in use (a swap parked its handle) stays open.
      if (
        !owned(recovery.repository) &&
        ![...parked].some((other) => other.repository === recovery.repository)
      )
        await recovery.repository.close();
    }
    setRecoveryPending(parked.size > 0);
    if (activeHandle) await localSave.save();
    else await adoptDraft(repository);
  }

  async function saveBeforeAuth(action: "login" | "logout") {
    finishWriting();
    finishProjectName();
    // An edited placeholder leaves as a saved map; only broken storage stops it.
    if (!activeHandle)
      try {
        await adoptDraft(repository);
      } catch {
        setStorageMessage("Wait for local map storage before leaving.");
        return false;
      }
    const owner = handleRepository;
    const handle = activeHandle;
    if (!handle) {
      setStorageMessage("Wait for local map storage before leaving.");
      return false;
    }
    setAuthNavigationPending(true);
    cloud?.destroy();
    cloud = undefined;
    // A copy in progress must not race the navigation.
    await queryClient.cancelQueries({ queryKey: migrationKey });
    owner.setRelaysPaused(true);
    let leaving = false;
    try {
      await retryLocalSaving();
      if (handleRepository !== owner || activeHandle !== handle || disposed)
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
      if (handleRepository !== owner || activeHandle !== handle || disposed)
        return false;
      await auth.prepareNavigation(action);
      leaving = true;
      if (action === "login")
        track("sign_in_started", { project_count: savedProjects().length });
      else track("signed_out");
      return true;
    } catch {
      if (handleRepository !== owner || disposed) return false;
      setStorageMessage(
        "Could not save your map before leaving. Free up browser storage and retry.",
      );
      return false;
    } finally {
      if (!leaving) {
        setAuthNavigationPending(false);
        owner.setRelaysPaused(false);
        startCloud();
      }
    }
  }

  async function performOpenLoad() {
    finishWriting();
    const owner = repository;
    try {
      cloud?.retry();
      const projects = await queryClient.fetchQuery({
        queryKey: catalogKey(owner.names.catalog),
        queryFn: () => owner.list(),
      });
      if (repository !== owner || disposed) return;
      setStorageMessage("");
      setShowLoad(true);
      track("project_list_opened", { project_count: projects.length });
    } catch (error) {
      if (repository !== owner || disposed) return;
      setStorageMessage("Could not list maps. Browser storage is unavailable.");
      throw error;
    }
  }

  function load(id: string) {
    const source = anonymousRepo();
    const anonymous = source && !catalog.data?.some((map) => map.id === id);
    openMutation.mutate({ id, owner: anonymous ? source : repository });
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
      showNotice({ message: `Exported “${truncate(name, 40)}”` });
      track("project_exported", { format: "json", idea_count: details().size });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStorageMessage(
          error instanceof Error ? error.message : "Could not export this map.",
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
      if (!activeHandle && doc().version() !== draftVersion) {
        await adoptDraft(owner);
        if (owner !== repository || disposed) return;
      }
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
      if (!(await activateCreated(handle, owner))) return;
      if (owner !== repository || disposed) return;
      await owner.setLatestProject(handle.id).catch(() => {});
      showNotice({ message: `Imported “${truncate(content.name, 40)}”` });
      track("project_imported", {
        idea_count: details().size,
        file_kb: Math.ceil(file.size / 1024),
      });
    } catch (error) {
      if (owner !== repository || disposed) return;
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStorageMessage(
          error instanceof Error
            ? error.message
            : "Could not import this backup.",
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
    focusAfterHistory();
  }

  function redo() {
    const { undo } = session();
    undo.finishGroup();
    undo.redo();
    focusAfterHistory();
  }

  // An open idea editor always has keyboard focus, however it opened (undo,
  // redo, a toolbar button), unless someone is typing in the notes panel.
  createEffect(
    on([writing, selectedId], ([open]) => {
      if (!open) return;
      queueMicrotask(() => {
        const editor = canvas.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Node text"]',
        );
        const active = document.activeElement;
        if (
          editor &&
          active !== editor &&
          !active?.matches(
            'textarea[aria-label="Idea notes"], textarea[aria-label="Idea title"], input',
          )
        )
          editor.focus({ preventScroll: true });
      });
    }),
  );

  // A restored edit keeps its editor focused; otherwise keys go to the map.
  function focusAfterHistory() {
    if (!writing()) return canvas.focus({ preventScroll: true });
    canvas
      .querySelector<HTMLTextAreaElement>('textarea[aria-label="Node text"]')
      ?.focus({ preventScroll: true });
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

  // When the menu key (or Shift+F10) was last pressed; its contextmenu event
  // carries no reliable pointer information across browsers.
  let contextKeyAt = -Infinity;
  function openContextMenu(e: MouseEvent) {
    const target = e.target instanceof Element ? e.target : undefined;
    const toolbar = target?.closest("[data-toolbar], dialog");
    const nodeElement = target?.closest<HTMLElement>("[data-node-id]");
    if (toolbar) {
      setContextMenu(undefined);
      return;
    }
    // Working on the map ends an open search, as a left press does.
    if (searchOpen()) closeSearch(true);

    e.preventDefault();
    finishWriting();
    // The keyboard menu key has no pointer; it opens the selected idea's menu
    // beside the idea instead of clearing the selection.
    const fromKeyboard =
      !nodeElement && selectedId() && performance.now() - contextKeyAt < 500;
    const nodeId = fromKeyboard ? selectedId() : nodeElement?.dataset.nodeId;
    setSelectedId(nodeId);
    const anchor = fromKeyboard
      ? canvas
          .querySelector(`[data-node-id="${CSS.escape(nodeId ?? "")}"]`)
          ?.getBoundingClientRect()
      : undefined;
    const clientX = anchor ? anchor.right : e.clientX;
    const clientY = anchor ? anchor.bottom : e.clientY;

    const bounds = canvas.getBoundingClientRect();
    const rootPosition = nodeId
      ? undefined
      : {
          x:
            (clientX - bounds.left - bounds.width / 2 - left()) / zoom() +
            viewOrigin().x,
          y:
            (clientY - bounds.top - bounds.height / 2 - top()) / zoom() +
            viewOrigin().y,
        };

    const menuWidth = 208;
    const menuHeight = nodeId
      ? details().get(nodeId)?.descendants
        ? 144
        : 104
      : 56;
    setContextMenu({
      x: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8)),
      nodeId,
      rootPosition,
    });
  }

  function add(kind: "child" | "sibling" | "root", position?: NodePosition) {
    finishWriting();
    const current = selectedId();
    if (kind === "child" && current && depthOf(current) >= MAX_DEPTH)
      return tooDeep();
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
      if (!created) return;
      write(created);
      track("idea_added", {
        kind: kind === "root" || !id ? "root" : kind,
        depth: depthOf(created),
        idea_count: details().size,
      });
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
    if (blockedByFocus(id, "move")) return;
    const parent =
      target.kind === "inside" ? target.id : details().get(target.id)?.parent;
    // In branch focus a move may only land inside the focused branch.
    if (focusId() && !(parent && inFocus(parent))) {
      showNotice({
        message: "Leave focus to move ideas out of this branch",
        action: { label: "Leave focus", run: exitFocus },
      });
      return;
    }
    if ((parent ? depthOf(parent) : 0) + branchHeight(id) > MAX_DEPTH)
      return tooDeep();
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
    track("idea_moved", { to_top_level: !parent });
    setSelectedId(id);
    showNotice({
      message: parent
        ? `Moved “${nodeLabel(id)}” under “${nodeLabel(parent)}”`
        : `Moved “${nodeLabel(id)}” to the top level`,
      action: { label: "Undo", run: undo },
    });
  }

  // Whether an idea is the focused branch's root or inside it.
  function inFocus(id: string) {
    const focus = focusId();
    if (!focus) return true;
    for (let at: string | undefined = id; at; at = details().get(at)?.parent)
      if (at === focus) return true;
    return false;
  }

  // The focused branch's root anchors the view; moving it would take the
  // branch somewhere the view does not show.
  function blockedByFocus(id: string, action: "move") {
    if (id !== focusId()) return false;
    showNotice({
      message: `Leave focus to ${action} this branch`,
      action: { label: "Leave focus", run: exitFocus },
    });
    return true;
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
    if (depthOf(id) + branchHeight(id) > MAX_DEPTH) return tooDeep();
    if (id === focusId()) {
      showNotice({
        message: "Leave focus to add a parent above this branch",
        action: { label: "Leave focus", run: exitFocus },
      });
      return;
    }
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
    if (!created) return;
    write(created);
    track("idea_added", {
      kind: "parent",
      depth: depthOf(created),
      idea_count: details().size,
    });
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
    track("idea_deleted", { removed });
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
    const scope = colorScope();
    if (command((doc) => setNodeColor(doc, id, color, scope === "branch")))
      track("idea_colored", { scope });
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
      !e.isPrimary ||
      e.button !== 0 ||
      pointer ||
      (nodeId && writing() && selectedId() === nodeId)
    )
      return;
    // Working on the map ends an open search, keeping the result in view.
    if (searchOpen()) closeSearch(true);
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
    const first = repository;
    void initializeWorkspace().catch((error) => {
      if (disposed || repository !== first) return;
      setStorageMessage(
        error instanceof Error
          ? error.message
          : "Could not open local map storage.",
      );
    });
    onCleanup(() => {
      disposed = true;
      activation++;
      void queryClient.cancelQueries({ queryKey: CLOUD_LOOKUP_KEY });
      void queryClient.cancelQueries({ queryKey: migrationKey });
      stopAuth();
      auth.destroy();
      cloud?.destroy();
      stopCatalog?.();
      stopAnonymousCatalog?.();
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
      const source = anonymousRepo();
      void activeHandle?.close();
      void repository.close();
      if (source && source !== repository) void source.close();
      for (const recovery of parked) void recovery.repository.close();
    });

    // What leaving this page now would lose, if anything.
    const unsavedWork = () => {
      if (recoveryPending())
        return "Edits from the previous account are not saved yet.";
      if (!activeHandle && doc().version() !== draftVersion)
        return "Your newest edits are not saved yet.";
      if (
        repository.hasMemoryOnlyProjects() ||
        anonymousRepo()?.hasMemoryOnlyProjects() ||
        (!view().saving().local &&
          (!view().saving().cloud || cloudStatus()?.status !== "saved"))
      )
        return "A map with local saving off is not saved anywhere else yet.";
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (unsavedWork()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    makeEventListener(window, "beforeunload", beforeUnload);
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))
        contextKeyAt = performance.now();
      if (overlayOpen()) return;
      if (
        e.isComposing ||
        writing() ||
        (e.target instanceof Element &&
          e.target.closest("textarea, input, [contenteditable=true]"))
      )
        return;
      // An open menu owns the keyboard; its own Esc handling closes it.
      if (contextMenu() || menuOpen() || inOpenMenu(e.target)) return;
      // While search is open the map ignores every key but Esc, which closes
      // it from anywhere.
      if (searchOpen()) {
        if (e.key === "Escape") {
          e.preventDefault();
          closeSearch(false);
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
      // With an idea selected every printable key types into it, so these
      // single-key shortcuts apply only when nothing is selected.
      if (
        e.key === "/" &&
        !selectedId() &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        openSearch();
        return;
      }
      if (
        e.key === "?" &&
        !selectedId() &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        setShowHelp((open) => !open);
        return;
      }
      // Letter commands use Option/Alt so plain typing always edits the idea.
      const option =
        e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.repeat;
      if (option && matchesLetter(e, "o")) {
        e.preventDefault();
        setOutlineOpen((open) => !open);
        return;
      }
      if (option && matchesLetter(e, "n")) {
        e.preventDefault();
        toggleNotes();
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
      if (e.altKey && !mod && !e.shiftKey && e.code === "Digit1") {
        e.preventDefault();
        fitMap();
        return;
      }
      if (e.altKey && !mod && !e.shiftKey && e.code === "Digit2") {
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
      if (e.target instanceof Element && e.target.closest("[data-toolbar]"))
        return;
      const arrow = ARROW_DIRECTIONS.get(e.key);
      const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
      const first = visibleForest()[0]?.id;
      // Ideas are not tab stops, so with nothing selected an arrow key is the
      // keyboard's way onto the map.
      if (!selectedId() && arrow && plain && first) {
        e.preventDefault();
        setColorScope("node");
        setSelectedId(first);
        return;
      }
      if (!selectedId()) return;
      const id = selectedId() as string;
      // Option+arrows move ideas everywhere. Ctrl+arrows also work, except that
      // macOS reserves them for Mission Control.
      const move = arrow && !e.shiftKey && !e.metaKey && e.altKey !== e.ctrlKey;
      if (option && matchesLetter(e, "g")) {
        e.preventDefault();
        toggleCollapse(id);
      } else if (option && matchesLetter(e, "f")) {
        e.preventDefault();
        if (focusId() === id) exitFocus();
        else focusBranch();
      } else if (move) {
        e.preventDefault();
        if (arrow === "right") indentSelected();
        else if (arrow === "left") outdentSelected();
        else if (!blockedByFocus(id, "move"))
          command((doc) => reorderNode(doc, id, arrow === "up" ? -1 : 1));
      } else if (
        (plain && (e.key === "Delete" || e.key === "Backspace")) ||
        (e.metaKey &&
          !e.shiftKey &&
          !e.ctrlKey &&
          !e.altKey &&
          e.key === "Backspace")
      ) {
        e.preventDefault();
        removeSelected();
      } else if (plain && e.key === "Tab") {
        e.preventDefault();
        add("child");
      } else if (plain && e.key === "Enter") {
        e.preventDefault();
        // A central idea has no siblings to speak of; Enter grows the map.
        add(details().get(id)?.parent ? "sibling" : "child");
      } else if (
        e.key === "Tab" &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        insertParent();
      } else if (arrow && plain) {
        e.preventDefault();
        const target =
          navigationTarget(visibleForest(), id, arrow) ?? nearbyIdea(id, arrow);
        if (target) {
          setColorScope("node");
          setSelectedId(target);
        }
      } else if (e.key === "F2" || (plain && e.key === " ")) {
        e.preventDefault();
        write(id);
      } else if (
        // One character, including emoji outside the Basic Multilingual Plane.
        [...e.key].length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        // Typing replaces the idea's text: writing starts before the key's
        // default action, so the character lands in the selected editor.
        write(id);
      }
    };
    const wheel = (e: WheelEvent) => {
      if (e.target instanceof Element && e.target.closest("dialog")) {
        // The dialog scrolls itself, but a pinch there must not zoom the page.
        if (e.ctrlKey || e.metaKey) e.preventDefault();
        return;
      }
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
    // Saving is automatic, so the key must first keep the browser's own "Save
    // page" dialog away. It saves only from the map: in a text field or behind
    // a dialog a save would end the edit or act out of sight.
    const saveShortcut = (event: KeyboardEvent) => {
      event.preventDefault();
      if (
        overlayOpen() ||
        event.isComposing ||
        writing() ||
        (event.target instanceof Element &&
          event.target.closest("textarea, input, [contenteditable=true]"))
      )
        return;
      save();
    };
    const historyShortcut = (
      event: KeyboardEvent | null,
      action: "undo" | "redo",
    ) => {
      if (
        !event ||
        event.isComposing ||
        contextMenu() ||
        menuOpen() ||
        inOpenMenu(event.target) ||
        pointer
      )
        return;
      const target = event.target;
      const textEditor =
        target instanceof Element &&
        target.matches(
          'textarea[aria-label="Node text"], textarea[aria-label="Idea notes"], textarea[aria-label="Idea title"]',
        );
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
        // If the restored state is not an edit, keep keys working on the map.
        queueMicrotask(() => {
          if (!writing() && document.activeElement === document.body)
            canvas.focus({ preventScroll: true });
        });
      } else if (action === "undo") undo();
      else redo();
    };
    const shortcuts = (event: KeyboardEvent) => {
      const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
      if (mod && !event.shiftKey && matchesLetter(event, "s")) {
        saveShortcut(event);
        return;
      }
      // A modal dialog owns the keyboard; map shortcuts would act behind it.
      if (overlayOpen()) return;
      // F6 moves between the canvas and the toolbars from anywhere, including
      // text fields, without tabbing through the map (Tab adds ideas there).
      if (
        event.key === "F6" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        finishWriting();
        cycleRegions(event.shiftKey ? -1 : 1);
        return;
      }
      if (!mod) return;
      if (matchesLetter(event, "f") && !event.shiftKey) {
        if (showPreferences()) return;
        event.preventDefault();
        openSearch();
        return;
      }
      if (matchesLetter(event, "z"))
        historyShortcut(event, event.shiftKey ? "redo" : "undo");
      else if (matchesLetter(event, "y") && !event.shiftKey)
        historyShortcut(event, "redo");
    };
    makeEventListener(window, "keydown", shortcuts);
    makeEventListener(window, "keydown", keydown);
    makeEventListener(window, "pointerup", (e) => stopPointer(e, true));
    makeEventListener(canvas, "wheel", wheel, { passive: false });
    const canvasClipboard = (e: ClipboardEvent) =>
      !writing() &&
      !overlayOpen() &&
      !searchOpen() &&
      !(
        e.target instanceof Element &&
        e.target.closest("input, textarea, [contenteditable=true], dialog")
      );
    let lastCopy: { text: string; entry: OutlineEntry } | undefined;
    const copyBranch = (e: ClipboardEvent) => {
      const id = selectedId();
      const node = id && findNode(forest(), id);
      if (!node || !canvasClipboard(e) || !e.clipboardData) return;
      e.preventDefault();
      const text = branchOutline(node, (key) => view().text(key));
      const entry = branchEntry(node, (key) => view().text(key));
      e.clipboardData.setData("text/plain", text);
      e.clipboardData.setData(BRANCH_MIME, JSON.stringify(entry));
      // Some browsers drop custom clipboard types; the same text pasted back
      // still restores notes and colors.
      lastCopy = { text, entry };
      if (e.type === "cut") removeSelected();
      else
        showNotice({
          message: `Copied “${nodeLabel(node.id)}”${node.next?.length ? " with its branch" : ""}`,
        });
    };
    const paste = (e: ClipboardEvent) => {
      if (!canvasClipboard(e) || !e.clipboardData) return;
      const text = e.clipboardData.getData("text/plain");
      const rich =
        parseBranchEntry(e.clipboardData.getData(BRANCH_MIME)) ??
        (lastCopy?.text === text ? lastCopy.entry : undefined);
      const entries = rich ? [rich] : parseOutline(text);
      if (!entries.length) return;
      e.preventDefault();
      pasteOutline(entries);
    };
    makeEventListener(window, "copy", copyBranch);
    makeEventListener(window, "cut", copyBranch);
    makeEventListener(window, "paste", paste);
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
    makeEventListener(canvas, "pointerdown", touchDown, { capture: true });
    makeEventListener(window, "pointermove", touchMove);
    makeEventListener(window, "pointerup", touchUp);
    makeEventListener(window, "pointercancel", touchUp);
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

  const toggleProjectMenu = () => {
    finishWriting();
    finishProjectName();
    setShowLoad(false);
    setShowBackup(false);
    setMenuOpen((open) => !open);
  };
  // "Sign in" inside a dialog: the dialog closes and the normal sign-in
  // starts, so its progress and failures show where they always do. Phones
  // keep their account controls in the menu panel, which opens instead.
  let signIn: (() => void) | undefined;
  const signInFrom = (show: (open: boolean) => void) =>
    account().status === "authenticated" || account().status === "checking"
      ? undefined
      : () => {
          returnToShare = false;
          show(false);
          if (isPhone()) setMenuOpen(true);
          else signIn?.();
        };
  // Runs a phone panel action on the map, with the panel out of the way.
  const fromPanel = (run: () => void) => () => {
    setMenuOpen(false);
    run();
  };
  const ProjectNameInput = () => (
    <input
      type="text"
      required
      aria-label="Project name"
      class="project-name"
      style={
        isPhone()
          ? undefined
          : {
              width: `${Math.min(28, Math.max(6, (projectNameDraft() ?? view().name()).length + 1))}ch`,
            }
      }
      value={projectNameDraft() ?? view().name()}
      onInput={(e) => setProjectNameDraft(e.currentTarget.value)}
      onBlur={finishProjectName}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== "Escape") return;
        e.currentTarget.blur();
        canvas.focus({ preventScroll: true });
      }}
    />
  );
  const OpenMapItems = () => (
    <>
      <button
        type="button"
        role={itemRole()}
        class="menu-item"
        aria-expanded={showLoad()}
        aria-controls="saved-projects"
        {...press(() => (showLoad() ? setShowLoad(false) : void openLoad()))}
      >
        Open map…
        <ChevronRightIcon
          class={`ml-auto size-4 transition-transform duration-100 ${showLoad() ? "rotate-90" : ""}`}
        />
      </button>
      <Show when={showLoad()}>
        <Show when={savedProjects().length > 6}>
          <input
            type="search"
            aria-label="Filter maps"
            placeholder="Filter maps"
            class="search-field mx-1 mb-1 rounded-md bg-stone-100 px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
            value={mapFilter()}
            onInput={(e) => setMapFilter(e.currentTarget.value)}
            // Escape clears, then closes; arrow keys stay in the field.
            ref={(el) =>
              closeOnEscape(el, () => {
                if (mapFilter()) setMapFilter("");
                else closeProjectMenu();
              })
            }
            onKeyDown={(e) => {
              // Only the keys the menu would take stop here. The rest reach
              // the window, which keeps Mod+S from the browser and runs F6.
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key))
                e.stopPropagation();
              // Enter opens the first match, but only of a typed filter: the
              // unfiltered list starts with whichever map is newest.
              const first = listedProjects()[0];
              if (e.key === "Enter" && mapFilter().trim() && first) {
                e.preventDefault();
                setMenuOpen(false);
                load(first.id);
              }
            }}
          />
        </Show>
        <ul
          id="saved-projects"
          aria-label="Saved maps"
          class="mx-1 mb-1 max-h-60 overflow-y-auto rounded-lg bg-stone-50 p-1 text-sm"
        >
          <For
            each={listedProjects()}
            fallback={
              <li class="px-2 py-2 text-stone-500">
                {mapFilter().trim() ? "No maps match" : "No saved maps yet"}
              </li>
            }
          >
            {(project) => (
              <li>
                <button
                  type="button"
                  role={itemRole()}
                  class="menu-item"
                  aria-label={`${project.name} · ${project.id.slice(0, 8)}`}
                  aria-current={project.id === doc().id ? "true" : undefined}
                  {...press(() => {
                    setMenuOpen(false);
                    load(project.id);
                  })}
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{project.name}</span>
                    <span class="block text-[11px] font-normal text-stone-500">
                      {project.id === doc().id
                        ? "Open now"
                        : `Created ${formatDate(project.createdAt)}`}
                    </span>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  );

  return (
    <section
      ref={canvas}
      tabIndex={-1}
      aria-label="Mind map canvas"
      data-storage-ready={storageReady()}
      onFocusIn={(e) => setFieldFocused(isTextField(e.target))}
      onFocusOut={(e) => {
        if (isTextField(e.target)) setFieldFocused(false);
      }}
      onPointerDown={(e) => {
        if (e.target instanceof Element && e.target.closest("[data-no-pan]"))
          return;
        startPointer(e);
      }}
      onPointerMove={movePointer}
      onPointerUp={(e) => stopPointer(e, true)}
      onPointerCancel={(e) => stopPointer(e, false)}
      onLostPointerCapture={(e) => {
        // Touch gives the idea under the finger an implicit capture; moving it
        // to the canvas when a drag starts is not a cancellation.
        if (e.target === canvas) stopPointer(e, false);
      }}
      onContextMenu={openContextMenu}
      class="map-canvas overflow-clip w-screen h-screen text-stone-900 relative touch-none select-none outline-none"
      style={{ cursor: panning() || draggingId() ? "grabbing" : "grab" }}
    >
      <ProjectPreferences
        open={showPreferences()}
        onClose={() => setShowPreferences(false)}
        saving={view().saving()}
        onChange={(value) => {
          if (!savingMutation.isPending) savingMutation.mutate(value);
        }}
        busy={savingMutation.isPending}
        error={preferencesError()}
        cloudStatus={cloudStatus()}
        signedIn={account().status === "authenticated"}
        onExport={exportCurrentProject}
        onSignIn={signInFrom(setShowPreferences)}
        onReviewAnalytics={
          isPhone() && analyticsEnabled
            ? () => {
                returnToShare = false;
                setShowPreferences(false);
                reviewConsent();
              }
            : undefined
        }
      />
      <ShareDialog
        open={showShare()}
        onClose={() => setShowShare(false)}
        projectId={doc().id}
        ownerId={
          account().status === "authenticated" ? account().user?.id : undefined
        }
        cloud={view().saving().cloud}
        onOpenPreferences={() => {
          returnToShare = true;
          setShowShare(false);
          setShowPreferences(true);
        }}
        onSignIn={signInFrom(setShowShare)}
        onShared={(enabled) => track("share_link_changed", { enabled })}
      />
      {/* On desktop the two top columns hold the menus and the search results,
          which open over the bottom chrome in a small window. */}
      <div class="pointer-events-none absolute top-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2 sm:z-40">
        <span role="status" class="sr-only">
          {saveDot().label}
        </span>
        <Show
          when={!isPhone()}
          fallback={
            <button
              type="button"
              data-no-pan
              data-toolbar
              class="map-toolbar phone-menu-button pointer-events-auto"
              data-problem={saveDot().tone === "error" ? "" : undefined}
              aria-label="Project menu"
              aria-haspopup="dialog"
              aria-expanded={menuOpen()}
              {...press(toggleProjectMenu)}
            >
              <MenuIcon />
            </button>
          }
        >
          <section
            data-no-pan
            data-toolbar
            aria-label="Project"
            class="map-toolbar pointer-events-auto flex max-w-full items-center gap-0.5 cursor-default"
          >
            <BrandMark class="mx-1 size-6 shrink-0 max-sm:hidden" />
            <ProjectNameInput />
            <button
              type="button"
              class="icon-button"
              aria-label="Project menu"
              title="Project menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen()}
              {...press(toggleProjectMenu)}
            >
              <ChevronDownIcon />
            </button>
            <fieldset
              aria-label="Project actions"
              class="flex min-w-0 items-center pr-2 pl-1 text-xs text-stone-500"
            >
              <Show
                when={saveDot().tone === "error"}
                fallback={
                  <span
                    aria-hidden="true"
                    class="save-state"
                    data-tone={saveDot().tone}
                    data-label={saveDot().label}
                  />
                }
              >
                <button
                  type="button"
                  class="save-state"
                  data-tone="error"
                  data-label="Couldn’t save · click for details"
                  aria-label="Save error details"
                  aria-haspopup="dialog"
                  {...press(() => setSaveErrorOpen(true))}
                />
              </Show>
            </fieldset>
          </section>
        </Show>
        <Show when={menuOpen() && !isPhone()}>
          <div
            ref={(el) => {
              projectMenu = el;
              transientLayer(el, {
                trigger: projectMenuButton,
                close: () => setMenuOpen(false),
              });
            }}
            data-no-pan
            data-toolbar
            role="menu"
            aria-label="Project menu"
            // A long menu scrolls itself rather than run off a short window.
            class="map-toolbar menu-panel pointer-events-auto max-h-[calc(100dvh-5rem)] w-72 overflow-y-auto cursor-default outline-none"
            onKeyDown={menuArrowKeys}
          >
            <fieldset disabled={fileBusy()} class="contents">
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                {...press(() => {
                  setMenuOpen(false);
                  createNewProject();
                })}
              >
                New map
              </button>
              <OpenMapItems />
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                {...press(() => {
                  setMenuOpen(false);
                  importProjectFromFile();
                })}
              >
                Import backup…
              </button>
              <div class="menu-divider" />
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                {...press(() => {
                  setMenuOpen(false);
                  save();
                })}
              >
                Save now
                <kbd class="ml-auto">{MOD_LABEL}S</kbd>
              </button>
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                {...press(() => {
                  setMenuOpen(false);
                  exportCurrentProject();
                })}
              >
                Export backup (.json)
              </button>
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                {...press(() => {
                  setMenuOpen(false);
                  void exportMarkdown();
                })}
              >
                Export outline (.md)
              </button>
              <div class="menu-divider" />
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                aria-haspopup="dialog"
                {...press(() => {
                  setMenuOpen(false);
                  finishWriting();
                  finishProjectName();
                  setShowShare(true);
                })}
              >
                Share link…
              </button>
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                aria-haspopup="dialog"
                {...press(() => {
                  setMenuOpen(false);
                  finishWriting();
                  finishProjectName();
                  returnToShare = false;
                  setShowPreferences(true);
                })}
              >
                Project preferences…
              </button>
              <Show when={analyticsEnabled}>
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item"
                  {...press(() => {
                    setMenuOpen(false);
                    reviewConsent();
                  })}
                >
                  Analytics choice…
                </button>
              </Show>
            </fieldset>
          </div>
        </Show>
        <Show when={storageMessage() || !storageReady() || memoryOnly()}>
          <div
            data-no-pan
            data-toolbar
            class="map-toolbar pointer-events-auto flex w-80 max-w-full flex-col gap-1 p-2! text-xs text-stone-600 cursor-default"
          >
            <Show when={memoryOnly()}>
              <p role="status" class="text-amber-800">
                In memory only · Export before closing this tab.
              </p>
            </Show>
            <div class="flex items-start gap-2 has-[p:empty]:hidden">
              <p
                role="status"
                data-storage-message
                class="min-w-0 flex-1 self-center"
              >
                {storageMessage()}
              </p>
              {/* While local saving is unavailable the message explains the
                  retry button below, so it stays. */}
              <Show when={storageMessage() && storageReady()}>
                <button
                  type="button"
                  class="icon-button size-8!"
                  aria-label="Dismiss"
                  title="Dismiss"
                  {...press(() => {
                    setStorageMessage("");
                    canvas.focus({ preventScroll: true });
                  })}
                >
                  <CloseIcon class="size-4" />
                </button>
              </Show>
            </div>
            <Show when={!storageReady()}>
              <div class="flex flex-wrap gap-1">
                <button
                  type="button"
                  class="map-control outlined"
                  {...press(retryLocal)}
                >
                  Retry local saving
                </button>
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <div class="pointer-events-none absolute top-3 right-3 z-30 flex flex-col items-end gap-2 sm:z-40">
        <Show when={!isPhone()}>
          <div class="flex items-start gap-2">
            <nav
              data-no-pan
              data-toolbar
              aria-label="Editing"
              class="map-toolbar pointer-events-auto flex items-center gap-0.5 cursor-default"
            >
              {/* Undo and redo appear with the first edit. They sit at the far end
                so the buttons already on screen stay where they are. */}
              <Show when={canUndo() || canRedo()}>
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Undo"
                  title={`Undo (${MOD_LABEL}Z)`}
                  disabled={!canUndo()}
                  {...press(undo)}
                >
                  <UndoIcon />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Redo"
                  title={`Redo (${MOD_LABEL}${SHIFT_LABEL}Z)`}
                  disabled={!canRedo()}
                  {...press(redo)}
                >
                  <RedoIcon />
                </button>
                <span class="toolbar-divider" />
              </Show>
              <button
                type="button"
                class="icon-button"
                aria-label="Search"
                title={`Search (${MOD_LABEL}F)`}
                aria-expanded={searchOpen()}
                {...press(() =>
                  searchOpen() ? closeSearch(false) : openSearch(),
                )}
              >
                <SearchIcon />
              </button>
              <button
                type="button"
                class="icon-button"
                aria-label="Outline"
                title={`${outlineOpen() ? "Close outline" : "Outline"} (${ALT_LABEL}O)`}
                aria-expanded={outlineOpen()}
                {...press((e) => {
                  setOutlineOpen((open) => !open);
                  backToCanvas(e);
                })}
              >
                <OutlineIcon open={outlineOpen()} />
              </button>
            </nav>
            <AccountControls
              state={account()}
              beforeNavigate={saveBeforeAuth}
              onRetry={() => void auth.check()}
              signInRef={(start) => {
                signIn = start;
              }}
            />
          </div>
        </Show>
        <Show when={searchOpen()}>
          <search
            data-no-pan
            data-toolbar
            aria-label="Search ideas"
            // The field fills the island, so the island carries its focus ring.
            class="map-toolbar pointer-events-auto flex w-88 max-w-[calc(100vw-1.5rem)] flex-col cursor-default has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-accent"
            // Beside the side panel, not over its header: previews select
            // ideas, and the outline and notes follow.
            classList={{
              "mr-[25rem] max-w-[calc(100vw-26.5rem)]! xl:mr-[29rem]":
                sideOpen() && !isPhone(),
            }}
            ref={(el) => closeOnEscape(el, () => closeSearch(false))}
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
                class="search-field min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-stone-500"
                value={searchQuery()}
                onInput={(e) => {
                  batch(() => {
                    setSearchQuery(e.currentTarget.value);
                    setSearchIndex(0);
                  });
                }}
                onKeyDown={(e) => {
                  const count = searchResults().length;
                  if (e.key === "Enter") {
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
                title="Close search (Esc)"
                {...press(() => closeSearch(false))}
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
                    <div
                      id={`search-result-${index()}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index() === searchIndex()}
                      class="search-result"
                      onPointerEnter={() => setSearchIndex(index())}
                      {...press(() => {
                        setSearchIndex(index());
                        closeSearch(true);
                      })}
                    >
                      <span class="block truncate text-sm text-stone-800">
                        {result.text.slice(0, result.match[0])}
                        <mark>
                          {result.text.slice(result.match[0], result.match[1])}
                        </mark>
                        {result.text.slice(result.match[1])}
                      </span>
                      <Show when={result.path.length}>
                        <span class="block truncate text-xs text-stone-500">
                          {/* The nearest parents matter most; earlier ones collapse. */}
                          {[
                            ...(result.path.length > 3 ? ["…"] : []),
                            ...result.path
                              .slice(-3)
                              .map((part) => truncate(part, 20)),
                          ].join(" › ")}
                        </span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
              <p class="border-t border-stone-100 px-3 py-1.5 text-[11px] text-stone-500">
                {/* One line: when both don't fit, the hint wraps out of view. */}
                <span class="flex h-[1lh] flex-wrap justify-between gap-x-2 overflow-hidden">
                  <span class="whitespace-nowrap">
                    {searchResults().length}
                    {searchHits().length > SEARCH_LIMIT ? "+" : ""}{" "}
                    {searchResults().length === 1 ? "match" : "matches"} in{" "}
                    {focusId() ? "this branch" : "this map"}
                  </span>
                  <span class="keyboard-hint whitespace-nowrap">
                    ↑↓ preview · Enter go · Esc back
                  </span>
                </span>
              </p>
            </Show>
          </search>
        </Show>
      </div>
      {/* The side panel: a drawer over the map's right edge, under the
            toolbar that opens it. On phones it covers the map. */}
      <Show when={sidePanel.mounted()}>
        <div
          ref={sidePanel.ref}
          data-closing={sidePanel.closing() ? "" : undefined}
          inert={sidePanel.closing()}
          class="side-drawer pointer-events-none absolute top-[4.5rem] right-3 bottom-[4.5rem] z-20 flex w-96 max-w-[calc(100%-1.5rem)] flex-col xl:w-[28rem] max-sm:inset-3 max-sm:z-40 max-sm:w-auto max-sm:max-w-none"
        >
          <SidePanel
            tab={sideTab() ?? "outline"}
            onTab={(tab) => {
              finishWriting();
              setSideTab(tab);
            }}
            onClose={() => {
              setSideTab(undefined);
              canvas.focus({ preventScroll: true });
            }}
            closeTitle={(tab) =>
              tab === "outline"
                ? `Close outline (${ALT_LABEL}O)`
                : // Esc, not the Alt shortcut: the notes field keeps that
                  // key for typing.
                  "Close notes (Esc)"
            }
            outline={
              <Outline
                roots={scopeForest()}
                text={(id) => view().text(id)}
                selectedId={selectedId()}
                collapsed={collapsedIds()}
                onSelect={(id, via) => {
                  finishWriting();
                  setColorScope("node");
                  setSelectedId(id);
                  // On narrow screens the outline covers the map, so picking an idea
                  // by tap returns to the map; arrow keys keep browsing the outline.
                  if (via === "pointer" && canvasSize().width < 640)
                    setOutlineOpen(false);
                }}
                onToggle={(id) => toggleCollapse(id, false)}
                onEdit={write}
                hasNote={(id) => !!view().note(id).trim()}
                onHover={setHintedId}
                onOpenNotes={(id) => {
                  finishWriting();
                  setColorScope("node");
                  setSelectedId(id);
                  // Opens the Notes tab ready to write in.
                  toggleNotes(true);
                }}
              />
            }
            notes={
              <NotesPanel
                doc={session().doc}
                id={selectedId()}
                onFocusChange={() => session().undo.finishGroup()}
                onShowOnMap={() => {
                  const id = selectedId();
                  if (id) showOnMap(id);
                }}
              />
            }
          />
        </div>
      </Show>
      <AnalyticsConsent />
      {/* One column, so these stack instead of covering each other. */}
      <div
        class="pointer-events-none absolute top-16 z-20 flex flex-col items-center gap-2"
        style={stripStyle(panelStrip())}
      >
        <Show when={focusId()}>
          <nav
            data-no-pan
            data-toolbar
            aria-label="Branch focus"
            // Clipped, so nothing can spill over the panels beside it. The
            // minimum keeps the way out in reach.
            class="map-toolbar pointer-events-auto flex max-w-full min-w-36 items-center gap-0.5 overflow-hidden text-sm cursor-default"
          >
            <button
              type="button"
              class="map-control flex h-9 shrink-0 items-center gap-1.5"
              title="Show the whole map (Esc with nothing selected)"
              {...press(exitFocus)}
            >
              <ArrowLeftIcon class="size-4" />
              <span classList={{ "sr-only": crumbRoom() < 240 }}>
                Whole map
              </span>
            </button>
            <For each={crumbs()}>
              {(id, index) => (
                <>
                  <ChevronRightIcon class="size-3.5 shrink-0 text-stone-400" />
                  <Show
                    when={index() < crumbs().length - 1}
                    fallback={
                      <span
                        aria-current="location"
                        class="max-w-48 truncate px-2 font-medium text-stone-800"
                      >
                        {nodeLabel(id)}
                      </span>
                    }
                  >
                    {/* The steps above give way first, so where you are stays
                        readable. */}
                    <button
                      type="button"
                      class="map-control h-9 max-w-36 shrink-3 truncate"
                      {...press(() => focusBranch(id))}
                    >
                      {nodeLabel(id)}
                    </button>
                  </Show>
                </>
              )}
            </For>
          </nav>
        </Show>
        <Show when={returnView()}>
          <nav
            data-no-pan
            data-toolbar
            aria-label="Return from search"
            class="map-toolbar pointer-events-auto flex max-w-full min-w-36 items-center gap-0.5 text-sm cursor-default"
          >
            <button
              type="button"
              class="map-control flex h-9 min-w-0 items-center gap-1.5"
              title="Restore the view and folds from before the search"
              {...press(() => {
                const back = returnView();
                setReturnView(undefined);
                if (back) restoreView(back);
                canvas.focus({ preventScroll: true });
              })}
            >
              <ArrowLeftIcon class="size-4 shrink-0" />
              <span class="truncate">Back to where you were</span>
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Stay here"
              title="Stay here"
              {...press(() => setReturnView(undefined))}
            >
              <CloseIcon class="size-4" />
            </button>
          </nav>
        </Show>
      </div>
      {/* The notice keeps its place above the selection toolbar's slot, so the
          toolbar reappearing (when an edit ends on press) never moves it from
          under the pointer. */}
      <div
        class="pointer-events-none absolute bottom-[4.25rem] z-30 flex justify-center"
        style={stripStyle(noticeStrip())}
      >
        <Show when={notice()}>
          {(current) => (
            <div
              role="status"
              data-no-pan
              data-toolbar
              class="notice pointer-events-auto flex min-w-0 items-center gap-3 cursor-default"
            >
              <span class="min-w-0 truncate">{current().message}</span>
              <Show when={current().action}>
                {(action) => (
                  <button
                    type="button"
                    class="notice-action"
                    {...press(() => {
                      setNotice(undefined);
                      const undoing = action().run === undo;
                      action().run();
                      if (undoing)
                        showNotice({
                          message: "Undone",
                          action: { label: "Redo", run: redo },
                        });
                    })}
                  >
                    {action().label}
                  </button>
                )}
              </Show>
            </div>
          )}
        </Show>
      </div>
      {/* Level with the notice and after it, so the color popover, which opens
          into the notice's slot, paints over it. */}
      <div
        class="pointer-events-none absolute bottom-3 z-30 flex flex-col items-center gap-2"
        style={stripStyle(bottomStrip())}
      >
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
                class="map-toolbar absolute bottom-full left-1/2 mb-2 flex w-64 -translate-x-1/2 flex-col gap-2 outline-none"
                // Opaque: it opens over the notice and the analytics banner,
                // and inside the toolbar its own blur cannot hide them.
                style={{ background: "var(--surface)" }}
                ref={(el) =>
                  transientLayer(el, {
                    trigger: () =>
                      document.querySelector<HTMLButtonElement>(
                        'button[aria-label="Color"]',
                      ),
                    close: () => setColorOpen(false),
                  })
                }
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
                    <span>This idea</span>
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
                    {colorScope() === "node" ? "this idea" : "this branch"}
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
                        title={`${color.label} · ${colorScope() === "node" ? "This idea" : "This branch"}`}
                        {...press(() => colorSelectedNode(color.value))}
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
                    ? "Changes only the selected idea."
                    : "Changes this idea and everything under it."}
                </p>
              </section>
            </Show>
            <button
              type="button"
              class="tool-button"
              title="Add a child idea (Tab)"
              {...press(() => add("child"))}
            >
              <ChildIcon />
              <span class="max-sm:sr-only">Child</span>
            </button>
            <button
              type="button"
              class="tool-button"
              // Enter on a central idea adds a child instead.
              title={`Add a sibling idea${details().get(selectedId() ?? "")?.parent ? " (Enter)" : ""}`}
              disabled={selectedId() === focusId()}
              {...press(() => add("sibling"))}
            >
              <SiblingIcon />
              <span class="max-sm:sr-only">Sibling</span>
            </button>
            <span class="toolbar-divider" />
            <button
              type="button"
              class="icon-button"
              aria-label="Color"
              title="Color"
              aria-expanded={colorOpen()}
              {...press((e) => {
                setColorOpen((open) => !open);
                if (!colorOpen()) backToCanvas(e);
              })}
            >
              <span
                aria-hidden="true"
                class={`size-4.5 rounded-full border-2 ${(NODE_COLORS.find((color) => color.value === (selectedNode()?.color ?? "blue")) ?? NODE_COLORS[0]).swatchClass}`}
              />
            </button>
            <button
              type="button"
              class="icon-button relative"
              aria-label="Notes"
              title={`Notes (${ALT_LABEL}N)`}
              aria-expanded={notesOpen()}
              {...press(() => toggleNotes())}
            >
              <NoteIcon />
              <Show
                when={view()
                  .note(selectedId() ?? "")
                  .trim()}
              >
                <span
                  aria-hidden="true"
                  class="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent"
                />
              </Show>
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
                title={`${collapsedIds().has(selectedId() ?? "") ? "Expand" : "Collapse"} children (${ALT_LABEL}G)`}
                {...press(() => toggleCollapse(selectedId() as string))}
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
                class="icon-button narrow-hide"
                aria-label={
                  focusId() === selectedId()
                    ? "Leave focus"
                    : "Focus on this branch"
                }
                title={`${focusId() === selectedId() ? "Leave focus" : "Focus on this branch"} (${ALT_LABEL}F)`}
                aria-pressed={focusId() === selectedId()}
                {...press(() =>
                  focusId() === selectedId() ? exitFocus() : focusBranch(),
                )}
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
              aria-expanded={!!contextMenu()?.above}
              {...press((e) => {
                if (contextMenu()?.above) {
                  setContextMenu(undefined);
                  backToCanvas(e);
                  return;
                }
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
              })}
            >
              <MoreIcon />
            </button>
          </section>
        </Show>
      </div>
      <div
        class="map-layer absolute w-full h-full origin-top-left"
        classList={{ "map-layer-easing": easingView() }}
        data-dropping={dropTarget() ? "" : undefined}
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
          {/* Keyed by child id so a layout change updates path data in place
              instead of recreating every connection. */}
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
                hinted={hintedId() === id}
                writing={selectedId() === id && writing()}
                dragging={draggingId() === id}
                root={!details().get(id)?.parent || focusId() === id}
                note={!!view().note(id).trim()}
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
                onTab={(shift) => (shift ? insertParent() : add("child"))}
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
            top: `${(dragPointer()?.y ?? 0) - 40}px`,
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
          <p class="font-display text-2xl font-semibold text-stone-900">
            Your canvas is empty
          </p>
          <p class="max-w-64 text-sm text-stone-500">
            Start with the central idea. Press <kbd>Enter</kbd> anytime to add
            one.
          </p>
          <button
            type="button"
            class="primary-button"
            {...press(() => add("root"))}
          >
            Create an idea
          </button>
        </div>
      </Show>
      <Show when={contextMenu()}>
        {(menu) => (
          <div
            ref={(el) => {
              contextMenuElement = el;
              const moreActions = () =>
                document.querySelector<HTMLButtonElement>(
                  'button[aria-label="More actions"]',
                );
              transientLayer(el, {
                trigger: moreActions,
                close: () => setContextMenu(undefined),
                // A right-click menu has no trigger; it came from the map.
                returnFocus: () =>
                  (contextMenu()?.above && moreActions()) || canvas,
              });
            }}
            data-no-pan
            data-toolbar
            data-context-menu
            role="menu"
            aria-label={menu().nodeId ? "Idea actions" : "Canvas actions"}
            class="map-toolbar menu-panel fixed z-50 w-60 text-sm cursor-default outline-none"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
              transform: menu().above ? "translateY(-100%)" : undefined,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={menuArrowKeys}
          >
            <Show
              when={menu().nodeId}
              fallback={
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item"
                  {...press(() => {
                    const position = menu().rootPosition;
                    setContextMenu(undefined);
                    add("root", position);
                  })}
                >
                  New central idea
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
                      {...press(run(() => add("child")))}
                    >
                      Add child idea
                      <kbd class="ml-auto">Tab</kbd>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      disabled={nodeId() === focusId()}
                      {...press(run(() => add("sibling")))}
                    >
                      Add sibling idea
                      {/* Enter on a central idea adds a child instead. */}
                      <Show when={details().get(nodeId())?.parent}>
                        <kbd class="ml-auto">Enter</kbd>
                      </Show>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      disabled={nodeId() === focusId()}
                      {...press(run(insertParent))}
                    >
                      Insert parent
                      <kbd class="ml-auto">{SHIFT_LABEL}Tab</kbd>
                    </button>
                    <div class="menu-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      disabled={siblings()[0]?.id === nodeId()}
                      {...press(run(indentSelected))}
                    >
                      Move under idea above
                      <kbd class="ml-auto">{ALT_LABEL}→</kbd>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      disabled={
                        !details().get(nodeId())?.parent ||
                        nodeId() === focusId()
                      }
                      {...press(run(outdentSelected))}
                    >
                      Move out to parent level
                      <kbd class="ml-auto">{ALT_LABEL}←</kbd>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      {...press(run(() => toggleNotes(true)))}
                    >
                      {view().note(nodeId()).trim()
                        ? "Open notes"
                        : "Add notes"}
                      <kbd class="ml-auto">{ALT_LABEL}N</kbd>
                    </button>
                    <Show when={placedIds(nodeId()).length}>
                      <button
                        type="button"
                        role="menuitem"
                        class="menu-item"
                        {...press(run(() => resetPlacement(nodeId())))}
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
                        {...press(() => {
                          setContextMenu(undefined);
                          toggleCollapse(nodeId());
                        })}
                      >
                        {collapsedIds().has(nodeId())
                          ? "Expand children"
                          : "Collapse children"}
                        <kbd class="ml-auto">{ALT_LABEL}G</kbd>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        class="menu-item"
                        {...press(
                          run(() =>
                            focusId() === nodeId()
                              ? exitFocus()
                              : focusBranch(),
                          ),
                        )}
                      >
                        {focusId() === nodeId()
                          ? "Leave focus"
                          : "Focus on this branch"}
                        <kbd class="ml-auto">{ALT_LABEL}F</kbd>
                      </button>
                    </Show>
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      {...press(run(() => fitSelection(nodeId())))}
                    >
                      Fit selection
                      <kbd class="ml-auto">{ALT_LABEL}2</kbd>
                    </button>
                    <div class="menu-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item text-rose-700!"
                      {...press(run(removeSelected))}
                    >
                      Delete
                      <kbd class="ml-auto">{DELETE_LABEL}</kbd>
                    </button>
                  </>
                );
              }}
            </Show>
          </div>
        )}
      </Show>
      <Show when={!isPhone()}>
        <section
          data-no-pan
          data-toolbar
          aria-label="View and help"
          class="map-toolbar pointer-events-auto absolute right-3 bottom-3 z-20 flex items-center gap-0.5 text-sm cursor-default"
        >
          <fieldset aria-label="Canvas zoom" class="flex items-center gap-0.5">
            <button
              type="button"
              class="icon-button"
              aria-label="Zoom out"
              title={`Zoom out (${MOD_LABEL}−)`}
              disabled={zoom() <= ZOOM_MIN}
              {...press((e) => {
                changeZoom(zoom() / 1.2);
                backToCanvas(e);
              })}
            >
              <MinusIcon />
            </button>
            <button
              type="button"
              class="map-control h-9 min-w-14 px-1! tabular-nums max-sm:hidden"
              aria-label="Zoom to 100%"
              title={`Zoom to 100% (${MOD_LABEL}0)`}
              {...press((e) => {
                changeZoom(1);
                backToCanvas(e);
              })}
            >
              {Math.round(zoom() * 100)}%
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Zoom in"
              title={`Zoom in (${MOD_LABEL}+)`}
              disabled={zoom() >= ZOOM_MAX}
              {...press((e) => {
                changeZoom(zoom() * 1.2);
                backToCanvas(e);
              })}
            >
              <PlusIcon />
            </button>
            <span class="toolbar-divider" />
            <button
              type="button"
              class="icon-button"
              aria-label="Fit map"
              title={`Fit map (${ALT_LABEL}1)`}
              disabled={!forest().length}
              {...press((e) => {
                fitMap();
                backToCanvas(e);
              })}
            >
              <FitMapIcon />
            </button>
          </fieldset>
          <span class="toolbar-divider" />
          <button
            type="button"
            class="icon-button"
            aria-label="Shortcuts and navigation"
            title="Shortcuts and navigation (? with nothing selected)"
            aria-haspopup="dialog"
            {...press(() => setShowHelp(true))}
          >
            <HelpIcon />
          </button>
        </section>
      </Show>
      <Show when={isPhone()}>
        <Dialog
          variant="panel"
          open={menuOpen()}
          onClose={() => setMenuOpen(false)}
          title="Project menu"
          closeLabel="Close project menu"
          heading={<ProjectNameInput />}
        >
          <Show
            when={saveDot().tone === "error"}
            fallback={
              <p class="panel-status">
                <span
                  aria-hidden="true"
                  class="save-state"
                  data-tone={saveDot().tone}
                />
                {saveDot().label}
              </p>
            }
          >
            <button
              type="button"
              class="panel-status"
              aria-haspopup="dialog"
              {...press(fromPanel(() => setSaveErrorOpen(true)))}
            >
              <span aria-hidden="true" class="save-state" data-tone="error" />
              {saveDot().label}
              <ChevronRightIcon class="ml-auto size-4" />
            </button>
          </Show>
          <Show when={canUndo() || canRedo()}>
            <div class="grid grid-cols-2 gap-2 py-2">
              <button
                type="button"
                class="panel-pair"
                disabled={!canUndo()}
                {...press(fromPanel(undo))}
              >
                <UndoIcon />
                Undo
              </button>
              <button
                type="button"
                class="panel-pair"
                disabled={!canRedo()}
                {...press(fromPanel(redo))}
              >
                <RedoIcon />
                Redo
              </button>
            </div>
          </Show>
          <button
            type="button"
            class="menu-item"
            {...press(fromPanel(openSearch))}
          >
            <SearchIcon />
            Search
          </button>
          <button
            type="button"
            class="menu-item"
            {...press(fromPanel(() => setOutlineOpen(true)))}
          >
            <OutlineIcon />
            Outline
          </button>
          <button
            type="button"
            class="menu-item"
            disabled={!forest().length}
            {...press(fromPanel(fitMap))}
          >
            <FitMapIcon />
            Fit map
          </button>
          <div class="menu-divider" />
          <fieldset disabled={fileBusy()} class="contents">
            <button
              type="button"
              class="menu-item"
              {...press(fromPanel(createNewProject))}
            >
              New map
            </button>
            <OpenMapItems />
            <button
              type="button"
              class="menu-item"
              aria-haspopup="dialog"
              {...press(fromPanel(() => setShowShare(true)))}
            >
              Share link…
            </button>
            <button
              type="button"
              class="menu-item"
              aria-expanded={showBackup()}
              {...press(() => setShowBackup((open) => !open))}
            >
              Backup and export
              <ChevronRightIcon
                class={`ml-auto size-4 transition-transform duration-100 ${showBackup() ? "rotate-90" : ""}`}
              />
            </button>
            <Show when={showBackup()}>
              <div class="mx-1 mb-1 rounded-lg bg-stone-50 p-1">
                <button
                  type="button"
                  class="menu-item"
                  {...press(fromPanel(importProjectFromFile))}
                >
                  Import backup…
                </button>
                <button
                  type="button"
                  class="menu-item"
                  {...press(fromPanel(exportCurrentProject))}
                >
                  Export backup (.json)
                </button>
                <button
                  type="button"
                  class="menu-item"
                  {...press(fromPanel(() => void exportMarkdown()))}
                >
                  Export outline (.md)
                </button>
              </div>
            </Show>
            <button
              type="button"
              class="menu-item"
              aria-haspopup="dialog"
              {...press(
                fromPanel(() => {
                  returnToShare = false;
                  setShowPreferences(true);
                }),
              )}
            >
              Project preferences…
            </button>
            <button
              type="button"
              class="menu-item"
              aria-haspopup="dialog"
              {...press(fromPanel(() => setShowHelp(true)))}
            >
              Help
            </button>
          </fieldset>
          <AccountControls
            inline
            state={account()}
            beforeNavigate={saveBeforeAuth}
            onRetry={() => void auth.check()}
            onAuthError={() => setMenuOpen(true)}
            shownElsewhere={saveDot().label}
          />
        </Dialog>
      </Show>
      <SaveErrorDialog
        open={saveErrorOpen()}
        onClose={() => {
          setSaveErrorOpen(false);
          canvas.focus({ preventScroll: true });
        }}
        problems={saveProblems()}
        safeInBrowser={
          view().saving().local &&
          storageReady() &&
          !localSave.message() &&
          !recoveryPending()
        }
        retryingAlone={
          !!localSave.message() || cloudStatus()?.status === "retrying"
        }
        onRetryLocal={
          localSave.message() || recoveryPending() ? retryLocal : undefined
        }
        onRetryCloud={cloudProblem() ? retryCloud : undefined}
      />
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
