import { STORAGE_GENERATION } from "./offline-contract";

export const LEGACY_RESET_KEY = "mindgrab/legacy-project-reset";
const LOCK = "mindgrab/legacy-project-reset";
const CLOSE_TABS =
  "Close all other tabs on this site, then retry opening to reset obsolete development projects. Yjs projects and sign-in data will be retained.";

export function isLegacyProjectKey(key: string): boolean {
  return (
    key.startsWith("proj/") ||
    key.startsWith("project-updated/") ||
    key === "mindgrab/latest-project" ||
    /^mindgrab\/user\/\d+\/(proj\/|project-updated\/|mindgrab\/latest-project$)/.test(
      key,
    )
  );
}

export function legacyProjectKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && isLegacyProjectKey(key)) keys.push(key);
  }
  return keys;
}

async function otherTabs(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext)
    throw new Error(
      "Reconnect in a supported browser to reset obsolete projects.",
    );
  const registration = await navigator.serviceWorker.register(
    "/legacy-reset-worker.js",
    { scope: "/legacy-reset/", updateViaCache: "none" },
  );
  try {
    const worker =
      registration.active ?? registration.installing ?? registration.waiting;
    if (!worker)
      throw new Error(
        "Reset coordination is unavailable. Reconnect and retry.",
      );
    if (worker.state !== "activated") {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(false), 5000);
        const changed = () => {
          if (worker.state === "activated") finish(true);
          else if (worker.state === "redundant") finish(false);
        };
        const finish = (ok: boolean) => {
          clearTimeout(timeout);
          worker.removeEventListener("statechange", changed);
          if (ok) resolve();
          else
            reject(
              new Error(
                "Reset coordination is unavailable. Reconnect and retry.",
              ),
            );
        };
        worker.addEventListener("statechange", changed);
        changed();
      });
    }
    const channel = new MessageChannel();
    return await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        channel.port1.close();
        reject(new Error("Reset coordination timed out. Reconnect and retry."));
      }, 5000);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timeout);
        channel.port1.close();
        if (!Number.isSafeInteger(data) || data < 1)
          reject(new Error("Open tabs could not be verified. Retry opening."));
        else resolve(data > 1);
      };
      worker.postMessage("MINDGRAB_RESET_CLIENTS", [channel.port2]);
    });
  } finally {
    await registration.unregister();
  }
}

// Runs before any editor or auth repository opens. Never enumerate/delete IDB,
// clear storage, or rely on a marker to discard an existing Yjs generation.
export async function resetLegacyBrowserProjects(): Promise<
  string | undefined
> {
  try {
    const storage = window.localStorage;
    if (!legacyProjectKeys(storage).length) return;
    if (!navigator.locks)
      return "Reset coordination is unavailable in this browser. Open the current application in a supported browser.";
    return await navigator.locks.request(
      LOCK,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock || (await otherTabs())) return CLOSE_TABS;
        // Take a new inventory under the lock. A partial removal is safe to retry.
        for (const key of legacyProjectKeys(storage)) storage.removeItem(key);
        storage.setItem(LEGACY_RESET_KEY, String(STORAGE_GENERATION));
      },
    );
  } catch {
    return "Obsolete development projects could not be reset. Reconnect, close all other tabs on this site and retry. Yjs projects and sign-in data are retained.";
  }
}
