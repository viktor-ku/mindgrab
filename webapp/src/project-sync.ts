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
  online?: () => boolean;
  debounceMs?: number;
  retryMs?: number;
  onStatus?: (status: CloudStatus) => void;
}
export class ProjectSync {
  readonly handle: ProjectHandle;
  readonly repository: ProjectRepository;
  readonly api: LoroApi;
  readonly #options: SyncOptions;
  readonly #abort = new AbortController();
  #provider?: SyncProvider;
  #registered = false;
  #registrationChecked = false;
  #deleted = false;
  #registrationStarted = false;
  #snapshot = new Uint8Array();
  #generation = 0;
  #pending?: { bytes: Uint8Array; generation: number };
  #running?: Promise<void>;
  #requested = false;
  #timer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
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
    handle.doc.on("snapshot", this.#onSnapshot);
    globalThis.window?.addEventListener("online", this.#wake);
    globalThis.window?.addEventListener("offline", this.#offline);
    globalThis.document?.addEventListener("visibilitychange", this.#visible);
    this.#schedule(0);
  }
  get status() {
    return this.#status;
  }
  get destroyed() {
    return this.#abort.signal.aborted;
  }
  #online() {
    return this.#options.online?.() ?? globalThis.navigator?.onLine !== false;
  }
  #alive() {
    if (
      this.destroyed ||
      this.#paused ||
      !savingPreferences(this.handle.doc).cloud
    )
      throw new DOMException("Disposed", "AbortError");
  }
  #setStatus(status: CloudStatus) {
    if (!this.destroyed) {
      this.#status = status;
      this.#options.onStatus?.(status);
    }
  }
  #onSnapshot = (_bytes: Uint8Array, origin: unknown) => {
    if (!savingPreferences(this.handle.doc).cloud) {
      this.#provider?.destroy();
      this.#provider = undefined;
      this.#pending = undefined;
      this.#requested = true;
      this.#schedule(0);
      return;
    }
    if (this.#deleted) {
      this.#deleted = false;
      this.#registered = false;
      this.#snapshot = new Uint8Array();
    }
    if (origin === ORIGIN.remote || origin === this.#provider) return;
    this.#generation++;
    if (!this.#paused) {
      this.#setStatus({ status: this.#online() ? "saving" : "offline" });
      this.#schedule(this.#options.debounceMs ?? 250);
    }
  };
  #wake = () => this.retry();
  #offline = () => {
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
  };
  #visible = () => {
    if (globalThis.document?.visibilityState === "visible") this.#wake();
  };
  pauseForAuth(message: string) {
    this.#paused = true;
    this.#authPaused = true;
    clearTimeout(this.#timer);
    this.#provider?.disconnect();
    this.#setStatus({ status: "auth", message });
  }
  retry() {
    if (this.destroyed || this.#authPaused) return;
    this.#paused = false;
    this.#attempt = 0;
    this.#schedule(0);
  }
  #schedule(ms: number) {
    if (this.destroyed || this.#paused) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.syncNow();
    }, ms);
  }
  async syncNow(): Promise<void> {
    if (this.destroyed || this.#paused) return;
    clearTimeout(this.#timer);
    if (!this.#online()) {
      this.#offline();
      return;
    }
    if (this.#running) {
      this.#requested = true;
      return this.#running;
    }
    const work = globalThis.navigator?.locks
      ? navigator.locks.request(
          `${this.repository.names.catalog}/cloud/${this.handle.id}`,
          { signal: this.#abort.signal },
          () => this.#sync(),
        )
      : this.#sync();
    this.#running = work
      .catch((error: unknown) => {
        if (this.destroyed || this.#paused) return;
        if (
          !savingPreferences(this.handle.doc).cloud &&
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          this.#schedule(0);
          return;
        }
        const failure =
          error instanceof SyncError
            ? error
            : new SyncError("Cloud saving is unavailable. Retrying…");
        if (failure.kind !== "retry") {
          this.#paused = true;
          this.#authPaused = failure.kind === "auth";
          this.#provider?.disconnect();
          this.#setStatus({ status: failure.kind, message: failure.message });
        } else {
          this.#setStatus({
            status: "retrying",
            message: !savingPreferences(this.handle.doc).cloud
              ? "Cloud deletion pending. Reconnect to finish deleting the cloud copy."
              : failure.message,
          });
          this.#schedule(
            Math.min(
              30000,
              (this.#options.retryMs ?? 1000) *
                2 ** Math.min(this.#attempt++, 5),
            ),
          );
        }
      })
      .finally(() => {
        this.#running = undefined;
        if (this.#requested) {
          this.#requested = false;
          this.#schedule(this.#options.debounceMs ?? 250);
        }
      });
    return this.#running;
  }
  async #sync() {
    const signal = this.#abort.signal;
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
      this.#alive();
    }
    this.#setStatus({ status: "saving" });
    if (!this.#registered) {
      this.#registrationStarted = true;
      await this.repository.markCloudAttempted(this.handle.id);
      this.#alive();
      await this.api.register(this.handle.id, signal);
      this.#alive();
      await this.repository.markRegistered(this.handle.id);
      this.#alive();
      this.#registered = true;
    }
    const snapshot = await this.api.snapshot(this.handle.id, signal);
    this.#alive();
    this.#snapshot = decodeBase64(snapshot.data);
    this.handle.doc.merge(this.#snapshot, ORIGIN.remote);
    await this.handle.flush();
    this.#alive();
    await this.handle.refreshMetadata();
    this.#alive();
    if (!this.#pending) {
      const bytes = pendingSnapshot(this.handle.doc, this.#snapshot);
      if (bytes) this.#pending = { bytes, generation: this.#generation };
    }
    if (this.#pending) {
      const pending = this.#pending;
      const receipt = await this.api.merge(
        this.handle.id,
        pending.bytes,
        signal,
      );
      this.#alive();
      const bytes = decodeBase64(receipt.data);
      this.handle.doc.merge(bytes, ORIGIN.remote);
      this.#snapshot = bytes;
      this.#pending = undefined;
      await this.handle.flush();
      this.#alive();
      await this.handle.refreshMetadata();
      this.#alive();
    }
    if (!this.#provider) {
      const provider = this.#options.provider
        ? this.#options.provider(this.handle.id, this.handle.doc)
        : websocketProvider(this.handle.id, this.handle.doc, this.api.ownerId);
      this.#provider = provider;
      provider.on("sync", () => {
        if (!this.destroyed) this.#schedule(0);
      });
      provider.on("connection-close", (event) => {
        if (this.destroyed || this.#paused || !event) return;
        if (event.code === 1008) {
          this.#paused = true;
          this.#authPaused = event.reason === "Sign in again";
          this.#setStatus({
            status: this.#authPaused ? "auth" : "blocked",
            message: event.reason,
          });
        } else
          this.#schedule(
            Math.min(30000, 1000 * 2 ** Math.min(this.#attempt++, 5)),
          );
      });
    }
    this.#provider.connect();
    this.#attempt = 0;
    if (pendingSnapshot(this.handle.doc, this.#snapshot)) {
      this.#setStatus({ status: "saving" });
      this.#schedule(this.#options.debounceMs ?? 250);
    } else this.#setStatus({ status: "saved" });
  }
  destroy() {
    if (this.destroyed) return;
    this.#abort.abort();
    clearTimeout(this.#timer);
    this.handle.doc.off("snapshot", this.#onSnapshot);
    this.#provider?.destroy();
    globalThis.window?.removeEventListener("online", this.#wake);
    globalThis.window?.removeEventListener("offline", this.#offline);
    globalThis.document?.removeEventListener("visibilitychange", this.#visible);
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
    const snapshot = await api.snapshot(project.projectId, signal);
    signal.throwIfAborted();
    // Inspect cloud preferences before opening any writable local database.
    const handle = await repository.open(project.projectId, {
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
    } finally {
      await handle.close();
    }
  }
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
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: (_count, error) =>
        !this.#abort.signal.aborted &&
        !(error instanceof SyncError && error.kind === "auth"),
      retryDelay: (attempt) =>
        Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)),
      gcTime: 0,
    });
    this.#stopQuery = this.#observer.subscribe(() => {});
    globalThis.window?.addEventListener("online", this.#wake);
    globalThis.window?.addEventListener("focus", this.#wake);
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
    this.#wake();
  }
  #wake = () => {
    if (this.#authPaused || this.#abort.signal.aborted) return;
    void this.#observer.refetch({ cancelRefetch: false });
  };
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
    globalThis.window?.removeEventListener("online", this.#wake);
    globalThis.window?.removeEventListener("focus", this.#wake);
  }
}
