// proxyfox.svg's script (svg/make-svg.mjs builds it into the SVG): a standalone loader.
//
// Put proxyfox.svg on any site (or open it from disk) and it downloads the newest proxyfox.html
// from this repository through a WISP relay, over HTTPS, and runs it in a frame that fills the
// window. Raw WISP only gives a TCP connection, so the HTTPS is done here by epoxy-tls (rustls in
// WebAssembly, built in), which also checks GitHub's certificate: a relay can't read or change
// the file. Relays are tried in order; only if none answers is GitHub asked straight from the
// browser.
//
// Where the site allows it (Cache Storage), the downloaded file is kept: later opens start it at
// once and check for a newer one in the background (a conditional request, so an unchanged file
// costs almost nothing), which the next open uses.
//
// Multi-threading and a saved profile need the page that shows this SVG to be cross-origin
// isolated (the COOP/COEP headers, from the host or a service worker); the frame inherits it.
// Elsewhere Proxyfox runs single-threaded, as a downloaded copy does.
import initEpoxy, { EpoxyClient, EpoxyClientOptions } from '@mercuryworkshop/epoxy-tls/minimal-epoxy-bundled';

const SOURCE = 'https://raw.githubusercontent.com/The-Unblocked-Initiative-Repo-Access/proxyfox-html-public/main/proxyfox.html';
const RELAYS = ['wss://itcode.vip/api/', 'wss://wisp.mercurywork.shop/'];
const CACHE = 'proxyfox-svg';
const KEY = SOURCE; // the cache entry's key
const TEST = globalThis.__proxyfoxSvgTest || null; // local tests only: { source, relays, insecure }

const $ = (id) => document.getElementById(id);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer`)), ms)),
]);

let epoxyReady = null;
// GET through one relay. Resolves to { status, etag, bytes } (bytes null for a 304).
async function getVia(relay, etag, progress) {
  epoxyReady ??= initEpoxy();
  await epoxyReady;
  const options = new EpoxyClientOptions();
  options.wisp_v2 = false;
  options.redirect_limit = 5;
  options.user_agent = navigator.userAgent;
  if (TEST?.insecure) options.disable_certificate_validation = true;
  const client = new EpoxyClient(relay, options);
  try {
    const res = await withTimeout(client.fetch(TEST?.source || SOURCE, { headers: etag ? { 'If-None-Match': etag } : {} }), 20000, relay);
    return { status: res.status, etag: res.headers.get('etag'), bytes: res.status === 200 ? await readAll(res, progress) : null };
  } finally {
    try { client.free(); } catch {}
  }
}
// GET straight from the browser (GitHub's raw files allow it), when no relay answers.
async function getDirect(etag, progress) {
  const res = await fetch(TEST?.source || SOURCE, { cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {} });
  return { status: res.status, etag: res.headers.get('etag'), bytes: res.status === 200 ? await readAll(res, progress) : null };
}
async function readAll(res, progress) {
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await withTimeout(reader.read(), 60000, 'the download');
    if (done) break;
    parts.push(value);
    got += value.length;
    progress?.(got, total);
  }
  if (total && got !== total) throw new Error(`got ${mb(got)} of ${mb(total)}`);
  return new Blob(parts, { type: 'text/html' });
}
async function download(etag, progress) {
  let last = null;
  for (const relay of TEST?.relays || RELAYS) {
    try {
      return await getVia(relay, etag, progress);
    } catch (e) {
      last = e;
      console.warn(`[proxyfox.svg] ${relay} didn't get it: ${e?.message || e}`);
    }
  }
  if (TEST?.noDirect) throw last;
  try {
    return await getDirect(etag, progress);
  } catch (e) {
    throw new Error(`no relay got it through (${last?.message || last}), and GitHub couldn't be reached directly either`);
  }
}

async function openCache() {
  try { return await caches.open(CACHE); } catch { return null; } // none on file:// and some hosts
}
async function keep(cache, got) {
  if (!cache || !got.bytes) return;
  try {
    await cache.put(KEY, new Response(got.bytes, { headers: { 'Content-Type': 'text/html', ETag: got.etag || '' } }));
  } catch (e) {
    console.warn('[proxyfox.svg] not kept on this device:', e?.message || e);
  }
}

function show(blob) {
  const frame = $('pf-frame');
  frame.src = URL.createObjectURL(blob);
  frame.addEventListener('load', () => { try { frame.focus(); } catch {} }, { once: true });
}

async function start() {
  const cache = await openCache();
  const kept = cache ? await cache.match(KEY).catch(() => null) : null;
  if (kept) {
    show(await kept.blob());
    // A newer file for the next open, in the background.
    download(kept.headers.get('etag'), null).then((got) => {
      if (got.status === 200) return keep(cache, got).then(() => console.log('[proxyfox.svg] a newer Proxyfox was downloaded; it opens next time'));
      return null;
    }, (e) => console.warn('[proxyfox.svg] update check failed:', e?.message || e));
    return;
  }
  try {
    const got = await download(null, (n, total) => { if (n === total || n % (8 << 20) < 65536) console.log(`[proxyfox.svg] ${mb(n)}${total ? ` of ${mb(total)}` : ''}`); });
    if (got.status !== 200) throw new Error(`GitHub answered ${got.status}`);
    await keep(cache, got);
    show(got.bytes);
  } catch (e) {
    console.error(`[proxyfox.svg] Proxyfox couldn't be downloaded: ${e?.message || e}`);
  }
}

void start();
