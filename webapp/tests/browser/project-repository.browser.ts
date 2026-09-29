import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";
import { storageNames } from "../../src/project-repository";
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

// Served by interception, so pages still load after going offline.
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
    "creates, edits, and reopens a project offline",
    () =>
      withContext(async (context) => {
        const page = await tab(context);
        await context.setOffline(true);
        const saved = await page.evaluate(async () => {
          const { project } = mg;
          const handle = await mg.open().create({
            name: "Offline",
            root: { text: "Root" },
          });
          const [root] = project.projectForest(mg.content(handle));
          project.createChild(handle.doc, root.id, { text: "Child" });
          project.replaceNodeText(handle.doc, root.id, "Root, edited");
          await handle.flush();
          return {
            online: navigator.onLine,
            id: handle.id,
            status: handle.durability().status,
            content: mg.content(handle),
          };
        });
        expect(saved.online).toBe(false);
        expect(saved.status).toBe("saved");

        await reload(page);
        const reopened = await page.evaluate(async () => {
          const repo = mg.open();
          const id = (await repo.latestProject()) as string;
          const list = await repo.list();
          const handle = await repo.open(id);
          return { id, list, content: mg.content(handle) };
        });
        expect(reopened.id).toBe(saved.id);
        expect(reopened.content).toEqual(saved.content);
        expect(
          reopened.list.map(({ id, name, registration }) => ({
            id,
            name,
            registration,
          })),
        ).toEqual([{ id: saved.id, name: "Offline", registration: "pending" }]);
      }),
    TIMEOUT,
  );

  test(
    "two tabs open, edit, and close the same project independently",
    () =>
      withContext(async (context) => {
        const first = await tab(context);
        const second = await tab(context);
        const id = await first.evaluate(async () => {
          const handle = await mg.open().create({
            name: "Shared",
            root: { text: "Root" },
          });
          Object.assign(globalThis, { handle });
          return handle.id;
        });
        const opened = await second.evaluate(async (id) => {
          const handle = await mg.open().open(id);
          Object.assign(globalThis, { handle });
          return mg.content(handle);
        }, id);
        expect(Object.keys(opened.nodes)).toHaveLength(1);
        const rootId = Object.keys(opened.nodes)[0];

        await first.evaluate((rootId) => {
          const { handle } = globalThis as never as {
            handle: import("../src/project-repository").ProjectHandle;
          };
          mg.project.createChild(handle.doc, rootId, { text: "From first" });
        }, rootId);
        await second.waitForFunction(() => {
          const { handle } = globalThis as never as {
            handle: import("../src/project-repository").ProjectHandle;
          };
          return mg.liveNodes(handle) === 2;
        });

        // Closing the first tab's repository must not disturb the second tab.
        await first.evaluate(() => mg.repo.close());
        const after = await second.evaluate(async (rootId) => {
          const { handle } = globalThis as never as {
            handle: import("../src/project-repository").ProjectHandle;
          };
          mg.project.createChild(handle.doc, rootId, { text: "From second" });
          await handle.flush();
          return {
            status: handle.durability().status,
            databases: (await indexedDB.databases()).map(({ name }) => name),
          };
        }, rootId);
        expect(after.status).toBe("saved");
        expect(after.databases).toContain(NAMES.project(id));

        await reload(first);
        const texts = await first.evaluate(async (id) => {
          const handle = await mg.open().open(id);
          return Object.values(mg.content(handle).nodes)
            .map(({ text }) => text)
            .sort();
        }, id);
        expect(texts).toEqual(["From first", "From second", "Root"]);
      }),
    TIMEOUT,
  );

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
            handle: import("../src/project-repository").ProjectHandle;
          };
          return handle.state().status === "ready";
        });
        const duplicate = await second.evaluate(async (id) => {
          const { handle } = globalThis as never as {
            handle: import("../src/project-repository").ProjectHandle;
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
    "refreshes renamed metadata and restores the latest project",
    () =>
      withContext(async (context) => {
        const page = await tab(context);
        const other = await tab(context);
        await other.evaluate(() => {
          const repo = mg.open();
          Object.assign(globalThis, { changes: 0 });
          repo.onCatalogChange(() => {
            (globalThis as never as { changes: number }).changes++;
          });
        });
        const ids = await page.evaluate(async () => {
          const repo = mg.open();
          const first = await repo.create({ name: "Same" });
          const second = await repo.create({ name: "Same" });
          await second.close();
          mg.project.renameProject(first.doc, "Renamed");
          await first.refreshMetadata();
          await repo.setPreference(`project/${first.id}/view`, { zoom: 2 });
          return { first: first.id, second: second.id };
        });
        await other.waitForFunction(
          () => (globalThis as never as { changes: number }).changes >= 3,
        );

        await reload(page);
        const restored = await page.evaluate(async () => {
          const repo = mg.open();
          const latest = (await repo.latestProject()) as string;
          const handle = await repo.open(latest);
          return {
            latest,
            name: mg.content(handle).metadata.name,
            names: (await repo.list()).map(({ name }) => name),
            view: await repo.preference(`project/${latest}/view`),
          };
        });
        expect(restored).toEqual({
          latest: ids.second,
          name: "Same",
          names: ["Renamed", "Same"],
          view: undefined,
        });
        const first = await page.evaluate(async (id) => {
          const handle = await mg.repo.open(id);
          return {
            latest: await mg.repo.latestProject(),
            name: mg.content(handle).metadata.name,
            view: await mg.repo.preference(`project/${id}/view`),
          };
        }, ids.first);
        expect(first).toEqual({
          latest: ids.first,
          name: "Renamed",
          view: { zoom: 2 },
        });
      }),
    TIMEOUT,
  );

  test(
    "isolates projects by deployment, namespace, and UUID",
    () =>
      withContext(async (context) => {
        const page = await tab(context);
        const result = await page.evaluate(async () => {
          const anonymous = mg.open();
          const account = mg.open({
            namespace: mg.storage.accountNamespace(7),
          });
          const staging = mg.open({ deployment: "staging" });
          const first = await anonymous.create({ name: "One", root: {} });
          const second = await anonymous.create({ name: "Two", root: {} });
          mg.project.renameProject(first.doc, "One, renamed");
          await first.refreshMetadata();
          const elsewhere = await account.open(first.id);
          return {
            anonymous: (await anonymous.list()).map(({ name }) => name),
            account: (await account.list()).length,
            staging: (await staging.list()).length,
            accountLatest: await account.latestProject(),
            elsewhere: elsewhere.state().status,
            second: mg.content(second).metadata.name,
            databases: (await indexedDB.databases())
              .map(({ name }) => name)
              .sort(),
            ids: [first.id, second.id],
          };
        });
        expect(result.anonymous).toEqual(["One, renamed", "Two"]);
        expect(result.account).toBe(0);
        expect(result.staging).toBe(0);
        expect(result.accountLatest).toBeUndefined();
        expect(result.elsewhere).toBe("loading");
        expect(result.second).toBe("Two");
        const account = storageNames({
          deployment: "test",
          namespace: "account-7",
        });
        expect(result.databases).toEqual(
          [
            NAMES.catalog,
            NAMES.project(result.ids[0]),
            NAMES.project(result.ids[1]),
            account.catalog,
            account.project(result.ids[0]),
            storageNames({ deployment: "staging", namespace: "anonymous" })
              .catalog,
          ].sort(),
        );
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
            handle: import("../src/project-repository").ProjectHandle;
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
            handle: import("../src/project-repository").ProjectHandle;
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
            handle: import("../src/project-repository").ProjectHandle;
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
