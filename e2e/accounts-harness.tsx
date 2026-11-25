import { QueryClientProvider } from "@tanstack/solid-query";
import { RouterProvider } from "@tanstack/solid-router";
import { appRouter } from "./app-router";
import { queryClient } from "../webapp/src/query-client";
import { render } from "solid-js/web";
import type { ProjectDocument } from "../webapp/src/project-document";
import { App } from "../webapp/src/App";
import { claimAnonymousProjects } from "../webapp/src/anonymous-claims";
import { ProjectRepository } from "../webapp/src/project-repository";
import * as project from "../webapp/src/project-document";
import { levelRows } from "../webapp/src/preferences";
import type { SavingPreferences } from "../webapp/src/preferences";
import "../webapp/src/index.css";

let current: ProjectDocument;

// HTTP provides actual durable baselines/receipts in this fixture. Hold socket
// connections open so account transitions must explicitly destroy providers.
const sockets = new Set<Socket>();
class Socket {
  static OPEN = 1;
  static CLOSING = 2;
  readonly url: string;
  readyState = 0;
  binaryType = "arraybuffer";
  onopen?: (event: Event) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: Event) => void;
  constructor(url: string) {
    this.url = url;
    sockets.add(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    sockets.delete(this);
    this.onclose?.({ code: 1000, reason: "" });
  }
}
window.WebSocket = Socket as unknown as typeof WebSocket;

// Everything this page has told the user, including what cleared itself again
// before a test could look.
const messages = new Set<string>();
new MutationObserver(() => {
  for (const element of document.querySelectorAll(
    '[data-storage-message], .notice, [role="alert"]',
  )) {
    const text = element.textContent?.trim();
    if (text) messages.add(text);
  }
}).observe(document, { subtree: true, childList: true, characterData: true });

// Project database opens can be failed from the page's first open: the mode
// survives a reload in sessionStorage, so a cold load starts without storage.
const FAIL_OPEN_KEY = "accountHarness/fail-open";
class FailedOpenRequest {
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
  readonly result = undefined;
  readonly error = new DOMException("Storage is gated.", "UnknownError");
  readonly transaction = null;
  readonly readyState = "pending";
}
const openDatabase = IDBFactory.prototype.open;
IDBFactory.prototype.open = function (name: string, version?: number) {
  if (!sessionStorage.getItem(FAIL_OPEN_KEY) || !name.includes("/project/"))
    return openDatabase.call(this, name, version);
  const request = new FailedOpenRequest();
  queueMicrotask(() => request.onerror?.(new Event("error")));
  return request as unknown as IDBOpenDBRequest;
};

async function repository(namespace: string) {
  return new ProjectRepository({ deployment: location.origin, namespace });
}
const accountHarness = {
  id: () => current.id,
  // Signed out, the preferences lock cloud saving; a map may still have set
  // it off for itself. The app's repository hears of it from this one.
  async setSaving(saving: SavingPreferences, namespace = "anonymous") {
    const repo = await repository(namespace);
    try {
      await repo.preferences.change({
        set: levelRows("map", current.id, {
          saveLocally: saving.local,
          saveInCloud: saving.cloud,
        }),
      });
    } finally {
      await repo.close();
    }
  },
  sockets: () => [...sockets].map((socket) => socket.url),
  messages() {
    return [...messages];
  },
  failOpen(value: boolean) {
    if (value) sessionStorage.setItem(FAIL_OPEN_KEY, "1");
    else sessionStorage.removeItem(FAIL_OPEN_KEY);
  },
  async texts(namespace: string, id: string) {
    const repo = await repository(namespace);
    const handle = await repo.open(id, { remember: false });
    try {
      return handle.doc.view().nodes.map((node) => node.text);
    } finally {
      await handle.close();
      await repo.close();
    }
  },
  async catalog(namespace: string, includeClaims = false) {
    const repo = await repository(namespace);
    try {
      return await repo.list({ includeClaims });
    } finally {
      await repo.close();
    }
  },
  // Claims preserve the complete Loro history under the destination account.
  // The signed-in app claims anonymous maps on its own as soon as it sees
  // them, so the edits are made under the claim lock, before anyone can copy.
  async historyClaim(ownerId: number) {
    const source = await repository("anonymous");
    const destination = await repository(`account-${ownerId}`);
    const id = crypto.randomUUID();
    let handle!: Awaited<ReturnType<ProjectRepository["create"]>>;
    let replica!: ProjectDocument;
    await navigator.locks.request(
      `${source.names.catalog}/claim/${id}`,
      async () => {
        handle = await source.create({
          id,
          name: "Loro history",
          root: { text: "Root" },
        });
        const root = handle.doc.view().roots[0];
        replica = project.openProjectDocument(id, [handle.doc.snapshot()]);
        project.editNodeText(replica, root, 0, 0, "Missing ");
        project.editNodeText(replica, root, 3, 0, "dependent ");
        handle.doc.merge(replica.snapshot());
        await handle.flush();
      },
    );
    const before = [...handle.doc.snapshot()];
    await claimAnonymousProjects(
      source,
      destination,
      ownerId,
      new AbortController().signal,
    );
    const marker = (await source.list({ includeClaims: true })).find(
      (entry) => entry.id === id,
    )?.claim;
    if (marker?.phase !== "complete" || marker.targetId !== id)
      throw new Error("Claim did not preserve its UUID");
    const target = await destination.open(id, { remember: false });
    const after = [...target.doc.snapshot()];
    const equal = target.doc.version() === handle.doc.version();
    await target.close();
    await handle.close();
    await source.close();
    await destination.close();
    replica.destroy();
    return { before, after, equal };
  },
};
export type AccountHarness = typeof accountHarness;
declare global {
  interface Window {
    accountHarness: AccountHarness;
  }
}
window.accountHarness = accountHarness;
render(
  () => (
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={appRouter(() => (
          <App
            onDocument={(doc) => {
              current = doc;
            }}
          />
        ))}
      />
    </QueryClientProvider>
  ),
  document.getElementById("root") as HTMLElement,
);
