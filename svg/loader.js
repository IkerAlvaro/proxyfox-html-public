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
const RELAYS = ['wss://itcode.vip/api/', 'wss://wisp.mercurywork.shop/'];
// svg/sign.mjs --new-key prints this (and the private key, for the PROXYFOX_SIGNING_KEY secret).
const PUBLIC_KEY = { kty: 'EC', crv: 'P-256', x: 'g6ninswrJTM9o-G1PSQXPRAXvrOILC7-fVOIVR8plng', y: 'x9iac4XTqmRNVRoynlrAeW1nkSoyyL4ijBX5LL0Xiz8' };
const CACHE = 'proxyfox-svg';
const TEST = globalThis.__proxyfoxSvgTest || null; // local tests only: { base, relays, noDirect }
const base = () => TEST?.base || BASE;
const KEY = () => `${base()}proxyfox.html`; // the kept copy's key in Cache Storage

const $ = (id) => document.getElementById(id);
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

// A file of this repository: through each relay in turn, then straight from the browser.
async function get(name, progress) {
  let last = null;
  for (const relay of TEST?.relays || RELAYS) {
    try {
      const r = await httpsGet(relay, base() + name, progress);
      if (r.status !== 200) throw new Error(`GitHub answered ${r.status}`);
      return r.body;
    } catch (e) {
      last = e;
      console.warn(`[proxyfox.svg] ${name} not through ${relay}: ${e?.message || e}`);
    }
  }
  if (TEST?.noDirect) throw last;
  const res = await fetch(base() + name, { cache: 'no-store' }).catch((e) => { throw new Error(`no relay got it (${last?.message}), nor GitHub directly (${e.message})`); });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
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
  const body = await get(`proxyfox.html?v=${sig.sha256.slice(0, 16)}`, (n) => progress?.(n, sig.size));
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
  frame.src = URL.createObjectURL(new Blob([body], { type: 'text/html' }));
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
    show(await kept.blob());
    // A newer signed file for the next open, in the background.
    try {
      const sig = await latestSignature();
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
    await keep(cache, sig, body);
    show(body);
  } catch (e) {
    console.error(`[proxyfox.svg] Proxyfox couldn't be downloaded: ${e?.message || e}`);
    $('pf-bar').style.width = '100%';
    $('pf-bar').style.background = '#d03b3b'; // red: it failed (the console says why)
  }
}

void start();
