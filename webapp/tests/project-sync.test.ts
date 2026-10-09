import { afterEach, expect, test } from "bun:test";
import { LoroApi, SyncError } from "../src/loro-api";
import {
  createProjectDocument,
  editNodeText,
  openProjectDocument,
  setSavingPreferences,
} from "../src/project-document";
import type { ProjectDocument } from "../src/project-document";
import type {
  ProjectHandle,
  ProjectRepository,
} from "../src/project-repository";
import { pendingSnapshot, ProjectSync } from "../src/project-sync";
const controllers: ProjectSync[] = [];
const docs: ProjectDocument[] = [];
afterEach(() => {
  for (const sync of controllers.splice(0)) sync.destroy();
  for (const doc of docs.splice(0)) doc.destroy();
});
const keep = (doc: ProjectDocument) => {
  docs.push(doc);
  return doc;
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Server extends LoroApi {
  doc: ProjectDocument;
  merges: Uint8Array[] = [];
  registrations = 0;
  deletions = 0;
  lost = false;
  auth = true;
  deleteFails = false;
  registerGate?: Promise<void>;
  snapshotGate?: Promise<void>;
  mergeGate?: Promise<void>;
  constructor(id: string) {
    super();
    this.doc = keep(openProjectDocument(id));
  }
  result() {
    return {
      projectId: this.doc.id,
      revision: String(this.merges.length),
      encoding: "loro-snapshot" as const,
      data: Buffer.from(this.doc.snapshot()).toString("base64"),
      durable: true as const,
    };
  }
  override async register(id: string) {
    await this.registerGate;
    if (!this.auth) throw new SyncError("Sign in again.", "auth");
    this.registrations++;
    return {
      projectId: id,
      schemaVersion: 1 as const,
      format: "mindgrab-loro-v1" as const,
      name: null,
    };
  }
  override async snapshot() {
    await this.snapshotGate;
    return this.result();
  }
  override async merge(_id: string, bytes: Uint8Array) {
    this.merges.push(bytes.slice());
    this.doc.merge(bytes);
    await this.mergeGate;
    if (this.lost) {
      this.lost = false;
      throw new Error("Lost response");
    }
    return this.result();
  }
  override async remove() {
    if (this.deleteFails) throw new SyncError("Unavailable");
    this.deletions++;
    this.doc = keep(openProjectDocument(this.doc.id));
  }
}
function attach(doc: ProjectDocument, server: Server) {
  let attempted = false;
  let registered = false;
  let closed = false;
  const handle = {
    id: doc.id,
    doc,
    flush: async () => {},
    refreshMetadata: async () => {},
  } as ProjectHandle;
  const repo = {
    scope: { namespace: "account-1" },
    names: { catalog: `test/${doc.id}` },
    isRegistered: async () => registered,
    cloudAttempted: async () => attempted,
    markCloudAttempted: async () => {
      attempted = true;
    },
    markRegistered: async () => {
      registered = true;
    },
    markUnregistered: async () => {
      attempted = false;
      registered = false;
    },
  } as unknown as ProjectRepository;
  const sync = new ProjectSync(handle, repo, {
    api: server,
    online: () => true,
    debounceMs: 60000,
    retryMs: 60000,
    provider: () => ({
      connect() {},
      disconnect() {},
      destroy() {
        closed = true;
      },
      on() {},
    }),
  });
  controllers.push(sync);
  return { sync, closed: () => closed };
}
function fixture() {
  const doc = keep(
    createProjectDocument(crypto.randomUUID(), "Planning", {
      text: "Shared 🌲",
    }),
  );
  const root = doc.view().roots[0];
  const server = new Server(doc.id);
  return { doc, root, server, ...attach(doc, server) };
}

test("lost acknowledgements retry the same snapshot while later edits remain unsent", async () => {
  const { doc, root, server, sync } = fixture();
  server.lost = true;
  await sync.syncNow();
  expect(sync.status.status).toBe("retrying");
  editNodeText(doc, root, 0, 0, "Later ");
  await sync.syncNow();
  expect(server.merges[1]).toEqual(server.merges[0]);
  expect(sync.status.status).toBe("saving");
  await sync.syncNow();
  expect(sync.status.status).toBe("saved");
  expect(server.doc.view()).toEqual(doc.view());
});
test("edits received during an in-flight merge cannot be acknowledged prematurely", async () => {
  const { doc, root, server, sync } = fixture();
  const pending = gate();
  server.mergeGate = pending.promise;
  const running = sync.syncNow();
  while (!server.merges.length) await Bun.sleep(1);
  editNodeText(doc, root, 0, 0, "During upload ");
  pending.resolve();
  await running;
  expect(sync.status.status).toBe("saving");
  await sync.syncNow();
  expect(sync.status.status).toBe("saved");
  expect(server.doc.view()).toEqual(doc.view());
});
test("reload recovery includes pure deletions and duplicate histories produce no extra upload", async () => {
  const { doc, root, server, sync } = fixture();
  await sync.syncNow();
  sync.destroy();
  editNodeText(doc, root, 0, 6, "");
  const reopened = keep(openProjectDocument(doc.id, [doc.snapshot()]));
  const next = attach(reopened, server).sync;
  await next.syncNow();
  expect(server.doc.view().nodes[0].text).toBe(" 🌲");
  expect(pendingSnapshot(reopened, server.doc.snapshot())).toBeUndefined();
  const count = server.merges.length;
  await next.syncNow();
  expect(server.merges).toHaveLength(count);
});
test("destroy fences a delayed snapshot and removes the previous connection", async () => {
  const { doc, root, server, sync, closed } = fixture();
  await sync.syncNow();
  editNodeText(server.doc, root, 0, 0, "Remote ");
  const pending = gate();
  server.snapshotGate = pending.promise;
  const running = sync.syncNow();
  sync.destroy();
  pending.resolve();
  await running;
  expect(doc.view().nodes[0].text).toBe("Shared 🌲");
  expect(closed()).toBe(true);
});
test("authentication failures pause cloud activity without removing local work", async () => {
  const { doc, server, sync } = fixture();
  server.auth = false;
  await sync.syncNow();
  expect(sync.status.status).toBe("auth");
  server.auth = true;
  sync.retry();
  await sync.syncNow();
  expect(server.merges).toHaveLength(0);
  expect(doc.view().nodes[0].text).toBe("Shared 🌲");
});
test("private projects never register or upload, including manual retry", async () => {
  const { doc, root, server, sync } = fixture();
  setSavingPreferences(doc, { local: false, cloud: false });
  await sync.syncNow();
  editNodeText(doc, root, 0, 0, "Private ");
  sync.retry();
  await sync.syncNow();
  expect(server.registrations).toBe(0);
  expect(server.merges).toHaveLength(0);
  expect(server.deletions).toBe(0);
  expect(sync.status.status).toBe("disabled");
});
test("opt-out fences registration in flight and deletes its cloud reservation", async () => {
  const { doc, server, sync } = fixture();
  const pending = gate();
  server.registerGate = pending.promise;
  const running = sync.syncNow();
  await Bun.sleep(1);
  setSavingPreferences(doc, { local: true, cloud: false });
  pending.resolve();
  await running;
  await sync.syncNow();
  expect(server.merges).toHaveLength(0);
  expect(server.deletions).toBe(1);
  expect(sync.status.status).toBe("disabled");
});
test("failed cloud deletion is retried and re-enabling saving uploads retained private edits", async () => {
  const { doc, root, server, sync, closed } = fixture();
  await sync.syncNow();
  server.deleteFails = true;
  setSavingPreferences(doc, { local: true, cloud: false });
  expect(closed()).toBe(true);
  editNodeText(doc, root, 0, 0, "Private ");
  await sync.syncNow();
  expect(sync.status.status).toBe("retrying");
  server.deleteFails = false;
  sync.retry();
  await sync.syncNow();
  expect(sync.status.status).toBe("disabled");
  setSavingPreferences(doc, { local: true, cloud: true });
  await sync.syncNow();
  expect(server.doc.view()).toEqual(doc.view());
  expect(sync.status.status).toBe("saved");
});
