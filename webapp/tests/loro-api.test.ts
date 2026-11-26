import { afterEach, expect, test } from "bun:test";
import { LoroApi, SyncError } from "../src/loro-api";
import type { CloudSnapshot } from "../src/loro-api";
import { createProjectDocument } from "../src/project-document";
import type { ProjectDocument } from "../src/project-document";
import { createQueryClient } from "../src/query-client";

const clients: ReturnType<typeof createQueryClient>[] = [];
const docs: ProjectDocument[] = [];
afterEach(() => {
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
    };
    calls.push(call);
    return answer(call);
  };
  const client = createQueryClient();
  clients.push(client);
  return { api: new LoroApi(endpoint, fetcher, 1, client), calls };
}

test("a refused read is not repeated", async () => {
  const { api, calls } = connect(() => refused("project_not_found", 404));
  const failure = await api
    .changes(id, { since: "" }, signal())
    .catch((error) => error);
  expect(failure.code).toBe("project_not_found");
  expect(calls).toHaveLength(1);
});
test("a read is asked once, and its head and changes are handed on", async () => {
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
test("a save is answered with a receipt", async () => {
  const receipt: CloudSnapshot = {
    projectId: id,
    revision: "1",
    encoding: "loro-update",
    data: "",
    head: "0@5",
    durable: true,
  };
  const { api, calls } = connect(() => json(receipt));
  expect(await api.merge(id, new Uint8Array([1, 2]), signal())).toEqual(
    receipt,
  );
  expect(calls).toEqual([
    { method: "mergeProject.php", body: new Uint8Array([1, 2]) },
  ]);
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
