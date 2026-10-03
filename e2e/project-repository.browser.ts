import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";
import { storageNames } from "../webapp/src/project-repository";
import type { Harness } from "./repository-harness";

// Real Chromium IndexedDB. Run `bunx playwright install chromium` once.
declare const mg: Harness;

const ORIGIN = "http://localhost:4173";
const PAGE = `<!doctype html><script type="module" src="/harness.js"></script>`;
const TIMEOUT = 30_000;
const NAMES = storageNames({ deployment: "test", namespace: "anonymous" });

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [`${import.meta.dir}/repository-harness.ts`],
    target: "browser",
    format: "esm",
  });
  if (!build.success) throw new AggregateError(build.logs, "Harness build");
  bundle = await build.outputs[0].text();
  browser = await chromium.launch();
});

afterAll(() => browser?.close());

// This isolates IndexedDB behavior by keeping the harness available offline.
// Production shell caching/cold reopening is covered by offline-shell.browser.ts.
async function newContext() {
  const context = await browser.newContext();
  await context.route(`${ORIGIN}/**`, (route) => {
    const script = new URL(route.request().url()).pathname === "/harness.js";
    return route.fulfill({
      contentType: script ? "text/javascript" : "text/html",
      body: script ? bundle : PAGE,
    });
  });
  return context;
}

async function load(page: Page) {
  await page.waitForFunction(() => "mg" in globalThis);
  return page;
}

async function tab(context: BrowserContext) {
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("page error:", error));
  await page.goto(ORIGIN);
  return load(page);
}

async function reload(page: Page) {
  await page.reload();
  return load(page);
}

async function withContext(run: (context: BrowserContext) => Promise<void>) {
  const context = await newContext();
  try {
    await run(context);
  } finally {
    await context.close();
  }
}

describe("IndexedDB project repository", () => {
  test(
    "never seeds a document that is empty after hydration",
    () =>
      withContext(async (context) => {
        const first = await tab(context);
        const second = await tab(context);
        const id = crypto.randomUUID();
        const waiting = await second.evaluate(async (id) => {
          const repo = mg.open();
          const handle = await repo.open(id);
          Object.assign(globalThis, { handle });
          return {
            state: handle.state().status,
            structs: handle.doc.store.clients.size,
            listed: (await repo.list()).length,
          };
        }, id);
        expect(waiting).toEqual({ state: "loading", structs: 0, listed: 0 });

        await first.evaluate(
          (id) =>
            mg.open().create({ id, name: "Race", root: { text: "Only" } }),
          id,
        );
        await second.waitForFunction(() => {
          const { handle } = globalThis as never as {
            handle: import("../webapp/src/project-repository").ProjectHandle;
          };
          return handle.state().status === "ready";
        });
        const duplicate = await second.evaluate(async (id) => {
          const { handle } = globalThis as never as {
            handle: import("../webapp/src/project-repository").ProjectHandle;
          };
          await handle.flush();
          const error = await mg.repo
            .create({ id, name: "Again", root: { text: "Second seed" } })
            .catch((error: Error) => error.name);
          return { error, nodes: mg.liveNodes(handle) };
        }, id);
        expect(duplicate).toEqual({ error: "ProjectExistsError", nodes: 1 });

        await reload(second);
        const reopened = await second.evaluate(async (id) => {
          const handle = await mg.open().open(id);
          return { state: handle.state().status, nodes: mg.liveNodes(handle) };
        }, id);
        expect(reopened).toEqual({ state: "ready", nodes: 1 });
      }),
    TIMEOUT,
  );

  test(
    "reports failed commits as unsaved and keeps in-memory content",
    () =>
      withContext(async (context) => {
        const page = await tab(context);
        const result = await page.evaluate(async () => {
          const { project } = mg;
          const handle = await mg.open().create({ name: "Faults", root: {} });
          const statuses: string[] = [];
          handle.onDurability(({ status }) => statuses.push(status));
          const [root] = project.projectForest(mg.content(handle));
          mg.failWrites("/project/", "updates");
          project.replaceNodeText(handle.doc, root.id, "Kept in memory");
          const unsaved = await mg.until(handle, "unsaved");
          project.createChild(handle.doc, root.id, { text: "Also kept" });
          const flushed = await handle.flush().then(
            () => "saved",
            (error) => `${error.name}:${error.reason}`,
          );
          const whileFailing = mg.content(handle);
          mg.clearFaults();
          await handle.flush();
          return {
            reason: unsaved.status === "unsaved" && unsaved.error.reason,
            flushed,
            whileFailing,
            statuses,
            final: handle.durability().status,
            id: handle.id,
          };
        });
        expect(result.reason).toBe("aborted");
        expect(result.flushed).toBe("StorageError:aborted");
        expect(result.statuses[0]).toBe("saving");
        expect(result.statuses).toContain("unsaved");
        expect(result.statuses.at(-1)).toBe("saved");
        expect(result.final).toBe("saved");
        expect(
          Object.values(result.whileFailing.nodes)
            .map(({ text }) => text)
            .sort(),
        ).toEqual(["Also kept", "Kept in memory"]);

        await reload(page);
        const reopened = await page.evaluate(async (id) => {
          const handle = await mg.open().open(id);
          return mg.content(handle);
        }, result.id);
        expect(reopened).toEqual(result.whileFailing);
      }),
    TIMEOUT,
  );

  test(
    "survives quota errors and reconstructs the confirmed document",
    () =>
      withContext(async (context) => {
        const page = await tab(context);
        // Chromium caches remaining space after a write, so set quota first.
        const cdp = await context.newCDPSession(page);
        await cdp.send("Storage.overrideQuotaForOrigin", {
          origin: ORIGIN,
          quotaSize: 40_000,
        });
        const id = await page.evaluate(async () => {
          const handle = await mg.open().create({ name: "Quota", root: {} });
          Object.assign(globalThis, { handle });
          return handle.id;
        });
        const failed = await page.evaluate(async () => {
          const { handle } = globalThis as never as {
            handle: import("../webapp/src/project-repository").ProjectHandle;
          };
          const [root] = mg.project.projectForest(mg.content(handle));
          mg.project.replaceNodeText(handle.doc, root.id, mg.noise(60_000));
          const unsaved = await mg.until(handle, "unsaved");
          return {
            reason: unsaved.status === "unsaved" && unsaved.error.reason,
            length: mg.content(handle).nodes[root.id].text.length,
          };
        });
        expect(failed).toEqual({ reason: "quota", length: 60_000 });

        await cdp.send("Storage.overrideQuotaForOrigin", {
          origin: ORIGIN,
          quotaSize: 10_000_000,
        });
        const confirmed = await page.evaluate(async () => {
          const { handle } = globalThis as never as {
            handle: import("../webapp/src/project-repository").ProjectHandle;
          };
          await handle.flush();
          return {
            status: handle.durability().status,
            content: mg.content(handle),
            stateVector: [...mg.Y.encodeStateVector(handle.doc)],
          };
        });
        expect(confirmed.status).toBe("saved");

        await reload(page);
        const reopened = await page.evaluate(async (id) => {
          const handle = await mg.open().open(id);
          return {
            content: mg.content(handle),
            stateVector: [...mg.Y.encodeStateVector(handle.doc)],
          };
        }, id);
        expect(reopened).toEqual({
          content: confirmed.content,
          stateVector: confirmed.stateVector,
        });
      }),
    TIMEOUT,
  );

  test(
    "recovers a document saved before its catalog entry",
    () =>
      withContext(async (context) => {
        const page = await tab(context);
        const id = crypto.randomUUID();
        const failure = await page.evaluate(async (id) => {
          mg.failWrites("/catalog", "projects");
          return mg
            .open()
            .create({ id, name: "Interrupted", root: { text: "Seed" } })
            .then(
              () => "created",
              (error) => `${error.name}:${error.reason}`,
            );
        }, id);
        expect(failure).toBe("StorageError:aborted");

        await reload(page);
        const recovered = await page.evaluate(async (id) => {
          const repo = mg.open();
          const list = await repo.list();
          const again = await repo
            .create({ id, name: "Interrupted", root: { text: "Seed" } })
            .catch((error: Error) => error.name);
          const handle = await repo.open(id);
          return {
            list: list.map(({ id, name }) => ({ id, name })),
            again,
            texts: Object.values(mg.content(handle).nodes).map(
              ({ text }) => text,
            ),
          };
        }, id);
        expect(recovered).toEqual({
          list: [{ id, name: "Interrupted" }],
          again: "ProjectExistsError",
          texts: ["Seed"],
        });
      }),
    TIMEOUT,
  );

  test(
    "repeated open and close does not accumulate observers or connections",
    () =>
      withContext(async (context) => {
        const page = await tab(context);
        const result = await page.evaluate(async () => {
          const repo = mg.open();
          const kept = await repo.create({ name: "Kept", root: {} });
          const other = await repo.create({ name: "Other", root: {} });
          await other.close();
          await repo.list();
          const before = {
            connections: mg.connections(),
            channels: mg.channels(),
            observers: mg.observers(kept.doc),
          };
          for (let i = 0; i < 25; i++) {
            const again = await repo.open(kept.id);
            again.onDurability(() => {});
            mg.project.renameProject(again.doc, `Kept ${i}`);
            await again.close();
            const closed = await repo.open(other.id);
            closed.onDurability(() => {});
            await closed.close();
          }
          await kept.flush();
          return {
            before,
            after: {
              connections: mg.connections(),
              channels: mg.channels(),
              observers: mg.observers(kept.doc),
            },
          };
        });
        expect(result.after).toEqual(result.before);
        expect(Object.values(result.before.connections)).toEqual([1, 1]);
      }),
    TIMEOUT,
  );

  test(
    "reconnects after another tab upgrades the database, and times out when blocked",
    () =>
      withContext(async (context) => {
        const page = await tab(context);
        const other = await tab(context);
        const id = await page.evaluate(async () => {
          const handle = await mg.open().create({ name: "Upgrade", root: {} });
          Object.assign(globalThis, { handle });
          return handle.id;
        });
        const name = NAMES.project(id);
        await other.evaluate(
          (name) =>
            new Promise<void>((resolve, reject) => {
              const request = indexedDB.open(name, 2);
              request.onsuccess = () => {
                request.result.close();
                resolve();
              };
              request.onerror = () => reject(request.error);
            }),
          name,
        );
        const edited = await page.evaluate(async () => {
          const { handle } = globalThis as never as {
            handle: import("../webapp/src/project-repository").ProjectHandle;
          };
          const [root] = mg.project.projectForest(mg.content(handle));
          mg.project.replaceNodeText(handle.doc, root.id, "After upgrade");
          await handle.flush();
          return handle.durability().status;
        });
        expect(edited).toBe("saved");

        // A connection that ignores versionchange holds a deletion pending.
        await other.evaluate(
          (name) =>
            new Promise<void>((resolve) => {
              const request = indexedDB.open(name);
              request.onsuccess = () => {
                request.result.onversionchange = null;
                indexedDB.deleteDatabase(name).onblocked = () => resolve();
              };
            }),
          name,
        );
        const blocked = await page.evaluate(async (id) => {
          await mg.repo.close();
          return mg
            .open({ openTimeoutMs: 300 })
            .open(id)
            .then(
              () => "opened",
              (error) => `${error.name}:${error.reason}`,
            );
        }, id);
        expect(blocked).toBe("StorageError:blocked");

        await other.close();
        await reload(page);
        const texts = await page.evaluate(async (id) => {
          const handle = await mg.open().open(id);
          return handle.state().status;
        }, id);
        // The pending deletion ran once unblocked; nothing reseeded it.
        expect(texts).toBe("loading");
      }),
    TIMEOUT,
  );
});

test(
  "an interrupted import seed stays out of catalog recovery in another tab and after reload",
  () =>
    withContext(async (context) => {
      const first = await tab(context);
      const second = await tab(context);
      const staged = await first.evaluate(async () => {
        const repo = mg.open();
        const active = await repo.create({ name: "Active", root: {} });
        const id = crypto.randomUUID();
        // A crash after the seed commit leaves this durable pending marker.
        const catalog = await new Promise<IDBDatabase>((resolve) => {
          const open = indexedDB.open(repo.names.catalog);
          open.onsuccess = () => resolve(open.result);
        });
        const mark = catalog.transaction(["preferences"], "readwrite");
        const marked = new Promise<void>((resolve) => {
          mark.oncomplete = () => resolve();
        });
        mark.objectStore("preferences").put(true, `pendingImport/${id}`);
        await marked;
        catalog.close();
        const seed = mg.project.createProjectDocument(
          id,
          "Interrupted import",
          { text: "Complete seed" },
        );
        const db = await new Promise<IDBDatabase>((resolve) => {
          const open = indexedDB.open(repo.names.project(id));
          open.onupgradeneeded = () => {
            open.result.createObjectStore("updates", { autoIncrement: true });
            open.result.createObjectStore("custom");
          };
          open.onsuccess = () => resolve(open.result);
        });
        const write = db.transaction(["updates"], "readwrite");
        const saved = new Promise<void>((resolve) => {
          write.oncomplete = () => resolve();
        });
        write.objectStore("updates").add(mg.Y.encodeStateAsUpdate(seed));
        await saved;
        db.close();
        seed.destroy();
        return { active: active.id, staged: id };
      });
      expect(
        await second.evaluate(async () =>
          (await mg.open().list()).map(({ name }) => name),
        ),
      ).toEqual(["Active"]);
      await reload(first);
      expect(
        await first.evaluate(async () => {
          const repo = mg.open();
          return {
            ids: (await repo.list()).map(({ id }) => id),
            latest: await repo.latestProject(),
          };
        }),
      ).toEqual({ ids: [staged.active], latest: staged.active });
    }),
  TIMEOUT,
);

// Import publication has its own rollback path: cover both document and catalog COMMIT failures.
for (const [database, store] of [
  ["/project/", "updates"],
  ["/catalog", "projects"],
]) {
  test(
    `failed ${store} commits leave no imported document or catalog entry`,
    () =>
      withContext(async (context) => {
        const page = await tab(context);
        const result = await page.evaluate(
          async ([database, store]) => {
            const repo = mg.open();
            const active = await repo.create({
              name: "Kept",
              root: { text: "Keep me" },
            });
            const before = mg.content(active);
            const databases = (await indexedDB.databases())
              .map(({ name }) => name)
              .sort();
            const file = mg.files.parseProjectFile(
              mg.files.exportProjectDocument(active.doc),
            );
            mg.failWrites(database, store);
            const error = await repo
              .importContent(mg.files.prepareProjectImport(file).content)
              .then(
                () => "unexpected success",
                (error: Error) => error.name,
              );
            mg.clearFaults();
            return {
              error,
              before,
              after: mg.content(active),
              list: (await repo.list()).map(({ id, name }) => ({ id, name })),
              latest: await repo.latestProject(),
              id: active.id,
              databases,
              afterDatabases: (await indexedDB.databases())
                .map(({ name }) => name)
                .sort(),
            };
          },
          [database, store],
        );
        expect(result.error).toBe("StorageError");
        expect(result.after).toEqual(result.before);
        expect(result.list).toEqual([{ id: result.id, name: "Kept" }]);
        expect(result.latest).toBe(result.id);
        expect(result.afterDatabases).toEqual(result.databases);
        await reload(page);
        expect(
          await page.evaluate(async () =>
            (await mg.open().list()).map(({ name }) => name),
          ),
        ).toEqual(["Kept"]);
      }),
    TIMEOUT,
  );
}
