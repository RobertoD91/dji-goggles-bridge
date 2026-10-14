// Offline support: serve the app shell from cache and refresh it in the background.

const CACHE = "dji-goggles-webusb-v1";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "src/annexb.js",
  "src/bitstream.js",
  "src/bootstrap.js",
  "src/h264.js",
  "src/player.js",
  "src/recorder.js",
  "src/session.js",
  "src/stream.js",
  "src/usb.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate: instant (offline-capable) loads, updates on the next visit.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  const network = caches.open(CACHE).then((cache) =>
    fetch(request).then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    }),
  );
  event.waitUntil(network.catch(() => {}));
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => cached ?? network));
});
