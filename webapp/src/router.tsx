import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/solid-router";
import { App } from "./App.tsx";
import { CheckHealth, CheckHealthPending } from "./CheckHealth.tsx";
import { checkHealth } from "./health";

const rootRoute = createRootRoute({ component: Outlet });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App,
});

const checkHealthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/checkhealth",
  loader: () => checkHealth(),
  staleTime: 0,
  gcTime: 0,
  pendingMs: 150,
  pendingComponent: CheckHealthPending,
  component: CheckHealth,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, checkHealthRoute]),
});

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
