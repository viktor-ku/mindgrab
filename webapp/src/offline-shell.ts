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

export type UpdateOutcome =
  | { status: "unsafe"; risks: string[] }
  | { status: "others"; others: number }
  | { status: "reloading" };

/** Other open Mindgrab windows, which must close before this one updates. */
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

// "Update now". Never activates while another window could still run the old
// build, and never reloads over work a guard reports unless force is set.
export async function applyUpdate(force: boolean): Promise<UpdateOutcome> {
  const worker = pendingUpdate();
  if (!worker) throw new Error("No update is waiting.");
  // Ends text editing, so typed text reaches the map before it is saved.
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
  const risks: string[] = [];
  for (const guard of guards) {
    const risk = await guard().catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    if (risk) risks.push(risk);
  }
  if (risks.length && !force) return { status: "unsafe", risks };
  const { others, activating } = await ask<{
    others: number;
    activating: boolean;
  }>(worker, "MINDGRAB_ACTIVATE", "The update did not answer.");
  if (!activating) return { status: "others", others };
  await activated(worker);
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
// hints. Never activate or reload a running editor here.
function monitorUpdates() {
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
