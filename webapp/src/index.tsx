/* @refresh reload */
import { QueryClientProvider } from "@tanstack/solid-query";
import { queryClient } from "./query-client";
import { RouterProvider } from "@tanstack/solid-router";
import { startAnalytics } from "./analytics";
import { render } from "solid-js/web";
import { router } from "./router.tsx";
import "./index.css";

const root = document.getElementById("root");
void startAnalytics();

// Mindgrab is online only. Browsers that installed the old offline service
// worker drop it, so they always load the current build from the network.
void navigator.serviceWorker
  ?.getRegistrations()
  .then((registrations) =>
    Promise.all(registrations.map((registration) => registration.unregister())),
  )
  .catch(() => {});

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  ),
  root!,
);
