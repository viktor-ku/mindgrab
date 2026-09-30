// This coordination worker has a separate scope and no fetch/cache handlers.
// includeUncontrolled also finds stale tabs that cannot participate in locks.
self.addEventListener("message", (event) => {
  if (event.data !== "MINDGRAB_RESET_CLIENTS" || !event.ports[0]) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => event.ports[0].postMessage(clients.length)),
  );
});
