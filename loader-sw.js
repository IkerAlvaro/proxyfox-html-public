// loader-sw.js: makes the loader an installable app (PWA) that opens without a network.
//
// Registered by the loader (svg/loader.js) with the scope /loader, so it covers loader.html and
// loader.svg only: sw.js, which proxyfox.html registers when it is opened from this site directly,
// keeps the rest. The loader keeps proxyfox.html itself (Cache Storage, proxyfox-svg), so this only
// has to keep the loader page, the app manifest and the icons. The loader page is asked for on the
// network first (so a new loader is used at once) and comes from here when that fails or is slow.
const CACHE = 'proxyfox-loader-v1';
const FILES = ['loader.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];
const url = (file) => new URL(file, self.location.href).href;
const NETWORK_WAIT = 4000; // then the kept loader, if there is one

// Multi-threading needs these on the page: every response this worker gives the loader gets them,
// so the loader is cross-origin isolated even on a host that doesn't send them.
function isolate(response) {
  if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  // A 204/304 has no body, and a new Response refuses the empty one Chrome hands over.
  const body = [204, 205, 304].includes(response.status) ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map(url))).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('proxyfox-loader-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const at = new URL(req.url);
  if (at.origin !== self.location.origin) return; // relays, GitHub, the main site: untouched
  const file = FILES.find((f) => url(f) === at.origin + at.pathname);
  if (!file && req.mode !== 'navigate') return;
  const key = url(file || 'loader.html');
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fromNetwork = fetch(req).then(async (res) => {
      if (res.ok && res.type === 'basic') await cache.put(key, res.clone()).catch(() => {});
      return res;
    });
    const timer = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT, null));
    const first = await Promise.race([fromNetwork.catch(() => null), timer]);
    // Always with the isolation headers, also from hosts that send none (GitHub Pages, CDNs).
    if (first) return isolate(first);
    const kept = await cache.match(key);
    if (kept) return isolate(kept);
    return isolate(await fromNetwork); // nothing kept yet: wait for the network after all
  })());
});
