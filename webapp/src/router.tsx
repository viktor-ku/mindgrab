import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/solid-router";
import { Show } from "solid-js";
import { App } from "./App.tsx";
import { appSearchSchema } from "./app-search";
import { CheckHealth, CheckHealthPending } from "./CheckHealth.tsx";
import { healthQueryOptions } from "./health";
import { queryClient } from "./query-client";
import { SharedProject } from "./SharedProject.tsx";

const rootRoute = createRootRoute({ component: Outlet });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: appSearchSchema,
  component: App,
});

// A project's view-only share link. The token is the only credential.
const sharedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$token",
  component: () => {
    const params = sharedRoute.useParams();
    return (
      <Show when={params().token} keyed>
        {(token) => <SharedProject token={token} />}
      </Show>
    );
  },
});

const checkHealthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/checkhealth",
  loader: () => queryClient.ensureQueryData(healthQueryOptions()),
  staleTime: 0,
  gcTime: 0,
  pendingMs: 150,
  pendingComponent: CheckHealthPending,
  component: CheckHealth,
});

// An address that is no page of the app, such as a share link pasted without
// its /s/ prefix. It looks like the shared view's "not shared anymore" page.
function NotFound() {
  return (
    <main class="map-canvas relative h-screen w-screen text-stone-900">
      <div class="absolute top-1/2 left-1/2 flex w-[22rem] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 text-center">
        <h1 class="font-display text-2xl font-semibold">Page not found</h1>
        <p class="text-sm leading-6 text-stone-600">
          This address doesn’t lead to a map. Check the link, or start from
          Mindgrab.
        </p>
        <a href="/" class="primary-button">
          Open Mindgrab
        </a>
      </div>
    </main>
  );
}

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, sharedRoute, checkHealthRoute]),
  defaultNotFoundComponent: NotFound,
});

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
