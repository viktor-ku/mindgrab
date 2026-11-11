// Tombstone for the retired offline service worker. Browsers that installed it
// keep checking /sw.js; this version takes over at once, deletes the cached
// app, and unregisters itself, so the next load comes from the network.
// Remove once old installs have had time to pick it up.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("mindgrab-shell/")) await caches.delete(name);
      await self.registration.unregister();
    })(),
  );
});
