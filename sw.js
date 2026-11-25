// sw.js: makes the website an installable app (PWA) that opens from this device.
//
// This copy is for the public site (proxyfox-html-public, pr0xyfox.dev), which hosts proxyfox.svg,
// proxyfox.html and this file only: version.json and wisps.json come from the main website
// (REMOTE), and the app's manifest and icons aren't here.
//
// proxyfox.html is one 77 MB file. This service worker keeps it, and the app's few small
// files, in the browser's Cache Storage, so opening the app reads it from disk instead of
// the network, and works offline. Each opening also asks the site whether proxyfox.html
// changed, with a conditional request: an unchanged file costs a "304 Not Modified" and no
// download. A new build downloads in the background and is used from the next opening on
// (the page offers to reload for it). The COOP/COEP/CORP headers that make the page
// multi-threaded (cross-origin isolated) are added by this service worker to every response
// it handles, so the web server doesn't have to send them. Check for updates on the launch
// page downloads an update right away (Update now) and puts it in the same cache.
// proxyfox.html registers this only when opened from a website; a file opened from disk
// has no service worker.

const CACHE = 'firefox-html-app-v8'; // a new name downloads the app's small files again (v8: the front page opens loader.html)
const APP = 'proxyfox.html';
// The app's address before it was renamed: old links, and apps installed from it, open APP.
const OLD_APP = 'firefox.html';
const FILES = ['./', APP];
// Read from the main website at every request (it allows other sites to read them): what Check for
// updates and the relay list read. Not kept on the device.
const REMOTE = 'https://proxyfox.codedbyzach.com/';
const REMOTE_FILES = ['version.json', 'wisps.json'];
const url = (file) => new URL(file, self.registration.scope).href;
const version = (response) => response?.headers.get('etag') || response?.headers.get('last-modified') || '';
// The light copy: proxyfox.html without the Base64 of the engine files this device keeps
// (makeLight, below), stored next to the full copy and tagged with its version.
const LIGHT = APP + '?light';
const LIGHT_OF = 'X-Proxyfox-Light-Of';

// Cross-origin isolation headers, added to every response this worker returns.
// 'credentialless' lets third-party no-cors subresources load (without cookies) instead of
// being blocked. Safari doesn't support it; switch to 'require-corp' if you need Safari.
const COEP = 'credentialless';
function isolate(response) {
  // Opaque and opaque-redirect responses (status 0) can't be rebuilt, and have no headers to set.
  if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', COEP);
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  // Hardening (PF-14): no MIME sniffing, no Referer to other sites, and only this site may show
  // the page in a frame (a frame on another site could dress it up or trick clicks).
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', "frame-ancestors 'self'");
  // A 304 (Update now when the file is unchanged) or 204 has no body, but Chrome hands it over
  // with an empty one, which a new Response refuses ("Failed to fetch" on the page).
  const body = [204, 205, 304].includes(response.status) ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // A new version of this file (a new CACHE name) keeps the proxyfox.html already on the
    // device; the next opening's update check downloads a newer one if the site has it.
    // On the first visit proxyfox.html normally comes from the browser's HTTP cache here,
    // rather than being downloaded a second time.
    // proxyfox.html (87 MB) isn't downloaded here: the loader keeps its own copy. It is kept the first
    // time the page fetches it through this worker (the fetch handler below), as before.
    const kept = await caches.match(url(APP));
    if (kept) await cache.put(url(APP), kept);
    // The front page only if it can be: with access codes (worker/proxyfox-gate.js) it needs the
    // site's access cookie, which a copy installed before access codes doesn't have yet, and
    // that copy must still get this new sw.js.
    await cache.add('./').catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const now = version(await (await caches.open(CACHE)).match(url(APP)));
    let changed = false;
    for (const key of await caches.keys()) {
      if (!key.startsWith('firefox-html-app-') || key === CACHE) continue;
      const old = await caches.open(key);
      const before = version((await old.match(url(APP))) ?? (await old.match(url(OLD_APP))));
      if (before && now && before !== now) changed = true;
      await caches.delete(key);
    }
    await self.clients.claim();
    // A page that opened from the previous copy offers to reload into this one.
    if (changed) for (const client of await self.clients.matchAll()) client.postMessage({ type: 'firefox-html-update' });
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Chrome quirk: this combination throws if passed to fetch().
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const { origin, pathname, search } = new URL(request.url);
  const key = origin + pathname; // the same file whatever its query (?env.NAME=...)
  if (request.method === 'GET' && key === url(OLD_APP)) return void event.respondWith(Response.redirect(url(APP) + search, 302));
  const remote = request.method === 'GET' && REMOTE_FILES.find((file) => key === url(file));
  if (remote) {
    return void event.respondWith(fetch(REMOTE + remote + search, { cache: 'no-store', mode: 'cors', credentials: 'omit' })
      .then(isolate, () => new Response('', { status: 504, statusText: 'Gateway Timeout' })));
  }

  // A request that asks for no stored copy goes to the network: Check for updates' Update now
  // downloads the new proxyfox.html this way, and stores it in the cache itself.
  const fresh = request.cache === 'no-store' || request.cache === 'reload';
  const cacheable = !fresh && request.method === 'GET' && FILES.some((file) => url(file) === key);
  // An address with an access code (?code=...) asks the site first, so the code is checked and
  // remembered (worker/proxyfox-gate.js) even where this device keeps a copy; offline, the copy.
  const withCode = new URLSearchParams(search).has('code');
  event.respondWith((async () => {
    if (cacheable) {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(key);
      if (cached && withCode) return isolate(await fetch(request).catch(() => cached));
      if (cached) {
        if (key === url(APP)) {
          event.waitUntil(checkForUpdate(cache, cached));
          // The light copy, while the full copy it was made from is the current one (?full asks
          // for the full one; the page drops the light copy itself when an engine file isn't on
          // the device after all).
          if (!new URLSearchParams(search).has('full')) {
            const light = await cache.match(url(LIGHT));
            if (light && version(cached) && light.headers.get(LIGHT_OF) === version(cached)) return isolate(light);
          }
        }
        return isolate(cached);
      }
      // No copy here: from the network. proxyfox.html is checked with the site even if the
      // browser's own HTTP cache has a copy, so access codes count (a copy dropped above, or
      // one from before access codes, isn't used without one).
      const response = await fetch(key === url(APP) ? new Request(request, { cache: 'no-cache' }) : request);
      if (response.ok) event.waitUntil(cache.put(key, response.clone()));
      return isolate(response);
    }
    // everything else: straight from the network, plus the isolation headers
    return isolate(await fetch(request));
  })());
});

// Downloads a new proxyfox.html if the site has one; one check at a time.
// (The cache stores the server's own response; isolation headers are added when it is served.)
let checking = null;
const strong = (etag) => (etag || '').replace(/^W\//, '');
function checkForUpdate(cache, cached) {
  checking ??= (async () => {
    const etag = cached.headers.get('etag');
    const modified = cached.headers.get('last-modified');
    if (!etag && !modified) return; // no cheap way to ask: don't download 77 MB every time
    const headers = {};
    if (etag) headers['If-None-Match'] = etag;
    if (modified) headers['If-Modified-Since'] = modified;
    const abort = new AbortController();
    const response = await fetch(url(APP), { cache: 'no-store', headers, signal: abort.signal });
    // No access (worker/proxyfox-gate.js's answer without a valid access code, as when a code
    // was deleted; not a Cloudflare challenge, which is a 403 too): this device stops keeping
    // Proxyfox, so the next opening asks for a code. The page already open keeps running.
    if (response.status === 403 && response.headers.get('X-Proxyfox-Access') === 'denied') {
      abort.abort();
      await cache.delete(url(APP));
      await cache.delete(url(LIGHT));
      return;
    }
    // Unchanged (304), unavailable, or a server that answers 200 anyway with the same file:
    // keep the copy on the device, and stop before the body downloads.
    const unchanged = response.status === 304 || !response.ok ||
      (etag && strong(response.headers.get('etag')) === strong(etag)) ||
      (!etag && response.headers.get('last-modified') === modified);
    if (unchanged) {
      abort.abort();
      return;
    }
    await cache.put(url(APP), response);
    await cache.delete(url(LIGHT)); // made from the previous copy (it wouldn't be served anyway)
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'firefox-html-update' });
  })().catch(() => {}).finally(() => { checking = null; });
  return checking;
}

// ------------------------------------------------------------------ light copy --
// Later launches read the engine's three big files (chrome-assets.tar, gecko.wasm, ublock.tar)
// from this device (engine-cache.js), yet still read and parsed their 78 MB of Base64 in the
// page. The page asks for a light copy once all of them are on the device; this makes it from
// the full copy, streaming, with those blocks left empty (about 6 MB instead of 87 MB), and
// serves it while the full copy it came from is current. In testing the launch page was ready
// in about 0.8 s instead of 1.7 s. It is made only from the build the page has the files for
// (the build id in the copy's asset manifest must match), and the page loads the full copy
// (dropping this one) if a file turns out to be missing.
self.addEventListener('message', (event) => {
  const d = event.data;
  if (d?.type === 'proxyfox-light' && typeof d.buildId === 'string' && Array.isArray(d.assets)) {
    event.waitUntil(makeLight(d.buildId, d.assets.map(String)).catch(() => {}));
  }
});

let making = null;
function makeLight(buildId, names) {
  making ??= (async () => {
    const cache = await caches.open(CACHE);
    const full = await cache.match(url(APP));
    const v = version(full);
    if (!full || !full.body || !v) return;
    const kept = await cache.match(url(LIGHT));
    if (kept && kept.headers.get(LIGHT_OF) === v) return;
    const headers = new Headers(full.headers);
    for (const h of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(h);
    headers.set(LIGHT_OF, v);
    // A stream error (another build, no manifest) makes put() fail, so nothing is stored.
    const body = full.body.pipeThrough(withoutAssets(buildId, new Set(names)));
    await cache.put(url(LIGHT), new Response(body, { status: 200, statusText: 'OK', headers }));
  })().finally(() => { making = null; });
  return making;
}

// Copies the page, leaving the content of the named asset blocks out. pack.mjs writes each block
// as <script type="application/octet-stream" data-asset="NAME" data-encoding="base64">, then
// Base64 (which has no "<"), then </script>; the asset manifest comes before the blocks.
const enc = new TextEncoder();
const MANIFEST_TAG = enc.encode('<script type="application/json" id="asset-manifest">');
const ASSET_TAG = enc.encode('<script type="application/octet-stream" data-asset="');
const LT = 0x3c; // <
const GT = 0x3e; // >
function find(hay, needle, from) {
  for (let i = hay.indexOf(needle[0], from); i !== -1 && i + needle.length <= hay.length; i = hay.indexOf(needle[0], i + 1)) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}
function withoutAssets(buildId, names) {
  const dec = new TextDecoder();
  const TAIL = ASSET_TAG.length + 64; // kept back so a tag split between chunks is found whole
  let buf = new Uint8Array(0);
  let checked = false; // the manifest's build id matched
  let skipping = false;
  const step = (out, final) => {
    let pos = 0;
    let waiting = false; // a tag or the manifest continues in the next chunk
    while (pos < buf.length) {
      if (skipping) {
        const lt = buf.indexOf(LT, pos);
        if (lt === -1) { pos = buf.length; break; } // all Base64: left out
        skipping = false;
        pos = lt; // the block's </script> is copied
        continue;
      }
      if (!checked) {
        const m = find(buf, MANIFEST_TAG, pos);
        if (m === -1) break;
        const end = buf.indexOf(LT, m + MANIFEST_TAG.length); // the JSON has no "<" (pack.mjs escapes it)
        if (end === -1) { out.enqueue(buf.subarray(pos, m)); pos = m; waiting = true; break; }
        const manifest = JSON.parse(dec.decode(buf.subarray(m + MANIFEST_TAG.length, end)));
        if (manifest?.build?.buildId !== buildId) throw new Error('not the build whose engine files this device keeps');
        checked = true;
        out.enqueue(buf.subarray(pos, end));
        pos = end;
        continue;
      }
      const t = find(buf, ASSET_TAG, pos);
      if (t === -1) break;
      const close = buf.indexOf(GT, t + ASSET_TAG.length);
      if (close === -1) { out.enqueue(buf.subarray(pos, t)); pos = t; waiting = true; break; }
      const name = dec.decode(buf.subarray(t + ASSET_TAG.length, close)).split('"')[0];
      out.enqueue(buf.subarray(pos, close + 1));
      pos = close + 1;
      if (names.has(name)) skipping = true;
    }
    if (!skipping && !waiting) {
      const upTo = final ? buf.length : Math.max(pos, buf.length - TAIL);
      if (upTo > pos) { out.enqueue(buf.subarray(pos, upTo)); pos = upTo; }
    }
    buf = buf.subarray(pos); // never written to: views instead of copies (chunks are new arrays)
  };
  return new TransformStream({
    transform(chunk, out) {
      if (buf.length) {
        const joined = new Uint8Array(buf.length + chunk.length);
        joined.set(buf);
        joined.set(chunk, buf.length);
        buf = joined;
      } else {
        buf = chunk;
      }
      step(out, false);
    },
    flush(out) {
      step(out, true);
      if (buf.length) out.enqueue(buf);
      if (!checked) throw new Error('no asset manifest');
    },
  });
}
