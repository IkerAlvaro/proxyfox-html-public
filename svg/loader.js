// proxyfox.svg's script (svg/make-svg.mjs builds it into the SVG): a standalone loader.
//
// Put proxyfox.svg on any site (or open it from disk) and it downloads the newest proxyfox.html
// from this repository through a WISP relay, and runs it in a frame that fills the window.
//
// The connection is TLS done with the browser's own crypto (tls.js, based on zaka13alt's loader),
// which doesn't check GitHub's certificate. What makes it safe is the signature instead: each
// proxyfox.html has a proxyfox.html.sig (made by svg/sign.mjs with a private key only the sign
// workflow has), and the loader runs a file only if its SHA-256 and size match a signature that
// checks out with PUBLIC_KEY. A relay that answers in GitHub's place can't make one.
//
// Where the site allows it (Cache Storage), the file is kept: later opens start it at once and
// look for a newer signed file in the background, which the next open uses. Multi-threading and a
// saved profile need the page showing this SVG to be cross-origin isolated; the frame inherits it.
import { httpsGet } from './tls.js';

const BASE = 'https://raw.githubusercontent.com/The-Unblocked-Initiative-Repo-Access/proxyfox-html-public/main/';
// The relays, tried top to bottom for each request: the next one only when one refuses, fails or
// stops answering. Built in from wisps.json (svg/make-svg.mjs); once a download worked, the
// repository's newest wisps.json is kept (localStorage) and used from the next open, followed by
// the built-in ones it doesn't list.
const BUILT_IN = __WISPS__;
const WISPS_KEY = 'proxyfox-svg-wisps';
const isRelay = (u) => typeof u === 'string' && /^wss?:\/\/[^\s"]+$/.test(u);
function relays() {
  let kept = [];
  try { kept = JSON.parse(localStorage.getItem(WISPS_KEY) || '[]'); } catch {}
  return [...new Set([...(Array.isArray(kept) ? kept.filter(isRelay) : []), ...BUILT_IN])];
}
async function refreshRelays() {
  try {
    const list = JSON.parse(new TextDecoder().decode(await get(`wisps.json?t=${Date.now()}`)));
    if (Array.isArray(list) && list.length && list.every(isRelay)) localStorage.setItem(WISPS_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn('[proxyfox.svg] wisps.json not updated:', e?.message || e);
  }
}
// svg/sign.mjs --new-key prints this (and the private key, for the PROXYFOX_SIGNING_KEY secret).
const PUBLIC_KEY = { kty: 'EC', crv: 'P-256', x: 'g6ninswrJTM9o-G1PSQXPRAXvrOILC7-fVOIVR8plng', y: 'x9iac4XTqmRNVRoynlrAeW1nkSoyyL4ijBX5LL0Xiz8' };
const CACHE = 'proxyfox-svg';
const TEST = globalThis.__proxyfoxSvgTest || null; // local tests only: { base, relays, noDirect }
const base = () => TEST?.base || BASE;
const KEY = () => `${base()}proxyfox.html`; // the kept copy's key in Cache Storage

const $ = (id) => document.getElementById(id);
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

// A file of this repository: through the relays, then straight from the browser.
// Relays that failed in this page load: skipped for the files after, so each dead one costs once,
// not once per file. The relay that last worked goes first.
const failed = new Set();
let preferred = null;
// The relays race to connect: the first starts at once, and each HEDGE_MS without a TLS handshake
// done (or a failure) starts the next one too. The first to finish its handshake gets the request
// and the others are closed, so a dead or slow relay costs HEDGE_MS instead of its whole 3 s.
const HEDGE_MS = 500;
function race(queue, name, progress) {
  return new Promise((resolve) => {
    const live = new Map(); // relay -> AbortController
    let winner = null, timer = 0, last = null;
    const finish = (v) => { clearTimeout(timer); resolve(v); };
    const launch = () => {
      clearTimeout(timer);
      if (winner) return;
      const relay = queue.shift();
      if (!relay) { if (!live.size) finish({ last }); return; }
      const ctrl = new AbortController();
      live.set(relay, ctrl);
      httpsGet(relay, base() + name, (n, t) => progress?.(n, t), {
        signal: ctrl.signal,
        onConnect: () => {
          if (winner) { if (winner !== relay) ctrl.abort(); return; } // a redirect connects the winner again
          winner = relay;
          clearTimeout(timer);
          for (const [r, c] of live) if (r !== relay) { c.abort(); queue.unshift(r); } // not their fault: kept for a retry
        },
      }).then((r) => {
        live.delete(relay);
        if (r.status !== 200) throw new Error(`GitHub answered ${r.status}`);
        preferred = relay;
        finish({ body: r.body });
      }).catch((e) => {
        live.delete(relay);
        if (ctrl.signal.aborted && winner !== relay) return; // lost the race
        last = e;
        if (!/GitHub answered/.test(String(e?.message))) failed.add(relay); // GitHub's own answer isn't the relay's fault
        console.warn(`[proxyfox.svg] ${name} not through ${relay}: ${e?.message || e}`);
        if (winner === relay) finish({ retry: true, last }); // failed after it connected: race the rest again
        else launch();
      });
      timer = setTimeout(launch, HEDGE_MS);
    };
    launch();
  });
}
async function viaRelays(name, progress) {
  const queue = (TEST?.relays || relays()).filter((r) => !failed.has(r));
  if (preferred && queue.includes(preferred)) queue.unshift(...queue.splice(queue.indexOf(preferred), 1));
  let last = new Error('no relay left to try');
  while (queue.length) {
    const r = await race(queue, name, progress);
    if (r.body) return r.body;
    last = r.last;
    if (!r.retry) break;
  }
  throw last;
}
async function get(name, progress) {
  let last = null;
  try {
    return await viaRelays(name, progress);
  } catch (e) {
    last = e;
  }
  if (TEST?.noDirect) throw last;
  const res = await fetch(base() + name, { cache: 'no-store' }).catch((e) => { throw new Error(`no relay got it (${last?.message}), nor GitHub directly (${e.message})`); });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  // Read as it arrives, so the loading bar moves on this path too (signedFile gives the total).
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (let r; !(r = await reader.read()).done;) {
    parts.push(r.value);
    got += r.value.length;
    progress?.(got, 0);
  }
  const body = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.length; }
  return body;
}

// The newest signature, checked. Asked for with a fresh address each time, so no cache answers.
async function latestSignature() {
  const sig = JSON.parse(new TextDecoder().decode(await get(`proxyfox.html.sig?t=${Date.now()}`)));
  const key = await crypto.subtle.importKey('jwk', PUBLIC_KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = sig?.format === 1 && /^[0-9a-f]{64}$/.test(sig.sha256) && Number.isInteger(sig.size) && await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key, Uint8Array.from(atob(sig.signature), (c) => c.charCodeAt(0)),
    new TextEncoder().encode(`proxyfox.html\n${sig.sha256}\n${sig.size}\n`));
  if (!ok) throw new Error('proxyfox.html.sig is not signed by Proxyfox');
  return sig;
}

const isSigned = async (sig, body) => body.length === sig.size && hex(await crypto.subtle.digest('SHA-256', body)) === sig.sha256;

// The file the signature names, checked against it (its own address per version, so a cache
// can't hand back another one). `body` is a download already made, used if it is the signed one.
async function signedFile(sig, progress, body = null) {
  if (body && await isSigned(sig, body)) return body;
  // The total is what the wire carries (gzip through a relay), or the file's size.
  body = await get(`proxyfox.html?v=${sig.sha256.slice(0, 16)}`, (n, total) => progress?.(n, total || sig.size));
  if (!await isSigned(sig, body)) {
    throw new Error('the downloaded proxyfox.html is not the signed one (an update may be going out: try again in a minute)');
  }
  return body;
}

async function openCache() {
  try { return await caches.open(CACHE); } catch { return null; } // none on file:// and some hosts
}
async function keep(cache, sig, body) {
  if (!cache) return;
  try {
    await cache.put(KEY(), new Response(body, { headers: { 'Content-Type': 'text/html', 'X-Sha256': sig.sha256 } }));
  } catch (e) {
    console.warn('[proxyfox.svg] not kept on this device:', e?.message || e);
  }
}

// The loading bar: while Proxyfox downloads (or, from this device, starts); gone once it shows.
function progressBar(n, total) {
  $('pf-progress').style.display = 'flex';
  const pct = total ? Math.min(n >= total ? 100 : 99, (n / total) * 100) : 0;
  $('pf-bar').style.width = `${pct}%`;
}
// ------------------------------------------------------------------ light copy --
// proxyfox.html keeps its engine files (gecko.wasm, chrome-assets.tar, ...) on this device after the
// first start (its engine-cache.js, in the site's private storage, OPFS: the same storage as this
// page's, which the frame shares). Then most of the 87 MB it is made of is Base64 it won't read,
// but the browser still has to parse it. So the frame gets a light copy: the page with the content
// of those blocks left out, like the website's service worker does (sw.js). A block is left out
// only if its file is there and passes the same check the page makes (size and 16 samples hashed),
// so the page finds every file it needs. The pieces are slices of the kept copy: nothing is copied.
const ENGINE_DIR = 'proxyfox-engine-cache';
const ENGINE_ASSETS = ['chrome-assets.tar', 'gecko.wasm', 'ublock.tar', 'emoji.ttf', 'fonts.tar'];
const OPTS_KEY = 'firefox-html-opts-v2'; // the page's options: engineCache false turns its cache off
const MANIFEST_TAG = '<script type="application/json" id="asset-manifest">';
const ASSET_TAG = '<script type="application/octet-stream" data-asset="';
const ascii = async (blob, from, to) => new TextDecoder('latin1').decode(await blob.slice(from, to).arrayBuffer());
async function samplesOk(file, size, expected) {
  const n = size, s = Math.min(64 * 1024, n);
  const buf = new Uint8Array(16 * s + 8);
  for (let i = 0; i < 16; i++) {
    const at = Math.floor((n - s) * i / 15);
    buf.set(new Uint8Array(await file.slice(at, at + s).arrayBuffer()), i * s);
  }
  new DataView(buf.buffer).setFloat64(16 * s, n);
  return hex(await crypto.subtle.digest('SHA-256', buf)) === expected;
}
async function lighten(full) {
  try {
    // The page keeps engine files only when it runs from a website (not from a file on disk).
    if (!/^https?:\/\//.test(location.origin) || !navigator.storage?.getDirectory) return full;
    try { if (JSON.parse(localStorage.getItem(OPTS_KEY) || '{}').engineCache === false) return full; } catch {}
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(ENGINE_DIR);
    const kept = JSON.parse(await (await (await dir.getFileHandle('meta.json')).getFile()).text());
    if (kept?.format !== 1 || !kept.files) return full;
    const head = await ascii(full, 0, 1 << 20);
    const m = head.indexOf(MANIFEST_TAG);
    if (m < 0) return full;
    const mEnd = head.indexOf('<', m + MANIFEST_TAG.length);
    const assets = JSON.parse(head.slice(m + MANIFEST_TAG.length, mEnd)).assets;
    // latin1 keeps one character per byte, so positions in the text are positions in the file.
    const parts = [];
    let pos = mEnd, from = 0;
    for (;;) {
      const near = await ascii(full, pos, pos + 256);
      const t = near.indexOf(ASSET_TAG);
      if (t < 0) break;
      const close = near.indexOf('>', t);
      const name = near.slice(t + ASSET_TAG.length).split('"')[0];
      const a = assets[name];
      if (close < 0 || !a || a.encoding !== 'base64') break;
      const start = pos + close + 1, end = start + 4 * Math.ceil(a.stored / 3);
      if ((await ascii(full, end, end + 9)) !== '</script>') break; // not laid out as expected: stop here
      const entry = kept.files[a.sha256Raw];
      if (ENGINE_ASSETS.includes(name) && entry?.name === name && entry.size === a.size) {
        const file = await (await dir.getFileHandle(a.sha256Raw)).getFile().catch(() => null);
        if (file?.size === a.size && await samplesOk(file, a.size, entry.samples)) {
          parts.push(full.slice(from, start));
          from = end;
        }
      }
      pos = end;
    }
    if (!parts.length) return full;
    parts.push(full.slice(from));
    const light = new Blob(parts, { type: 'text/html' });
    console.log(`[proxyfox.svg] light copy: ${(light.size / 1048576).toFixed(1)} MB instead of ${(full.size / 1048576).toFixed(1)} MB (engine files are on this device)`);
    return light;
  } catch {
    return full; // no engine files kept (yet), or no storage here
  }
}

async function show(body) {
  const frame = $('pf-frame');
  const full = body instanceof Blob ? body : new Blob([body], { type: 'text/html' });
  frame.src = URL.createObjectURL(await lighten(full));
  frame.addEventListener('load', () => {
    $('pf-progress').style.display = 'none';
    try { frame.focus(); } catch {}
  }, { once: true });
}

async function start() {
  const cache = await openCache();
  const kept = cache ? await cache.match(KEY()).catch(() => null) : null;
  if (kept) {
    progressBar(1, 1);
    await show(await kept.blob());
    // A newer signed file for the next open, in the background.
    try {
      const sig = await latestSignature();
      void refreshRelays();
      if (sig.sha256 !== kept.headers.get('X-Sha256')) {
        await keep(cache, sig, await signedFile(sig));
        console.log('[proxyfox.svg] a newer Proxyfox was downloaded; it opens next time');
      }
    } catch (e) {
      console.warn('[proxyfox.svg] update check failed:', e?.message || e);
    }
    return;
  }
  try {
    progressBar(0, 0);
    // The signature and the file at once: the file's address changes every 5 minutes (so caches
    // between here and GitHub can serve it, yet not for long); if it isn't the signed one after all
    // (an update going out), the signed one is downloaded by its own address.
    let size = 0;
    const early = get(`proxyfox.html?b=${Math.floor(Date.now() / 300000)}`, (n, total) => progressBar(n, total || size))
      .catch((e) => { console.warn('[proxyfox.svg] early download failed:', e?.message || e); return null; });
    const sig = await latestSignature();
    size = sig.size;
    const body = await signedFile(sig, progressBar, await early);
    progressBar(1, 1);
    // Shown first; kept on the device (an 87 MB write) while it starts.
    await show(body);
    await keep(cache, sig, body);
    void refreshRelays(); // after the big download, not competing with it
  } catch (e) {
    console.error(`[proxyfox.svg] Proxyfox couldn't be downloaded: ${e?.message || e}`);
    $('pf-bar').style.width = '100%';
    $('pf-bar').style.background = '#d03b3b'; // red: it failed (the console says why)
  }
}

void start();
