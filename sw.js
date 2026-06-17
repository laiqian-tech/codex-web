// Offline shell cache for the Codex Web client.
// Network-first for the app shell so a redeploy's new JS/CSS is picked up
// immediately; the cache is only a fallback for offline / failed fetches.
const CACHE = "codex-web-v4";
const SHELL = ["/", "/index.html", "/styles.css", "/script.js", "/markdown.js", "/icon.svg", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache API calls; always go to network.
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") return;
  // Network-first: serve the freshest asset when online, refresh the cache,
  // and fall back to the cached copy (or the app shell) when offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("/index.html"))),
  );
});
