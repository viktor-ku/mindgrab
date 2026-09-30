// Browser-side helpers for project-repository.test.ts; bundled per test run.
import * as Y from "yjs";
import * as project from "../../src/project-document";
import * as storage from "../../src/project-repository";
import * as files from "../../src/project-import-export";

// Open IndexedDB connections by database name, for leak checks.
const connections = new Map<string, number>();
const count = (name: string, delta: number) => {
  const next = (connections.get(name) ?? 0) + delta;
  if (next) connections.set(name, next);
  else connections.delete(name);
};
const open = IDBFactory.prototype.open;
IDBFactory.prototype.open = function (...args) {
  const request = open.apply(this, args);
  request.addEventListener("success", () => {
    const db = request.result;
    const close = db.close;
    let closed = false;
    count(db.name, 1);
    db.close = function () {
      if (!closed) count(db.name, -1);
      closed = true;
      close.call(this);
    };
  });
  return request;
};

const channels = new Set<BroadcastChannel>();
const Channel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = class extends Channel {
  constructor(name: string) {
    super(name);
    channels.add(this);
  }
  close() {
    channels.delete(this);
    super.close();
  }
};

// Aborts matching write transactions after their requests succeed, which is
// exactly the case y-indexeddb reports as stored. The listener is added late so
// the code under test sees success first, as it would before a failed commit.
const faults: { database: string; store: string }[] = [];
for (const method of ["add", "put"] as const) {
  const original = IDBObjectStore.prototype[method];
  IDBObjectStore.prototype[method] = function (
    this: IDBObjectStore,
    ...args: [unknown, IDBValidKey?]
  ) {
    const request = original.apply(this, args);
    const { transaction } = this;
    if (
      faults.some(
        (fault) =>
          transaction.db.name.includes(fault.database) &&
          this.name === fault.store,
      )
    )
      queueMicrotask(() =>
        request.addEventListener("success", () => transaction.abort()),
      );
    return request;
  };
}

const harness = {
  Y,
  project,
  storage,
  files,
  repo: undefined as unknown as storage.ProjectRepository,
  open(scope: Partial<storage.RepositoryOptions> = {}) {
    harness.repo = new storage.ProjectRepository({
      deployment: "test",
      namespace: storage.ANONYMOUS_NAMESPACE,
      ...scope,
    });
    return harness.repo;
  },
  failWrites(database: string, store: string) {
    faults.push({ database, store });
  },
  clearFaults() {
    faults.length = 0;
  },
  connections: () => Object.fromEntries(connections),
  channels: () => [...channels].map((channel) => channel.name).sort(),
  observers: (doc: Y.Doc) =>
    Object.fromEntries(
      [...doc._observers].map(([name, set]) => [name, set.size]),
    ),
  content: (handle: storage.ProjectHandle) =>
    project.materializeProject(handle.doc),
  liveNodes: (handle: storage.ProjectHandle) =>
    Object.values(project.materializeProject(handle.doc).nodes).filter(
      (node) => !node.deleted,
    ).length,
  until(handle: storage.ProjectHandle, status: storage.Durability["status"]) {
    return new Promise<storage.Durability>((resolve) => {
      if (handle.durability().status === status)
        return resolve(handle.durability());
      const off = handle.onDurability((durability) => {
        if (durability.status !== status) return;
        off();
        resolve(durability);
      });
    });
  },
  // Random text defeats compression so quota tests really need the space.
  noise(length: number) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return new TextDecoder().decode(bytes.map((byte) => 97 + (byte % 26)));
  },
};

export type Harness = typeof harness;
Object.assign(globalThis, { mg: harness });
