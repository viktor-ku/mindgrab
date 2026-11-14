import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/solid-router";
import type { JSX } from "solid-js";
import { appSearchSchema } from "../webapp/src/app-search";

// The editor's route as the app declares it, over an in-memory history: the
// harness pages are not served at "/", and tests read the address from here.
// It starts with the page's own search, so a harness loaded with
// `?preferences=true` opens as the app would from that address.
export function appRouter(component: () => JSX.Element) {
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    validateSearch: appSearchSchema,
    component,
  });
  return createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: [`/${location.search}`] }),
  });
}

// The app reads its typed search through the registered router. Here that
// is this one, which declares the same "/" route as the app's router.
declare module "@tanstack/solid-router" {
  interface Register {
    router: ReturnType<typeof appRouter>;
  }
}
