import { afterEach, expect, test } from "bun:test";
import { LoroApi, SyncError } from "../src/loro-api";
import type { CloudSnapshot } from "../src/loro-api";
import {
  createProjectDocument,
  editNodeText,
  openProjectDocument,
} from "../src/project-document";
import type { ProjectDocument } from "../src/project-document";
import type {
  CloudMarker,
  ProjectHandle,
  ProjectRepository,
} from "../src/project-repository";
import { ProjectSync } from "../src/project-sync";
import { createQueryClient } from "../src/query-client";

const clients: ReturnType<typeof createQueryClient>[] = [];
const docs: ProjectDocument[] = [];
const syncs: ProjectSync[] = [];
afterEach(() => {
  for (const sync of syncs.splice(0)) sync.destroy();
  for (const doc of docs.splice(0)) doc.destroy();
  for (const client of clients.splice(0)) client.clear();
});
const keep = (doc: ProjectDocument) => {
  docs.push(doc);
  return doc;
};
const endpoint = (path: string) => `https://api.test${path}`;
const id = "10000000-0000-4000-8000-000000000000";
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const refused = (code: string, status = 400) =>
  json({ error: { code } }, status);

interface Call {
  method: string;
  // The JSON arguments, or the bytes of a save.
  body: unknown;
  accept: string | null;
}
function connect(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const body = init?.body;
    const call = {
      method: new URL(String(url)).pathname.replace("/api/", ""),
      body:
        typeof body === "string"
          ? JSON.parse(body)
          : new Uint8Array(body as ArrayBuffer),
      accept: new Headers(init?.headers).get("Accept"),
    };
    calls.push(call);
    return answer(call);
  };
  const client = createQueryClient();
  clients.push(client);
  return { api: new LoroApi(endpoint, fetcher, 1, client), calls };
}
// The API from before incremental reads. It refuses an argument it does not
// know, takes no notice of Accept, and answers every read and every save with
// the complete snapshot.
function earlierApi() {
  const doc = keep(openProjectDocument(id));
  let revision = 0;
  const snapshot = () =>
    json({
      projectId: id,
      revision: String(revision),
      encoding: "loro-snapshot",
      data: Buffer.from(doc.snapshot()).toString("base64"),
      durable: true,
    });
  const connection = connect(({ method, body }) => {
    if (method === "mergeProject.php") {
      const before = doc.version();
      doc.merge(body as Uint8Array);
      if (doc.version() !== before) revision++;
      return snapshot();
    }
    if (method === "getProjectSnapshot.php")
      return Object.keys(body as object).some((key) => key !== "projectId")
        ? refused("invalid_request")
        : snapshot();
    return json({
      projectId: id,
      schemaVersion: 1,
      format: "mindgrab-loro-v1",
      name: null,
    });
  });
  return { ...connection, doc };
}

test("a read the earlier API refuses is repeated once in the form it knows", async () => {
  const { api, calls, doc } = earlierApi();
  doc.merge(
    keep(createProjectDocument(id, "Planning", { text: "Idea" })).snapshot(),
  );
  const lifetime = signal();
  const reply = await api.changes(
    id,
    { revision: "7", since: "3@5" },
    lifetime,
  );
  expect(calls.map(({ body }) => body)).toEqual([
    { projectId: id, revision: "7", since: "3@5" },
    { projectId: id },
  ]);
  expect(reply.encoding).toBe("loro-snapshot");
  expect("head" in reply).toBe(false);
  expect(Buffer.from(reply.data, "base64")).toEqual(
    Buffer.from(doc.snapshot()),
  );
  // Nothing is remembered: the next read tries the new form again.
  await api.snapshot(id, lifetime);
  expect(calls.slice(2).map(({ body }) => body)).toEqual([
    { projectId: id, since: "" },
    { projectId: id },
  ]);
});
test("a read refused in both forms stops after the second and blocks", async () => {
  const { api, calls } = connect(() => refused("invalid_request"));
  const failure = await api
    .changes(id, { since: "" }, signal())
    .catch((error) => error);
  expect(failure).toBeInstanceOf(SyncError);
  expect(failure.kind).toBe("blocked");
  expect(calls.map(({ body }) => body)).toEqual([
    { projectId: id, since: "" },
    { projectId: id },
  ]);
});
test("a read refused for any other reason is not repeated", async () => {
  const { api, calls } = connect(() => refused("project_not_found", 404));
  const failure = await api
    .changes(id, { since: "" }, signal())
    .catch((error) => error);
  expect(failure.code).toBe("project_not_found");
  expect(calls).toHaveLength(1);
});
test("the current API is asked once, and its head and changes are handed on", async () => {
  const update: CloudSnapshot = {
    projectId: id,
    revision: "8",
    encoding: "loro-update",
    data: "",
    head: "4@5",
    durable: true,
  };
  const { api, calls } = connect(() => json(update));
  expect(
    await api.changes(id, { revision: "7", since: "3@5" }, signal()),
  ).toEqual(update);
  expect(calls).toHaveLength(1);
  // Changes alone are not the complete copy `snapshot` promises.
  const failure = await api.snapshot(id, signal()).catch((error) => error);
  expect(failure).toBeInstanceOf(SyncError);
  expect(failure.kind).toBe("retry");
});
test("a save asks for a receipt and accepts either answer", async () => {
  const receipt: CloudSnapshot = {
    projectId: id,
    revision: "1",
    encoding: "loro-update",
    data: "",
    head: "0@5",
    durable: true,
  };
  const current = connect(() => json(receipt));
  expect(await current.api.merge(id, new Uint8Array([1, 2]), signal())).toEqual(
    receipt,
  );
  expect(current.calls).toEqual([
    {
      method: "mergeProject.php",
      body: new Uint8Array([1, 2]),
      accept: "application/vnd.mindgrab.receipt+json",
    },
  ]);
  const earlier = earlierApi();
  const doc = keep(createProjectDocument(id, "Planning", { text: "Idea" }));
  const complete = await earlier.api.merge(id, doc.snapshot(), signal());
  expect(complete.encoding).toBe("loro-snapshot");
  expect(complete.head).toBeUndefined();
  expect(complete.data).not.toBe("");
});
test("a map saves and keeps saving against the earlier API", async () => {
  const { api, calls, doc: cloud } = earlierApi();
  const doc = keep(createProjectDocument(id, "Planning", { text: "Idea" }));
  let registered = false;
  let marker: CloudMarker | undefined;
  const handle = {
    id,
    doc,
    saving: { local: true, cloud: true },
    onSaving: () => () => {},
    flush: async () => {},
    refreshMetadata: async () => {},
  };
  const repository = {
    scope: { namespace: "account-1" },
    names: { catalog: `test/${id}` },
    isRegistered: async () => registered,
    cloudAttempted: async () => registered,
    markCloudAttempted: async () => {},
    markRegistered: async () => {
      registered = true;
    },
    cloudVersion: async () => marker,
    markCloudVersion: async (_id: string, next?: CloudMarker) => {
      marker = next;
    },
  };
  const sync = new ProjectSync(
    handle as unknown as ProjectHandle,
    repository as unknown as ProjectRepository,
    {
      api,
      manual: true,
      provider: () => ({
        connect() {},
        disconnect() {},
        destroy() {},
        on() {},
      }),
    },
  );
  syncs.push(sync);
  await sync.syncNow();
  expect(sync.status.status).toBe("saved");
  expect(cloud.view()).toEqual(doc.view());
  // The head it could not be told is worked out from the snapshot.
  const head = cloud.head() ?? "";
  expect(marker).toEqual({ revision: "1", head });
  calls.length = 0;
  editNodeText(doc, doc.view().roots[0], 0, 0, "Next ");
  await sync.syncNow();
  expect(sync.status.status).toBe("saved");
  expect(cloud.view()).toEqual(doc.view());
  // One refused read, its repeat, and a save of the edit alone.
  expect(calls.map(({ method }) => method)).toEqual([
    "getProjectSnapshot.php",
    "getProjectSnapshot.php",
    "mergeProject.php",
  ]);
  expect(calls[0].body).toEqual({ projectId: id, revision: "1", since: head });
  expect(calls[1].body).toEqual({ projectId: id });
  expect((calls[2].body as Uint8Array).length).toBeLessThan(200);
});
test("reads that hold different versions are separate requests, even at once", async () => {
  const doc = keep(createProjectDocument(id, "Planning", { text: "Idea" }));
  const { api, calls } = connect(({ body }) =>
    json({
      projectId: id,
      revision: "1",
      ...((body as { since?: string }).since
        ? { encoding: "loro-update", data: "" }
        : {
            encoding: "loro-snapshot",
            data: Buffer.from(doc.snapshot()).toString("base64"),
          }),
      head: doc.head(),
      durable: true,
    }),
  );
  const lifetime = signal();
  const [update, complete] = await Promise.all([
    api.changes(id, { since: doc.head() ?? "" }, lifetime),
    api.snapshot(id, lifetime),
  ]);
  expect(calls).toHaveLength(2);
  expect(update.encoding).toBe("loro-update");
  expect(complete.encoding).toBe("loro-snapshot");
});
