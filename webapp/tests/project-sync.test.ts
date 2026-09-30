import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { CrdtApi, digest, SyncError } from "../src/crdt-api";
import {
  createChild,
  createProjectDocument,
  editNodeText,
  materializeProject,
  openProjectDocument,
  ORIGIN,
  replaceNodeText,
} from "../src/project-document";
import type {
  ProjectHandle,
  ProjectRepository,
} from "../src/project-repository";
import { missingUpdate, ProjectSync } from "../src/project-sync";
import type { SyncProvider } from "../src/project-sync";

const ID = "10000000-0000-4000-8000-000000000000";
const ROOT = "20000000-0000-4000-8000-000000000000";
const all: ProjectSync[] = [];
afterEach(() => {
  for (const sync of all.splice(0)) sync.destroy();
});
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Server extends CrdtApi {
  doc = openProjectDocument(ID);
  registrations = 0;
  submissions: { id: string; bytes: Uint8Array }[] = [];
  receipts = new Map<
    string,
    { bytes: Uint8Array; receipt: Awaited<ReturnType<CrdtApi["submit"]>> }
  >();
  failAfterCommit = false;
  registerGate?: Promise<void>;
  receiptGate?: Promise<void>;
  baselineGate?: Promise<void>;
  auth = true;
  validation: "valid" | "pending_dependencies" = "valid";
  override async register(id: string) {
    await this.registerGate;
    if (!this.auth) throw new SyncError("Sign in again.", "auth");
    this.registrations++;
    return {
      projectId: id,
      schemaVersion: 1 as const,
      protocolVersion: 1 as const,
      name: null,
    };
  }
  override async baseline() {
    await this.baselineGate;
    return {
      schemaVersion: 1 as const,
      lastSequence: String(this.receipts.size),
      validation: this.validation,
      encoding: "yjs-v1" as const,
      data: base64(Y.encodeStateAsUpdate(this.doc)),
      stateVector: base64(Y.encodeStateVector(this.doc)),
    };
  }
  override async submit(id: string, updateId: string, bytes: Uint8Array) {
    this.submissions.push({ id: updateId, bytes: bytes.slice() });
    let saved = this.receipts.get(updateId);
    if (saved) expect(bytes).toEqual(saved.bytes);
    else {
      Y.applyUpdate(this.doc, bytes, ORIGIN.remote);
      const receipt = {
        protocolVersion: 1 as const,
        projectId: id,
        updateId,
        sequence: String(this.receipts.size + 1),
        sha256: await digest(bytes),
        durable: true as const,
        validation: this.validation,
      };
      saved = { bytes: bytes.slice(), receipt };
      this.receipts.set(updateId, saved);
    }
    await this.receiptGate;
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new Error("Lost response");
    }
    return saved.receipt;
  }
  override async status() {
    return {
      schemaVersion: 1 as const,
      lastSequence: String(this.receipts.size),
      validation: this.validation,
    };
  }
}
class Provider implements SyncProvider {
  destroyed = false;
  connected = false;
  listeners = new Map<string, (...args: never[]) => void>();
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  destroy() {
    this.destroyed = true;
    this.disconnect();
  }
  on(name: string, listener: (...args: never[]) => void) {
    this.listeners.set(name, listener);
  }
  synced() {
    (this.listeners.get("sync") as (v: boolean) => void)?.(true);
  }
}
function attach(doc: Y.Doc, server: Server, online = () => true) {
  const provider = new Provider();
  let flushes = 0;
  let registrations = 0;
  const handle = {
    id: doc.guid,
    doc,
    flush: async () => {
      flushes++;
    },
    refreshMetadata: async () => {},
  } as ProjectHandle;
  const repo = {
    markRegistered: async () => {
      registrations++;
    },
  } as unknown as ProjectRepository;
  const sync = new ProjectSync(handle, repo, {
    api: server,
    provider: () => provider,
    online,
    debounceMs: 60_000,
    retryMs: 60_000,
  });
  all.push(sync);
  return {
    sync,
    provider,
    flushes: () => flushes,
    registrations: () => registrations,
  };
}
const seed = () =>
  createProjectDocument(ID, "Same name", { id: ROOT, text: "Root" });

test("offline devices merge text/tree edits on reconnect without a snapshot winner", async () => {
  const server = new Server();
  const first = seed();
  const a = attach(first, server);
  await a.sync.syncNow();
  const second = openProjectDocument(ID, [Y.encodeStateAsUpdate(server.doc)]);
  let online = false;
  const b = attach(second, server, () => online);
  editNodeText(first, ROOT, 0, 0, "A ");
  createChild(first, ROOT, { text: "A child" });
  editNodeText(second, ROOT, 4, 0, " B");
  createChild(second, ROOT, { text: "B child" });
  await b.sync.syncNow();
  expect(b.sync.status.status).toBe("offline");
  await a.sync.syncNow();
  online = true;
  await b.sync.syncNow();
  a.sync.destroy();
  const reconnected = attach(first, server);
  await reconnected.sync.syncNow();
  expect(materializeProject(first)).toEqual(materializeProject(second));
  expect(materializeProject(server.doc)).toEqual(materializeProject(first));
  expect(
    Object.values(materializeProject(first).nodes)
      .map((n) => n.text)
      .sort(),
  ).toEqual(["A Root B", "A child", "B child"]);
});

test("edits during registration and awaiting a receipt remain pending; synced does not acknowledge them", async () => {
  const server = new Server();
  const registration = deferred<void>();
  server.registerGate = registration.promise;
  const doc = seed();
  const { sync, provider } = attach(doc, server);
  const running = sync.syncNow();
  editNodeText(doc, ROOT, 4, 0, " during registration");
  const receipt = deferred<void>();
  server.receiptGate = receipt.promise;
  registration.resolve();
  while (!server.submissions.length) await Bun.sleep(1);
  editNodeText(doc, ROOT, 0, 0, "Later ");
  provider.synced();
  expect(sync.status.status).toBe("saving");
  receipt.resolve();
  await running;
  expect(sync.status.status).toBe("saving");
  expect(materializeProject(server.doc).nodes[ROOT].text).toBe(
    "Root during registration",
  );
  await sync.syncNow();
  expect(sync.status.status).toBe("saved");
  expect(materializeProject(server.doc)).toEqual(materializeProject(doc));
});

test("lost receipt retries identical UUID/bytes even when server baseline already covers the batch", async () => {
  const server = new Server();
  server.failAfterCommit = true;
  const doc = seed();
  const { sync } = attach(doc, server);
  await sync.syncNow();
  expect(sync.status.status).toBe("retrying");
  editNodeText(doc, ROOT, 0, 0, "After lost ack ");
  await sync.syncNow();
  expect(server.submissions[1]).toEqual(server.submissions[0]);
  expect(server.receipts.size).toBe(1);
  expect(sync.status.status).toBe("saving");
  await sync.syncNow();
  expect(sync.status.status).toBe("saved");
  expect(server.receipts.size).toBe(2);
});

test("reload recovery includes pure text deletes with equal vectors", async () => {
  const server = new Server();
  const doc = seed();
  const initial = attach(doc, server);
  await initial.sync.syncNow();
  initial.sync.destroy();
  const vector = Y.encodeStateVector(doc);
  editNodeText(doc, ROOT, 0, 4, "");
  expect(Y.encodeStateVector(doc)).toEqual(vector);
  expect(missingUpdate(doc, Y.encodeStateAsUpdate(server.doc))).toBeDefined();
  const persisted = Y.encodeStateAsUpdate(doc);
  const reopened = openProjectDocument(ID, [persisted]);
  const fresh = attach(reopened, server);
  await fresh.sync.syncNow();
  expect(materializeProject(server.doc).nodes[ROOT].text).toBe("");
  expect(fresh.sync.status.status).toBe("saved");
  expect(
    missingUpdate(reopened, Y.encodeStateAsUpdate(server.doc)),
  ).toBeUndefined();
  const count = server.submissions.length;
  await fresh.sync.syncNow();
  expect(server.submissions.length).toBe(count);
});

test("destroy fences delayed baseline/registration/receipt results and removes old provider", async () => {
  const server = new Server();
  const gate = deferred<void>();
  server.baselineGate = gate.promise;
  const doc = seed();
  const remote = seed();
  replaceNodeText(remote, ROOT, "Old account data");
  server.doc = remote;
  const { sync, registrations } = attach(doc, server);
  const running = sync.syncNow();
  while (!registrations()) await Bun.sleep(1);
  sync.destroy();
  gate.resolve();
  await running;
  expect(materializeProject(doc).nodes[ROOT].text).toBe("Root");
  expect(server.submissions).toEqual([]);
  const second = attach(doc, new Server());
  await second.sync.syncNow();
  second.sync.destroy();
  expect(second.provider.destroyed).toBe(true);
});

test("pending dependencies never mean saved; auth pauses without deleting local content", async () => {
  const server = new Server();
  server.validation = "pending_dependencies";
  const doc = seed();
  const { sync } = attach(doc, server);
  await sync.syncNow();
  expect(sync.status.status).toBe("retrying");
  server.validation = "valid";
  await sync.syncNow();
  expect(sync.status.status).toBe("saved");
  const expired = new Server();
  expired.auth = false;
  const paused = attach(doc, expired);
  await paused.sync.syncNow();
  expect(paused.sync.status.status).toBe("auth");
  expect(materializeProject(doc).nodes[ROOT].text).toBe("Root");
  expired.auth = true;
  paused.sync.retry();
  await paused.sync.syncNow();
  expect(paused.sync.status.status).toBe("saved");
});

test("HTTP receipts verify project, batch UUID and exact SHA-256; catalogs paginate", async () => {
  const bytes = Y.encodeStateAsUpdate(seed());
  const updateId = crypto.randomUUID();
  const seen: RequestInit[] = [];
  const api = new CrdtApi((path) => `http://localhost${path}`, (async (
    _url,
    init,
  ) => {
    seen.push(init as RequestInit);
    return Response.json({
      protocolVersion: 1,
      projectId: ID,
      updateId,
      sequence: "1",
      sha256: "0".repeat(64),
      durable: true,
      validation: "valid",
    });
  }) as typeof fetch);
  await expect(
    api.submit(ID, updateId, bytes, new AbortController().signal),
  ).rejects.toThrow("receipt did not match");
  expect(seen[0].credentials).toBe("include");
  expect(seen[0].headers).toEqual({
    "Content-Type": "application/octet-stream",
    "X-Mindgrab-Schema-Version": "1",
  });
  let pages = 0;
  const catalog = new CrdtApi(
    (path) => `http://localhost${path}`,
    (async () => {
      pages++;
      return Response.json({
        projects: [
          {
            projectId: ID,
            protocolVersion: 1,
            schemaVersion: 1,
            name: "Duplicate name",
          },
        ],
        nextCursor: pages === 1 ? "second page" : null,
      });
    }) as typeof fetch,
  );
  expect(await catalog.list(new AbortController().signal)).toHaveLength(2);
  expect(pages).toBe(2);
});

test("V1 chunking preserves causal identity, Unicode and deletes across reversed/duplicate deliveries", async () => {
  const { updateBatches } = await import("../src/update-batches");
  const doc = seed();
  for (let i = 0; i < 20; i++) createChild(doc, ROOT, { text: `Node ${i} 🧠` });
  editNodeText(doc, ROOT, 0, 4, "");
  const original = Y.encodeStateAsUpdate(doc);
  const chunks = updateBatches(original, 256);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((bytes) => bytes.length <= 256)).toBe(true);
  for (const delivery of [chunks, [...chunks].reverse()]) {
    const replica = openProjectDocument(ID);
    for (const bytes of delivery) {
      Y.applyUpdate(replica, bytes);
      Y.applyUpdate(replica, bytes);
    }
    expect(materializeProject(replica)).toEqual(materializeProject(doc));
    expect(Y.encodeStateVector(replica)).toEqual(Y.encodeStateVector(doc));
    expect(missingUpdate(replica, original)).toBeUndefined();
  }
});

test("auth fencing during a delayed receipt cannot later show saved", async () => {
  const server = new Server();
  const receipt = deferred<void>();
  server.receiptGate = receipt.promise;
  const { sync } = attach(seed(), server);
  const running = sync.syncNow();
  while (!server.submissions.length) await Bun.sleep(1);
  sync.pauseForAuth("Sign in again.");
  receipt.resolve();
  await running;
  expect(sync.status.status).toBe("auth");
  server.receiptGate = undefined;
  sync.retry();
  await sync.syncNow();
  expect(sync.status.status).toBe("saved");
});

test("a connected provider's synced event cannot clear an outstanding durable receipt", async () => {
  const server = new Server();
  const doc = seed();
  const { sync, provider } = attach(doc, server);
  await sync.syncNow();
  const receipt = deferred<void>();
  server.receiptGate = receipt.promise;
  editNodeText(doc, ROOT, 0, 0, "Pending ");
  const running = sync.syncNow();
  while (server.submissions.length < 2) await Bun.sleep(1);
  provider.synced();
  expect(sync.status.status).toBe("saving");
  sync.destroy();
  receipt.resolve();
  await running;
  expect(sync.status.status).toBe("saving");
  expect(provider.destroyed).toBe(true);
});
