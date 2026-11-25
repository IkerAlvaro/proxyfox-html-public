#!/usr/bin/env node
// Applies this fork's performance patches (svg/patches/*.mjs) to proxyfox.html.
//
//   node svg/patch.mjs [in.html] [out.html]      (default: proxyfox.html in place)
//   node svg/patch.mjs --check [in.html]         dry run: says what applies, writes nothing
//
// A patch file exports (default) an array of
//   { name, target, from, to, count? }
//   target: 'app'  the page's module script (the app: options, paint, input, wisp client, ...)
//           'glue' gecko.js, the engine's JavaScript (as the page has it AFTER its own GLUE_PATCHES)
//   from/to: exact text; `from` must occur `count` times (default 1). A patch whose `from` is gone
//           and whose `to` is there is taken as already applied, so running this twice is fine.
// Anything else stops the run: a proxyfox.html this doesn't fit must not be shipped half patched.
//
// 'glue' patches run on gecko.js as stored, i.e. BEFORE the page's own GLUE_PATCHES (resources/src/
// glue-patches.js, applied at start), which must keep matching exactly once: check() below runs them
// on the result and refuses a patched glue they no longer fit.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const [IN = path.join(ROOT, 'proxyfox.html'), OUT = IN] = args.filter((a) => !a.startsWith('--'));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fail = (m) => { throw new Error(`patch: ${m}`); };
const count = (s, t) => s.split(t).length - 1;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-'));
const zstd = (a, input) => {
  fs.writeFileSync(path.join(tmp, 'i'), input);
  execFileSync('zstd', [...a, path.join(tmp, 'i'), '-o', path.join(tmp, 'o')], { stdio: ['ignore', 'ignore', 'inherit'] });
  return fs.readFileSync(path.join(tmp, 'o'));
};

const dir = path.join(HERE, 'patches');
const patches = [];
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort() : []) {
  for (const p of (await import(path.join(dir, f))).default) patches.push({ ...p, file: f });
}

const html = fs.readFileSync(IN, 'utf8');
const MANIFEST = /(<script type="application\/json" id="asset-manifest">)([^<]*)(<\/script>)/;
const mm = MANIFEST.exec(html) || fail('no asset manifest');
const manifest = JSON.parse(mm[2]);
const OPEN = '<script type="module">';
const modAt = html.lastIndexOf(OPEN), modEnd = html.lastIndexOf('</script>');
if (modAt < 0 || modEnd < modAt) fail('no module script');
let app = html.slice(modAt + OPEN.length, modEnd);

const GECKO = /(<script type="application\/octet-stream" data-asset="gecko\.js" data-encoding="base64">)([^<]*)(<\/script>)/;
const gm = GECKO.exec(html) || fail('no gecko.js block');
const ga = manifest.assets['gecko.js'];
const storedGlue = Buffer.from(gm[2], 'base64');
let glue = (ga.compression === 'zstd' ? zstd(['-q', '-d', '-f'], storedGlue) : storedGlue).toString('utf8');

const targets = { app: () => app, glue: () => glue };
const set = { app: (v) => { app = v; }, glue: (v) => { glue = v; } };
let applied = 0, already = 0;
for (const p of patches) {
  if (!targets[p.target]) fail(`${p.file}: "${p.name}" has no target app/glue`);
  const src = targets[p.target](), want = p.count ?? 1;
  const n = count(src, p.from), done = count(src, p.to);
  // Already applied: `to` is there and `from` is gone, or `to` contains `from` (then `from` stays after a
  // patch, and applying it again would nest the change in itself).
  if (done >= want && (n === 0 || p.to.includes(p.from))) { already++; continue; }
  if (n !== want) fail(`${p.file}: "${p.name}" matches ${n} times in ${p.target}, expected ${want}`);
  set[p.target](src.split(p.from).join(p.to));
  applied++;
}

// The page's own glue patches must still fit the patched glue (it applies them at start).
{
  const a = app.indexOf('var GLUE_PATCHES = ['), b = app.indexOf('function patchGlue(src)');
  if (a < 0 || b < a) fail('GLUE_PATCHES not found in the app');
  const own = new Function(`${app.slice(a, b)}; return GLUE_PATCHES;`)();
  let g = glue;
  for (const p of own) {
    const n = count(g, p.from);
    if (n !== (p.count ?? 1)) fail(`the page's own glue patch "${p.name}" fits ${n} times after these patches`);
    g = g.split(p.from).join(p.to);
  }
}
console.log(`patch: ${applied} applied, ${already} already there, ${patches.length} in svg/patches`);
if (CHECK) { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }

let out = html.slice(0, modAt + OPEN.length) + app + html.slice(modEnd);
if (glue !== (ga.compression === 'zstd' ? zstd(['-q', '-d', '-f'], storedGlue) : storedGlue).toString('utf8')) {
  const raw = Buffer.from(glue, 'utf8');
  const packed = zstd(['-q', '-f', '--ultra', '-19'], raw);
  manifest.assets['gecko.js'] = { ...ga, compression: 'zstd', stored: packed.length, sha256: sha(packed), size: raw.length, sha256Raw: sha(raw) };
  out = out.replace(GECKO, (_all, open, _b64, close) => open + packed.toString('base64') + close);
}
// A new build id: engine files kept on devices and light copies are tied to the build.
manifest.build = { ...manifest.build, patched: sha(Buffer.from(JSON.stringify(patches.map((p) => [p.file, p.name, p.from, p.to])))).slice(0, 12) };
out = out.replace(MANIFEST, (_all, open, _json, close) => open + JSON.stringify(manifest).replace(/</g, '\\u003c') + close);
fs.writeFileSync(OUT, out, 'utf8');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`patch: wrote ${OUT}`);
