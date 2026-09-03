const CACHE = "slowbite-v6-camera-experiment";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./camera.mjs", "./logic.mjs", "./manifest.webmanifest", "./icon.svg", "./ready-chime.mp3",
  "./pace-10.mp3", "./pace-15.mp3", "./pace-20.mp3", "./pace-25.mp3", "./pace-30.mp3", "./pace-35.mp3",
  "./pace-40.mp3", "./pace-45.mp3", "./pace-50.mp3", "./pace-55.mp3", "./pace-60.mp3"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.headers.has("range")) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok && response.status === 200) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
      }
      return response;
    }))
  );
});
