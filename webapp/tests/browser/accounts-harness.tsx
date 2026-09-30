import { render } from "solid-js/web";
import * as Y from "yjs";
import { App } from "../../src/App";
import { AuthSession, authStorageKey } from "../../src/auth-session";
import { claimAnonymousProjects } from "../../src/anonymous-claims";
import { ProjectRepository, storageNames } from "../../src/project-repository";
import * as project from "../../src/project-document";
import "../../src/index.css";

let current: Y.Doc;
const retired: Y.Doc[] = [];
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
      this.name === "updates" &&
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

async function repository(namespace: string) {
  return new ProjectRepository({ deployment: location.origin, namespace });
}
const accountHarness = {
  project,
  Y,
  content: () => project.materializeProject(current),
  id: () => current.guid,
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
      }).project(current.guid);
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
  editRetired(id: string) {
    const doc = retired.find((doc) => doc.guid === id);
    if (!doc) throw new Error("Missing retired document");
    const root = Object.keys(project.materializeProject(doc).nodes)[0];
    project.replaceNodeText(doc, root, "Late old account update");
    return (doc.getMap("project") as unknown as { _dEH: { l: unknown[] } })._dEH
      .l.length;
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
      return [...Y.encodeStateAsUpdate(handle.doc)];
    } finally {
      await handle.close();
      await repo.close();
    }
  },
  // Direct repository fixture creates a causal gap that visible JSON cannot
  // preserve, then exercises the same claim service the production UI uses.
  async pendingClaim(ownerId: number) {
    const source = await repository("anonymous");
    const destination = await repository(`account-${ownerId}`);
    const handle = await source.create({
      name: "Causal gap",
      root: { text: "Root" },
    });
    const id = handle.id;
    const root = Object.keys(project.materializeProject(handle.doc).nodes)[0];
    const replica = project.openProjectDocument(id, [
      Y.encodeStateAsUpdate(handle.doc),
    ]);
    project.editNodeText(replica, root, 0, 0, "Missing ");
    const vector = Y.encodeStateVector(replica);
    project.editNodeText(replica, root, 3, 0, "dependent ");
    Y.applyUpdate(handle.doc, Y.encodeStateAsUpdate(replica, vector));
    await handle.flush();
    const before = [...Y.encodeStateAsUpdate(handle.doc)];
    const ids = await claimAnonymousProjects(
      source,
      destination,
      ownerId,
      new AbortController().signal,
    );
    if (!ids.includes(id)) throw new Error("Claim did not preserve its UUID");
    const target = await destination.open(id, { remember: false });
    const after = [...Y.encodeStateAsUpdate(target.doc)];
    const pending = target.doc.store.pendingStructs !== null;
    await target.close();
    await handle.close();
    await source.close();
    await destination.close();
    replica.destroy();
    return { before, after, pending };
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
    <App
      onDocument={(doc) => {
        if (current) retired.push(current);
        current = doc;
      }}
    />
  ),
  document.getElementById("root") as HTMLElement,
);
