import { IndexeddbPersistence, PREFERRED_TRIM_SIZE } from "y-indexeddb";
import * as Y from "yjs";
import {
  createProjectDocument,
  importProjectDocument,
  isNodeId,
  ORIGIN,
  openProjectDocument,
  projectName,
  readProject,
} from "./project-document";
import type { NewNode, ProjectContent, ProjectState } from "./project-document";

// Lifecycle and guarantees: docs/architecture/0002-local-project-repository.md.
export const STORAGE_GENERATION = 1;
export const ANONYMOUS_NAMESPACE = "anonymous";
export const accountNamespace = (userId: number | string) =>
  `account-${userId}`;

const CATALOG_VERSION = 1;
const UPDATES = "updates";
const PROJECTS = "projects";
const PREFERENCES = "preferences";
const LATEST_PROJECT = "latestProject";
const pendingImportKey = (id: string) => `pendingImport/${id}`;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const TRIM_DELAY_MS = 1000;

export interface RepositoryScope {
  // Separates backends that share one browser origin, e.g. local and staging.
  deployment: string;
  // ANONYMOUS_NAMESPACE or accountNamespace(userId).
  namespace: string;
  generation?: number;
}

export function storageNames(scope: RepositoryScope) {
  const { deployment, namespace, generation = STORAGE_GENERATION } = scope;
  if (!deployment || !namespace || !Number.isSafeInteger(generation))
    throw new Error("Invalid storage scope.");
  const base = `mindgrab/${encodeURIComponent(deployment)}/${encodeURIComponent(namespace)}/g${generation}`;
  const projectPrefix = `${base}/project/`;
  return {
    catalog: `${base}/catalog`,
    projectPrefix,
    project: (id: string) => projectPrefix + id,
  };
}

export type StorageFailure =
  | "unavailable"
  | "quota"
  | "blocked"
  | "open"
  | "versionchange"
  | "closed"
  | "aborted";

const MESSAGES: Record<StorageFailure, string> = {
  unavailable: "Browser storage is unavailable.",
  quota: "Browser storage is full.",
  blocked: "Browser storage did not open in time.",
  open: "Browser storage could not be opened.",
  versionchange: "Browser storage was upgraded or reset by another tab.",
  closed: "The browser closed the storage connection.",
  aborted: "The browser did not commit the change.",
};

export class StorageError extends Error {
  readonly reason: StorageFailure;

  constructor(reason: StorageFailure, cause?: unknown) {
    super(MESSAGES[reason], { cause });
    this.name = "StorageError";
    this.reason = reason;
  }
}

export class ProjectExistsError extends Error {
  readonly id: string;

  constructor(id: string) {
    super("This project ID already has local content.");
    this.name = "ProjectExistsError";
    this.id = id;
  }
}

function storageError(error: unknown, fallback: StorageFailure) {
  if (error instanceof StorageError) return error;
  const name = (error as { name?: unknown } | null | undefined)?.name;
  const reason: StorageFailure =
    name === "QuotaExceededError"
      ? "quota"
      : name === "InvalidStateError"
        ? "closed"
        : name === "VersionError"
          ? "versionchange"
          : name === "SecurityError"
            ? "unavailable"
            : fallback;
  return new StorageError(reason, error);
}

function factory(): IDBFactory {
  try {
    if (globalThis.indexedDB) return globalThis.indexedDB;
  } catch (error) {
    throw storageError(error, "unavailable");
  }
  throw new StorageError("unavailable");
}

function deleteDatabase(name: string, timeoutMs: number): Promise<void> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const deletion = factory().deleteDatabase(name);
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(storageError(deletion.error, "aborted"));
    }),
    timeoutMs,
  );
}

async function persistImportedSeed(
  name: string,
  seed: Y.Doc,
  timeoutMs: number,
) {
  let created = false;
  const db = await openDatabase(name, timeoutMs, (db) => {
    created = true;
    // The y-indexeddb database layout; hydration starts only after this commit.
    db.createObjectStore(UPDATES, { autoIncrement: true });
    db.createObjectStore("custom");
  });
  if (!db) throw new StorageError("open");
  try {
    if (!created) throw new ProjectExistsError(seed.guid);
    const tx = db.transaction([UPDATES], "readwrite");
    const done = committed(tx);
    try {
      tx.objectStore(UPDATES).add(Y.encodeStateAsUpdate(seed));
    } catch (error) {
      tx.abort();
      await done.catch(() => {});
      throw storageError(error, "aborted");
    }
    await done;
  } finally {
    db.close();
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(storageError(req.error, "aborted"));
  });
}

// Request success precedes commit; only `complete` means the data is durable.
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(storageError(tx.error, "aborted"));
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StorageError("blocked")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Without `upgrade`, resolves undefined instead of creating a missing database.
function openDatabase(
  name: string,
  timeoutMs: number,
  upgrade?: (db: IDBDatabase) => void,
  version?: number,
): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    let open: IDBOpenDBRequest;
    try {
      open = factory().open(name, version);
    } catch (error) {
      reject(storageError(error, "unavailable"));
      return;
    }
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      finish();
      return true;
    };
    const timer = setTimeout(
      () => settle(() => reject(new StorageError("blocked"))),
      timeoutMs,
    );
    open.onupgradeneeded = () => {
      if (upgrade) upgrade(open.result);
      else open.transaction?.abort();
    };
    open.onerror = () => {
      if (!upgrade && open.error?.name === "AbortError")
        settle(() => resolve(undefined));
      else settle(() => reject(storageError(open.error, "open")));
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      if (!settle(() => resolve(db))) db.close();
    };
  });
}

// Reads a project without creating, hydrating, or writing its database.
async function readStoredName(name: string, id: string, timeoutMs: number) {
  const db = await openDatabase(name, timeoutMs);
  if (!db) return;
  try {
    if (!db.objectStoreNames.contains(UPDATES)) return;
    const tx = db.transaction([UPDATES], "readonly");
    const updates = await request(tx.objectStore(UPDATES).getAll());
    const doc = openProjectDocument(id, updates);
    const state = readProject(doc);
    doc.destroy();
    return state.status === "ready" ? state.content.metadata.name : undefined;
  } catch {
    return;
  } finally {
    db.close();
  }
}

export interface CatalogEntry {
  id: string;
  name: string;
  createdAt: string;
  // Whether the backend has acknowledged this project's UUID.
  registration: "pending" | "registered";
  // Anonymous source markers bind a one-time claim to one account.
  claim?: { ownerId: number; targetId: string; phase: "pending" | "complete" };
  // A copied target cannot sync or appear in Load before registration succeeds.
  claimPending?: boolean;
  claimSource?: string;
}

class Catalog {
  readonly name: string;
  readonly timeoutMs: number;
  #connection?: Promise<IDBDatabase>;

  constructor(name: string, timeoutMs: number) {
    this.name = name;
    this.timeoutMs = timeoutMs;
  }

  #open() {
    const forget = () => {
      if (this.#connection === connection) this.#connection = undefined;
    };
    const connection = openDatabase(
      this.name,
      this.timeoutMs,
      (db) => {
        db.createObjectStore(PROJECTS, { keyPath: "id" });
        db.createObjectStore(PREFERENCES);
      },
      CATALOG_VERSION,
    ).then((db) => {
      const open = db as IDBDatabase;
      open.onversionchange = () => {
        open.close();
        forget();
      };
      open.onclose = forget;
      return open;
    });
    connection.catch(forget);
    this.#connection = connection;
    return connection;
  }

  // Reopens once when another tab's upgrade or the browser closed the connection.
  async #transaction(store: string, mode: IDBTransactionMode) {
    for (let attempt = 0; ; attempt++) {
      const db = await (this.#connection ?? this.#open());
      try {
        return db.transaction([store], mode).objectStore(store);
      } catch (error) {
        this.#connection = undefined;
        if (attempt) throw storageError(error, "closed");
      }
    }
  }

  async get(id: string): Promise<CatalogEntry | undefined> {
    return request((await this.#transaction(PROJECTS, "readonly")).get(id));
  }

  async all(): Promise<CatalogEntry[]> {
    return request((await this.#transaction(PROJECTS, "readonly")).getAll());
  }

  // `change` runs inside the transaction; returning its argument skips the write.
  async update(
    id: string,
    change: (entry: CatalogEntry | undefined) => CatalogEntry | undefined,
  ) {
    const store = await this.#transaction(PROJECTS, "readwrite");
    const done = committed(store.transaction);
    let result: CatalogEntry | undefined;
    let written = false;
    const read = store.get(id);
    read.onsuccess = () => {
      result = change(read.result);
      if (result && result !== read.result) {
        store.put(result);
        written = true;
      }
    };
    await done;
    return { entry: result, written };
  }

  async preference(key: string): Promise<unknown> {
    return request((await this.#transaction(PREFERENCES, "readonly")).get(key));
  }

  async setPreference(key: string, value: unknown) {
    const store = await this.#transaction(PREFERENCES, "readwrite");
    if (value === undefined) store.delete(key);
    else store.put(value, key);
    await committed(store.transaction);
  }

  async remove(id: string) {
    const store = await this.#transaction(PROJECTS, "readwrite");
    store.delete(id);
    await committed(store.transaction);
  }

  close() {
    this.#connection?.then((db) => db.close()).catch(() => {});
    this.#connection = undefined;
  }
}

export type Durability =
  | { status: "saved" }
  | { status: "saving" }
  | { status: "unsaved"; error: StorageError };

type RelayMessage =
  | { type: "sync"; stateVector: Uint8Array; reply?: boolean }
  | { type: "update"; update: Uint8Array };

// One live document per project per tab, shared by every handle opened on it.
class ProjectSession {
  readonly id: string;
  readonly dbName: string;
  readonly timeoutMs: number;
  readonly onChange: (session: ProjectSession) => void;
  readonly doc: Y.Doc;
  metadata: Promise<void> = Promise.resolve();
  catalogName?: string;
  registered = false;
  #persistence?: IndexeddbPersistence;
  #disconnected = false;
  #channel?: BroadcastChannel;
  #pending = new Set<Promise<void>>();
  #failure?: StorageError;
  #fullChain: Promise<void> = Promise.resolve();
  #queuedFull?: Promise<void>;
  #trimTimer?: ReturnType<typeof setTimeout>;
  #listeners = new Set<(durability: Durability) => void>();
  #last: Durability = { status: "saved" };
  #closing?: Promise<Durability>;

  constructor(
    id: string,
    dbName: string,
    timeoutMs: number,
    onChange: (session: ProjectSession) => void,
  ) {
    this.id = id;
    this.dbName = dbName;
    this.timeoutMs = timeoutMs;
    this.onChange = onChange;
    this.doc = openProjectDocument(id);
  }

  async hydrate() {
    try {
      await this.#connect();
    } catch (error) {
      this.doc.destroy();
      throw error;
    }
    this.doc.on("update", this.#onUpdate);
    this.#openChannel();
    this.onChange(this);
  }

  // y-indexeddb hydrates and owns the database layout; writes are tracked here
  // because its own handler reports neither commits nor failures.
  async #connect() {
    factory();
    const persistence = new IndexeddbPersistence(this.dbName, this.doc);
    this.doc.off("update", persistence._storeUpdate);
    persistence._storeUpdate = () => {};
    this.#persistence = persistence;
    this.#disconnected = false;
    const opened = persistence._db.then((db) => {
      const lost = () => {
        if (this.#persistence === persistence) this.#disconnected = true;
      };
      db.onversionchange = () => {
        db.close();
        lost();
      };
      db.onclose = lost;
    });
    try {
      await withTimeout(
        Promise.all([opened, persistence.whenSynced]),
        this.timeoutMs,
      );
    } catch (error) {
      persistence.destroy().catch(() => {});
      throw storageError(error, "open");
    }
  }

  #onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== this.#persistence) {
      if (origin !== this.#channel)
        this.#channel?.postMessage({ type: "update", update });
      this.#persist(update);
    }
    this.onChange(this);
  };

  #persist(update: Uint8Array) {
    const persistence = this.#persistence as IndexeddbPersistence;
    if (this.#failure || this.#disconnected || !persistence.db) {
      this.#requestFull().catch(() => {});
      return;
    }
    try {
      const tx = persistence.db.transaction([UPDATES], "readwrite");
      tx.objectStore(UPDATES).add(update);
      this.#track(committed(tx));
    } catch (error) {
      this.#disconnected = true;
      this.#track(Promise.reject(storageError(error, "closed")));
      return;
    }
    if (++persistence._dbsize >= PREFERRED_TRIM_SIZE) this.#scheduleTrim();
  }

  #track(write: Promise<void>, full = false) {
    this.#pending.add(write);
    this.#notify();
    write
      .then(
        () => {
          if (full) this.#failure = undefined;
        },
        (error) => {
          this.#failure = storageError(error, "aborted");
        },
      )
      .finally(() => {
        this.#pending.delete(write);
        this.#notify();
      });
  }

  // A full-state write covers every earlier failed or missing update. At most
  // one waits behind the running one, since it encodes state when it starts.
  #requestFull(): Promise<void> {
    if (this.#queuedFull) return this.#queuedFull;
    const write = this.#fullChain.then(() => {
      this.#queuedFull = undefined;
      return this.#writeFull();
    });
    this.#queuedFull = write;
    this.#fullChain = write.catch(() => {});
    this.#track(write, true);
    return write;
  }

  // Same-store readwrite transactions run in creation order, so everything
  // stored before this one is merged into the snapshot that replaces it.
  async #writeFull() {
    if (this.#disconnected || !this.#persistence?.db) {
      await this.#persistence?.destroy().catch(() => {});
      await this.#connect();
    }
    const persistence = this.#persistence as IndexeddbPersistence;
    const tx = (persistence.db as IDBDatabase).transaction(
      [UPDATES],
      "readwrite",
    );
    const done = committed(tx);
    const store = tx.objectStore(UPDATES);
    let key = persistence._dbref - 1;
    const read = store.getAll(IDBKeyRange.lowerBound(persistence._dbref));
    read.onsuccess = () => {
      Y.transact(
        this.doc,
        () => {
          for (const update of read.result) Y.applyUpdate(this.doc, update);
        },
        persistence,
        false,
      );
      const add = store.add(Y.encodeStateAsUpdate(this.doc));
      add.onsuccess = () => {
        key = add.result as number;
        store.delete(IDBKeyRange.upperBound(key, true));
      };
    };
    await done;
    persistence._dbref = key + 1;
    persistence._dbsize = 1;
  }

  #scheduleTrim() {
    clearTimeout(this.#trimTimer);
    this.#trimTimer = setTimeout(() => {
      this.#trimTimer = undefined;
      this.#requestFull().catch(() => {});
    }, TRIM_DELAY_MS);
  }

  // Cross-tab relay for the same project; each tab also persists what it receives.
  #openChannel() {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(this.dbName);
    const post = (message: RelayMessage) => channel.postMessage(message);
    channel.onmessage = ({ data }: MessageEvent<RelayMessage>) => {
      try {
        if (data.type === "update")
          Y.applyUpdate(this.doc, data.update, channel);
        else if (data.type === "sync") {
          post({
            type: "update",
            update: Y.encodeStateAsUpdate(this.doc, data.stateVector),
          });
          if (!data.reply)
            post({
              type: "sync",
              stateVector: Y.encodeStateVector(this.doc),
              reply: true,
            });
        }
        if (this.doc.store.pendingStructs || this.doc.store.pendingDs)
          this.#requestFull().catch(() => {});
      } catch {
        // A malformed message from another tab must not break this document.
      }
    };
    this.#channel = channel;
    post({ type: "sync", stateVector: Y.encodeStateVector(this.doc) });
  }

  durability(): Durability {
    if (this.#failure) return { status: "unsaved", error: this.#failure };
    return { status: this.#pending.size ? "saving" : "saved" };
  }

  #notify() {
    const next = this.durability();
    const error = (d: Durability) => (d.status === "unsaved" ? d.error : null);
    if (next.status === this.#last.status && error(next) === error(this.#last))
      return;
    this.#last = next;
    for (const listener of this.#listeners) listener(next);
  }

  subscribe(listener: (durability: Durability) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async settled() {
    while (this.#pending.size) await Promise.allSettled(this.#pending);
  }

  async flush() {
    // Yjs update events omit unresolved structs/delete sets. Preserve those
    // bytes explicitly before closing, claiming or acknowledging a baseline.
    if (
      this.#failure ||
      this.doc.store.pendingStructs ||
      this.doc.store.pendingDs
    )
      await this.#requestFull();
    await this.settled();
    if (this.#failure) throw this.#failure;
  }

  close() {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<Durability> {
    this.detachRelay();
    await this.flush().catch(() => {});
    await this.metadata;
    clearTimeout(this.#trimTimer);
    this.doc.off("update", this.#onUpdate);
    this.#listeners.clear();
    const result = this.durability();
    await this.#persistence?.destroy().catch(() => {});
    this.doc.destroy();
    return result;
  }

  detachRelay() {
    this.#channel?.close();
    this.#channel = undefined;
  }

  resumeRelay() {
    if (!this.#closing && !this.#channel) this.#openChannel();
  }
}

export interface ProjectHandle {
  readonly id: string;
  // Hydrated; edit it with the project-document commands.
  readonly doc: Y.Doc;
  // "loading" after hydration means no content has arrived for this UUID yet.
  state(): ProjectState;
  durability(): Durability;
  onDurability(listener: (durability: Durability) => void): () => void;
  // Resolves once every change so far is committed; retries after failures.
  flush(): Promise<void>;
  refreshMetadata(): Promise<void>;
  close(): Promise<Durability>;
}

class Handle implements ProjectHandle {
  readonly session: ProjectSession;
  readonly release: () => Promise<Durability>;
  readonly refresh: () => Promise<void>;
  #closed?: Promise<Durability>;
  #subscriptions = new Set<() => void>();

  constructor(
    session: ProjectSession,
    release: () => Promise<Durability>,
    refresh: () => Promise<void>,
  ) {
    this.session = session;
    this.release = release;
    this.refresh = refresh;
  }

  get id() {
    return this.session.id;
  }

  get doc() {
    return this.session.doc;
  }

  #assertOpen() {
    if (this.#closed) throw new Error("This project handle is closed.");
  }

  state() {
    return readProject(this.doc);
  }

  durability() {
    return this.session.durability();
  }

  onDurability(listener: (durability: Durability) => void) {
    this.#assertOpen();
    const unsubscribe = this.session.subscribe(listener);
    const remove = () => {
      unsubscribe();
      this.#subscriptions.delete(remove);
    };
    this.#subscriptions.add(remove);
    return remove;
  }

  flush() {
    this.#assertOpen();
    return this.session.flush();
  }

  refreshMetadata() {
    this.#assertOpen();
    return this.refresh();
  }

  close() {
    this.#closed ??= (() => {
      for (const remove of this.#subscriptions) remove();
      return this.release();
    })();
    return this.#closed;
  }
}

export interface RepositoryOptions extends RepositoryScope {
  openTimeoutMs?: number;
}

export interface NewProject {
  id?: string;
  name: string;
  root?: NewNode;
}

const byName = (a: CatalogEntry, b: CatalogEntry) =>
  a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface SessionRecord {
  refs: number;
  session: Promise<ProjectSession>;
}

// Project documents are the source of truth; the catalog is a rebuildable index.
export class ProjectRepository {
  readonly names: ReturnType<typeof storageNames>;
  readonly scope: RepositoryScope;
  readonly #timeoutMs: number;
  readonly #catalog: Catalog;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #listeners = new Set<() => void>();
  readonly #pendingImports = new Set<string>();
  readonly #channel?: BroadcastChannel;
  #closed = false;
  #detached = false;
  #relaysPaused = false;

  constructor(options: RepositoryOptions) {
    this.scope = options;
    this.names = storageNames(options);
    this.#timeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.#catalog = new Catalog(this.names.catalog, this.#timeoutMs);
    if (typeof BroadcastChannel !== "undefined") {
      this.#channel = new BroadcastChannel(this.names.catalog);
      this.#channel.onmessage = () => this.#emit();
    }
  }

  // Seeds only an explicitly new UUID, and registers it after the seed commits.
  async create({ id = crypto.randomUUID(), name, root }: NewProject) {
    const seed = createProjectDocument(id, name, root);
    return this.#createFromSeed(id, seed);
  }

  // Imports complete validated content as one update under a fresh project UUID.
  async importContent(content: ProjectContent) {
    const id = crypto.randomUUID();
    const seed = importProjectDocument(id, content);
    return this.#createFromSeed(id, seed, true);
  }

  async #createFromSeed(id: string, seed: Y.Doc, importing = false) {
    if (importing) this.#pendingImports.add(id);
    let handle: ProjectHandle | undefined;
    try {
      if (importing) {
        // Other tabs must not discover a durable seed before its catalog commit.
        await this.#catalog.setPreference(pendingImportKey(id), true);
        await persistImportedSeed(
          this.names.project(id),
          seed,
          this.#timeoutMs,
        );
      }
      handle = await this.#acquire(id);
      if (!importing) {
        const { store } = handle.doc;
        if (store.clients.size || store.pendingStructs || store.pendingDs)
          throw new ProjectExistsError(id);
        Y.applyUpdate(handle.doc, Y.encodeStateAsUpdate(seed), ORIGIN.create);
      }
      await handle.flush();
      await handle.refreshMetadata();
      if (importing)
        await this.#catalog
          .setPreference(pendingImportKey(id), undefined)
          .catch(() => {});
      else await this.setLatestProject(id).catch(() => {});
      return handle;
    } catch (error) {
      await handle?.close();
      if (importing && !(error instanceof ProjectExistsError)) {
        // Remove durable seed data as well, so catalog recovery cannot surface
        // an import whose catalog transaction failed.
        await this.#catalog.remove(id).catch(() => {});
        await deleteDatabase(this.names.project(id), this.#timeoutMs)
          .then(() =>
            this.#catalog.setPreference(pendingImportKey(id), undefined),
          )
          .catch(() => {});
      } else if (importing) {
        await this.#catalog
          .setPreference(pendingImportKey(id), undefined)
          .catch(() => {});
      }
      throw importing && !(error instanceof ProjectExistsError)
        ? storageError(error, "aborted")
        : error;
    } finally {
      seed.destroy();
      this.#pendingImports.delete(id);
    }
  }

  // Resolves after hydration. Never seeds: an empty document stays "loading".
  async open(id: string, { remember = true } = {}) {
    const handle = await this.#acquire(id);
    if (remember) await this.setLatestProject(id).catch(() => {});
    return handle;
  }

  // Also registers stored documents whose catalog write was interrupted.
  async list({ includeClaims = false } = {}): Promise<CatalogEntry[]> {
    this.#assertOpen();
    const stored = await this.#storedProjects();
    const entries = new Map(
      (await this.#catalog.all()).map((entry) => [entry.id, entry]),
    );
    for (const id of stored ?? [])
      if (!entries.has(id)) {
        const entry = await this.#recover(id).catch(() => undefined);
        if (entry) entries.set(id, entry);
      }
    return [...entries.values()]
      .filter((entry) => !stored || stored.has(entry.id))
      .filter((entry) => includeClaims || (!entry.claim && !entry.claimPending))
      .sort(byName);
  }

  async latestProject(): Promise<string | undefined> {
    this.#assertOpen();
    const id = await this.#catalog.preference(LATEST_PROJECT);
    if (typeof id !== "string" || !isNodeId(id)) return;
    const entry = await this.#catalog.get(id);
    if (entry) return !entry.claim && !entry.claimPending ? id : undefined;
    return (await this.#recover(id))?.id;
  }

  setLatestProject(id: string) {
    this.#assertOpen();
    return this.#catalog.setPreference(LATEST_PROJECT, id);
  }

  // Device-local values, e.g. `project/<uuid>/view`; never project content.
  preference(key: string) {
    this.#assertOpen();
    return this.#catalog.preference(`local/${key}`);
  }

  setPreference(key: string, value: unknown) {
    this.#assertOpen();
    return this.#catalog.setPreference(`local/${key}`, value);
  }

  async markRegistered(id: string) {
    this.#assertOpen();
    const { written } = await this.#catalog.update(id, (entry) =>
      entry && entry.registration !== "registered"
        ? { ...entry, registration: "registered" }
        : entry,
    );
    if (written) this.#announce();
  }

  // Catalog transactions serialize these markers across tabs. The UUID is
  // chosen before copying, so an interrupted/retried claim reuses its target.
  async beginClaim(id: string, ownerId: number) {
    this.#assertOpen();
    const { entry, written } = await this.#catalog.update(id, (entry) =>
      entry && !entry.claim
        ? { ...entry, claim: { ownerId, targetId: id, phase: "pending" } }
        : entry,
    );
    if (written) this.#announce();
    return entry?.claim;
  }

  async rerouteClaim(id: string, ownerId: number, targetId: string) {
    this.#assertOpen();
    const { entry, written } = await this.#catalog.update(id, (entry) =>
      entry?.claim?.ownerId === ownerId && entry.claim.targetId === targetId
        ? { ...entry, claim: { ...entry.claim, targetId: crypto.randomUUID() } }
        : entry,
    );
    if (written) this.#announce();
    return entry?.claim;
  }

  async reserveClaim(id: string, name: string, source: string) {
    this.#assertOpen();
    const { entry, written } = await this.#catalog.update(
      id,
      (entry) =>
        entry ?? {
          id,
          name,
          createdAt: new Date().toISOString(),
          registration: "pending",
          claimPending: true,
          claimSource: source,
        },
    );
    if (written) this.#announce();
    return entry?.claimSource === source;
  }

  async releaseClaim(id: string) {
    this.#assertOpen();
    const { written } = await this.#catalog.update(id, (entry) =>
      entry?.claimPending ? { ...entry, claimPending: false } : entry,
    );
    if (written) this.#announce();
  }

  async completeClaim(id: string, ownerId: number, targetId: string) {
    this.#assertOpen();
    const { written } = await this.#catalog.update(id, (entry) =>
      entry?.claim?.ownerId === ownerId && entry.claim.targetId === targetId
        ? { ...entry, claim: { ...entry.claim, phase: "complete" } }
        : entry,
    );
    if (written) this.#announce();
  }

  // Fires for catalog changes made in this or another tab.
  onCatalogChange(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Closes this tab's connections only; stored data and other tabs are untouched.
  async close() {
    if (this.#closed) return;
    this.detach();
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(
      sessions.map(({ session }) => session.then((open) => open.close())),
    );
    this.#catalog.close();
  }

  // Fence channels/listeners immediately; a failed flush can keep the document
  // in memory for recovery without exposing it in the next workspace.
  detach() {
    this.#detached = true;
    this.#channel?.close();
    this.#listeners.clear();
    for (const { session } of this.#sessions.values())
      void session.then((open) => open.detachRelay()).catch(() => {});
  }

  setRelaysPaused(paused: boolean) {
    if (this.#detached || this.#closed) return;
    this.#relaysPaused = paused;
    for (const { session } of this.#sessions.values())
      void session
        .then((open) => {
          if (this.#detached || this.#relaysPaused) open.detachRelay();
          else open.resumeRelay();
        })
        .catch(() => {});
  }

  #assertOpen() {
    if (this.#closed || this.#detached)
      throw new Error("The project repository is closed.");
  }

  async #acquire(id: string): Promise<ProjectHandle> {
    this.#assertOpen();
    let record = this.#sessions.get(id);
    if (!record) {
      const session = new ProjectSession(
        id,
        this.names.project(id),
        this.#timeoutMs,
        (changed) => this.#metadataChanged(changed),
      );
      const created: SessionRecord = {
        refs: 0,
        session: session.hydrate().then(() => session),
      };
      created.session.catch(() => {
        if (this.#sessions.get(id) === created) this.#sessions.delete(id);
      });
      this.#sessions.set(id, created);
      record = created;
    }
    record.refs++;
    const current = record;
    const session = await current.session.catch((error) => {
      current.refs--;
      throw error;
    });
    if (this.#detached || this.#relaysPaused) session.detachRelay();
    return new Handle(
      session,
      () => this.#release(id, current, session),
      () => this.#queueRefresh(session),
    );
  }

  async #release(id: string, record: SessionRecord, session: ProjectSession) {
    if (--record.refs > 0) return session.durability();
    if (this.#sessions.get(id) === record) this.#sessions.delete(id);
    return session.close();
  }

  #metadataChanged(session: ProjectSession) {
    if (this.#pendingImports.has(session.id)) return;
    const name = projectName(session.doc);
    if (name === undefined) return;
    if (session.registered && name === session.catalogName) return;
    this.#queueRefresh(session).catch(() => {});
  }

  #queueRefresh(session: ProjectSession) {
    const refresh = session.metadata.then(() => this.#refresh(session));
    session.metadata = refresh.catch(() => {});
    return refresh;
  }

  // Waits for document commits, so the index never points at unsaved content.
  async #refresh(session: ProjectSession) {
    await session.settled();
    if (session.durability().status === "unsaved") return;
    const name = projectName(session.doc);
    if (name === undefined) return;
    const ready =
      session.registered || readProject(session.doc).status === "ready";
    const { entry, written } = await this.#catalog.update(
      session.id,
      (entry) => {
        if (entry) return entry.name === name ? entry : { ...entry, name };
        if (!ready) return;
        return {
          id: session.id,
          name,
          createdAt: new Date().toISOString(),
          registration: "pending",
        };
      },
    );
    if (entry) {
      session.registered = true;
      session.catalogName = entry.name;
    }
    if (written) this.#announce();
  }

  async #storedProjects() {
    const idb = factory();
    if (typeof idb.databases !== "function") return;
    const { projectPrefix } = this.names;
    const ids = new Set<string>();
    for (const { name } of await idb.databases()) {
      const id = name?.startsWith(projectPrefix)
        ? name.slice(projectPrefix.length)
        : "";
      if (isNodeId(id)) ids.add(id);
    }
    return ids;
  }

  async #recover(id: string) {
    if (
      this.#pendingImports.has(id) ||
      (await this.#catalog.preference(pendingImportKey(id)))
    )
      return;
    const name = await readStoredName(
      this.names.project(id),
      id,
      this.#timeoutMs,
    );
    if (name === undefined) return;
    const { entry, written } = await this.#catalog.update(
      id,
      (entry) =>
        entry ?? {
          id,
          name,
          createdAt: new Date().toISOString(),
          registration: "pending",
        },
    );
    if (written) this.#announce();
    return entry;
  }

  #announce() {
    this.#channel?.postMessage("catalog");
    this.#emit();
  }

  #emit() {
    if (this.#detached || this.#closed) return;
    for (const listener of this.#listeners) listener();
  }
}
