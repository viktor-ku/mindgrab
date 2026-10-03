// SQLx owns the disposable database and test-only fault/control listener.
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, release, tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { build } from "vite";
import type { ReleaseHarness } from "./release-harness";

declare const mg: ReleaseHarness;
const config = JSON.parse(await Bun.stdin.text()) as {
  controlUrl: string;
  cookie: string;
  otherCookie: string;
  rustVersion: string;
  postgresVersion: string;
};
const budgets = {
  editP95Ms: 50,
  reopenMs: 2500,
  replayMs: 500,
  cloudMs: 10_000,
  convergenceMs: 35_000,
  payloadBytesPerNode: 1500,
};
const directory = await mkdtemp(join(tmpdir(), "mindgrab-release-"));
const outDir = join(directory, "dist");
const contexts: BrowserContext[] = [];
const errors: string[] = [];
const metrics: Record<string, unknown>[] = [];
let upstreams: string[] = [];
let active = 0;
let apiAvailable = true;
let socketsEnabled = true;
let dropReceipt = false;
let delayedReceipt: Promise<void> | undefined;
let failedCommits = 0;
let droppedId = "";
const attempts = new Map<string, number>();
const batches = new Map<
  string,
  { bytes: Uint8Array<ArrayBuffer>; receipt: unknown }
>();
const changedRetries: string[] = [];
const sockets = new Set<{ close(): void }>();
async function control(action: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(config.controlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, origin, ...extra }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Control ${action}: ${response.status}`);
  return response.json();
}
// Real HTTP proxy; static assets are served from one production build. Browser
// interception is never used, so the cold reopen must use the real shell cache.
const ProxyWebSocket = globalThis.WebSocket as unknown as {
  new (url: string, options: { headers: Record<string, string> }): WebSocket;
};
type ProxySocket = {
  peer: WebSocket;
  queued: (string | Uint8Array<ArrayBuffer>)[];
};
const server = Bun.serve<ProxySocket>({
  hostname: "localhost",
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/auth/") ||
      url.pathname.startsWith("/sync/")
    ) {
      const call = url.pathname + url.search;
      if (!apiAvailable)
        return new Response("API processes stopped by fixture", {
          status: 503,
        });
      if (url.pathname.startsWith("/sync/v1/")) {
        if (!socketsEnabled) return new Response(null, { status: 503 });
        const peer = new ProxyWebSocket(
          `${upstreams[active].replace("http:", "ws:")}${url.pathname}${url.search}`,
          {
            headers: {
              Cookie: request.headers.get("cookie") ?? "",
              Origin: origin,
            },
          },
        );
        const data = {
          peer,
          queued: [] as (string | Uint8Array<ArrayBuffer>)[],
        };
        peer.addEventListener("open", () => {
          for (const message of data.queued.splice(0)) peer.send(message);
        });
        peer.addEventListener("error", () => peer.close());
        if (server.upgrade(request, { data })) return;
        peer.close();
        return new Response(null, { status: 400 });
      }
      const headers = new Headers(request.headers);
      headers.set("Origin", origin);
      headers.delete("host");
      const body =
        request.method === "GET" ? undefined : await request.arrayBuffer();
      if (url.pathname === "/api/submitProjectUpdate") {
        const previous = batches.get(call);
        if (
          previous &&
          !Buffer.from(previous.bytes).equals(
            Buffer.from(body ?? new ArrayBuffer(0)),
          )
        )
          changedRetries.push(call);
      }
      const response = await fetch(
        `${upstreams[active]}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (url.pathname === "/api/submitProjectUpdate") {
        attempts.set(call, (attempts.get(call) ?? 0) + 1);
        if (response.status >= 500) failedCommits++;
        if (response.ok && body)
          batches.set(call, {
            bytes: new Uint8Array(body),
            receipt: await response.clone().json(),
          });
        if (response.ok && dropReceipt) {
          dropReceipt = false;
          droppedId = call;
          // The real COMMIT has finished; discard its receipt before the browser.
          return new Response("Injected lost receipt", { status: 502 });
        }
        if (response.ok && delayedReceipt) await delayedReceipt;
      }
      return response;
    }
    const file = Bun.file(
      join(outDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1)),
    );
    return (await file.exists())
      ? new Response(file, { headers: { "Cache-Control": "no-store" } })
      : new Response("Not found", { status: 404 });
  },
  websocket: {
    open(socket) {
      sockets.add(socket);
      const peer = socket.data.peer;
      peer.binaryType = "arraybuffer";
      peer.addEventListener("message", (event) => socket.send(event.data));
      peer.addEventListener("close", () => socket.close());
    },
    message(socket, message) {
      if (socket.data.peer.readyState === WebSocket.OPEN)
        socket.data.peer.send(
          typeof message === "string" ? message : new Uint8Array(message),
        );
      else
        socket.data.queued.push(
          typeof message === "string" ? message : new Uint8Array(message),
        );
    },
    close(socket) {
      sockets.delete(socket);
      socket.data.peer.close();
    },
  },
});
const origin = `http://localhost:${server.port}`;
function closeSockets() {
  socketsEnabled = false;
  for (const socket of sockets) socket.close();
}
async function context(
  cookie = config.cookie,
  profile: string = crypto.randomUUID(),
) {
  const context = await chromium.launchPersistentContext(
    join(directory, profile),
    { headless: true },
  );
  contexts.push(context);
  // Exercise the production browser-compatible download/file-input path.
  await context.addInitScript(() => {
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined });
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined });
  });
  context.setDefaultTimeout(budgets.cloudMs);
  const [name, value] = cookie.split("=");
  await context.addCookies([
    { name, value, url: origin, httpOnly: true, sameSite: "Lax" },
  ]);
  context.on("page", (page) =>
    page.on("pageerror", (error) => errors.push(error.message)),
  );
  for (const page of context.pages())
    page.on("pageerror", (error) => errors.push(error.message));
  return context;
}
async function load(context: BrowserContext) {
  const page = await context.newPage();
  const start = performance.now();
  await page.goto(origin);
  await page.waitForSelector('[data-storage-ready="true"]');
  await page.waitForFunction(() => Boolean(mg.doc()));
  return { page, ms: performance.now() - start };
}
async function locallySaved(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="Project actions"]')
      ?.textContent?.includes("Saved locally"),
  );
}
async function cloudSaved(page: Page) {
  await page.getByText("Saved to cloud", { exact: true }).waitFor();
}
async function offline(context: BrowserContext, value: boolean) {
  await context.setOffline(value);
  for (const page of context.pages())
    await page.evaluate(
      (value) => window.dispatchEvent(new Event(value ? "offline" : "online")),
      value,
    );
}
async function choose(page: Page, name: string) {
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page.waitForFunction(
    (name) => mg.content().metadata.name === name,
    name,
  );
}
async function canonical(page: Page) {
  return page.evaluate(() => mg.content());
}
let convergenceRound = 0;
async function converge(a: Page, b: Page) {
  console.error(`convergence round ${++convergenceRound}`);
  await cloudSaved(a);
  await cloudSaved(b);
  try {
    await waitUntil(
      async () => {
        const values = await Promise.all([
          a.evaluate(() => mg.canonical()),
          b.evaluate(() => mg.canonical()),
        ]);
        return Boolean(values[0]) && values[0] === values[1];
      },
      "replica convergence",
      budgets.convergenceMs,
    );
  } catch (error) {
    for (const page of [a, b])
      console.error(
        "Replica at failure",
        await page.evaluate(() => ({
          id: mg.doc().guid,
          state: mg.project.readProject(mg.doc()).status,
          content: mg.canonical()?.slice(0, 3000),
          ui: document.body.innerText.slice(0, 1000),
        })),
      );
    throw error;
  }
  const expected = await canonical(a);
  expect(await canonical(b)).toEqual(expected);
  return expected;
}

function fixture(count: number) {
  return JSON.stringify({
    format: "mindgrab-project",
    version: 2,
    project: {
      name: `Release ${count}`,
      nodes: [
        {
          id: "root",
          text: "Release root 🌍",
          color: "blue",
          children: Array.from({ length: count - 1 }, (_, i) => ({
            id: `n${i}`,
            text: `Idea ${i} 🌍 `.repeat(8),
            color: "green",
            children: [],
          })),
        },
      ],
    },
  });
}
async function importFile(page: Page, json: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await (await chooser).setFiles({
    name: "release.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
}
try {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({
      root: join(import.meta.dir, "../.."),
      logLevel: "silent",
      envDir: false,
      define: { "import.meta.env.VITE_BACKEND_URL": JSON.stringify("") },
      plugins: [
        {
          name: "release-observation",
          enforce: "pre",
          transform(code, id) {
            if (id.endsWith("/src/App.tsx"))
              return code.replace(
                "props.onDocument?.(current)",
                "(props.onDocument?.(current), globalThis.__releaseDoc = current)",
              );
          },
          transformIndexHtml: {
            order: "pre",
            handler: (html) =>
              html.replace(
                "</head>",
                '<script type="module" src="/tests/browser/release-harness.ts"></script></head>',
              ),
          },
        },
      ],
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  upstreams = (await control("start")).urls;
  const aContext = await context(config.cookie, "device-a");
  const bContext = await context(config.cookie, "device-b");
  const { page: a } = await load(aContext);
  await cloudSaved(a);
  await a.getByLabel("Project name").fill("Shared release project");
  await a.getByLabel("Project name").press("Tab");
  await cloudSaved(a);
  let id = await a.evaluate(() => mg.doc().guid);
  const { page: b } = await load(bContext);
  await cloudSaved(b);
  await choose(b, "Shared release project");
  await cloudSaved(b);
  // Independent API processes share Postgres, including live browser sockets.
  active = 1;
  await b.reload();
  await b.waitForSelector('[data-storage-ready="true"]');
  await a.evaluate(() => mg.edit("Live 🌍 "));
  await b.waitForFunction(() =>
    mg.content().nodes[mg.root()].text.startsWith("Live 🌍 "),
  );
  console.error("phase: live convergence");
  await converge(a, b);

  await a.waitForFunction(
    async () =>
      (await navigator.serviceWorker.getRegistration())?.active?.state ===
      "activated",
  );
  await a.reload();
  await a.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await cloudSaved(a);
  closeSockets();
  await offline(aContext, true);
  await offline(bContext, true);
  await a.evaluate(() => {
    mg.edit("Offline A ");
    mg.child("A branch");
  });
  await b.evaluate(() => {
    mg.edit("Offline B ");
    mg.child("B branch");
  });
  await locallySaved(a);
  await locallySaved(b);
  const localA = await canonical(a);
  // Browser process termination after acknowledged IndexedDB commit. Reopen a
  // direct URL while offline with the same profile; no routed assets/fallback.
  const browser = aContext.browser();
  if (!browser) throw new Error("Persistent Chromium has no browser process");
  const cdp = await browser.newBrowserCDPSession();
  const processes = await cdp.send("SystemInfo.getProcessInfo");
  const browserProcess = processes.processInfo.find(
    (process) => process.type === "browser",
  );
  if (!browserProcess) throw new Error("Chromium process identity unavailable");
  const disconnected = new Promise<void>((resolve) =>
    browser.once("disconnected", () => resolve()),
  );
  process.kill(browserProcess.id, "SIGKILL");
  await Promise.race([
    disconnected,
    Bun.sleep(5000).then(() => {
      throw new Error("Browser SIGKILL exceeded 5s");
    }),
  ]);
  const recoveredContext = await context(config.cookie, "device-a");
  await offline(recoveredContext, true);
  const reopened = await load(recoveredContext);
  const ar = reopened.page;
  expect(reopened.ms).toBeLessThan(budgets.reopenMs);
  expect(await canonical(ar)).toEqual(localA);
  expect(
    await ar.getByRole("button", { name: "Undo", exact: true }).isDisabled(),
  ).toBe(true);
  await ar.evaluate(() => mg.child("Created offline after crash"));
  await locallySaved(ar);
  // A second tab still exchanges documents offline via the scoped relay.
  const { page: a2 } = await load(recoveredContext);
  await ar.evaluate(() => mg.edit("Offline tab "));
  await a2.waitForFunction(() =>
    mg.content().nodes[mg.root()].text.startsWith("Offline tab "),
  );
  await locallySaved(ar);
  await a2.close();

  dropReceipt = true;
  await offline(recoveredContext, false);
  await offline(bContext, false);
  console.error("phase: offline convergence");
  const merged = await converge(ar, b);
  expect(
    Object.values(merged.nodes).filter((node) => !node.deleted).length,
  ).toBe(4);
  expect(merged.nodes[await ar.evaluate(() => mg.root())].text).toContain(
    "Offline A",
  );
  expect(merged.nodes[await ar.evaluate(() => mg.root())].text).toContain(
    "Offline B",
  );
  expect(droppedId).not.toBe("");
  expect(attempts.get(droppedId)).toBeGreaterThanOrEqual(2);

  // A receipt delayed past a newer edit must never acknowledge that edit.
  let releaseReceipt: () => void = () => {};
  delayedReceipt = new Promise((resolve) => {
    releaseReceipt = resolve;
  });
  const beforeAttempts = Array.from(attempts.values()).reduce(
    (a, b) => a + b,
    0,
  );
  await ar.evaluate(() => mg.edit("Delayed batch "));
  await locallySaved(ar);
  await waitUntil(
    () =>
      Array.from(attempts.values()).reduce((a, b) => a + b, 0) > beforeAttempts,
    "delayed update submission",
  );
  await ar.evaluate(() => mg.edit("Newer generation "));
  await locallySaved(ar);
  expect(
    await ar.getByText("Saved to cloud", { exact: true }).isVisible(),
  ).toBe(false);
  delayedReceipt = undefined;
  releaseReceipt();
  await converge(ar, b);

  // Local undo retains a same-node remote edit; redo restores only local work.
  await ar.reload();
  await ar.waitForSelector('[data-storage-ready="true"]');
  await cloudSaved(ar);
  const beforeUndo = await ar.evaluate(
    () => mg.content().nodes[mg.root()].text,
  );
  await ar.evaluate(() => mg.edit("UNDO-LOCAL "));
  await cloudSaved(ar);
  await b.evaluate(() => mg.edit("KEEP-REMOTE "));
  await converge(ar, b);
  await ar.getByRole("button", { name: "Undo", exact: true }).click();
  await converge(ar, b);
  expect(await ar.evaluate(() => mg.content().nodes[mg.root()].text)).toBe(
    `KEEP-REMOTE ${beforeUndo}`,
  );
  await ar.getByRole("button", { name: "Redo", exact: true }).click();
  await converge(ar, b);
  const redone = await ar.evaluate(() => mg.content().nodes[mg.root()].text);
  expect(redone.split("UNDO-LOCAL ").length).toBe(2);
  expect(redone.replace("UNDO-LOCAL ", "")).toBe(`KEEP-REMOTE ${beforeUndo}`);
  socketsEnabled = true;
  await ar.reload();
  await b.reload();
  await ar.waitForSelector('[data-storage-ready="true"]');
  await b.waitForSelector('[data-storage-ready="true"]');
  await cloudSaved(ar);
  await cloudSaved(b);
  closeSockets();

  // Deferred database COMMIT failure cannot produce a cloud acknowledgement.
  const beforeFailure = await control("inspect", { projectId: id });
  await control("commit-failure", { enabled: true });
  await ar.evaluate(() => mg.edit("COMMIT-RETRY "));
  await locallySaved(ar);
  await waitUntil(() => failedCommits > 0, "injected DB commit failure");
  expect(
    await ar.getByText("Saved to cloud", { exact: true }).isVisible(),
  ).toBe(false);
  const afterFailure = await control("inspect", { projectId: id });
  expect(afterFailure.receipts).toBe(beforeFailure.receipts);
  expect(afterFailure.state.content).toEqual(beforeFailure.state.content);
  await control("commit-failure", { enabled: false });
  await converge(ar, b);

  // Aborted IndexedDB transactions report failure. Retrying saves retained edits.
  await offline(recoveredContext, true);
  await ar.evaluate(() => {
    mg.storageFault(true);
    mg.edit("IDB-RETRY ");
  });
  await ar.getByText(/browser did not commit/i).waitFor();
  expect(await ar.getByText("Saved locally", { exact: true }).isVisible()).toBe(
    false,
  );
  await ar.evaluate(() => mg.storageFault(false));
  await locallySaved(ar);
  await offline(recoveredContext, false);
  await converge(ar, b);

  socketsEnabled = true;
  await ar.reload();
  await b.reload();
  await ar.waitForSelector('[data-storage-ready="true"]');
  await b.waitForSelector('[data-storage-ready="true"]');
  await cloudSaved(ar);
  await cloudSaved(b);

  // Pure deletions do not advance the state vector, but must survive every layer.
  await offline(recoveredContext, true);
  const deletion = await ar.evaluate(() => {
    const before = Array.from(mg.Y.encodeStateVector(mg.doc()));
    const text = mg.content().nodes[mg.root()].text;
    mg.project.editNodeText(mg.doc(), mg.root(), 0, text.length, "");
    return { before, after: Array.from(mg.Y.encodeStateVector(mg.doc())) };
  });
  expect(deletion.after).toEqual(deletion.before);
  await locallySaved(ar);
  await ar.reload();
  await ar.waitForSelector('[data-storage-ready="true"]');
  expect(await ar.evaluate(() => mg.content().nodes[mg.root()].text)).toBe("");
  await offline(recoveredContext, false);
  await converge(ar, b);
  active = 0;
  upstreams = (await control("restart")).urls;
  await ar.reload();
  await ar.waitForSelector('[data-storage-ready="true"]');
  await cloudSaved(ar);
  expect(await ar.evaluate(() => mg.content().nodes[mg.root()].text)).toBe("");

  await conflictAndReorder(ar, id);
  await converge(ar, b);
  // Pinned Yrs can refuse re-encoding some Unicode/undo histories. That is a
  // safe outcome only if every original row remains and content is unchanged.
  const mixedBefore = await control("inspect", { projectId: id });
  const mixedCompact = await control("compact", { projectId: id });
  const mixedAfter = await control("inspect", { projectId: id });
  expect(mixedAfter.state.content).toEqual(mixedBefore.state.content);
  expect(mixedAfter.receipts).toBe(mixedBefore.receipts);
  if (!mixedCompact.coverage) {
    expect(mixedCompact.prunedRows).toBe(0);
    expect(mixedAfter.rows).toBe(mixedBefore.rows);
    expect(mixedAfter.logBytes).toBe(mixedBefore.logBytes);
  }
  // A fresh history must actually publish/prune; the conservative refusal
  // above cannot accidentally turn the successful compaction gate into a no-op.
  await ar.getByRole("button", { name: "New", exact: true }).click();
  await ar.waitForFunction(
    (previous) =>
      mg.doc().guid !== previous &&
      document.querySelector('[data-storage-ready="true"]'),
    id,
  );
  await ar.getByLabel("Project name").fill("Compaction release project");
  await ar.getByLabel("Project name").press("Tab");
  await cloudSaved(ar);
  id = await ar.evaluate(() => mg.doc().guid);
  await b.reload();
  await b.waitForSelector('[data-storage-ready="true"]');
  await choose(b, "Compaction release project");
  await cloudSaved(b);
  await offline(bContext, true);
  const offlineBranch = await b.evaluate(() =>
    mg.child("Long-offline branch 🌍"),
  );
  await locallySaved(b);
  const textBeforeCompaction = await ar.evaluate(
    () => mg.content().nodes[mg.root()].text,
  );
  await ar.evaluate(() => mg.edit("Compacted online "));
  await cloudSaved(ar);
  const beforeCompact = await control("inspect", { projectId: id });
  const compact = await control("compact", { projectId: id });
  expect(compact.coverage).toBe(true);
  expect(compact.prunedRows).toBeGreaterThan(0);
  const compacted = await control("inspect", { projectId: id });
  expect(compacted.rows).toBe(0);
  expect(compacted.receipts).toBe(beforeCompact.receipts);
  expect(compacted.state.content).toEqual(beforeCompact.state.content);
  const original = [...batches.entries()].find(([path]) => path.includes(id));
  if (!original) throw new Error("Missing committed batch for receipt retry");
  const retried = await ar.request.post(`${origin}${original[0]}`, {
    headers: {
      Origin: origin,
      "Content-Type": "application/octet-stream",
      "X-Mindgrab-Schema-Version": "1",
    },
    data: Buffer.from(original[1].bytes),
  });
  expect(retried.ok()).toBe(true);
  expect(await retried.json()).toEqual(original[1].receipt);
  await ar.getByRole("button", { name: "Undo", exact: true }).click();
  await cloudSaved(ar);
  expect(await ar.evaluate(() => mg.content().nodes[mg.root()].text)).toBe(
    textBeforeCompaction,
  );
  await ar.getByRole("button", { name: "Redo", exact: true }).click();
  await cloudSaved(ar);
  expect(await ar.evaluate(() => mg.content().nodes[mg.root()].text)).toBe(
    `Compacted online ${textBeforeCompaction}`,
  );
  await offline(bContext, false);
  const finalContent = await converge(ar, b);
  if (!offlineBranch) throw new Error("Offline child creation failed");
  expect(finalContent.nodes[offlineBranch].text).toBe("Long-offline branch 🌍");

  const durable = await control("inspect", { projectId: id });
  expect(durable.state.current).toBe(true);
  expect(durable.state.content).toEqual(finalContent);
  const restored = await control("restore", { projectId: id });
  expect(restored.state.content).toEqual(finalContent);
  expect(restored.state.placements).toEqual(durable.state.placements);
  expect(restored.state.current).toBe(true);
  upstreams.push(restored.url);
  active = upstreams.length - 1;
  const restoredContext = await context(restored.cookie);
  const { page: restorePage } = await load(restoredContext);
  await cloudSaved(restorePage);
  await choose(restorePage, "Compaction release project");
  await cloudSaved(restorePage);
  expect(await canonical(restorePage)).toEqual(finalContent);
  await restoredContext.close();
  active = 0;

  await verifyAccounts(ar, id, recoveredContext);
  await measurements(ar);
  expect(changedRetries).toEqual([]);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      converged: true,
      budgets,
      metrics,
      faults: { droppedReceiptRetries: attempts.get(droppedId), failedCommits },
      environment: {
        os: `${process.platform} ${release()}`,
        cpu: cpus()[0]?.model,
        cpuCount: cpus().length,
        bun: Bun.version,
        chromium: await ar.context().browser()?.version(),
        rust: config.rustVersion,
        postgres: config.postgresVersion,
      },
    }),
  );
} finally {
  delayedReceipt = undefined;
  for (const context of contexts) await context.close().catch(() => {});
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  budget = budgets.cloudMs,
) {
  const deadline = performance.now() + budget;
  while (!(await predicate())) {
    if (performance.now() >= deadline)
      throw new Error(`${label} exceeded ${budget}ms`);
    await Bun.sleep(20);
  }
}

async function conflictAndReorder(page: Page, id: string) {
  const scenario = await page.evaluate(() => {
    const root = mg.root();
    const base = mg.Y.encodeStateAsUpdate(mg.doc());
    const replicas = [new mg.Y.Doc(), new mg.Y.Doc()];
    const updates: number[][] = [];
    for (const doc of replicas) mg.Y.applyUpdate(doc, base);
    for (const [index, doc] of replicas.entries()) {
      doc.on("update", (bytes) => updates.push(Array.from(bytes)));
      mg.project.editNodeText(doc, root, 0, 0, `ordered-${index}-1 `);
      mg.project.editNodeText(doc, root, 0, 0, `ordered-${index}-2 `);
    }
    // Legal cycle/orphan conflicts must be resolved by projection alone.
    const branches = Object.keys(mg.content().nodes)
      .filter((node) => node !== root)
      .slice(0, 3);
    replicas[0].transact(() => {
      const nodes = replicas[0]
        .getMap("project")
        .get("nodes") as import("yjs").Map<import("yjs").Map<unknown>>;
      nodes
        .get(branches[0])
        ?.set("placement", { parent: branches[1], rank: "a0" });
      nodes
        .get(branches[1])
        ?.set("placement", { parent: branches[0], rank: "a0" });
      nodes.get(branches[2])?.set("placement", {
        parent: "ffffffff-ffff-4fff-bfff-ffffffffffff",
        rank: "a0",
      });
    });
    const expected = new mg.Y.Doc();
    mg.Y.applyUpdate(expected, base);
    for (const bytes of updates)
      mg.Y.applyUpdate(expected, Uint8Array.from(bytes));
    const content = mg.project.materializeProject(expected);
    const forest = mg.project.projectForest(content);
    for (const doc of [...replicas, expected]) doc.destroy();
    return { updates, content, forest };
  });
  async function put(index: number) {
    const response = await page.request.post(
      `${origin}/api/submitProjectUpdate?${new URLSearchParams({ projectId: id, updateId: crypto.randomUUID() })}`,
      {
        headers: {
          Origin: origin,
          "Content-Type": "application/octet-stream",
          "X-Mindgrab-Schema-Version": "1",
        },
        data: Buffer.from(scenario.updates[index]),
      },
    );
    expect(response.ok()).toBe(true);
    return response.json();
  }
  expect((await put(1)).validation).toBe("pending_dependencies");
  await put(1);
  await put(3);
  await put(4);
  await put(2);
  expect((await put(0)).validation).toBe("valid");
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  await cloudSaved(page);
  expect(await canonical(page)).toEqual(scenario.content);
  expect(await page.evaluate(() => mg.forest())).toEqual(scenario.forest);
  const state = (await control("inspect", { projectId: id })).state;
  expect(state.content).toEqual(scenario.content);
  const jsParents = await page.evaluate(() =>
    Object.fromEntries(mg.project.effectiveParents(mg.content())),
  );
  for (const [node, parent] of Object.entries(jsParents))
    expect(state.placements[node].parent).toEqual(parent);
}

async function verifyAccounts(
  page: Page,
  id: string,
  ownerContext: BrowserContext,
) {
  const content = await canonical(page);
  const [name, value] = config.otherCookie.split("=");
  await ownerContext.addCookies([
    { name, value, url: origin, httpOnly: true, sameSite: "Lax" },
  ]);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  await page.getByText("Other", { exact: true }).waitFor();
  expect(await page.evaluate(() => mg.doc().guid)).not.toBe(id);
  for (const method of [
    "getProject",
    "getProjectBaseline",
    "getProjectState",
    "getProjectUpdates",
  ]) {
    const response = await page.request.post(`${origin}/api/${method}`, {
      data: { projectId: id },
    });
    expect(response.status()).toBe(404);
  }
  const write = await page.request.post(
    `${origin}/api/submitProjectUpdate?${new URLSearchParams({ projectId: id, updateId: crypto.randomUUID() })}`,
    {
      headers: {
        Origin: origin,
        "Content-Type": "application/octet-stream",
        "X-Mindgrab-Schema-Version": "1",
      },
      data: Buffer.from([0, 0]),
    },
  );
  expect(write.status()).toBe(404);
  const [ownerName, ownerValue] = config.cookie.split("=");
  await ownerContext.addCookies([
    {
      name: ownerName,
      value: ownerValue,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  await cloudSaved(page);
  expect(await canonical(page)).toEqual(content);
}

async function measurements(page: Page) {
  for (const count of [10, 1000]) {
    await importFile(page, fixture(count));
    await page.waitForFunction(
      (count) => Object.keys(mg.content().nodes).length === count,
      count,
    );
    await cloudSaved(page);
    const id = await page.evaluate(() => mg.doc().guid);
    const edits = await page.evaluate(() => mg.benchmark(100));
    expect(edits.p95).toBeLessThan(budgets.editP95Ms);
    await locallySaved(page);
    await cloudSaved(page);
    // Freeze all writers after the acknowledged save. No socket echo or worker
    // can append another row between the two storage/replay measurements.
    await offline(page.context(), true);
    apiAvailable = false;
    await control("stop");
    const before = await control("inspect", { projectId: id });
    expect(before.replayMs).toBeLessThan(budgets.replayMs);
    const compact = await control("compact", { projectId: id });
    expect(compact.coverage).toBe(true);
    const after = await control("inspect", { projectId: id });
    expect(after.rows).toBe(0);
    expect(after.replayMs).toBeLessThan(budgets.replayMs);
    expect(before.logBytes + before.checkpointBytes).toBeLessThan(
      count * budgets.payloadBytesPerNode,
    );
    expect(after.checkpointBytes).toBeLessThan(
      count * budgets.payloadBytesPerNode,
    );
    expect(after.receipts).toBe(before.receipts);
    expect(after.state.content).toEqual(await canonical(page));
    const start = performance.now();
    await page.reload();
    await page.waitForSelector('[data-storage-ready="true"]');
    await page.waitForFunction(
      (count) => Object.keys(mg.content().nodes).length === count,
      count,
    );
    const reopenMs = performance.now() - start;
    expect(reopenMs).toBeLessThan(budgets.reopenMs);
    expect(await canonical(page)).toEqual(after.state.content);
    upstreams = (await control("start")).urls;
    apiAvailable = true;
    active = 0;
    await offline(page.context(), false);
    await cloudSaved(page);
    const expectedFile = JSON.parse(await page.evaluate(() => mg.export()));
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const download = await downloadEvent;
    const path = await download.path();
    if (!path) throw new Error("Export did not produce a file");
    const json = await Bun.file(path).text();
    const exported = JSON.parse(json);
    expect(exported.format).toBe(expectedFile.format);
    expect(exported.version).toBe(expectedFile.version);
    expect(exported.project).toEqual(expectedFile.project);
    await importFile(page, json);
    await page.waitForFunction((id) => mg.doc().guid !== id, id);
    await cloudSaved(page);
    const imported = JSON.parse(await page.evaluate(() => mg.export()));
    const stripIds = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripIds);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "id")
            .map(([key, value]) => [key, stripIds(value)]),
        );
      return value;
    };
    expect(stripIds(imported.project)).toEqual(stripIds(expectedFile.project));
    const summary = (value: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "state"),
      );
    metrics.push({
      nodes: count,
      edits,
      reopenMs,
      before: summary(before),
      after: summary(after),
      compact,
    });
  }
  await importFile(
    page,
    JSON.stringify({
      format: "mindgrab-project",
      version: 2,
      project: { name: "Release empty", nodes: [] },
    }),
  );
  await page.waitForFunction(
    () => mg.content().metadata.name === "Release empty",
  );
  await cloudSaved(page);
  await page.reload();
  await page.waitForSelector('[data-storage-ready="true"]');
  await cloudSaved(page);
  expect(await page.evaluate(() => mg.forest())).toEqual([]);
  const empty = await control("inspect", {
    projectId: await page.evaluate(() => mg.doc().guid),
  });
  expect(empty.state.content.nodes).toEqual({});
}
