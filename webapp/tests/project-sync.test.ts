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
import {
  committedVersion,
  pendingUpload,
  ProjectSync,
} from "../src/project-sync";
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
    this.registrations++;
    return {
      projectId: id,
      schemaVersion: 1 as const,
      format: "mindgrab-loro-v1" as const,
      name: null,
    };
  }
  override async snapshot() {
    return this.result();
  }
  override async merge(_id: string, bytes: Uint8Array) {
    this.merges.push(bytes.slice());
    try {
      this.doc.merge(bytes);
    } catch {
      // The backend's 422 for changes that build on history it does not hold.
      throw new SyncError("Rejected", "blocked", "missing_dependencies");
    }
    await this.mergeGate;
    if (this.lost) {
      this.lost = false;
      throw new Error("Lost response");
    }
    return this.result();
  }
  override async remove() {
    this.deletions++;
    this.doc = keep(openProjectDocument(this.doc.id));
  }
}
function attach(doc: ProjectDocument, server: Server) {
  let attempted = false;
  let registered = false;
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
    manual: true,
    provider: () => ({
      connect() {},
      disconnect() {},
      destroy() {},
      on() {},
    }),
  });
  controllers.push(sync);
  return { sync };
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

const long = () =>
  Array.from({ length: 1500 }, () => crypto.randomUUID()).join(" ");
test("a save whose acknowledgement was lost is not uploaded again", async () => {
  const { doc, root, server, sync } = fixture();
  editNodeText(doc, root, 0, 0, long());
  server.lost = true;
  await sync.syncNow();
  expect(sync.status.status).toBe("retrying");
  editNodeText(doc, root, 0, 0, "Later ");
  await sync.syncNow();
  // The cloud kept the first save, so only the later edit is sent.
  expect(server.merges).toHaveLength(2);
  expect(server.merges[0].length).toBeGreaterThan(40_000);
  expect(server.merges[1].length).toBeLessThan(1000);
  expect(sync.status.status).toBe("saved");
  expect(server.doc.view()).toEqual(doc.view());
});
test("edits received during an in-flight merge are uploaded by the same sync", async () => {
  const { doc, root, server, sync } = fixture();
  const pending = gate();
  server.mergeGate = pending.promise;
  const running = sync.syncNow();
  while (!server.merges.length) await Bun.sleep(1);
  editNodeText(doc, root, 0, 0, "During upload ");
  expect(sync.status.status).toBe("saving");
  pending.resolve();
  await running;
  expect(server.merges).toHaveLength(2);
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
  expect(
    pendingUpload(
      reopened,
      committedVersion(reopened.id, server.doc.snapshot()),
    ),
  ).toBeUndefined();
  const count = server.merges.length;
  await next.syncNow();
  expect(server.merges).toHaveLength(count);
});
test("saves after the first send only new changes, and the whole map again if the cloud copy was replaced", async () => {
  const { doc, root, server, sync } = fixture();
  editNodeText(doc, root, 0, 0, long());
  await sync.syncNow();
  editNodeText(doc, root, 0, 0, "Next ");
  await sync.syncNow();
  expect(server.merges).toHaveLength(2);
  expect(server.merges[0].length).toBeGreaterThan(40_000);
  expect(server.merges[1].length).toBeLessThan(1000);
  expect(server.doc.view()).toEqual(doc.view());
  // Another device deletes the cloud copy and creates it again mid-save.
  editNodeText(doc, root, 0, 0, "Again ");
  const snapshot = server.snapshot.bind(server);
  server.snapshot = async () => {
    const result = await snapshot();
    server.doc = keep(openProjectDocument(doc.id));
    return result;
  };
  await sync.syncNow();
  // The refused changes, then the whole map.
  expect(server.merges).toHaveLength(4);
  expect(server.merges[2].length).toBeLessThan(1000);
  expect(server.merges[3].length).toBeGreaterThan(40_000);
  expect(sync.status.status).toBe("saved");
  expect(server.doc.view()).toEqual(doc.view());
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
