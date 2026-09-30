/* @refresh reload */
import { RouterProvider } from "@tanstack/solid-router";
import { Show } from "solid-js";
import { offlineMessage, startOfflineShell } from "./offline-shell";
import { resetLegacyBrowserProjects } from "./legacy-reset";
import { render } from "solid-js/web";
import { router } from "./router.tsx";
import "./index.css";

const root = document.getElementById("root");

const upgradeMessage =
  (await startOfflineShell()) ?? (await resetLegacyBrowserProjects());

render(
  () => (
    <Show
      when={!upgradeMessage}
      fallback={
        <main class="p-6 text-stone-900">
          <h1 class="text-xl font-semibold">Application update needed</h1>
          <p role="alert" class="my-4">
            {upgradeMessage}
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            Retry opening
          </button>
        </main>
      }
    >
      <RouterProvider router={router} />
      <Show when={offlineMessage()}>
        <p
          role="status"
          aria-label="Offline application"
          class="fixed bottom-3 left-3 z-30 max-w-sm rounded bg-white/90 px-3 py-2 text-xs text-stone-600"
        >
          {offlineMessage()}
        </p>
      </Show>
    </Show>
  ),
  root!,
);
