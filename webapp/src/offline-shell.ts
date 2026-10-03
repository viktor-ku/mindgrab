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

async function inspect(worker: ServiceWorker) {
  const channel = new MessageChannel();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("Cached application version could not be verified."));
    }, 5000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(data);
    };
    worker.postMessage("MINDGRAB_SHELL_INFO", [channel.port2]);
  });
}

const UPDATE_INTERVAL_MS = 5 * 60_000;
const register = () =>
  navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  });

// Keep discovery alive even if an offline startup/failed deployment prevents the
// first registration. Browser reachability events are hints, so visible tabs also
// retry periodically. Never activate or reload a running editor here.
function monitorUpdates() {
  const observed = new WeakSet<ServiceWorkerRegistration>();
  const observe = (registration: ServiceWorkerRegistration) => {
    if (observed.has(registration)) return;
    observed.add(registration);
    const report = () => {
      if (registration.waiting)
        setOfflineMessage(
          "An update is ready. Save or export your projects before closing all Mindgrab tabs to reopen. Projects with local saving off are not kept in this browser.",
        );
      else if (registration.active)
        setOfflineMessage(
          "Ready to reopen offline in this browser. Only projects with local saving on are available offline.",
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
  const check = () => {
    if (navigator.onLine) void observer.refetch({ cancelRefetch: false });
  };
  // Reachability events are hints; an online event can arrive while the
  // Query online manager already considers this browser online.
  window.addEventListener("online", check);
  window.addEventListener("focus", check);
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
