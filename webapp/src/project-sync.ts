import { QueryObserver } from "@tanstack/solid-query";
import type { QueryClient } from "@tanstack/solid-query";
import { backendEndpoint } from "./backend";
import { LoroApi, decodeBase64, SyncError } from "./loro-api";
import {
  ORIGIN,
  openProjectDocument,
  savingPreferences,
} from "./project-document";
import type { ProjectDocument } from "./project-document";
import type { ProjectHandle, ProjectRepository } from "./project-repository";

export type CloudStatus =
  | { status: "saving" | "saved" | "offline" | "disabled" | "deleting" }
  | { status: "retrying" | "auth" | "blocked"; message: string };
export interface SyncProvider {
  connect(): void;
  disconnect(): void;
  destroy(): void;
  on(name: "sync", listener: (synced: boolean) => void): void;
  on(
    name: "connection-close",
    listener: (event: CloseEvent | null) => void,
  ): void;
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
  const listeners = new Map<string, (event: never) => void>();
  return {
    connect() {
      if (destroyed || (socket && socket.readyState < WebSocket.CLOSING))
        return;
      const url = new URL(backendEndpoint(`/sync/loro/${id}`));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ownerId", String(ownerId));
      const current = new WebSocket(url);
      socket = current;
      current.onmessage = () => {
        if (socket === current) listeners.get("sync")?.(true as never);
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
    on(name: string, listener: (event: never) => void) {
      listeners.set(name, listener);
    },
  };
}
export function pendingSnapshot(doc: ProjectDocument, committed: Uint8Array) {
  if (!doc.ready) return undefined;
  if (!committed.length) return doc.snapshot();
  const remote = openProjectDocument(doc.id, [committed]);
  try {
    return remote.version() === doc.version() ? undefined : doc.snapshot();
  } finally {
    remote.destroy();
  }
}
export interface SyncOptions {
  api?: LoroApi;
  provider?: (id: string, doc: ProjectDocument) => SyncProvider;
  // Syncs only on syncNow(): no retries, polling or focus/reconnect refetches.
  manual?: boolean;
  onStatus?: (status: CloudStatus) => void;
}
const retryDelay = (attempt: number) =>
  Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
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
  #snapshot = new Uint8Array();
  // A sent snapshot whose acknowledgement may be lost is resent unchanged.
  #pending?: Uint8Array;
  #paused = false;
  #authPaused = false;
  #status: CloudStatus = { status: "saving" };
  constructor(
    handle: ProjectHandle,
    repository: ProjectRepository,
    options: SyncOptions = {},
  ) {
    this.handle = handle;
    this.repository = repository;
    this.#options = options;
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
      retryDelay,
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
    if (this.#paused || !savingPreferences(this.handle.doc).cloud)
      throw fenced();
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
    if (!savingPreferences(this.handle.doc).cloud) {
      this.#provider?.destroy();
      this.#provider = undefined;
      this.#pending = undefined;
      this.#trigger(true);
      return;
    }
    if (this.#deleted) {
      this.#deleted = false;
      this.#registered = false;
      this.#snapshot = new Uint8Array();
    }
    if (origin === ORIGIN.remote || origin === this.#provider || this.#paused)
      return;
    this.#setStatus({ status: "saving" });
    this.#trigger(false);
  };
  #offline() {
    this.#provider?.disconnect();
    this.#setStatus(
      savingPreferences(this.handle.doc).cloud
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
        !savingPreferences(this.handle.doc).cloud &&
        error instanceof DOMException &&
        error.name === "AbortError"
      )
        return this.#run(signal);
      const failure =
        error instanceof SyncError
          ? error
          : new SyncError("Cloud saving is unavailable. Retrying…");
      if (failure.kind !== "retry") {
        this.#pause({ status: failure.kind, message: failure.message });
        return null;
      }
      this.#setStatus({
        status: "retrying",
        message: !savingPreferences(this.handle.doc).cloud
          ? "Cloud deletion pending. Reconnect to finish deleting the cloud copy."
          : failure.message,
      });
      throw failure;
    }
    return null;
  }
  async #sync(signal: AbortSignal) {
    if (!savingPreferences(this.handle.doc).cloud) {
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
        this.#snapshot = new Uint8Array();
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
    // Pulling a remote change is not saving: only registration or an upload
    // shows "saving", so socket notifications don't flash it.
    if (
      !this.#registered ||
      this.#pending ||
      pendingSnapshot(this.handle.doc, this.#snapshot)
    )
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
    const snapshot = await this.api.snapshot(this.handle.id, signal);
    this.#alive(signal);
    await this.#apply(decodeBase64(snapshot.data), signal);
    // Edits made during an upload are uploaded by the same run.
    for (;;) {
      this.#pending ??= pendingSnapshot(this.handle.doc, this.#snapshot);
      if (!this.#pending) break;
      this.#setStatus({ status: "saving" });
      const receipt = await this.api.merge(
        this.handle.id,
        this.#pending,
        signal,
      );
      this.#alive(signal);
      this.#pending = undefined;
      await this.#apply(decodeBase64(receipt.data), signal);
    }
    this.#connect().connect();
    this.#setStatus({ status: "saved" });
  }
  async #apply(committed: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    this.handle.doc.merge(committed, ORIGIN.remote);
    this.#snapshot = committed;
    await this.handle.flush();
    this.#alive(signal);
    await this.handle.refreshMetadata();
    this.#alive(signal);
  }
  #connect() {
    if (this.#provider) return this.#provider;
    const provider = this.#options.provider
      ? this.#options.provider(this.handle.id, this.handle.doc)
      : websocketProvider(this.handle.id, this.handle.doc, this.api.ownerId);
    this.#provider = provider;
    provider.on("sync", () => this.#trigger(true));
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
    this.#provider?.destroy();
    this.#observer.destroy();
    this.api.queryClient.removeQueries({
      queryKey: this.#queryKey,
      exact: true,
    });
  }
}

// Merge discovery into local content. Uninitialized projects never receive a default root.
export async function discoverProjects(
  repository: ProjectRepository,
  api: LoroApi,
  signal: AbortSignal,
) {
  const projects = await api.list(signal);
  const knownProjects = new Map(
    (await repository.list()).map((entry) => [entry.id, entry]),
  );
  for (const project of projects) {
    signal.throwIfAborted();
    const known = knownProjects.get(project.projectId);
    if (known?.saving?.cloud === false) continue;
    const handle = await importCloudProject(
      repository,
      api,
      project.projectId,
      signal,
    );
    await handle.close();
  }
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
  // Inspect cloud preferences before opening any writable local database.
  const handle = await repository.open(id, {
    remember: false,
    initialSnapshot: decodeBase64(snapshot.data),
  });
  try {
    signal.throwIfAborted();
    await handle.flush();
    signal.throwIfAborted();
    await handle.refreshMetadata();
    signal.throwIfAborted();
    await repository.markRegistered(handle.id);
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
      retryDelay,
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
      await discoverProjects(this.repository, this.api, signal);
      signal.throwIfAborted();
      this.#onCatalog();
      for (const entry of await this.repository.list()) {
        signal.throwIfAborted();
        if (entry.id === this.#active?.handle.id) continue;
        const handle = await this.repository.open(entry.id, {
          remember: false,
        });
        try {
          signal.throwIfAborted();
          const sync = new ProjectSync(handle, this.repository, {
            api: this.api,
            provider: silentProvider,
            manual: true,
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
