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
// The relays, per web filter ({ "GoGuardian": [relays], ..., "Not sure": [...] }; an old plain list is
// one filter). The person picks their filter (Choose your filter, the first time), and for each
// request its relays are tried top to bottom, then the other filters': the next one only when one
// refuses, fails or stops answering. Built in from wisps.json (svg/make-svg.mjs); once a download
// worked, the repository's newest wisps.json is kept (localStorage) and used from the next open,
// followed by the built-in relays it doesn't list. The chosen filter is kept under the name
// Proxyfox reads too (proxyfox-filter), and the frame is named after it for a loader opened from a
// file, so Proxyfox doesn't ask again.
const BUILT_IN = __WISPS__;
const WISPS_KEY = 'proxyfox-svg-wisps';
const FILTER_KEY = 'proxyfox-filter';
const isRelay = (u) => typeof u === 'string' && /^wss?:\/\/[^\s"]+$/.test(u);
function parseFilters(data) {
  if (Array.isArray(data)) data = { 'All relays': data };
  if (!data || typeof data !== 'object') return null;
  const out = {};
  for (const [name, list] of Object.entries(data)) {
    const urls = Array.isArray(list) ? [...new Set(list.filter(isRelay))] : [];
    if (name.trim() && urls.length) out[name.trim()] = urls;
  }
  return Object.keys(out).length ? out : null;
}
function filters() {
  try { return parseFilters(JSON.parse(localStorage.getItem(WISPS_KEY) || 'null')) || BUILT_IN; } catch { return BUILT_IN; }
}
let chosen = '';
function relays() {
  const f = filters();
  return [...new Set([...(f[chosen] || []), ...Object.values(f).flat(), ...Object.values(BUILT_IN).flat()])];
}
async function refreshRelays() {
  try {
    const list = JSON.parse(new TextDecoder().decode(await get(`wisps.json?t=${Date.now()}`)));
    if (parseFilters(list)) localStorage.setItem(WISPS_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn('[proxyfox.svg] wisps.json not updated:', e?.message || e);
  }
}
// The filter: the kept one if the list still has it, the only one if there is just one, else asked.
async function chooseFilter() {
  const names = Object.keys(filters());
  let name = '';
  try { name = localStorage.getItem(FILTER_KEY) || ''; } catch {}
  if (!names.includes(name)) name = names.length === 1 ? names[0] : await askFilter(names);
  try { localStorage.setItem(FILTER_KEY, name); } catch {}
  chosen = name;
}
function askFilter(names) {
  const select = $('pf-filter-select'), go = $('pf-filter-go');
  const option = (value, text) => {
    const o = document.createElementNS('http://www.w3.org/1999/xhtml', 'option'); // an SVG page has no new Option()
    o.value = value;
    o.textContent = text;
    return o;
  };
  select.replaceChildren(option('', 'Select your filter'), ...names.map((n) => option(n, n)));
  select.firstChild.disabled = true;
  select.value = '';
  go.disabled = true;
  go.style.opacity = '.5';
  $('pf-filter').style.display = 'flex';
  return new Promise((resolve) => {
    select.onchange = () => { go.disabled = !select.value; go.style.opacity = select.value ? '1' : '.5'; };
    go.onclick = () => {
      if (!select.value) return;
      $('pf-filter').style.display = 'none';
      resolve(select.value);
    };
  });
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
async function get(name, progress) {
  const queue = (TEST?.relays || relays()).filter((r) => !failed.has(r));
  if (preferred && queue.includes(preferred)) queue.unshift(...queue.splice(queue.indexOf(preferred), 1));
  let last = null;
  while (queue.length) {
    const r = await race(queue, name, progress);
    if (r.body) return r.body;
    last = r.last;
    if (!r.retry) break;
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

// The file the signature names, checked against it (its own address per version, so a cache
// can't hand back another one).
async function signedFile(sig, progress) {
  // The total is what the wire carries (gzip through a relay), or the file's size.
  const body = await get(`proxyfox.html?v=${sig.sha256.slice(0, 16)}`, (n, total) => progress?.(n, total || sig.size));
  if (body.length !== sig.size || hex(await crypto.subtle.digest('SHA-256', body)) !== sig.sha256) {
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
function show(body) {
  const frame = $('pf-frame');
  frame.name = `proxyfox-filter:${chosen}`;
  frame.src = URL.createObjectURL(new Blob([body], { type: 'text/html' }));
  frame.addEventListener('load', () => {
    $('pf-progress').style.display = 'none';
    try { frame.focus(); } catch {}
  }, { once: true });
}

async function start() {
  await chooseFilter();
  const cache = await openCache();
  const kept = cache ? await cache.match(KEY()).catch(() => null) : null;
  if (kept) {
    progressBar(1, 1);
    show(await kept.blob());
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
    const sig = await latestSignature();
    const body = await signedFile(sig, progressBar);
    progressBar(1, 1);
    // Shown first; kept on the device (an 87 MB write) while it starts.
    show(body);
    await keep(cache, sig, body);
    void refreshRelays(); // after the big download, not competing with it
  } catch (e) {
    console.error(`[proxyfox.svg] Proxyfox couldn't be downloaded: ${e?.message || e}`);
    $('pf-bar').style.width = '100%';
    $('pf-bar').style.background = '#d03b3b'; // red: it failed (the console says why)
  }
}

void start();
