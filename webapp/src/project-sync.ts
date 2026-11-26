import { QueryObserver } from "@tanstack/solid-query";
import type { QueryClient } from "@tanstack/solid-query";
import { backendEndpoint } from "./backend";
import { LoroApi, decodeBase64, SyncError } from "./loro-api";
import type { CloudSnapshot } from "./loro-api";
import { ORIGIN, openProjectDocument } from "./project-document";
import type { ProjectDocument } from "./project-document";
import type {
  CloudMarker,
  ProjectHandle,
  ProjectRepository,
} from "./project-repository";
import { saveRetryDelay } from "./query-client";

export type CloudStatus =
  | { status: "saving" | "saved" | "offline" | "disabled" | "deleting" }
  | { status: "retrying" | "auth" | "blocked"; message: string };
export interface SyncProvider {
  connect(): void;
  disconnect(): void;
  destroy(): void;
  // `revision` is the cloud revision the notification names, when it names one.
  on(
    name: "sync",
    listener: (synced: boolean, revision?: string) => void,
  ): void;
  on(
    name: "connection-close",
    listener: (event: CloseEvent | null) => void,
  ): void;
}
function notifiedRevision(message: unknown) {
  try {
    const revision: unknown = JSON.parse(String(message))?.revision;
    return typeof revision === "string" ? revision : undefined;
  } catch {
    return undefined;
  }
}
// Sockets carry commit notifications only. Every document merge goes through
// the authenticated, transactional HTTP API and the same shared Rust core.
export function websocketProvider(
  id: string,
  _doc: ProjectDocument,
  ownerId?: number,
): SyncProvider {
  let socket: WebSocket | undefined;
  let destroyed = false;
  const listeners = new Map<string, (...event: never[]) => void>();
  return {
    connect() {
      if (destroyed || (socket && socket.readyState < WebSocket.CLOSING))
        return;
      const url = new URL(backendEndpoint(`/ws/project/${id}`));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ownerId", String(ownerId));
      const current = new WebSocket(url);
      socket = current;
      current.onmessage = ({ data }) => {
        if (socket === current)
          listeners.get("sync")?.(
            true as never,
            notifiedRevision(data) as never,
          );
      };
      current.onclose = (event) => {
        if (socket === current) {
          socket = undefined;
          listeners.get("connection-close")?.(event as never);
        }
      };
    },
    disconnect() {
      const current = socket;
      socket = undefined;
      current?.close();
    },
    destroy() {
      destroyed = true;
      this.disconnect();
      listeners.clear();
    },
    on(name: string, listener: (...event: never[]) => void) {
      listeners.set(name, listener);
    },
  };
}
// The version and head of a committed cloud snapshot, or undefined while the
// cloud has none.
function committedVersion(id: string, snapshot: Uint8Array) {
  if (!snapshot.length) return undefined;
  const remote = openProjectDocument(id, [snapshot]);
  try {
    return { version: remote.native().version(), head: remote.head() };
  } finally {
    remote.destroy();
  }
}
// Whether the document holds anything the cloud copy at `committed` lacks.
function unsaved(doc: ProjectDocument, committed?: Uint8Array) {
  return doc.ready && (!committed || committed.join(",") !== doc.version());
}
// What the cloud copy lacks: the whole document while the cloud has none, and
// afterwards only the changes made since `committed`, never the complete
// history again.
export function pendingUpload(doc: ProjectDocument, committed?: Uint8Array) {
  if (!unsaved(doc, committed)) return undefined;
  return committed ? doc.updatesSince(committed) : doc.snapshot();
}
export interface SyncOptions {
  api?: LoroApi;
  provider?: (id: string, doc: ProjectDocument) => SyncProvider;
  // Syncs only on syncNow(): no retries, polling or focus/reconnect refetches.
  manual?: boolean;
  onStatus?: (status: CloudStatus) => void;
  // The revision a listing just reported for the map. A map whose marker
  // names it is not read before uploading.
  revision?: string;
}
const unavailable = () =>
  new SyncError("Cloud saving is unavailable. Retrying…");
const fenced = () => new DOMException("Disposed", "AbortError");

// One query per project lifetime. Query serializes runs, retries transient
// failures with backoff, pauses while offline, and refetches on focus,
// reconnect and a slow poll. Local edits join a running sync, which uploads
// until nothing is pending; socket notifications restart it.
export class ProjectSync {
  readonly handle: ProjectHandle;
  readonly repository: ProjectRepository;
  readonly api: LoroApi;
  readonly #options: SyncOptions;
  readonly #abort = new AbortController();
  readonly #queryKey: readonly string[];
  readonly #observer: QueryObserver<null, Error, null, null, readonly string[]>;
  #provider?: SyncProvider;
  #registered = false;
  #registrationChecked = false;
  #deleted = false;
  #registrationStarted = false;
  // What the server last said the cloud copy holds, and that as a version of
  // this document. Every sync asks again before choosing what to upload,
  // unless a listing just vouched for the marker, so a save whose
  // acknowledgement was lost is never sent a second time.
  #cloud?: CloudMarker;
  #committed?: Uint8Array;
  // The listing's revision for the map, for the first sync only: later ones
  // run after the listing has aged.
  #listed?: string;
  #paused = false;
  #authPaused = false;
  #status: CloudStatus = { status: "saving" };
  readonly #stopSaving: () => void;
  constructor(
    handle: ProjectHandle,
    repository: ProjectRepository,
    options: SyncOptions = {},
  ) {
    this.handle = handle;
    this.repository = repository;
    this.#options = options;
    this.#listed = options.revision;
    this.api =
      options.api ??
      new LoroApi(
        undefined,
        undefined,
        Number(repository.scope.namespace.replace("account-", "")),
      );
    this.#queryKey = [
      "cloud-sync",
      repository.names.catalog,
      handle.id,
      crypto.randomUUID(),
    ];
    this.#observer = new QueryObserver(
      this.api.queryClient,
      this.#queryOptions(),
    );
    this.#observer.subscribe(({ fetchStatus }) => {
      if (fetchStatus === "paused") this.#offline();
    });
    handle.doc.on("snapshot", this.#onSnapshot);
    this.#stopSaving = handle.onSaving(this.#onSaving);
  }
  get status() {
    return this.#status;
  }
  get destroyed() {
    return this.#abort.signal.aborted;
  }
  #queryOptions() {
    const manual = !!this.#options.manual;
    return {
      queryKey: this.#queryKey,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        this.#run(AbortSignal.any([this.#abort.signal, signal])),
      enabled: !manual && !this.#paused,
      networkMode: "online" as const,
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (_count: number, error: Error) =>
        !manual && error instanceof SyncError,
      retryDelay: saveRetryDelay,
      gcTime: 0,
    };
  }
  // Restart cancels an in-flight run; otherwise a request joins it.
  #trigger(restart: boolean) {
    if (this.destroyed || this.#paused || this.#options.manual) return;
    void this.#observer.refetch({ cancelRefetch: restart });
  }
  #alive(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#paused || !this.handle.saving.cloud) throw fenced();
  }
  #setStatus(status: CloudStatus) {
    if (!this.destroyed) {
      this.#status = status;
      this.#options.onStatus?.(status);
    }
  }
  #pause(status: CloudStatus & { message: string }) {
    this.#paused = true;
    this.#authPaused = status.status === "auth";
    this.#provider?.disconnect();
    this.#setStatus(status);
    this.#observer.setOptions(this.#queryOptions());
  }
  #onSnapshot = (_bytes: Uint8Array, origin: unknown) => {
    if (!this.handle.saving.cloud) return;
    if (origin === ORIGIN.remote || origin === this.#provider || this.#paused)
      return;
    this.#setStatus({ status: "saving" });
    this.#trigger(false);
  };
  // Turned off, the next run deletes the cloud copy; turned on again after
  // that, the map registers and uploads as a new one.
  #onSaving = () => {
    if (!this.handle.saving.cloud) {
      this.#provider?.destroy();
      this.#provider = undefined;
      this.#trigger(true);
      return;
    }
    if (this.#deleted) {
      this.#deleted = false;
      this.#registered = false;
      this.#cloud = undefined;
      this.#committed = undefined;
    }
    if (this.#paused) return;
    this.#setStatus({ status: "saving" });
    this.#trigger(false);
  };
  #offline() {
    this.#provider?.disconnect();
    this.#setStatus(
      this.handle.saving.cloud
        ? { status: "offline" }
        : this.#deleted
          ? { status: "disabled" }
          : {
              status: "retrying",
              message:
                "Cloud deletion pending. Reconnect to delete the existing cloud copy.",
            },
    );
  }
  pauseForAuth(message: string) {
    this.#pause({ status: "auth", message });
  }
  retry() {
    if (this.destroyed || this.#authPaused) return;
    this.#paused = false;
    this.#observer.setOptions(this.#queryOptions());
    this.#trigger(true);
  }
  async syncNow(): Promise<void> {
    if (this.destroyed || this.#paused) return;
    await this.#observer.refetch({ cancelRefetch: false });
  }
  async #run(signal: AbortSignal): Promise<null> {
    try {
      await (globalThis.navigator?.locks
        ? navigator.locks.request(
            `${this.repository.names.catalog}/cloud/${this.handle.id}`,
            { signal },
            () => this.#sync(signal),
          )
        : this.#sync(signal));
    } catch (error) {
      if (signal.aborted || this.#paused) throw error;
      // Opting out fenced this run; the next one deletes the cloud copy.
      if (
        !this.handle.saving.cloud &&
        error instanceof DOMException &&
        error.name === "AbortError"
      )
        return this.#run(signal);
      const failure = error instanceof SyncError ? error : unavailable();
      if (failure.kind !== "retry") {
        this.#pause({ status: failure.kind, message: failure.message });
        return null;
      }
      this.#setStatus({
        status: "retrying",
        message: !this.handle.saving.cloud
          ? "Cloud deletion pending. Reconnect to finish deleting the cloud copy."
          : failure.message,
      });
      throw failure;
    }
    return null;
  }
  async #sync(signal: AbortSignal) {
    if (!this.handle.saving.cloud) {
      if (
        !this.#deleted &&
        (this.#registrationStarted ||
          this.#registered ||
          (await this.repository.cloudAttempted(this.handle.id)))
      ) {
        this.#setStatus({ status: "deleting" });
        await this.api.remove(this.handle.id, signal);
        signal.throwIfAborted();
        await this.repository.markUnregistered(this.handle.id);
        this.#registered = false;
        this.#registrationStarted = false;
        this.#cloud = undefined;
        this.#committed = undefined;
      }
      this.#deleted = true;
      this.#setStatus({ status: "disabled" });
      return;
    }
    if (!this.#registrationChecked) {
      this.#registered = await this.repository.isRegistered(this.handle.id);
      this.#registrationChecked = true;
      this.#alive(signal);
    }
    const stored = await this.repository.cloudVersion(this.handle.id);
    this.#alive(signal);
    this.#recall(stored);
    // Pulling a remote change is not saving: only registration or an upload
    // shows "saving", so socket notifications don't flash it.
    if (!this.#registered || unsaved(this.handle.doc, this.#committed))
      this.#setStatus({ status: "saving" });
    if (!this.#registered) {
      this.#registrationStarted = true;
      await this.repository.markCloudAttempted(this.handle.id);
      this.#alive(signal);
      await this.api.register(this.handle.id, signal);
      this.#alive(signal);
      await this.repository.markRegistered(this.handle.id);
      this.#alive(signal);
      this.#registered = true;
    }
    // A listing that names the marker's revision has just said the cloud copy
    // did not move, so there is nothing to read.
    const listed = this.#listed;
    this.#listed = undefined;
    if (
      listed === undefined ||
      !this.#cloud?.head ||
      listed !== this.#cloud.revision
    )
      await this.#read(signal);
    // Edits made during an upload are uploaded by the same run.
    let whole = false;
    let resent = false;
    let reread = false;
    for (;;) {
      const upload = whole
        ? this.handle.doc.snapshot()
        : pendingUpload(this.handle.doc, this.#committed);
      if (!upload) break;
      whole = false;
      this.#setStatus({ status: "saving" });
      let receipt: CloudSnapshot;
      try {
        receipt = await this.api.merge(this.handle.id, upload, signal);
      } catch (error) {
        // The cloud copy no longer holds what these changes build on: it was
        // deleted and created again since it was read. Send the whole
        // document, once.
        if (
          resent ||
          !(error instanceof SyncError) ||
          error.code !== "missing_dependencies"
        )
          throw error;
        whole = resent = true;
        continue;
      }
      this.#alive(signal);
      if (await this.#apply(receipt, signal)) continue;
      // The cloud copy holds more than this save and what was read before it:
      // another device saved in between. Read that, once.
      if (reread) throw unavailable();
      reread = true;
      await this.#read(signal);
    }
    this.#connect().connect();
    this.#setStatus({ status: "saved" });
  }
  // Takes up the newest marker this document can use, the stored one on a
  // tie: another tab may have saved since this one last did. A marker is of
  // use only while the document holds every change its head names.
  #recall(stored?: CloudMarker) {
    let cloud: CloudMarker | undefined;
    let committed: Uint8Array | undefined;
    for (const marker of [stored, this.#cloud]) {
      if (!marker) continue;
      if (cloud && BigInt(marker.revision) <= BigInt(cloud.revision)) continue;
      const version = marker.head
        ? this.handle.doc.versionAt(marker.head)
        : undefined;
      if (marker.head && !version) continue;
      cloud = marker;
      committed = version;
    }
    this.#cloud = cloud;
    this.#committed = committed;
  }
  // Asks for what the cloud copy holds beyond the marker, or beyond this
  // document when there is no marker to name.
  async #read(signal: AbortSignal) {
    const { id, doc } = this.handle;
    const marker = this.#cloud;
    const since = marker?.head || (doc.head() ?? "");
    const reply = await this.api.changes(
      id,
      marker ? { revision: marker.revision, since } : { since },
      signal,
    );
    this.#alive(signal);
    if (await this.#apply(reply, signal)) return;
    // The answer builds on something this document lacks, so the marker was
    // no guide: forget it and take the complete copy.
    this.#cloud = undefined;
    this.#committed = undefined;
    await this.repository.markCloudVersion(id, undefined);
    this.#alive(signal);
    const complete = await this.api.changes(id, { since: "" }, signal);
    this.#alive(signal);
    if (!(await this.#apply(complete, signal))) throw unavailable();
  }
  // Merges what the cloud answered and takes its version as committed. False
  // when the answer does not fit this document; the marker is then untouched.
  async #apply(reply: CloudSnapshot, signal: AbortSignal) {
    const { id, doc } = this.handle;
    const update = reply.encoding === "loro-update";
    // No head: the cloud copy has not moved since the revision asked about.
    if (update && reply.head === undefined)
      return reply.revision === this.#cloud?.revision;
    // Stays "" for a cloud copy that holds no document yet.
    let head: string | undefined = "";
    let version: Uint8Array | undefined;
    if (update || reply.data) {
      const data = decodeBase64(reply.data);
      try {
        doc.merge(data, ORIGIN.remote);
      } catch (error) {
        if (update) return false;
        throw error;
      }
      head = reply.head;
      version = head === undefined ? undefined : doc.versionAt(head);
      if (!version) {
        if (update) return false;
        ({ version, head } = committedVersion(id, data) ?? {});
      }
    }
    // Before anything is awaited, so an edit made meanwhile is measured
    // against the copy just merged.
    const cloud =
      head === undefined ? undefined : { revision: reply.revision, head };
    this.#cloud = cloud;
    this.#committed = version;
    await this.handle.flush();
    this.#alive(signal);
    await this.handle.refreshMetadata();
    this.#alive(signal);
    await this.repository.markCloudVersion(id, cloud);
    this.#alive(signal);
    return true;
  }
  #connect() {
    if (this.#provider) return this.#provider;
    const provider = this.#options.provider
      ? this.#options.provider(this.handle.id, this.handle.doc)
      : websocketProvider(this.handle.id, this.handle.doc, this.api.ownerId);
    this.#provider = provider;
    // A notification naming the marker's revision brings nothing new: it is
    // the one sent on connect, its periodic repeat, or the echo of this
    // tab's own save.
    provider.on("sync", (_synced, revision) => {
      if (revision === undefined || revision !== this.#cloud?.revision)
        this.#trigger(true);
    });
    provider.on("connection-close", (event) => {
      if (this.destroyed || this.#paused || !event) return;
      if (event.code === 1008)
        this.#pause({
          status: event.reason === "Sign in again" ? "auth" : "blocked",
          message: event.reason,
        });
      // Reconnect through a sync, at most once a second.
      else if (!this.#options.manual)
        void this.api.queryClient.prefetchQuery({
          ...this.#queryOptions(),
          staleTime: 1000,
        });
    });
    return provider;
  }
  destroy() {
    if (this.destroyed) return;
    this.#abort.abort();
    this.handle.doc.off("snapshot", this.#onSnapshot);
    this.#stopSaving();
    this.#provider?.destroy();
    this.#observer.destroy();
    this.api.queryClient.removeQueries({
      queryKey: this.#queryKey,
      exact: true,
    });
  }
}

// Merge discovery into local content. Uninitialized projects never receive a default root.
// `listed` is each cloud project's revision, undefined from an API that does
// not report one. Maps this device already has are left to their own sync,
// except `stalled`, a map whose sync stopped: a cloud copy that has moved since
// is merged into it here.
export async function discoverProjects(
  repository: ProjectRepository,
  api: LoroApi,
  signal: AbortSignal,
  stalled?: string,
) {
  const projects = await api.list(signal);
  const listed = new Map(
    projects.map((project) => [project.projectId, project.revision]),
  );
  const knownProjects = new Map(
    (await repository.list()).map((entry) => [entry.id, entry]),
  );
  // One map that cannot be stored or read must not hold back the others. The
  // first such failure is handed back for the caller to report afterwards.
  let unreadable: unknown;
  for (const project of projects) {
    signal.throwIfAborted();
    const known = knownProjects.get(project.projectId);
    if (
      known &&
      (project.projectId !== stalled ||
        known.saving?.cloud === false ||
        (project.revision !== undefined &&
          project.revision ===
            (await repository.cloudVersion(project.projectId))?.revision))
    )
      continue;
    try {
      const handle = await importCloudProject(
        repository,
        api,
        project.projectId,
        signal,
      );
      await handle.close();
    } catch (error) {
      if (signal.aborted || error instanceof SyncError) throw error;
      unreadable ??= error;
    }
  }
  return { listed, unreadable };
}

// Stores one cloud project locally, marks it registered and leaves it open.
async function importCloudProject(
  repository: ProjectRepository,
  api: LoroApi,
  id: string,
  signal: AbortSignal,
) {
  const snapshot = await api.snapshot(id, signal);
  signal.throwIfAborted();
  const data = decodeBase64(snapshot.data);
  // Inspect cloud preferences before opening any writable local database.
  const handle = await repository.open(id, {
    remember: false,
    initialSnapshot: data,
  });
  try {
    signal.throwIfAborted();
    await handle.flush();
    signal.throwIfAborted();
    await handle.refreshMetadata();
    signal.throwIfAborted();
    await repository.markRegistered(handle.id);
    // The next sync of this map then has nothing to read.
    const head = data.length
      ? (snapshot.head ?? committedVersion(id, data)?.head)
      : "";
    if (head !== undefined)
      await repository.markCloudVersion(handle.id, {
        revision: snapshot.revision,
        head,
      });
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

// A browser without local projects for an account opens the account's most
// recently changed cloud map, so signing in never needs to seed an empty one.
// Projects this device keeps out of the cloud, and claim copies that are not
// registered yet, are skipped.
export async function openLatestCloudProject(
  repository: ProjectRepository,
  api: LoroApi,
  signal: AbortSignal,
): Promise<ProjectHandle | null> {
  const recent = await api.recent(signal);
  signal.throwIfAborted();
  const known = new Map(
    (await repository.list({ includeClaims: true })).map((entry) => [
      entry.id,
      entry,
    ]),
  );
  const latest = recent.find(({ projectId }) => {
    const entry = known.get(projectId);
    return entry?.saving?.cloud !== false && !entry?.claimPending;
  });
  if (!latest) return null;
  const handle = await importCloudProject(
    repository,
    api,
    latest.projectId,
    signal,
  );
  await repository.setLatestProject(handle.id).catch(() => {});
  return handle;
}

const silentProvider = (): SyncProvider => ({
  connect() {},
  disconnect() {},
  destroy() {},
  on() {},
});

// Reconcile inactive local projects too, so navigating away does not strand
// persisted edits. Only the active project keeps a live socket.
export class CloudWorkspace {
  readonly repository: ProjectRepository;
  readonly api: LoroApi;
  readonly #abort = new AbortController();
  readonly #onStatus: (status: CloudStatus | undefined) => void;
  readonly #onCatalog: () => void;
  #active?: ProjectSync;
  #background?: ProjectSync;
  readonly #queryKey: readonly string[];
  readonly #observer: QueryObserver<null, Error, null, null, readonly string[]>;
  readonly #stopQuery: () => void;
  #authPaused = false;

  constructor(
    repository: ProjectRepository,
    onStatus: (status: CloudStatus | undefined) => void,
    onCatalog: () => void,
    api?: LoroApi,
    queryClient?: QueryClient,
  ) {
    this.repository = repository;
    this.api =
      api ??
      new LoroApi(
        undefined,
        undefined,
        Number(repository.scope.namespace.replace("account-", "")),
        queryClient,
      );
    this.#onStatus = onStatus;
    this.#onCatalog = onCatalog;
    this.#queryKey = [
      "cloud-workspace",
      repository.names.catalog,
      crypto.randomUUID(),
    ];
    this.#observer = new QueryObserver(this.api.queryClient, {
      queryKey: this.#queryKey,
      queryFn: () => this.#refresh(),
      networkMode: "online",
      refetchInterval: 30_000,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (_count, error) =>
        !this.#abort.signal.aborted &&
        !(error instanceof SyncError && error.kind === "auth"),
      retryDelay: saveRetryDelay,
      gcTime: 0,
    });
    this.#stopQuery = this.#observer.subscribe(() => {});
  }
  activate(handle: ProjectHandle) {
    if (this.#abort.signal.aborted || this.#authPaused) return;
    this.#active?.destroy();
    this.#onStatus({ status: "saving" });
    this.#active = new ProjectSync(handle, this.repository, {
      api: this.api,
      onStatus: (status) => {
        if (this.#abort.signal.aborted) return;
        if (status.status === "auth") this.#pauseForAuth(status.message);
        else this.#onStatus(status);
      },
    });
  }
  detach() {
    this.#active?.destroy();
    this.#active = undefined;
    this.#onStatus(undefined);
  }
  retry() {
    this.#active?.retry();
    if (this.#authPaused || this.#abort.signal.aborted) return;
    void this.#observer.refetch({ cancelRefetch: false });
  }
  async #refresh(): Promise<null> {
    if (this.#abort.signal.aborted || this.#authPaused) return null;
    const signal = this.#abort.signal;
    try {
      // One unreadable map must not hold back the uploads of the others; it
      // still fails the pass afterwards, so the pass is retried.
      const active = this.#active;
      const discovered = await discoverProjects(
        this.repository,
        this.api,
        signal,
        active?.status.status === "blocked" ? active.handle.id : undefined,
      );
      let { unreadable } = discovered;
      signal.throwIfAborted();
      this.#onCatalog();
      for (const entry of await this.repository.list()) {
        signal.throwIfAborted();
        if (entry.id === this.#active?.handle.id) continue;
        let handle: ProjectHandle;
        try {
          handle = await this.repository.open(entry.id, { remember: false });
        } catch (error) {
          unreadable ??= error;
          continue;
        }
        try {
          signal.throwIfAborted();
          const sync = new ProjectSync(handle, this.repository, {
            api: this.api,
            provider: silentProvider,
            manual: true,
            revision: discovered.listed.get(entry.id),
          });
          this.#background = sync;
          await sync.syncNow();
          signal.throwIfAborted();
          if (sync.status.status === "auth") {
            throw new SyncError(sync.status.message, "auth");
          }
        } finally {
          this.#background?.destroy();
          this.#background = undefined;
          await handle.close();
        }
      }
      if (unreadable) throw unreadable;
    } catch (error) {
      if (signal.aborted) return null;
      if (error instanceof SyncError && error.kind === "auth") {
        this.#pauseForAuth(error.message);
      }
      throw error;
    }
    return null;
  }
  #pauseForAuth(message: string) {
    if (this.#authPaused || this.#abort.signal.aborted) return;
    this.#authPaused = true;
    this.#observer.setOptions({ ...this.#observer.options, enabled: false });
    this.#active?.pauseForAuth(message);
    this.#background?.pauseForAuth(message);
    this.#onStatus({ status: "auth", message });
  }
  destroy() {
    this.#abort.abort();
    this.#stopQuery();
    this.#observer.destroy();
    void this.api.queryClient.cancelQueries({
      queryKey: this.#queryKey,
      exact: true,
    });
    this.api.queryClient.removeQueries({
      queryKey: this.#queryKey,
      exact: true,
    });
    this.#active?.destroy();
    this.#background?.destroy();
  }
}
