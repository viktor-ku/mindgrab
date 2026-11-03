import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/solid-router";
import { Show } from "solid-js";
import { App } from "./App.tsx";
import { CheckHealth, CheckHealthPending } from "./CheckHealth.tsx";
import { healthQueryOptions } from "./health";
import { queryClient } from "./query-client";
import { SharedProject } from "./SharedProject.tsx";

const rootRoute = createRootRoute({ component: Outlet });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
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

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, sharedRoute, checkHealthRoute]),
});

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
