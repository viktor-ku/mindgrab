/* @refresh reload */
import { QueryClientProvider } from "@tanstack/solid-query";
import { press } from "./press";
import { queryClient, executeMutation } from "./query-client";
import { RouterProvider } from "@tanstack/solid-router";
import { Show } from "solid-js";
import {
  offlineMessage,
  pendingUpdate,
  startOfflineShell,
} from "./offline-shell";
import { UpdateNotice } from "./UpdateNotice";
import { startAnalytics } from "./analytics";
import { render } from "solid-js/web";
import { router } from "./router.tsx";
import "./index.css";

const root = document.getElementById("root");
void startAnalytics();

const upgradeMessage = await executeMutation(
  queryClient,
  { mutationKey: ["offline-shell", "startup"], mutationFn: startOfflineShell },
  undefined,
);

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <Show
        when={!upgradeMessage}
        fallback={
          <main class="p-6 text-stone-900">
            <h1 class="text-xl font-semibold">Application update needed</h1>
            <p role="alert" class="my-4">
              {upgradeMessage}
            </p>
            <button
              type="button"
              class="primary-button"
              {...press(() => window.location.reload())}
            >
              Retry opening
            </button>
            <UpdateNotice inline />
          </main>
        }
      >
        <RouterProvider router={router} />
        <UpdateNotice />
        {/* Under the map's chrome, so it never covers a toolbar. The update
            notice says all there is to say while an update waits. */}
        <Show when={offlineMessage() && !pendingUpdate()}>
          <p
            role="status"
            aria-label="Offline application"
            class="fixed bottom-3 left-3 z-10 max-w-sm rounded bg-white/90 px-3 py-2 text-xs text-stone-600"
          >
            {offlineMessage()}
          </p>
        </Show>
      </Show>
    </QueryClientProvider>
  ),
  root!,
);
