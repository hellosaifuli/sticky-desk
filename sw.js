// Sticky Desk service worker: opens without internet, and shows lock screen notifications.
const CACHE = "sticky-desk-v7";
const SHELL = ["/", "/manifest.webmanifest", "/icon-180.png", "/icon-192.png", "/icon-512.png", "/q/index.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const put = (req, res) => { if (res && (res.ok || res.type === "opaque")) caches.open(CACHE).then((c) => c.put(req, res)); return res; };

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return; // sync always goes to the network
  // the page itself: newest when online, the saved copy when not
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => put("/", res.clone()) && res).catch(() => caches.match("/")));
    return;
  }
  // Quran portions never change: keep the first copy
  if (url.origin === location.origin && url.pathname.startsWith("/q/")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => put(req, res.clone()) && res)));
    return;
  }
  // everything else (icons, fonts, the prayer-time library): saved copy now, refreshed in the background
  if (url.origin === location.origin || /(^|\.)(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => {
      const fresh = fetch(req).then((res) => put(req, res.clone()) && res).catch(() => hit);
      return hit || fresh;
    }));
  }
});

self.addEventListener("push", (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = { title: "Sticky Desk", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(msg.title || "Sticky Desk", {
    body: msg.body || "", tag: msg.tag || "sticky-desk", renotify: true,
    icon: "/icon-192.png", badge: "/icon-192.png", data: { url: msg.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => new URL(w.url).origin === location.origin);
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
