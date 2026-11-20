import { afterEach, expect, test } from "bun:test";
import { LoroApi } from "../src/loro-api";
import { createQueryClient } from "../src/query-client";

const clients: ReturnType<typeof createQueryClient>[] = [];
const client = () => {
  const value = createQueryClient();
  clients.push(value);
  return value;
};
afterEach(() => {
  for (const value of clients.splice(0)) value.clear();
});
const endpoint = (path: string) => `https://query.test${path}`;
const id = "10000000-0000-4000-8000-000000000000";
const status = (revision: string) =>
  new Response(
    JSON.stringify({
      projectId: id,
      revision,
      encoding: "loro-snapshot",
      data: "",
      durable: true,
    }),
  );

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
    new LoroApi(endpoint, fetcher, 1, queries).snapshot(id, signal),
    new LoroApi(endpoint, fetcher, 2, queries).snapshot(id, signal),
  ]);
  expect(a.revision).toBe("1");
  expect(b.revision).toBe("2");
  expect(owners).toEqual(["1", "2"]);
});
