import { afterEach, expect, test } from "bun:test";
import { checkHealth } from "../src/health";
import { LoroApi } from "../src/loro-api";
import { websocketProvider } from "../src/project-sync";
import type { ProjectDocument } from "../src/project-document";
import { createQueryClient } from "../src/query-client";
import { fetchSharedProject, sharedProjectSocket } from "../src/shared-project";

const id = "10000000-0000-4000-8000-000000000000";
const pathOf = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const queries = createQueryClient();
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  queries.clear();
});

function recordSockets() {
  const urls: string[] = [];
  globalThis.WebSocket = class {
    constructor(url: URL) {
      urls.push(url.href);
    }
    close() {}
  } as unknown as typeof WebSocket;
  return urls;
}

test("cloud requests name their .php script, before any query string", async () => {
  const requests: { url: string; account: string | null }[] = [];
  const api = new LoroApi(
    (path) => `https://api.test${path}`,
    async (url, init) => {
      requests.push({
        url: String(url),
        account: new Headers(init?.headers).get("X-Mindgrab-Account.php"),
      });
      return Response.json({
        projectId: id,
        schemaVersion: 1,
        format: "mindgrab-loro-v1",
        name: null,
        revision: "1",
        encoding: "loro-snapshot",
        data: "",
        durable: true,
        token: null,
        projects: [],
        nextCursor: null,
      });
    },
    7,
    queries,
  );
  const signal = new AbortController().signal;
  await api.register(id, signal);
  await api.list(signal);
  await api.snapshot(id, signal);
  await api.shareLink(id, signal);
  await api.setShareLink(id, true, signal);
  await api.merge(id, new Uint8Array([1]), signal);
  await api.remove(id, signal);
  expect(requests.map(({ url }) => url)).toEqual([
    "https://api.test/api/createProject.php",
    "https://api.test/api/listProjects.php",
    "https://api.test/api/getProjectSnapshot.php",
    "https://api.test/api/getShareLink.php",
    "https://api.test/api/setShareLink.php",
    `https://api.test/api/mergeProject.php?projectId=${id}`,
    "https://api.test/api/deleteProject.php",
  ]);
  expect(requests.every(({ account }) => account === "7")).toBe(true);
});

test("health calls getHealth.php and reads the database time from server-timing.php", async () => {
  const urls: string[] = [];
  let now = 0;
  const report = await checkHealth({
    fetch: (async (url: string) => {
      urls.push(url);
      return Response.json(
        { database: { status: "up" } },
        {
          headers: { "server-timing.php": "db;dur=30", "server-timing": "db" },
        },
      );
    }) as typeof fetch,
    now: () => (now += 50),
    clock: () => 0,
  });
  expect(urls.map(pathOf)).toEqual(["/api/getHealth.php"]);
  expect(report.server).toEqual({ state: "up", latencyMs: 20 });
});

test("shared links use getSharedProject.php and the /ws/share socket", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json({
      projectId: id,
      name: null,
      revision: "1",
      encoding: "loro-snapshot",
      data: "",
    });
  }) as typeof fetch;
  await fetchSharedProject("token");
  expect(urls.map(pathOf)).toEqual(["/api/getSharedProject.php"]);
  const sockets = recordSockets();
  sharedProjectSocket("token");
  expect(sockets.map(pathOf)).toEqual(["/ws/share/token"]);
});

test("project sync connects to the /ws/project socket", () => {
  const sockets = recordSockets();
  websocketProvider(id, {} as ProjectDocument, 7).connect();
  expect(sockets.map(pathOf)).toEqual([`/ws/project/${id}?ownerId=7`]);
});
