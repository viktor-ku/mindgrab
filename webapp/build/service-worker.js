/* global BUILD */
const CACHE_PREFIX = "mindgrab-shell/";
const CACHE = CACHE_PREFIX + BUILD.version;
const ASSETS = new Set(BUILD.assets);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        // All-or-nothing installation. Redirected assets must not populate the
        // cache with an auth page. Anonymous static files need no credentials.
        for (const path of ASSETS) {
          const response = await fetch(path, {
            cache: "reload",
            credentials: "omit",
            redirect: "error",
          });
          if (!response.ok || response.type === "opaque")
            throw new Error(`Offline asset unavailable: ${path}`);
          await cache.put(path, response);
        }
      } catch (error) {
        await caches.delete(CACHE);
        throw error;
      }
      // No automatic skipWaiting: old clients must retain their build and
      // pending writes. Only a click on Update now asks for it (below).
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE)
          await caches.delete(name);
      // No clients.claim: never change the controller of a running editor.
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "MINDGRAB_SHELL_INFO")
    event.ports[0]?.postMessage({
      version: BUILD.version,
      compatibility: BUILD.compatibility,
    });
  // Asked of a waiting worker by the "Update now" button, which the person
  // clicks for every open Mindgrab window. Those windows save their work
  // first and reload as soon as this worker takes over.
  if (event.data === "MINDGRAB_WINDOWS" || event.data === "MINDGRAB_ACTIVATE")
    event.waitUntil(
      (async () => {
        const windows = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        const others = windows.filter(
          (client) => client.id !== event.source?.id,
        ).length;
        if (event.data === "MINDGRAB_ACTIVATE") await self.skipWaiting();
        event.ports[0]?.postMessage({ others });
      })(),
    );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Editor URLs use the root route. Never turn auth/health/unknown navigations
  // (or requests with token query strings) into an offline editor response.
  const navigation =
    request.mode === "navigate" &&
    (url.pathname === "/" || url.pathname === "/index.html") &&
    [...url.searchParams.keys()].every((key) => key === "project");
  const asset = !url.search && ASSETS.has(url.pathname);
  if (!navigation && !asset) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await cache.match(
        navigation ? "/index.html" : url.pathname,
      );
      // Missing/evicted cache entries fall back to network without writing it.
      return response ?? fetch(request);
    })(),
  );
});
