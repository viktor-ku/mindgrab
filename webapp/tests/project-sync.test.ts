import { afterEach, expect, test } from "bun:test";
import { loadProject, saveProject } from "../src/projects";
import { syncProjects } from "../src/project-sync";

function storage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => data.clear(),
  };
}

const project = (name: string, text: string) => ({
  version: 1 as const,
  name,
  nodes: [{ id: "root", text }],
  view: { left: 0, top: 0, zoom: 1 },
});

const cloudProject = (name: string, text: string, updated_at: string) => ({
  name,
  state: {
    version: 1 as const,
    nodes: [{ id: "root", text }],
    view: { left: 0, top: 0, zoom: 1 },
  },
  updated_at,
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("sync uploads local projects and downloads cloud-only projects", async () => {
  const local = storage();
  saveProject(
    local,
    project("Local", "local copy"),
    "2025-02-01T00:00:00.000Z",
  );
  const uploaded: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method) {
      return Response.json([
        cloudProject("Cloud", "remote copy", "2025-02-02T00:00:00.000Z"),
      ]);
    }
    uploaded.push(JSON.parse(String(init.body)));
    return Response.json({
      name: "Local",
      state: project("Local", "local copy"),
      updated_at: "2025-02-03T00:00:00.000Z",
    });
  }) as typeof fetch;

  await syncProjects(local);

  expect(uploaded).toEqual([
    {
      name: "Local",
      state: {
        version: 1,
        nodes: [{ id: "root", text: "local copy" }],
        view: { left: 0, top: 0, zoom: 1 },
      },
    },
  ]);
  expect(loadProject(local, "proj/Cloud")).toEqual(
    project("Cloud", "remote copy"),
  );
  expect(loadProject(local, "proj/Local")).toEqual(
    project("Local", "local copy"),
  );
});

test("a newer cloud project replaces an older local copy", async () => {
  const local = storage();
  saveProject(
    local,
    project("Shared", "old local"),
    "2025-01-01T00:00:00.000Z",
  );
  let uploadCount = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method) uploadCount++;
    return Response.json([
      cloudProject("Shared", "new cloud", "2025-02-01T00:00:00.000Z"),
    ]);
  }) as typeof fetch;

  await syncProjects(local);

  expect(uploadCount).toBe(0);
  expect(loadProject(local, "proj/Shared")).toEqual(
    project("Shared", "new cloud"),
  );
});

test("a newer local project wins and remains available when sync fails", async () => {
  const local = storage();
  saveProject(
    local,
    project("Shared", "new local"),
    "2025-02-01T00:00:00.000Z",
  );
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method) {
      return Response.json({
        name: "Shared",
        state: project("Shared", "new local"),
        updated_at: "2025-02-02T00:00:00.000Z",
      });
    }
    return Response.json([
      cloudProject("Shared", "old cloud", "2025-01-01T00:00:00.000Z"),
    ]);
  }) as typeof fetch;

  await syncProjects(local);
  expect(loadProject(local, "proj/Shared")).toEqual(
    project("Shared", "new local"),
  );

  globalThis.fetch = (async () =>
    new Response(null, { status: 503 })) as typeof fetch;
  await expect(syncProjects(local)).rejects.toThrow(
    "Could not load cloud projects",
  );
  expect(loadProject(local, "proj/Shared")).toEqual(
    project("Shared", "new local"),
  );
});
