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
let openMode = sessionStorage.getItem(OPEN_MODE_KEY);
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
  if (!openMode || !name.includes("/project/"))
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
function setOpenMode(mode: "hold" | "fail" | null) {
  openMode = mode;
  if (mode) sessionStorage.setItem(OPEN_MODE_KEY, mode);
  else sessionStorage.removeItem(OPEN_MODE_KEY);
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
  failAuthWrites(value: boolean) {
    authWritesFail = value;
  },
  failAuthDatabase(value: boolean) {
    authDatabaseFail = value;
  },
  openGate(value: boolean) {
    setOpenMode(value ? "hold" : null);
  },
  failOpen(value: boolean) {
    setOpenMode(value ? "fail" : null);
  },
  editRetired(id: string) {
    const doc = retired.find((doc) => doc.id === id);
    if (!doc) throw new Error("Missing retired document");
    const root = doc.view().roots[0];
    project.replaceNodeText(doc, root, "Late old account update");
    return doc.observerCount;
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
