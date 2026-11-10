import { QueryObserver } from "@tanstack/solid-query";
import { queryClient } from "./query-client";
import { createSignal } from "solid-js";
import { SHELL_COMPATIBILITY } from "./offline-contract";

export const [offlineMessage, setOfflineMessage] = createSignal("");

export function compatibleShell(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const info = value as { compatibility?: Record<string, unknown> };
  return Object.entries(SHELL_COMPATIBILITY).every(
    ([key, version]) => info.compatibility?.[key] === version,
  );
}

function ask<T>(worker: ServiceWorker, message: string, failure: string) {
  const channel = new MessageChannel();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error(failure));
    }, 5000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}
const inspect = (worker: ServiceWorker) =>
  ask<unknown>(
    worker,
    "MINDGRAB_SHELL_INFO",
    "Cached application version could not be verified.",
  );

// A newer build that has installed and waits for every Mindgrab window to
// close. Kept apart from offlineMessage so no status can replace it.
const [pendingUpdate, setPendingUpdate] = createSignal<ServiceWorker>();
export { pendingUpdate };

// What a reload would lose in this window, if anything. Editors register one.
type UpdateGuard = () => Promise<string | undefined>;
const guards = new Set<UpdateGuard>();
export function guardUpdate(guard: UpdateGuard) {
  guards.add(guard);
  return () => void guards.delete(guard);
}
// Set just before the update reloads, after the guards passed or the person
// confirmed the risks, so the editor does not ask again on unload.
let leaving = false;
export const leavingForUpdate = () => leaving;

// The risks a warning showed: this tab's, and each other tab's by its id.
export interface Confirmation {
  own: string[];
  tabs: Record<string, string[]>;
}
export type UpdateOutcome =
  | { status: "unsafe"; risks: string[]; confirmation: Confirmation }
  | { status: "reloading" };

/** Other open Mindgrab windows, which update along with this one. */
export const otherWindows = (worker: ServiceWorker) =>
  ask<{ others: number }>(
    worker,
    "MINDGRAB_WINDOWS",
    "The update did not answer.",
  ).then(({ others }) => others);

function activated(worker: ServiceWorker) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The update did not start.")),
      10_000,
    );
    const check = () => {
      if (worker.state !== "activated") return;
      clearTimeout(timer);
      worker.removeEventListener("statechange", check);
      resolve();
    };
    worker.addEventListener("statechange", check);
    check();
  });
}

// Saves pending work in this window and returns what a reload would lose.
export async function checkGuards() {
  const risks: string[] = [];
  for (const guard of guards) {
    const risk = await guard().catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    if (risk) risks.push(risk);
  }
  return risks;
}

// Every Mindgrab window of this origin follows an update started in any of
// them: it saves and reports its risks when asked, and reloads once the new
// worker takes over. Activation only ever comes from a click on Update now.
// A following window reloads only if every risk it finds then is one the
// person confirmed; anything new keeps it open and asks here.
type TabMessage =
  | { type: "prepare"; id: string }
  | { type: "preparing"; id: string; tab: string }
  | { type: "prepared"; id: string; tab: string; risks: string[] }
  | { type: "commit"; id: string; accepted: Record<string, string[]> }
  | { type: "committed"; id: string; tab: string }
  | { type: "reload" };
let tabs: BroadcastChannel | undefined;
const tab = crypto.randomUUID();
let initiating = false;
let following = false;
// Risks in this window that the person confirmed from another one.
let accepted: string[] = [];
// The update went ahead elsewhere, but reloading here would lose this.
const [strandedRisks, setStrandedRisks] = createSignal<string[]>();
export { strandedRisks };
export function reloadAnyway() {
  leaving = true;
  window.location.reload();
}
/** Checks this tab again and reloads it if nothing would be lost now. */
export async function follow() {
  if (initiating || leaving || following) return;
  following = true;
  try {
    const risks = await checkGuards();
    if (risks.every((risk) => accepted.includes(risk))) reloadAnyway();
    else setStrandedRisks(risks);
  } finally {
    following = false;
  }
}
function listenToTabs() {
  if (tabs || !("BroadcastChannel" in window)) return;
  const channel = new BroadcastChannel("mindgrab-update");
  tabs = channel;
  const send = (message: TabMessage) => channel.postMessage(message);
  channel.addEventListener("message", (event: MessageEvent<TabMessage>) => {
    const message = event.data;
    if (message?.type === "prepare") {
      // Answers at once, so the asking tab knows to wait for the saves.
      send({ type: "preparing", id: message.id, tab });
      void checkGuards().then((risks) =>
        send({ type: "prepared", id: message.id, tab, risks }),
      );
    }
    if (message?.type === "commit") {
      accepted = message.accepted[tab] ?? [];
      send({ type: "committed", id: message.id, tab });
    }
    if (message?.type === "reload") void follow();
  });
  // No worker claims a running page, so a new controller means Update now.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    void follow();
  });
}

// A tab that does not acknowledge within this time is frozen or gone. One
// that did gets longer to finish saving (a cloud upload waits up to 10 s).
const ANSWER_TIMEOUT_MS = 3000;
const PREPARE_TIMEOUT_MS = 15_000;
type Prepared = Extract<TabMessage, { type: "prepared" }>;
// Asks the other windows to save, and gathers what their reload would lose.
function prepareOthers(id: string, expected: number) {
  const channel = tabs;
  if (!expected || !channel) return Promise.resolve<Prepared[]>([]);
  return new Promise<Prepared[]>((resolve) => {
    const answering = new Set<string>();
    const prepared = new Map<string, Prepared>();
    let answered = false;
    const finish = () => {
      clearTimeout(answerTimer);
      clearTimeout(prepareTimer);
      channel.removeEventListener("message", reply);
      resolve([...prepared.values()]);
    };
    const done = () =>
      prepared.size >= expected ||
      (answered && [...answering].every((tab) => prepared.has(tab)));
    const reply = ({ data }: MessageEvent<TabMessage>) => {
      if (!data || !("id" in data) || data.id !== id) return;
      if (data.type === "preparing") answering.add(data.tab);
      if (data.type === "prepared") {
        answering.add(data.tab);
        prepared.set(data.tab, data);
      }
      if (done()) finish();
    };
    const answerTimer = setTimeout(() => {
      answered = true;
      if (done()) finish();
    }, ANSWER_TIMEOUT_MS);
    const prepareTimer = setTimeout(finish, PREPARE_TIMEOUT_MS);
    channel.addEventListener("message", reply);
    channel.postMessage({ type: "prepare", id } satisfies TabMessage);
  });
}
// Tells the prepared windows what the person accepted for each of them, and
// waits until they have heard it.
function commitOthers(id: string, accepted: Record<string, string[]>) {
  const channel = tabs;
  const expected = Object.keys(accepted).length;
  if (!expected || !channel) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const heard = new Set<string>();
    const finish = () => {
      clearTimeout(timer);
      channel.removeEventListener("message", reply);
      resolve();
    };
    const reply = ({ data }: MessageEvent<TabMessage>) => {
      if (data?.type !== "committed" || data.id !== id) return;
      heard.add(data.tab);
      if (heard.size >= expected) finish();
    };
    const timer = setTimeout(finish, ANSWER_TIMEOUT_MS);
    channel.addEventListener("message", reply);
    channel.postMessage({ type: "commit", id, accepted } satisfies TabMessage);
  });
}

// "Update now", which the person clicks for every open Mindgrab tab. Each tab
// saves first; the new build takes over only when no tab would lose work, or
// when the person confirmed every risk found now. A risk the warning did not
// show (a new tab, a new map) shows the warning again.
export async function applyUpdate(
  confirmed?: Confirmation,
): Promise<UpdateOutcome> {
  const worker = pendingUpdate();
  if (!worker) throw new Error("No update is waiting.");
  // Ends text editing, so typed text reaches the map before it is saved.
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
  const id = crypto.randomUUID();
  const [own, expected] = await Promise.all([
    checkGuards(),
    otherWindows(worker),
  ]);
  const prepared = await prepareOthers(id, expected);
  // A tab that does not answer (frozen in the background) accepts nothing,
  // so it reloads only if nothing there would be lost.
  const risks = [
    ...new Set([
      ...own,
      ...prepared.flatMap(({ risks }) =>
        risks.map((risk) => `In another tab: ${risk}`),
      ),
    ]),
  ];
  const found: Confirmation = {
    own,
    tabs: Object.fromEntries(prepared.map((p) => [p.tab, p.risks])),
  };
  const covered =
    own.every((risk) => confirmed?.own.includes(risk)) &&
    prepared.every((p) =>
      p.risks.every((risk) => confirmed?.tabs[p.tab]?.includes(risk)),
    );
  if (!covered) return { status: "unsafe", risks, confirmation: found };
  // Before anything activates, every tab learns what the person accepted.
  await commitOthers(id, found.tabs);
  initiating = true;
  try {
    await ask(worker, "MINDGRAB_ACTIVATE", "The update did not answer.");
    await activated(worker);
  } catch (error) {
    initiating = false;
    throw error;
  }
  // Controlled tabs already follow controllerchange; this reaches the rest.
  tabs?.postMessage({ type: "reload" } satisfies TabMessage);
  leaving = true;
  window.location.reload();
  return { status: "reloading" };
}

const UPDATE_INTERVAL_MS = 5 * 60_000;
const register = () =>
  navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  });

// Keep discovery alive even if an offline startup/failed deployment prevents the
// first registration. Visible tabs retry periodically and on focus/reconnect
// hints. Nothing here activates a worker or reloads a tab on its own.
function monitorUpdates() {
  listenToTabs();
  const observed = new WeakSet<ServiceWorkerRegistration>();
  const observe = (registration: ServiceWorkerRegistration) => {
    if (observed.has(registration)) return;
    observed.add(registration);
    const report = () => {
      const waiting = registration.waiting ?? undefined;
      // A waiting worker turns redundant when a newer build replaces it.
      waiting?.addEventListener("statechange", report);
      setPendingUpdate(waiting?.state === "installed" ? waiting : undefined);
      if (registration.active)
        setOfflineMessage(
          "Ready to reopen offline in this browser. Only maps with local saving on are available offline.",
        );
    };
    const watch = () => {
      registration.installing?.addEventListener("statechange", report);
      report();
    };
    registration.addEventListener("updatefound", watch);
    watch();
    void navigator.serviceWorker.ready.then(report);
  };
  const options = {
    queryKey: ["offline-shell", "updates"] as const,
    queryFn: async () => {
      const existing = await navigator.serviceWorker.getRegistration("/");
      const registration = existing ?? (await register());
      observe(registration);
      if (existing) await registration.update();
      return null;
    },
    networkMode: "online" as const,
    refetchInterval: UPDATE_INTERVAL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  };
  const observer = new QueryObserver(queryClient, options);
  // This observer lives for the page lifetime, like the service worker listeners.
  observer.subscribe(() => {});
  const check = () => void observer.refetch({ cancelRefetch: false });
  return { observe, check };
}

// Called before the router mounts, so an incompatible cached shell cannot open
// or mutate the repository. No handler here activates a worker or reloads tabs.
export async function startOfflineShell(): Promise<string | undefined> {
  if (!import.meta.env.PROD) return;
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    setOfflineMessage("Offline reopening is unavailable in this browser.");
    return;
  }
  const updates = monitorUpdates();
  const recovery = (message: string) => {
    updates.check();
    return message;
  };
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    try {
      if (!compatibleShell(await inspect(controller)))
        return recovery(
          "This cached application uses an unsupported storage or document version. Your local data is retained. Reconnect, close all Mindgrab tabs, and reopen to finish the update.",
        );
    } catch {
      return recovery(
        "The cached application version could not be verified. Your local data is retained. Reconnect, close all Mindgrab tabs, and reopen to retry.",
      );
    }
  }
  try {
    updates.observe(await register());
  } catch {
    setOfflineMessage(
      controller
        ? "Using the cached application. Update check unavailable."
        : "Offline reopening is not ready. Reconnect and reopen to retry.",
    );
  }
}
