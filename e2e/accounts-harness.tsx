import { QueryClientProvider } from "@tanstack/solid-query";
import { queryClient } from "../webapp/src/query-client";
import { render } from "solid-js/web";
import type { ProjectDocument } from "../webapp/src/project-document";
import { App } from "../webapp/src/App";
import { AuthSession, authStorageKey } from "../webapp/src/auth-session";
import { claimAnonymousProjects } from "../webapp/src/anonymous-claims";
import {
  ProjectRepository,
  storageNames,
} from "../webapp/src/project-repository";
import * as project from "../webapp/src/project-document";
import { checkGuards } from "../webapp/src/offline-shell";
import "../webapp/src/index.css";

let current: ProjectDocument;
const retired: ProjectDocument[] = [];
const channels = new Set<BroadcastChannel>();
const Channel = window.BroadcastChannel;
window.BroadcastChannel = class extends Channel {
  constructor(name: string) {
    super(name);
    channels.add(this);
  }
  close() {
    channels.delete(this);
    super.close();
  }
};

// HTTP provides actual durable baselines/receipts in this fixture. Hold socket
// connections open so account transitions must explicitly destroy providers.
const sockets = new Set<Socket>();
class Socket {
  static OPEN = 1;
  static CLOSING = 2;
  readonly url: string;
  readyState = 0;
  binaryType = "arraybuffer";
  onopen?: (event: Event) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: Event) => void;
  constructor(url: string) {
    this.url = url;
    sockets.add(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    sockets.delete(this);
    this.onclose?.({ code: 1000, reason: "" });
  }
}
window.WebSocket = Socket as unknown as typeof WebSocket;

// Everything this page has told the user, including what cleared itself again
// before a test could look.
const messages = new Set<string>();
new MutationObserver(() => {
  for (const element of document.querySelectorAll(
    '[data-storage-message], .notice, [role="alert"]',
  )) {
    const text = element.textContent?.trim();
    if (text) messages.add(text);
  }
}).observe(document, { subtree: true, childList: true, characterData: true });

let writesFail = false;
let failedProject = "";
let authWritesFail = false;
let authDatabaseFail = false;
for (const method of ["add", "put"] as const) {
  const original = IDBObjectStore.prototype[method];
  IDBObjectStore.prototype[method] = function (
    ...args: [unknown, IDBValidKey?]
  ) {
    const request = original.apply(this, args);
    if (authDatabaseFail && this.name === "records")
      request.addEventListener("success", () => this.transaction.abort());
    if (
      writesFail &&
      this.name === "snapshots" &&
      this.transaction.db.name === failedProject &&
      (args[0] as Uint8Array).byteLength > 2
    )
      queueMicrotask(() =>
        request.addEventListener("success", () => this.transaction.abort()),
      );
    return request;
  };
}
const store = Storage.prototype.setItem;
Storage.prototype.setItem = function (key: string, value: string) {
  if (authWritesFail && key.endsWith("/auth"))
    throw new DOMException("Full", "QuotaExceededError");
  store.call(this, key, value);
};

// Project database opens can be held or failed from the page's first open:
// the mode survives a reload in sessionStorage, so a cold load shows the
// placeholder for as long as the test wants.
const OPEN_MODE_KEY = "accountHarness/open";
const OPEN_ONLY_KEY = "accountHarness/open-only";
let openMode = sessionStorage.getItem(OPEN_MODE_KEY);
// With an id, only that project's database is held.
let openOnly = sessionStorage.getItem(OPEN_ONLY_KEY) ?? "";
const heldOpens: (() => void)[] = [];
class GatedOpenRequest {
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
  real?: IDBOpenDBRequest;
  failure?: DOMException;
  get result() {
    return this.real?.result;
  }
  get error() {
    return this.real?.error ?? this.failure ?? null;
  }
  get transaction() {
    return this.real?.transaction ?? null;
  }
  get readyState() {
    return this.real?.readyState ?? "pending";
  }
}
const openDatabase = IDBFactory.prototype.open;
IDBFactory.prototype.open = function (name: string, version?: number) {
  if (
    !openMode ||
    !name.includes("/project/") ||
    (openOnly && !name.endsWith(`/project/${openOnly}`))
  )
    return openDatabase.call(this, name, version);
  const proxy = new GatedOpenRequest();
  const start = () => {
    if (openMode === "fail") {
      proxy.failure = new DOMException("Storage is gated.", "UnknownError");
      queueMicrotask(() => proxy.onerror?.(new Event("error")));
      return;
    }
    const real = openDatabase.call(this, name, version);
    proxy.real = real;
    real.onsuccess = (event) => proxy.onsuccess?.(event);
    real.onerror = (event) => proxy.onerror?.(event);
    real.onblocked = (event) => proxy.onblocked?.(event);
    real.onupgradeneeded = (event) => proxy.onupgradeneeded?.(event);
  };
  if (openMode === "hold") heldOpens.push(start);
  else start();
  return proxy as unknown as IDBOpenDBRequest;
};
function setOpenMode(mode: "hold" | "fail" | null, only = "") {
  openMode = mode;
  openOnly = only;
  if (mode) sessionStorage.setItem(OPEN_MODE_KEY, mode);
  else sessionStorage.removeItem(OPEN_MODE_KEY);
  if (only) sessionStorage.setItem(OPEN_ONLY_KEY, only);
  else sessionStorage.removeItem(OPEN_ONLY_KEY);
  if (mode === "hold") return;
  for (const start of heldOpens.splice(0)) start();
}

async function repository(namespace: string) {
  return new ProjectRepository({ deployment: location.origin, namespace });
}
const accountHarness = {
  project,
  content: () => current.view(),
  id: () => current.id,
  channels: () => [...channels].map((channel) => channel.name),
  sockets: () => [...sockets].map((socket) => socket.url),
  failWrites(value: boolean) {
    writesFail = value;
    if (value) {
      const hint = JSON.parse(
        localStorage.getItem(authStorageKey(location.origin)) ?? "{}",
      );
      failedProject = storageNames({
        deployment: location.origin,
        namespace: hint.user ? `account-${hint.user.id}` : "anonymous",
      }).project(current.id);
    }
  },
  failProjectWrites(namespace: string, id: string) {
    writesFail = true;
    failedProject = storageNames({
      deployment: location.origin,
      namespace,
    }).project(id);
  },
  messages() {
    return [...messages];
  },
  // What Update now would report after saving on the person's behalf.
  updateRisks() {
    return checkGuards();
  },
  failAuthWrites(value: boolean) {
    authWritesFail = value;
  },
  failAuthDatabase(value: boolean) {
    authDatabaseFail = value;
  },
  openGate(value: boolean, only = "") {
    setOpenMode(value ? "hold" : null, only);
  },
  failOpen(value: boolean, only = "") {
    setOpenMode(value ? "fail" : null, only);
  },
  editRetired(id: string) {
    const doc = retired.find((doc) => doc.id === id);
    if (!doc) throw new Error("Missing retired document");
    const root = doc.view().roots[0];
    project.replaceNodeText(doc, root, "Late old account update");
    return doc.observerCount;
  },
  // Every later read of this map fails, as it would with a damaged database.
  async corrupt(namespace: string, id: string) {
    const repo = await repository(namespace);
    const name = repo.names.project(id);
    await repo.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["snapshots"], "readwrite");
      tx.objectStore("snapshots").add(new Uint8Array([1, 2, 3, 4, 5]));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  },
  // A complete marker over an edit it never heard of: a tab killed between
  // saving a keystroke and flagging it.
  async killedAfterEdit(id: string, ownerId: number, text: string) {
    const repo = await repository("anonymous");
    const entry = (await repo.list({ includeClaims: true })).find(
      (entry) => entry.id === id,
    );
    const claim = entry?.claim;
    if (!claim?.version) throw new Error("No complete claim");
    const handle = await repo.open(id, { remember: false });
    project.replaceNodeText(handle.doc, handle.doc.view().roots[0], text);
    await handle.flush();
    await handle.refreshMetadata();
    await handle.close();
    await repo.completeClaim(id, ownerId, claim.targetId, claim.version);
    await repo.close();
  },
  async texts(namespace: string, id: string) {
    const repo = await repository(namespace);
    const handle = await repo.open(id, { remember: false });
    try {
      return handle.doc.view().nodes.map((node) => node.text);
    } finally {
      await handle.close();
      await repo.close();
    }
  },
  async catalog(namespace: string, includeClaims = false) {
    const repo = await repository(namespace);
    try {
      return await repo.list({ includeClaims });
    } finally {
      await repo.close();
    }
  },
  async bytes(namespace: string, id: string) {
    const repo = await repository(namespace);
    const handle = await repo.open(id, { remember: false });
    try {
      return [...handle.doc.snapshot()];
    } finally {
      await handle.close();
      await repo.close();
    }
  },
  // Claims preserve the complete Loro history under the destination account.
  // The signed-in app claims anonymous maps on its own as soon as it sees
  // them, so the edits are made under the claim lock, before anyone can copy.
  async historyClaim(ownerId: number) {
    const source = await repository("anonymous");
    const destination = await repository(`account-${ownerId}`);
    const id = crypto.randomUUID();
    let handle!: Awaited<ReturnType<ProjectRepository["create"]>>;
    let replica!: ProjectDocument;
    await navigator.locks.request(
      `${source.names.catalog}/claim/${id}`,
      async () => {
        handle = await source.create({
          id,
          name: "Loro history",
          root: { text: "Root" },
        });
        const root = handle.doc.view().roots[0];
        replica = project.openProjectDocument(id, [handle.doc.snapshot()]);
        project.editNodeText(replica, root, 0, 0, "Missing ");
        project.editNodeText(replica, root, 3, 0, "dependent ");
        handle.doc.merge(replica.snapshot());
        await handle.flush();
      },
    );
    const before = [...handle.doc.snapshot()];
    await claimAnonymousProjects(
      source,
      destination,
      ownerId,
      new AbortController().signal,
    );
    const marker = (await source.list({ includeClaims: true })).find(
      (entry) => entry.id === id,
    )?.claim;
    if (marker?.phase !== "complete" || marker.targetId !== id)
      throw new Error("Claim did not preserve its UUID");
    const target = await destination.open(id, { remember: false });
    const after = [...target.doc.snapshot()];
    const equal = target.doc.version() === handle.doc.version();
    await target.close();
    await handle.close();
    await source.close();
    await destination.close();
    replica.destroy();
    return { before, after, equal };
  },
  async logoutElsewhere() {
    const auth = new AuthSession(location.origin);
    auth.start();
    await auth.prepareNavigation("logout");
    auth.destroy();
  },
};
export type AccountHarness = typeof accountHarness;
declare global {
  interface Window {
    accountHarness: AccountHarness;
  }
}
window.accountHarness = accountHarness;
render(
  () => (
    <QueryClientProvider client={queryClient}>
      <App
        onDocument={(doc) => {
          if (current) retired.push(current);
          current = doc;
        }}
      />
    </QueryClientProvider>
  ),
  document.getElementById("root") as HTMLElement,
);
