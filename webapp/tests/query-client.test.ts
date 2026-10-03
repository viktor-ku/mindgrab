import { afterEach, expect, test } from "bun:test";
import { onlineManager } from "@tanstack/solid-query";
import { CrdtApi, SyncError } from "../src/crdt-api";
import { createQueryClient, executeMutation } from "../src/query-client";

const clients: ReturnType<typeof createQueryClient>[] = [];
const client = () => {
  const value = createQueryClient();
  clients.push(value);
  return value;
};
afterEach(() => {
  onlineManager.setOnline(true);
  for (const value of clients.splice(0)) value.clear();
});
const endpoint = (path: string) => `https://query.test${path}`;
const id = "10000000-0000-4000-8000-000000000000";
const status = (lastSequence: string) =>
  new Response(
    JSON.stringify({
      schemaVersion: 1,
      lastSequence,
      validation: "valid",
    }),
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("local reads and writes finish offline; failed writes are never replayed automatically", async () => {
  onlineManager.setOnline(false);
  const queries = client();
  expect(
    await queries.fetchQuery({
      queryKey: ["local"],
      queryFn: async () => "stored",
    }),
  ).toBe("stored");
  let writes = 0;
  await expect(
    executeMutation(
      queries,
      {
        mutationFn: async () => {
          writes++;
          throw new Error("Storage full");
        },
      },
      undefined,
    ),
  ).rejects.toThrow("Storage full");
  onlineManager.setOnline(true);
  await queries.resumePausedMutations();
  expect(writes).toBe(1);
});

test("cloud reads deduplicate within a lifetime and fetch fresh state on the next read", async () => {
  const response = deferred<Response>();
  let requests = 0;
  const api = new CrdtApi(
    endpoint,
    async () => {
      requests++;
      return requests === 1 ? response.promise : status("2");
    },
    1,
    client(),
  );
  const signal = new AbortController().signal;
  const first = api.status(id, signal);
  const second = api.status(id, signal);
  expect(requests).toBe(1);
  response.resolve(status("1"));
  expect((await first).lastSequence).toBe("1");
  expect((await second).lastSequence).toBe("1");
  expect((await api.status(id, signal)).lastSequence).toBe("2");
  expect(requests).toBe(2);
});

test("a canceled lifetime cannot populate its replacement with a late response", async () => {
  const response = deferred<Response>();
  const started = deferred<void>();
  let requests = 0;
  let requestSignal: AbortSignal | undefined;
  const queries = client();
  const api = new CrdtApi(
    endpoint,
    async (_url, init) => {
      requests++;
      if (requests > 1) return status("2");
      requestSignal = init?.signal ?? undefined;
      started.resolve();
      // Deliberately ignores cancellation, like a response already in flight.
      return response.promise;
    },
    1,
    queries,
  );
  const old = new AbortController();
  const pending = api.status(id, old.signal);
  const rejection = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  await started.promise;
  old.abort();
  expect(await rejection).toBeInstanceOf(Error);
  expect(requestSignal?.aborted).toBe(true);
  expect(
    (await api.status(id, new AbortController().signal)).lastSequence,
  ).toBe("2");
  response.resolve(status("1"));
  await Promise.resolve();
  expect(
    queries
      .getQueryCache()
      .findAll()
      .some(
        (query) =>
          (query.state.data as { lastSequence?: string } | undefined)
            ?.lastSequence === "1",
      ),
  ).toBe(false);
});

test("shared query clients keep accounts separate and enforce ownership headers", async () => {
  const queries = client();
  const owners: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const owner = new Headers(init?.headers).get("X-Mindgrab-Account") ?? "";
    owners.push(owner);
    return status(owner);
  };
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([
    new CrdtApi(endpoint, fetcher, 1, queries).status(id, signal),
    new CrdtApi(endpoint, fetcher, 2, queries).status(id, signal),
  ]);
  expect(a.lastSequence).toBe("1");
  expect(b.lastSequence).toBe("2");
  expect(owners).toEqual(["1", "2"]);
});

test("cloud registration is a mutation with explicit retries and the original UUID", async () => {
  const queries = client();
  const ids: string[] = [];
  const api = new CrdtApi(
    endpoint,
    async (_url, init) => {
      ids.push(JSON.parse(String(init?.body)).projectId);
      return ids.length === 1
        ? new Response("{}", { status: 500 })
        : new Response(
            JSON.stringify({
              projectId: id,
              protocolVersion: 1,
              schemaVersion: 1,
              name: null,
            }),
          );
    },
    1,
    queries,
  );
  const signal = new AbortController().signal;
  await expect(api.register(id, signal)).rejects.toBeInstanceOf(SyncError);
  expect(ids).toEqual([id]);
  expect(queries.getMutationCache().getAll()[0].state.status).toBe("error");
  expect((await api.register(id, signal)).projectId).toBe(id);
  expect(ids).toEqual([id, id]);
});
