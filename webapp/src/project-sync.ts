import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { backendEndpoint } from "./backend";
import { CrdtApi, decodeBase64, SyncError } from "./crdt-api";
import { ORIGIN, readProject } from "./project-document";
import { updateBatches } from "./update-batches";
import type { ProjectHandle, ProjectRepository } from "./project-repository";

export type CloudStatus =
  | { status: "saving" | "saved" | "offline" }
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

export function websocketProvider(
  id: string,
  doc: Y.Doc,
  ownerId?: number,
): SyncProvider {
  const url = new URL(backendEndpoint("/sync/v1"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const provider = new WebsocketProvider(url.href, id, doc, {
    connect: false,
    // The repository relay is scoped by deployment/account/UUID, even offline.
    // y-websocket's URL-only BroadcastChannel would cross account namespaces.
    disableBc: true,
    maxBackoffTime: 30_000,
    shouldReconnect: () => false,
    params: ownerId ? { ownerId: String(ownerId) } : {},
  });
  provider.awareness.setLocalState(null);
  return provider;
}

// Vectors omit deletes. Compare deletion intervals with the committed baseline.
export function missingUpdate(doc: Y.Doc, committed: Uint8Array) {
  const update = Y.encodeStateAsUpdate(
    doc,
    Y.encodeStateVectorFromUpdate(committed),
  );
  const candidate = Y.decodeUpdate(update);
  if (candidate.structs.some((struct) => !(struct instanceof Y.Skip)))
    return update;
  const known = Y.decodeUpdate(committed).ds.clients;
  for (const [client, ranges] of candidate.ds.clients) {
    const covered = known.get(client) ?? [];
    for (const range of ranges) {
      let clock = range.clock;
      for (const interval of covered) {
        if (interval.clock > clock) break;
        clock = Math.max(clock, interval.clock + interval.len);
        if (clock >= range.clock + range.len) break;
      }
      if (clock < range.clock + range.len) return update;
    }
  }
  return undefined;
}

export interface SyncOptions {
  api?: CrdtApi;
  provider?: (id: string, doc: Y.Doc) => SyncProvider;
  online?: () => boolean;
  debounceMs?: number;
  retryMs?: number;
  onStatus?: (status: CloudStatus) => void;
}
interface Batch {
  id: string;
  bytes: Uint8Array;
  generation: number;
}

// One hydrated document and one account/project lifetime per controller.
export class ProjectSync {
  readonly handle: ProjectHandle;
  readonly repository: ProjectRepository;
  readonly api: CrdtApi;
  readonly #options: SyncOptions;
  readonly #abort = new AbortController();
  #provider?: SyncProvider;
  #registered = false;
  #needsBaseline = true;
  #baseline: Uint8Array = new Uint8Array([0, 0]);
  #generation = 0;
  #acknowledged = -1;
  #batches: Batch[] = [];
  #running?: Promise<void>;
  #requested = false;
  #timer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  #connectionAttempt = 0;
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
    this.api =
      options.api ??
      new CrdtApi(
        undefined,
        undefined,
        Number(repository.scope.namespace.replace("account-", "")),
      );
    this.#options = options;
    handle.doc.on("update", this.#onUpdate);
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
    if (this.destroyed || this.#paused)
      throw new DOMException("Disposed", "AbortError");
  }
  #setStatus(status: CloudStatus) {
    if (this.destroyed) return;
    this.#status = status;
    this.#options.onStatus?.(status);
  }
  #onUpdate = (_bytes: Uint8Array, origin: unknown) => {
    if (origin === ORIGIN.remote || origin === this.#provider) return;
    this.#generation++;
    if (this.#paused) return;
    this.#setStatus({ status: this.#online() ? "saving" : "offline" });
    this.#schedule(this.#options.debounceMs ?? 250);
  };
  #wake = () => {
    this.#needsBaseline = true;
    this.retry();
  };
  #offline = () => {
    this.#provider?.disconnect();
    this.#setStatus({ status: "offline" });
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
    if (this.destroyed) return;
    if (this.#authPaused) return;
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
    this.#timer = undefined;
    if (!this.#online()) {
      this.#offline();
      return;
    }
    if (this.#running) {
      this.#requested = true;
      return this.#running;
    }
    this.#running = this.#sync()
      .catch((error: unknown) => {
        if (this.destroyed || this.#paused) return;
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
          this.#setStatus(
            this.#online()
              ? { status: "retrying", message: failure.message }
              : { status: "offline" },
          );
          this.#needsBaseline = true;
          this.#schedule(
            Math.min(
              30_000,
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
    this.#setStatus({ status: "saving" });
    if (!this.#registered) {
      await this.api.register(this.handle.id, signal);
      this.#alive();
      await this.handle.flush();
      this.#alive();
      await this.handle.refreshMetadata();
      this.#alive();
      await this.repository.markRegistered(this.handle.id);
      this.#alive();
      this.#registered = true;
    }
    if (this.#needsBaseline) {
      const baseline = await this.api.baseline(this.handle.id, signal);
      this.#alive();
      const bytes = decodeBase64(baseline.data);
      Y.applyUpdate(this.handle.doc, bytes, ORIGIN.remote);
      await this.handle.flush();
      this.#alive();
      await this.handle.refreshMetadata();
      this.#alive();
      await this.repository.markRegistered(this.handle.id);
      this.#alive();
      this.#baseline = bytes;
      this.#needsBaseline = false;
    }
    const state = readProject(this.handle.doc);
    if (state.status === "invalid" || state.status === "unsupported")
      throw new SyncError(
        "This project needs a compatible app or recovery before cloud saving.",
        "blocked",
      );
    if (!this.#batches.length) {
      const bytes = missingUpdate(this.handle.doc, this.#baseline);
      if (bytes) {
        const generation = this.#generation;
        this.#batches = updateBatches(bytes).map((bytes) => ({
          id: crypto.randomUUID(),
          bytes,
          generation,
        }));
      } else this.#acknowledged = this.#generation;
    }
    if (this.#batches.length) {
      await this.handle.flush();
      this.#alive();
      while (this.#batches.length) {
        const batch = this.#batches[0];
        const receipt = await this.api.submit(
          this.handle.id,
          batch.id,
          batch.bytes,
          signal,
        );
        this.#alive();
        if (receipt.validation === "quarantined")
          throw new SyncError(
            "Cloud content needs recovery. Your local work is retained.",
            "blocked",
          );
        this.#baseline = Y.mergeUpdates([this.#baseline, batch.bytes]);
        this.#batches.shift();
        if (!this.#batches.length) this.#acknowledged = batch.generation;
      }
    }
    if (!this.#provider) {
      const provider = this.#options.provider
        ? this.#options.provider(this.handle.id, this.handle.doc)
        : websocketProvider(this.handle.id, this.handle.doc, this.api.ownerId);
      this.#provider = provider;
      provider.on("sync", (synced) => {
        // Socket sync is a wakeup, never a durability acknowledgement.
        if (synced && !this.destroyed) {
          this.#connectionAttempt = 0;
          this.#schedule(0);
        }
      });
      provider.on("connection-close", (event) => {
        if (this.destroyed || this.#paused || !event) return;
        this.#needsBaseline = true;
        if (event.code === 1008 || event.code === 1009) {
          this.#paused = true;
          this.#authPaused = event.reason === "Sign in again";
          this.#setStatus(
            event.reason === "Sign in again"
              ? {
                  status: "auth",
                  message: "Sign in again to resume cloud saving.",
                }
              : {
                  status: "blocked",
                  message:
                    "Cloud sync needs attention. Your local work is retained.",
                },
          );
          return;
        }
        this.#schedule(
          Math.min(30_000, 1000 * 2 ** Math.min(this.#connectionAttempt++, 5)),
        );
      });
    }
    this.#provider.connect();
    const status = await this.api.status(this.handle.id, signal);
    this.#alive();
    if (status.validation === "quarantined")
      throw new SyncError(
        "Cloud content needs recovery. Your local work is retained.",
        "blocked",
      );
    if (status.validation !== "valid") {
      this.#needsBaseline = true;
      throw new SyncError("Waiting for complete cloud content. Retrying…");
    }
    this.#attempt = 0;
    if (this.#generation !== this.#acknowledged) {
      this.#setStatus({ status: "saving" });
      this.#schedule(this.#options.debounceMs ?? 250);
    } else this.#setStatus({ status: "saved" });
  }
  // Fence immediately, before any asynchronous handle/repository cleanup.
  destroy() {
    if (this.destroyed) return;
    this.#abort.abort();
    clearTimeout(this.#timer);
    this.handle.doc.off("update", this.#onUpdate);
    this.#provider?.destroy();
    globalThis.window?.removeEventListener("online", this.#wake);
    globalThis.window?.removeEventListener("offline", this.#offline);
    globalThis.document?.removeEventListener("visibilitychange", this.#visible);
  }
}

// Merge discovery into local content. Empty UUIDs never receive a default root.
export async function discoverProjects(
  repository: ProjectRepository,
  api: CrdtApi,
  signal: AbortSignal,
) {
  const projects = await api.list(signal);
  for (const project of projects) {
    signal.throwIfAborted();
    const handle = await repository.open(project.projectId, {
      remember: false,
    });
    try {
      const baseline = await api.baseline(project.projectId, signal);
      signal.throwIfAborted();
      Y.applyUpdate(handle.doc, decodeBase64(baseline.data), ORIGIN.remote);
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
  readonly api: CrdtApi;
  readonly #abort = new AbortController();
  readonly #onStatus: (status: CloudStatus | undefined) => void;
  readonly #onCatalog: () => void;
  #active?: ProjectSync;
  #background?: ProjectSync;
  #running = false;
  #timer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  #authPaused = false;

  constructor(
    repository: ProjectRepository,
    onStatus: (status: CloudStatus | undefined) => void,
    onCatalog: () => void,
    api = new CrdtApi(
      undefined,
      undefined,
      Number(repository.scope.namespace.replace("account-", "")),
    ),
  ) {
    this.repository = repository;
    this.api = api;
    this.#onStatus = onStatus;
    this.#onCatalog = onCatalog;
    globalThis.window?.addEventListener("online", this.#wake);
    globalThis.window?.addEventListener("focus", this.#wake);
    this.#schedule(0);
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
    if (this.#authPaused) return;
    this.#attempt = 0;
    this.#schedule(0);
  };
  #schedule(ms: number) {
    if (this.#abort.signal.aborted || this.#authPaused) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#refresh(), ms);
  }
  async #refresh() {
    if (this.#running || this.#abort.signal.aborted) return;
    this.#running = true;
    let delay = 30_000;
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
      this.#attempt = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof SyncError && error.kind === "auth") {
        this.#pauseForAuth(error.message);
      }
      delay = Math.min(30_000, 1000 * 2 ** Math.min(this.#attempt++, 5));
    } finally {
      this.#running = false;
      this.#schedule(delay);
    }
  }
  #pauseForAuth(message: string) {
    if (this.#authPaused || this.#abort.signal.aborted) return;
    this.#authPaused = true;
    clearTimeout(this.#timer);
    this.#active?.pauseForAuth(message);
    this.#background?.pauseForAuth(message);
    this.#onStatus({ status: "auth", message });
  }
  destroy() {
    this.#abort.abort();
    clearTimeout(this.#timer);
    this.#active?.destroy();
    this.#background?.destroy();
    globalThis.window?.removeEventListener("online", this.#wake);
    globalThis.window?.removeEventListener("focus", this.#wake);
  }
}
