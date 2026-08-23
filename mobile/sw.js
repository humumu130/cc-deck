// 最小离线壳：仅缓存 App 壳与图标，数据一律走网络
const CACHE = "ccr-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && e.request.method === "GET" && SHELL.some((s) => url.pathname.endsWith(s.replace("./", "/")) || url.pathname === "/m")) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html"))),
  );
});
