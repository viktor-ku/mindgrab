import { afterEach, expect, test } from "bun:test";
import { LoroApi, SyncError } from "../src/loro-api";
import type { CloudSnapshot } from "../src/loro-api";
import {
  createProjectDocument,
  editNodeText,
  openProjectDocument,
} from "../src/project-document";
import type { SavingPreferences } from "../src/preferences";
import type { ProjectDocument } from "../src/project-document";
import type {
  CloudMarker,
  ProjectHandle,
  ProjectRepository,
} from "../src/project-repository";
import {
  CloudWorkspace,
  discoverProjects,
  pendingUpload,
  ProjectSync,
  websocketProvider,
} from "../src/project-sync";
import type { CloudStatus } from "../src/project-sync";
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
async function until(done: () => boolean) {
  for (let waited = 0; !done(); waited++) {
    if (waited > 2000) throw new Error("Timed out");
    await Bun.sleep(1);
  }
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type Held = { revision?: string; since: string };
// The cloud as the webapp sees it. `legacy` answers as an API from before
// incremental reads does once LoroApi has fallen back to the plain request:
// complete snapshots without a head, for reads and for saves alike.
class Server extends LoroApi {
  doc: ProjectDocument;
  merges: Uint8Array[] = [];
  reads: Held[] = [];
  registrations = 0;
  deletions = 0;
  // Moves with every change to the cloud copy and never starts over.
  revision = 0;
  // Document bytes sent to the client.
  downloaded = 0;
  lost = false;
  mergeGate?: Promise<void>;
  readonly legacy: boolean;
  constructor(id: string, legacy = false) {
    super();
    this.legacy = legacy;
    this.doc = keep(openProjectDocument(id));
  }
  #reply(
    encoding: CloudSnapshot["encoding"],
    data: Uint8Array = new Uint8Array(),
    head?: string,
  ): CloudSnapshot {
    this.downloaded += data.length;
    return {
      projectId: this.doc.id,
      revision: String(this.revision),
      encoding,
      data: Buffer.from(data).toString("base64"),
      ...(head === undefined ? {} : { head }),
      durable: true,
    };
  }
  // Starts the counters over, to measure what follows.
  restart() {
    this.merges = [];
    this.reads = [];
    this.downloaded = 0;
  }
  // A save, from this client or from another device.
  receive(bytes: Uint8Array) {
    const before = this.doc.version();
    this.doc.merge(bytes);
    if (this.doc.version() !== before) this.revision++;
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
  // The earlier API lists no revision.
  override async list() {
    return [
      {
        projectId: this.doc.id,
        schemaVersion: 1 as const,
        format: "mindgrab-loro-v1" as const,
        name: null,
        ...(this.legacy ? {} : { revision: String(this.revision) }),
      },
    ];
  }
  override async changes(_id: string, held: Held) {
    this.reads.push(held);
    const { doc } = this;
    if (this.legacy) return this.#reply("loro-snapshot", doc.snapshot());
    if (held.revision === String(this.revision))
      return this.#reply("loro-update");
    if (!doc.ready) return this.#reply("loro-snapshot");
    const head = doc.head();
    const snapshot = doc.snapshot();
    const version = head === undefined ? undefined : doc.versionAt(held.since);
    if (version) {
      const updates =
        version.join(",") === doc.version()
          ? new Uint8Array()
          : doc.updatesSince(version);
      if (updates.length < snapshot.length)
        return this.#reply("loro-update", updates, head);
    }
    return this.#reply("loro-snapshot", snapshot, head);
  }
  override async merge(_id: string, bytes: Uint8Array) {
    this.merges.push(bytes.slice());
    try {
      this.receive(bytes);
    } catch {
      // The backend's 422 for changes that build on history it does not hold.
      throw new SyncError("Rejected", "blocked", "missing_dependencies");
    }
    await this.mergeGate;
    if (this.lost) {
      this.lost = false;
      throw new Error("Lost response");
    }
    return this.legacy
      ? this.#reply("loro-snapshot", this.doc.snapshot())
      : this.#reply("loro-update", undefined, this.doc.head());
  }
  override async remove() {
    this.deletions++;
    this.revision++;
    this.doc = keep(openProjectDocument(this.doc.id));
  }
}
// The catalog's part in syncing. Two tabs on one map share one of these.
function repository(id: string) {
  let attempted = false;
  let registered = false;
  let cloud: CloudMarker | undefined;
  return {
    scope: { namespace: "account-1" },
    names: { catalog: `test/${id}` },
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
      cloud = undefined;
    },
    cloudVersion: async () => cloud,
    markCloudVersion: async (_id: string, marker?: CloudMarker) => {
      cloud = marker;
    },
  };
}
interface Attachment {
  repo?: ReturnType<typeof repository>;
  // The revision a listing reported, as a workspace pass hands it over.
  revision?: string;
  // Syncs by itself, as the open map does, and keeps its socket's listener.
  live?: boolean;
}
function attach(
  doc: ProjectDocument,
  server: Server,
  { repo = repository(doc.id), revision, live = false }: Attachment = {},
) {
  // Where the map is kept comes from its preferences, outside the document.
  const listeners = new Set<(saving: SavingPreferences) => void>();
  const handle = {
    id: doc.id,
    doc,
    saving: { local: true, cloud: true },
    onSaving(listener: (saving: SavingPreferences) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush: async () => {},
    refreshMetadata: async () => {},
  };
  const setSaving = (saving: SavingPreferences) => {
    handle.saving = saving;
    for (const listener of listeners) listener(saving);
  };
  const socket: { notify?: (synced: boolean, revision?: string) => void } = {};
  const sync = new ProjectSync(
    handle as unknown as ProjectHandle,
    repo as unknown as ProjectRepository,
    {
      api: server,
      manual: !live,
      revision,
      provider: () => ({
        connect() {},
        disconnect() {},
        destroy() {},
        on(name: string, listener: (...event: never[]) => void) {
          if (name === "sync") socket.notify = listener as typeof socket.notify;
        },
      }),
    },
  );
  controllers.push(sync);
  return { sync, setSaving, repo, socket };
}
function fixture(legacy = false, options?: Attachment) {
  const doc = keep(
    createProjectDocument(crypto.randomUUID(), "Planning", {
      text: "Shared 🌲",
    }),
  );
  const root = doc.view().roots[0];
  const server = new Server(doc.id, legacy);
  return { doc, root, server, ...attach(doc, server, options) };
}
// A second replica of `doc`: another tab, or the same map on another device.
const copy = (doc: ProjectDocument) =>
  keep(openProjectDocument(doc.id, [doc.snapshot()]));
// Another device changes the cloud copy.
function elsewhere(server: Server, text: string) {
  const device = copy(server.doc);
  editNodeText(device, device.view().roots[0], 0, 0, text);
  server.receive(device.snapshot());
}
// Both APIs must keep working: the webapp and the API deploy independently.
function both(name: string, run: (legacy: boolean) => Promise<void>) {
  test(`${name} (current API)`, () => run(false));
  test(`${name} (earlier API)`, () => run(true));
}

const long = () =>
  Array.from({ length: 1500 }, () => crypto.randomUUID()).join(" ");
both(
  "a save whose acknowledgement was lost is not uploaded again",
  async (legacy) => {
    const { doc, root, server, sync } = fixture(legacy);
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
  },
);
both(
  "edits received during an in-flight merge are uploaded by the same sync",
  async (legacy) => {
    const { doc, root, server, sync } = fixture(legacy);
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
  },
);
both(
  "reload recovery includes pure deletions and duplicate histories produce no extra upload",
  async (legacy) => {
    const { doc, root, server, sync } = fixture(legacy);
    await sync.syncNow();
    sync.destroy();
    editNodeText(doc, root, 0, 6, "");
    const reopened = keep(openProjectDocument(doc.id, [doc.snapshot()]));
    const next = attach(reopened, server).sync;
    await next.syncNow();
    expect(server.doc.view().nodes[0].text).toBe(" 🌲");
    expect(
      pendingUpload(reopened, reopened.versionAt(server.doc.head() ?? "")),
    ).toBeUndefined();
    const count = server.merges.length;
    await next.syncNow();
    expect(server.merges).toHaveLength(count);
  },
);
both(
  "saves after the first send only new changes, and the whole map again if the cloud copy was replaced",
  async (legacy) => {
    const { doc, root, server, sync } = fixture(legacy);
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
    const changes = server.changes.bind(server);
    server.changes = async (...held) => {
      const result = await changes(...held);
      server.changes = changes;
      await server.remove();
      return result;
    };
    await sync.syncNow();
    // The refused changes, then the whole map.
    expect(server.merges).toHaveLength(4);
    expect(server.merges[2].length).toBeLessThan(1000);
    expect(server.merges[3].length).toBeGreaterThan(40_000);
    expect(sync.status.status).toBe("saved");
    expect(server.doc.view()).toEqual(doc.view());
  },
);
both(
  "private projects never register or upload, including manual retry",
  async (legacy) => {
    const { doc, root, server, sync, setSaving } = fixture(legacy);
    setSaving({ local: false, cloud: false });
    await sync.syncNow();
    editNodeText(doc, root, 0, 0, "Private ");
    sync.retry();
    await sync.syncNow();
    expect(server.registrations).toBe(0);
    expect(server.merges).toHaveLength(0);
    expect(server.deletions).toBe(0);
    expect(sync.status.status).toBe("disabled");
  },
);

// A map saved once, with the server's counters started over.
async function saved(options?: Attachment) {
  const made = fixture(false, options);
  editNodeText(made.doc, made.root, 0, 0, long());
  await made.sync.syncNow();
  expect(made.sync.status.status).toBe("saved");
  made.server.restart();
  return made;
}
test("a one-character edit costs one read and one small save, and downloads nothing", async () => {
  const { doc, root, server, sync } = await saved();
  const head = doc.head();
  editNodeText(doc, root, 0, 0, "x");
  await sync.syncNow();
  // The read names what the cloud last reported, not the unsaved edit.
  expect(server.reads).toEqual([{ revision: "1", since: head ?? "" }]);
  expect(server.merges).toHaveLength(1);
  expect(server.merges[0].length).toBeLessThan(1000);
  expect(server.downloaded).toBe(0);
  expect(sync.status.status).toBe("saved");
  expect(server.doc.view()).toEqual(doc.view());
});
test("an idle sync downloads and uploads nothing", async () => {
  const { server, sync } = await saved();
  await sync.syncNow();
  expect(server.reads).toHaveLength(1);
  expect(server.merges).toHaveLength(0);
  expect(server.downloaded).toBe(0);
  expect(sync.status.status).toBe("saved");
});
test("a save whose acknowledgement was lost comes back once, no larger than it went up", async () => {
  const { doc, root, server, sync } = await saved();
  const head = doc.head();
  editNodeText(doc, root, 0, 0, long().slice(0, 5000));
  server.lost = true;
  await sync.syncNow();
  expect(sync.status.status).toBe("retrying");
  editNodeText(doc, root, 0, 0, "Later ");
  await sync.syncNow();
  // The marker still names the copy from before the lost save.
  expect(server.reads[1]).toEqual({ revision: "1", since: head ?? "" });
  expect(server.downloaded).toBeGreaterThan(0);
  expect(server.downloaded).toBeLessThanOrEqual(server.merges[0].length);
  expect(server.merges).toHaveLength(2);
  expect(server.merges[1].length).toBeLessThan(1000);
  expect(sync.status.status).toBe("saved");
  expect(server.doc.view()).toEqual(doc.view());
});
test("a first save whose acknowledgement was lost is neither sent nor fetched again", async () => {
  const { doc, server, sync } = fixture();
  server.lost = true;
  await sync.syncNow();
  expect(sync.status.status).toBe("retrying");
  await sync.syncNow();
  expect(server.merges).toHaveLength(1);
  expect(server.downloaded).toBe(0);
  expect(sync.status.status).toBe("saved");
  expect(server.doc.view()).toEqual(doc.view());
});
test("a second tab that holds the first tab's save reads nothing and sends nothing", async () => {
  const { doc, root, server, sync, repo } = await saved();
  const other = copy(doc);
  const tab = attach(other, server, { repo }).sync;
  await tab.syncNow();
  editNodeText(doc, root, 0, 0, "From the first tab ");
  await sync.syncNow();
  server.restart();
  // The edit reaches the other tab inside the browser, ahead of its sync.
  other.merge(doc.snapshot());
  await tab.syncNow();
  // It takes up the marker the first tab stored.
  expect(server.reads).toEqual([{ revision: "2", since: doc.head() ?? "" }]);
  expect(server.merges).toHaveLength(0);
  expect(server.downloaded).toBe(0);
  expect(tab.status.status).toBe("saved");
});
test("a second tab that lacks the first tab's save reads just that save", async () => {
  const { doc, root, server, sync, repo } = await saved();
  const other = copy(doc);
  const tab = attach(other, server, { repo }).sync;
  await tab.syncNow();
  const head = other.head();
  editNodeText(doc, root, 0, 0, "From the first tab ");
  await sync.syncNow();
  server.restart();
  await tab.syncNow();
  // The stored marker names a change this tab lacks, so its own is used.
  expect(server.reads).toEqual([{ revision: "1", since: head ?? "" }]);
  expect(server.downloaded).toBeGreaterThan(0);
  expect(server.downloaded).toBeLessThan(1000);
  expect(server.merges).toHaveLength(0);
  expect(other.view()).toEqual(doc.view());
});
test("an edit made on another device comes down as that edit alone", async () => {
  const { doc, server, sync } = await saved();
  elsewhere(server, "Elsewhere ");
  await sync.syncNow();
  expect(server.reads).toHaveLength(1);
  expect(server.downloaded).toBeGreaterThan(0);
  expect(server.downloaded).toBeLessThan(1000);
  expect(server.merges).toHaveLength(0);
  expect(doc.view()).toEqual(server.doc.view());
});
test("a cloud copy deleted and created again empty receives the whole map once", async () => {
  const { doc, server, sync } = await saved();
  await server.remove();
  await sync.syncNow();
  expect(server.reads).toHaveLength(1);
  expect(server.downloaded).toBe(0);
  expect(server.merges).toHaveLength(1);
  expect(server.merges[0].length).toBeGreaterThan(40_000);
  expect(sync.status.status).toBe("saved");
  expect(server.doc.view()).toEqual(doc.view());
});
test("a cloud copy created again from a copy that holds this one sends the difference", async () => {
  const { doc, server, sync } = await saved();
  const device = copy(server.doc);
  editNodeText(device, device.view().roots[0], 0, 0, "Elsewhere ");
  await server.remove();
  server.receive(device.snapshot());
  await sync.syncNow();
  expect(server.reads).toHaveLength(1);
  expect(server.downloaded).toBeGreaterThan(0);
  expect(server.downloaded).toBeLessThan(1000);
  expect(server.merges).toHaveLength(0);
  expect(doc.view()).toEqual(server.doc.view());
});
test("a cloud copy created again from an older copy comes down whole, once", async () => {
  const { doc, root, server, sync } = await saved();
  const device = copy(server.doc);
  editNodeText(doc, root, 0, 0, "Newer ");
  await sync.syncNow();
  await server.remove();
  editNodeText(device, device.view().roots[0], 0, 0, "Elsewhere ");
  server.receive(device.snapshot());
  server.restart();
  const complete = server.doc.snapshot().length;
  await sync.syncNow();
  expect(server.reads).toHaveLength(1);
  expect(server.downloaded).toBe(complete);
  // Only what the new copy lacks goes up.
  expect(server.merges).toHaveLength(1);
  expect(server.merges[0].length).toBeLessThan(1000);
  expect(sync.status.status).toBe("saved");
  expect(doc.view()).toEqual(server.doc.view());
});
test("turning cloud saving off and on again sends the whole map and downloads nothing", async () => {
  const { doc, server, sync, setSaving, repo } = await saved();
  setSaving({ local: true, cloud: false });
  await sync.syncNow();
  expect(sync.status.status).toBe("disabled");
  expect(server.deletions).toBe(1);
  expect(await repo.cloudVersion()).toBeUndefined();
  setSaving({ local: true, cloud: true });
  await sync.syncNow();
  expect(server.registrations).toBe(2);
  expect(server.reads).toEqual([{ since: doc.head() ?? "" }]);
  expect(server.merges).toHaveLength(1);
  expect(server.merges[0].length).toBeGreaterThan(40_000);
  expect(server.downloaded).toBe(0);
  expect(sync.status.status).toBe("saved");
  expect(server.doc.view()).toEqual(doc.view());
});
test("a marker naming changes the document lacks is set aside, even when the listing matches it", async () => {
  const { doc, root, server, sync, repo } = await saved();
  // An older copy of the map, as a restored browser profile would hold.
  const older = copy(doc);
  const head = older.head();
  editNodeText(doc, root, 0, 0, "Newer ");
  await sync.syncNow();
  server.restart();
  const restored = attach(older, server, {
    repo,
    revision: String(server.revision),
  }).sync;
  await restored.syncNow();
  // It asks from what the document holds, and names no revision.
  expect(server.reads).toEqual([{ since: head ?? "" }]);
  expect(server.downloaded).toBeGreaterThan(0);
  expect(server.downloaded).toBeLessThan(1000);
  expect(server.merges).toHaveLength(0);
  expect(restored.status.status).toBe("saved");
  expect(older.view()).toEqual(doc.view());
});
test("a sync whose listed revision matches the marker asks the cloud nothing", async () => {
  const { doc, server, repo } = await saved();
  const sync = attach(copy(doc), server, {
    repo,
    revision: String(server.revision),
  }).sync;
  await sync.syncNow();
  expect(server.reads).toHaveLength(0);
  expect(server.merges).toHaveLength(0);
  expect(sync.status.status).toBe("saved");
  // The listing vouches for the first sync only.
  await sync.syncNow();
  expect(server.reads).toHaveLength(1);
});
test("a sync still reads without a listed revision, without a marker, and before a first save", async () => {
  const { doc, server, repo } = await saved();
  await attach(copy(doc), server, { repo }).sync.syncNow();
  expect(server.reads).toHaveLength(1);
  elsewhere(server, "Elsewhere ");
  // The listing names a revision later than the marker's.
  await attach(copy(doc), server, {
    repo,
    revision: String(server.revision),
  }).sync.syncNow();
  expect(server.reads).toHaveLength(2);
  const unmarked = fixture(false, { revision: "0" });
  await unmarked.sync.syncNow();
  expect(unmarked.server.reads).toHaveLength(1);
  // The cloud held no document at the marker's revision, so it gets one.
  const empty = fixture();
  await empty.repo.markCloudVersion(empty.doc.id, { revision: "0", head: "" });
  const first = attach(empty.doc, empty.server, {
    repo: empty.repo,
    revision: "0",
  }).sync;
  await first.syncNow();
  expect(empty.server.reads).toHaveLength(1);
  expect(empty.server.merges).toHaveLength(1);
  expect(first.status.status).toBe("saved");
});
test("a save that finds the cloud copy moved since the listing reads once and settles", async () => {
  const { doc, server, repo } = await saved();
  const listed = String(server.revision);
  elsewhere(server, "Elsewhere ");
  const reopened = copy(doc);
  editNodeText(reopened, reopened.view().roots[0], 0, 0, "Pending ");
  const sync = attach(reopened, server, { repo, revision: listed }).sync;
  await sync.syncNow();
  expect(server.merges).toHaveLength(1);
  expect(server.reads).toEqual([{ revision: listed, since: doc.head() ?? "" }]);
  expect(sync.status.status).toBe("saved");
  expect(reopened.view()).toEqual(server.doc.view());
});
test("a receipt naming changes the document lacks is followed by one more read", async () => {
  const { doc, root, server, sync } = await saved();
  editNodeText(doc, root, 0, 0, "Mine ");
  // Another device saves between this sync's read and its upload.
  const changes = server.changes.bind(server);
  server.changes = async (...held) => {
    const result = await changes(...held);
    server.changes = changes;
    elsewhere(server, "Elsewhere ");
    return result;
  };
  await sync.syncNow();
  expect(server.reads).toHaveLength(2);
  expect(server.merges).toHaveLength(1);
  expect(sync.status.status).toBe("saved");
  expect(doc.view()).toEqual(server.doc.view());
});
test("a second receipt the document cannot place ends the run for a retry", async () => {
  const { doc, root, server, sync } = await saved();
  editNodeText(doc, root, 0, 0, "Mine ");
  const merge = server.merge.bind(server);
  server.merge = async (...save) => ({
    ...(await merge(...save)),
    head: "0@1",
  });
  // Something new to save after every read.
  const changes = server.changes.bind(server);
  server.changes = async (...held) => {
    const result = await changes(...held);
    editNodeText(doc, root, 0, 0, "More ");
    return result;
  };
  await sync.syncNow();
  expect(server.reads).toHaveLength(2);
  expect(server.merges).toHaveLength(2);
  expect(sync.status.status).toBe("retrying");
});
test("an answer that does not fit the document is dropped for the complete copy", async () => {
  const { doc, server, sync, repo } = await saved();
  // Changes that build on one this document never received.
  const device = copy(server.doc);
  const node = device.view().roots[0];
  editNodeText(device, node, 0, 0, "Missing ");
  const version = device.native().version();
  editNodeText(device, node, 0, 0, "Sent ");
  server.receive(device.snapshot());
  const changes = server.changes.bind(server);
  server.changes = async (...held) => {
    server.changes = changes;
    return {
      ...(await changes(...held)),
      data: Buffer.from(device.updatesSince(version)).toString("base64"),
    };
  };
  await sync.syncNow();
  expect(server.reads).toHaveLength(2);
  expect(server.reads[1]).toEqual({ since: "" });
  expect(await repo.cloudVersion()).toEqual({
    revision: String(server.revision),
    head: server.doc.head() ?? "",
  });
  expect(sync.status.status).toBe("saved");
  expect(doc.view()).toEqual(server.doc.view());
});
test("word that nothing changed counts only for the revision the marker names", async () => {
  const { doc, server, sync } = await saved();
  elsewhere(server, "Elsewhere ");
  const changes = server.changes.bind(server);
  server.changes = async (...held) => {
    server.changes = changes;
    const { head: _, ...reply } = await changes(...held);
    return { ...reply, data: "" };
  };
  await sync.syncNow();
  expect(server.reads).toHaveLength(2);
  expect(server.reads[1]).toEqual({ since: "" });
  expect(sync.status.status).toBe("saved");
  expect(doc.view()).toEqual(server.doc.view());
});
test("a socket notice naming the marker's revision asks nothing, and any other reads once", async () => {
  const { doc, server, sync, socket } = fixture(false, { live: true });
  const settled = () => until(() => sync.status.status === "saved");
  await settled();
  const reads = server.reads.length;
  // The notice sent on connect, its repeats, and the echo of a save.
  socket.notify?.(true, String(server.revision));
  await Bun.sleep(20);
  expect(server.reads).toHaveLength(reads);
  elsewhere(server, "Elsewhere ");
  socket.notify?.(true, String(server.revision));
  await until(() => server.reads.length > reads);
  await settled();
  expect(server.reads).toHaveLength(reads + 1);
  expect(doc.view()).toEqual(server.doc.view());
  // A notice that names no revision is taken as a change.
  socket.notify?.(true);
  await until(() => server.reads.length > reads + 1);
  await settled();
  expect(server.reads).toHaveLength(reads + 2);
});
both(
  "discovery imports a map this device lacks, and one it has only when that map's sync stalled and its cloud copy moved",
  async (legacy) => {
    const { doc, server, sync } = fixture(legacy);
    await sync.syncNow();
    const { signal } = new AbortController();
    const imports: Uint8Array[] = [];
    let entries: { id: string; saving: SavingPreferences }[] = [];
    const repo = {
      ...repository(doc.id),
      list: async () => entries,
      open: async (
        id: string,
        { initialSnapshot }: { initialSnapshot: Uint8Array },
      ) => {
        imports.push(initialSnapshot);
        return {
          id,
          flush: async () => {},
          refreshMetadata: async () => {},
          close: async () => {},
        };
      },
    };
    const discover = (stalled?: string) =>
      discoverProjects(
        repo as unknown as ProjectRepository,
        server,
        signal,
        stalled,
      );
    const revision = legacy ? undefined : String(server.revision);
    const first = await discover();
    expect(first.unreadable).toBeUndefined();
    expect([...first.listed]).toEqual([[doc.id, revision]]);
    expect(imports).toHaveLength(1);
    expect(await repo.isRegistered()).toBe(true);
    expect(await repo.cloudVersion()).toEqual({
      revision: String(server.revision),
      head: doc.head() ?? "",
    });
    // A map this device has is left to its own sync.
    entries = [{ id: doc.id, saving: { local: true, cloud: true } }];
    await discover();
    expect(imports).toHaveLength(1);
    // The earlier API cannot say whether a stalled map's copy moved.
    await discover(doc.id);
    expect(imports).toHaveLength(legacy ? 2 : 1);
    elsewhere(server, "Elsewhere ");
    await discover();
    expect(imports).toHaveLength(legacy ? 2 : 1);
    await discover(doc.id);
    expect(imports).toHaveLength(legacy ? 3 : 2);
    expect(await repo.cloudVersion()).toEqual({
      revision: String(server.revision),
      head: server.doc.head() ?? "",
    });
    // Once per change to the cloud copy, and never for a map kept out of it.
    if (!legacy) await discover(doc.id);
    elsewhere(server, "Again ");
    entries = [{ id: doc.id, saving: { local: true, cloud: false } }];
    await discover(doc.id);
    expect(imports).toHaveLength(legacy ? 3 : 2);
  },
);
test("a workspace pass imports the open map while its sync is blocked, once per change to the cloud copy", async () => {
  const doc = keep(
    createProjectDocument(crypto.randomUUID(), "Planning", { text: "Shared" }),
  );
  const server = new Server(doc.id);
  server.receive(doc.snapshot());
  const imports: string[] = [];
  const repo = {
    ...repository(doc.id),
    list: async () => [{ id: doc.id, saving: { local: true, cloud: true } }],
    open: async (id: string, options: { initialSnapshot?: Uint8Array }) => {
      if (options.initialSnapshot) imports.push(id);
      return {
        id,
        flush: async () => {},
        refreshMetadata: async () => {},
        close: async () => {},
      };
    },
  };
  // The cloud refuses the open map's own reads; an import asks from "".
  const changes = server.changes.bind(server);
  server.changes = async (id, held) => {
    if (held.since !== "") throw new SyncError("Refused", "blocked");
    return changes(id, held);
  };
  let status: CloudStatus | undefined;
  const workspace = new CloudWorkspace(
    repo as unknown as ProjectRepository,
    (next) => {
      status = next;
    },
    () => {},
    server,
  );
  try {
    workspace.activate({
      id: doc.id,
      doc,
      saving: { local: true, cloud: true },
      onSaving: () => () => {},
      flush: async () => {},
      refreshMetadata: async () => {},
    } as unknown as ProjectHandle);
    const pass = () =>
      server.queryClient.refetchQueries({ queryKey: ["cloud-workspace"] });
    await until(() => status?.status === "blocked");
    await pass();
    expect(imports).toEqual([doc.id]);
    await pass();
    expect(imports).toEqual([doc.id]);
    elsewhere(server, "Elsewhere ");
    await pass();
    expect(imports).toEqual([doc.id, doc.id]);
    await pass();
    expect(imports).toEqual([doc.id, doc.id]);
  } finally {
    workspace.destroy();
  }
});
test("the socket passes on the revision a message names, and none when it names none", () => {
  const sockets: Stub[] = [];
  class Stub {
    static CLOSING = 2;
    readyState = 1;
    onmessage?: (event: { data: unknown }) => void;
    onclose?: (event: unknown) => void;
    close() {}
    constructor() {
      sockets.push(this);
    }
  }
  const real = globalThis.WebSocket;
  globalThis.WebSocket = Stub as unknown as typeof WebSocket;
  try {
    const doc = keep(createProjectDocument(crypto.randomUUID(), "Planning"));
    const provider = websocketProvider(doc.id, doc, 7);
    const heard: unknown[][] = [];
    provider.on("sync", (...event) => heard.push(event));
    provider.connect();
    expect(sockets).toHaveLength(1);
    const messages = ['{"revision":"7"}', '{"revision":7}', "not json", "null"];
    for (const data of messages) sockets[0].onmessage?.({ data });
    expect(heard).toEqual([
      [true, "7"],
      [true, undefined],
      [true, undefined],
      [true, undefined],
    ]);
    provider.destroy();
  } finally {
    globalThis.WebSocket = real;
  }
});
