#!/usr/bin/env node
// Builds Proxyfox as an Isolated Web App: a signed web bundle (proxyfox.swbn) made from proxyfox.html.
//
//   PROXYFOX_IWA_KEY="$(cat iwa-key.pem)" node iwa/build.mjs [proxyfox.html] [--dir out/]
//
// Ported from IkerAlvaro's fork, with this project's own signing key (the PROXYFOX_IWA_KEY secret,
// .github/workflows/iwa.yml builds it after every new proxyfox.html).
//   node iwa/build.mjs --new-key        prints a new Ed25519 key (keep it: it IS the app's identity)
//
// What an IWA changes, and what this does about it:
// - Its CSP is fixed: script-src 'self' 'wasm-unsafe-eval', Trusted Types required. proxyfox.html
//   runs everything from inline scripts and blob:/data: URLs, so here each piece becomes a file of
//   the bundle: app.js (the page's module), engine/gecko-glue.js (gecko.js with the page's own
//   GLUE_PATCHES applied now instead of at start), and the engine's clock worker, audio worklets
//   and thread probe. boot.js gives Trusted Types a pass-through default policy.
// - The embedded assets are files of the bundle (assets/NAME, the stored zstd bytes) instead of
//   Base64 in the page: 21 MB less, and nothing to parse or decode from text at each start.
// - It is always cross-origin isolated: threads, SharedArrayBuffer and a saved profile, with no
//   service worker or special headers.
// - It may use Direct Sockets: boot.js answers the app's WISP connection itself and opens each
//   stream as a real TCP/UDP socket (no relay).
// Every change is checked to apply exactly once: a proxyfox.html this doesn't fit stops the build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as wbn from 'wbn';
import * as wbnSign from 'wbn-sign';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const args = process.argv.slice(2);

if (args.includes('--new-key')) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  process.stdout.write(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.exit(0);
}
const dirAt = args.indexOf('--dir');
const DIR = dirAt >= 0 ? args[dirAt + 1] : null; // also write the files, unpacked (for testing)
const IN = args.find((a, i) => !a.startsWith('--') && i !== dirAt + 1) || path.join(ROOT, 'proxyfox.html');
const OUT = path.join(ROOT, 'proxyfox.swbn');
// Where the bundle is published (this repository, served at pr0xyfox.dev): installed copies look for updates in
// update.json there (the manifest's update_manifest_url).
const SITE = 'https://pr0xyfox.dev/';

const fail = (m) => { throw new Error(`iwa: ${m}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Replaces `from` with `to`, which must be there exactly once.
const once = (src, from, to, what) => {
  const n = src.split(from).length - 1;
  if (n !== 1) fail(`${what}: found ${n} times, expected once (proxyfox.html changed: update iwa/build.mjs)`);
  return src.replace(from, () => to);
};
const zstdDecode = (bytes) => {
  if (typeof zlib.zstdDecompressSync === "function") return zlib.zstdDecompressSync(bytes, { params: { [zlib.constants.ZSTD_d_windowLogMax]: 31 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwa-'));
  try {
    fs.writeFileSync(path.join(dir, 'in'), bytes);
    execFileSync('zstd', ['-q', '-d', '-f', '--long=31', path.join(dir, 'in'), '-o', path.join(dir, 'out')]);
    return fs.readFileSync(path.join(dir, 'out'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// ------------------------------------------------------------------ take proxyfox.html apart --
const html = fs.readFileSync(IN, 'utf8');
const MANIFEST_RE = /<script type="application\/json" id="asset-manifest">([^<]*)<\/script>/;
const mm = MANIFEST_RE.exec(html) || fail('no asset manifest');
const manifest = JSON.parse(mm[1]);
const assets = new Map();
for (const m of html.matchAll(/<script type="application\/octet-stream" data-asset="([^"]+)" data-encoding="base64">([^<]*)<\/script>/g)) {
  const a = manifest.assets[m[1]] || fail(`${m[1]} isn't in the manifest`);
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length !== a.stored || sha(bytes) !== a.sha256) fail(`${m[1]} doesn't match its manifest entry`);
  assets.set(m[1], bytes);
}
for (const name of Object.keys(manifest.assets)) if (!assets.has(name)) fail(`${name} is missing`);
const MODULE_OPEN = '<script type="module">';
const modAt = html.lastIndexOf(MODULE_OPEN);
const modEnd = html.lastIndexOf('</script>');
if (modAt < 0 || modEnd < modAt) fail('no module script');
let app = html.slice(modAt + MODULE_OPEN.length, modEnd);
if (html.slice(modEnd + 9).replace(/\s|<\/body>|<\/html>/g, '') !== '') fail('something follows the module script');

// ------------------------------------------------------------------ engine glue --
const gA = app.indexOf('var GLUE_PATCHES = ['), gB = app.indexOf('function patchGlue(src)');
if (gA < 0 || gB < gA) fail('no GLUE_PATCHES');
// The page's own patch list, as the page applies it (patchGlue), here at build time.
const GLUE_PATCHES = new Function(`${app.slice(gA, gB)}; return GLUE_PATCHES;`)();
const geckoMeta = manifest.assets['gecko.js'];
let glue = (geckoMeta.compression === 'zstd' ? zstdDecode(assets.get('gecko.js')) : assets.get('gecko.js')).toString('utf8');
for (const p of GLUE_PATCHES) {
  const n = glue.split(p.from).length - 1;
  if (n !== (p.count ?? 1)) fail(`glue patch "${p.name}" fits ${n} times`);
  glue = glue.split(p.from).join(p.to);
}
const files = new Map(); // path -> [bytes, content type]
const js = (p, src) => files.set(p, [Buffer.from(src, 'utf8'), 'text/javascript; charset=utf-8']);

// The clock worker: its code was a string made into a blob: URL.
{
  const re = /new Worker\(URL\.createObjectURL\(new Blob\(\[("(?:[^"\\]|\\.)*")\], \{ type: "text\/javascript" \}\)\)\)/g;
  const found = [...glue.matchAll(re)];
  if (found.length !== 1) fail(`clock worker found ${found.length} times`);
  js('/engine/clock-worker.js', JSON.parse(found[0][1]) + '\n');
  glue = once(glue, found[0][0], 'new Worker("/engine/clock-worker.js")', 'clock worker');
}
// The audio sink worklet: its code was a string made into a data: URL.
{
  const URL_LINE = 'var url = "data:application/javascript;charset=utf-8," + encodeURIComponent(code);';
  const at = glue.indexOf(URL_LINE);
  const codeAt = glue.lastIndexOf('var code = ', at);
  if (at < 0 || codeAt < 0) fail('audio sink worklet not found');
  const expr = glue.slice(codeAt + 'var code = '.length, at).trim().replace(/;$/, '');
  js('/engine/host-audio-sink.js', new Function(`return (${expr});`)() + '\n');
  glue = once(glue, URL_LINE, 'var url = "/engine/host-audio-sink.js";', 'audio sink worklet');
}
// The audio mix worklet: a function of the glue, made into a blob: URL with toString().
{
  const DECL = 'var geckoAudioOutWorklet = ';
  const at = glue.indexOf(DECL);
  if (at < 0 || glue.indexOf(DECL, at + 1) >= 0) fail('geckoAudioOutWorklet not found once');
  // The function expression, exactly (acorn finds where it ends).
  const fn = acorn.parseExpressionAt(glue, at + DECL.length, { ecmaVersion: 'latest' });
  if (fn.type !== 'FunctionExpression') fail('geckoAudioOutWorklet is not a function');
  js('/engine/gecko-out-mix.js', `(${glue.slice(fn.start, fn.end)})();\n`);
  glue = once(glue, 'return URL.createObjectURL(new Blob([ "(" + geckoAudioOutWorklet.toString() + ")();" ], {\n      type: "text/javascript"\n    }));',
    'return "/engine/gecko-out-mix.js";', 'audio mix worklet');
}
for (const bad of [/\beval\(/, /new Function\b/, /data:application\/javascript/]) if (bad.test(glue)) fail(`the glue still has ${bad}`);
// The engine's threads run this file too: they need the same Trusted Types policy.
js('/engine/gecko-glue.js', `if (self.trustedTypes && !self.trustedTypes.defaultPolicy) self.trustedTypes.createPolicy("default", { createHTML: (s) => s, createScriptURL: (s) => s, createScript: (s) => s });\n${glue}`);

// ------------------------------------------------------------------ the page's module --
// The engine: its patched glue is a file now, not a blob: URL made at start.
app = once(app, 'var geckoBlobUrl = () => _geckoUrl ??= toBlobUrl(geckoGlueSource);', 'var geckoBlobUrl = () => "/engine/gecko-glue.js";', 'engine script');
// wasm-bindgen (epoxy) asks for Function("return this") to find the global object.
app = once(app, 'const ret = new Function(getStringFromWasm0(arg0, arg1));',
  'const src = getStringFromWasm0(arg0, arg1);\n    const ret = /^\\s*return this;?\\s*$/.test(src) ? function() { return globalThis; } : new Function(src);', 'Function("return this")');
// The thread check's tiny worker.
const PROBE = 'onmessage=e=>{Atomics.store(new Int32Array(e.data.buffer),0,7);postMessage(1)}';
app = once(app, `url = URL.createObjectURL(new Blob(["${PROBE}"], { type: "text/javascript" }));`, 'url = "/engine/probe-worker.js";', 'thread check worker');
js('/engine/probe-worker.js', PROBE + '\n');
// Engine files kept on the device (OPFS): an IWA keeps them like a website does.
app = once(app, 'function siteStorage() {\n  return ', 'function siteStorage() {\n  return location.protocol === "isolated-app:" || ', 'site storage');
// The assets: files of the bundle, read as they are stored (no Base64).
app = once(app, 'async function decodeAssets() {', 'var iwaAsset = async (name) => new Uint8Array(await (await fetch("/assets/" + name)).arrayBuffer());\nasync function decodeAssets() {', 'asset reader');
app = once(app, 'const bytes = await base64ToBytes(takeBase64(name));', 'const bytes = await iwaAsset(name);', 'asset decoding');
app = once(app, 'const block2 = document.querySelector(\'script[data-asset="mpl-source.zip"]\');\n  if (!block2?.firstChild) return;\n  const bytes = await base64ToBytes(block2.textContent);',
  'const bytes = await iwaAsset("mpl-source.zip");', 'MPL source download');
js('/app.js', app);
js('/boot.js', fs.readFileSync(path.join(HERE, 'boot.js'), 'utf8'));
for (const [name, bytes] of assets) files.set(`/assets/${name}`, [bytes, 'application/octet-stream']);

// ------------------------------------------------------------------ the page --
let page = html.slice(0, mm.index + mm[0].length);
page = once(page, '</title>', '</title>\n<link rel="manifest" href="/.well-known/manifest.webmanifest">\n<script src="/boot.js"></script>', 'title');
page += '\n<script type="module" src="/app.js"></script>\n</body>\n</html>\n';
if (/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/.test(page)) fail('the page still has an inline script');
const htmlFile = [Buffer.from(page, 'utf8'), 'text/html; charset=utf-8'];
files.set('/', htmlFile);
files.set('/index.html', htmlFile);

// ------------------------------------------------------------------ icons and the app's manifest --
const ico = fs.readFileSync(path.join(ROOT, 'favicon.ico'));
files.set('/icons/favicon.ico', [ico, 'image/x-icon']);
const icons = [];
for (let i = 0, n = ico.readUInt16LE(4); i < n; i++) {
  const e = 6 + 16 * i, size = ico[e] || 256, len = ico.readUInt32LE(e + 8), off = ico.readUInt32LE(e + 12);
  const png = ico.subarray(off, off + len);
  if (png.subarray(0, 4).toString('latin1') !== '\x89PNG') continue;
  files.set(`/icons/icon-${size}.png`, [png, 'image/png']);
  icons.push({ src: `/icons/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' });
}
if (!icons.length) fail('favicon.ico has no PNG image for the app icon');
const b = manifest.build || {};
// The last number is the bundle's own revision for the same proxyfox.html build: raise it when
// iwa/ changes without a new proxyfox.html, or installed copies would not take the new bundle.
const IWA_REVISION = 0;
const version = `${b.update?.id ?? 0}.${(b.date || '1970-01-01').replace(/-/g, '')}.${IWA_REVISION}`;
const webManifest = {
  name: b.brandName || 'Proxyfox',
  short_name: b.brandName || 'Proxyfox',
  description: `Firefox ${b.geckoVersion || ''} (Gecko compiled to WebAssembly), as an installed app that connects on its own`.replace(/\s+/g, ' '),
  id: '/',
  start_url: '/',
  scope: '/',
  version,
  update_manifest_url: `${SITE}update.json`,
  display: 'standalone',
  display_override: ['standalone'],
  // One window: a second launch focuses the open one instead of loading another 600 MB engine.
  launch_handler: { client_mode: 'focus-existing' },
  background_color: '#131211',
  theme_color: '#131211',
  icons,
  categories: ['productivity', 'utilities'],
  // What the app may use. cross-origin-isolated: threads and SharedArrayBuffer. direct-sockets: its
  // own TCP/UDP connections (boot.js). The rest: what Firefox in the page needs (copy and paste,
  // full screen, sound, location for sites that ask, passkeys).
  permissions_policy: {
    'cross-origin-isolated': ['self'],
    'direct-sockets': ['self'],
    'clipboard-read': ['self'],
    'clipboard-write': ['self'],
    fullscreen: ['self'],
    autoplay: ['self'],
    geolocation: ['self'],
    'publickey-credentials-get': ['self'],
    'publickey-credentials-create': ['self'],
    'keyboard-lock': ['self'], // Ctrl+T, Ctrl+W, Ctrl+Tab ... go to Firefox, not to the browser hosting the app
    'screen-wake-lock': ['self'], // the screen stays on while Proxyfox is in use (video, reading)
    'window-management': ['self'], // full screen on the display the person chooses
  },
};
const wm = [Buffer.from(JSON.stringify(webManifest, null, 2)), 'application/manifest+json'];
files.set('/.well-known/manifest.webmanifest', wm);
files.set('/manifest.webmanifest', wm);

// ------------------------------------------------------------------ write --
if (DIR) {
  for (const [p, [bytes]] of files) {
    const f = path.join(DIR, p === '/' ? 'index.html' : p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, bytes);
  }
  console.log(`iwa: files in ${DIR}`);
}
const pem = process.env.PROXYFOX_IWA_KEY;
if (!pem) {
  console.log('iwa: no PROXYFOX_IWA_KEY: not bundled (node iwa/build.mjs --new-key makes one)');
  process.exit(0);
}
const builder = new wbn.BundleBuilder('b2');
for (const [p, [bytes, type]] of [...files].sort(([a], [b2]) => (a < b2 ? -1 : 1))) {
  builder.addExchange(p, 200, { 'Content-Type': type }, bytes);
}
const bundle = builder.createBundle();
const signed = await wbnSign.SignedWebBundle.fromWebBundle(bundle, [new wbnSign.NodeCryptoSigningStrategy(wbnSign.parsePemKey(pem))]);
const bytes = signed.getSignedWebBundleBytes();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bytes);
const id = signed.getWebBundleId();
fs.writeFileSync(path.join(ROOT, 'update.json'), JSON.stringify({ versions: [{ version, src: `${SITE}proxyfox.swbn` }] }, null, 2) + '\n');
console.log(`iwa: ${OUT} (${(bytes.length / 1048576).toFixed(1)} MB, version ${version})`);
console.log(`iwa: app id ${id}: isolated-app://${id}/`);
