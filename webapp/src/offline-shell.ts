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

// Called before the router mounts, so an incompatible cached shell cannot open
// or mutate the repository. No handler here activates a worker or reloads tabs.
export async function startOfflineShell(): Promise<string | undefined> {
  if (!import.meta.env.PROD) return;
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    setOfflineMessage("Offline reopening is unavailable in this browser.");
    return;
  }
  const recovery = (message: string) => {
    // A blocked page must still be able to fetch a compatible worker. This does
    // not activate it; all old clients must close before it can take over.
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.update())
      .catch(() => {});
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
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    const report = () => {
      if (registration.waiting)
        setOfflineMessage(
          "An update is ready. Wait for Saved locally, then close all Mindgrab tabs and reopen. Unsynced work stays in this browser.",
        );
      else if (registration.active)
        setOfflineMessage("Ready to reopen offline in this browser.");
    };
    const watch = () => {
      registration.installing?.addEventListener("statechange", report);
      report();
    };
    registration.addEventListener("updatefound", watch);
    watch();
    void navigator.serviceWorker.ready.then(report);
    window.addEventListener("online", () => {
      void registration.update().catch(() => {});
    });
  } catch {
    setOfflineMessage(
      controller
        ? "Using the cached application. Update check unavailable."
        : "Offline reopening is not ready. Reconnect and reopen to retry.",
    );
  }
}
