// Capanna / KeyNet — service worker : notifications push uniquement (aucune mise en cache des pages)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { message: e.data ? e.data.text() : "" }; }
  const titre = d.titre || "Capanna";
  e.waitUntil(self.registration.showNotification(titre, {
    body: d.message || "",
    tag: d.id ? "keynet-" + d.id : undefined, // une même notification n'apparaît qu'une fois
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: d.url || "v2.html" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "v2.html", self.registration.scope).href;
  e.waitUntil((async () => {
    const fenetres = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of fenetres) {
      if (c.url.split("#")[0] === url.split("#")[0]) {
        await c.focus();
        try { return await c.navigate(url); } catch { return c.postMessage({ aller: url }); }
      }
    }
    return self.clients.openWindow(url);
  })());
});
