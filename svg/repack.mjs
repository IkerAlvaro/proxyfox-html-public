#!/usr/bin/env node
// Repacks proxyfox.html smaller, without changing what it runs: every embedded asset is (re)compressed
// with zstd at its strongest setting (--ultra -22, long-distance matching), and the smaller of that and
// the original is kept. gecko.js and branding.tar, which the build stores uncompressed, are compressed
// too: the page undoes zstd for any asset its manifest marks so (decodeAssets, inflateHere). The raw
// files and their sha256Raw stay the same, so engine files a device already keeps are still used.
//
// Left as they are: gecko.data (handed compressed to the engine, which reads it with its own
// decoder) and mpl-source.zip (offered as a download byte for byte).
//
//   node svg/repack.mjs [in.html] [out.html]     (default: proxyfox.html in place)
//
// Needs the zstd command (apt install zstd; GitHub's ubuntu runners have it).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = process.argv[2] || path.join(ROOT, 'proxyfox.html');
const OUT = process.argv[3] || IN;
const KEEP = new Set(['gecko.data', 'mpl-source.zip']);
// Long-distance window: 2^27 = 128 MB, what the build already uses for gecko.wasm (the page's
// decoder handles it).
const ZSTD = ['-q', '-f', '--ultra', '-22', '--long=27', '-T0'];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repack-'));
const zstd = (args, input) => {
  const i = path.join(tmp, 'in'), o = path.join(tmp, 'out');
  fs.writeFileSync(i, input);
  execFileSync('zstd', [...args, i, '-o', o], { stdio: ['ignore', 'ignore', 'inherit'] });
  return fs.readFileSync(o);
};

const html = fs.readFileSync(IN, 'latin1'); // one character per byte: Base64 and tags are ASCII
const MANIFEST = /(<script type="application\/json" id="asset-manifest">)([^<]*)(<\/script>)/;
const m = MANIFEST.exec(html);
if (!m) throw new Error('repack: no asset manifest');
const manifest = JSON.parse(m[2]);
const before = html.length;
let saved = 0;

const BLOCK = /(<script type="application\/octet-stream" data-asset="([^"]+)" data-encoding="base64">)([^<]*)(<\/script>)/g;
const out = html.replace(BLOCK, (all, open, name, b64, close) => {
  const a = manifest.assets[name];
  if (!a || a.encoding !== 'base64' || KEEP.has(name)) return all;
  const stored = Buffer.from(b64, 'base64');
  if (stored.length !== a.stored || sha(stored) !== a.sha256) throw new Error(`repack: ${name} doesn't match its manifest entry`);
  const raw = a.compression === 'zstd' ? zstd(['-q', '-d', '-f'], stored) : stored;
  if (a.compression === 'zstd' && (raw.length !== a.size || (a.sha256Raw && sha(raw) !== a.sha256Raw))) throw new Error(`repack: ${name} doesn't decompress to its manifest entry`);
  const packed = zstd(ZSTD, raw);
  // Checked the way the page will read it.
  if (!zstd(['-q', '-d', '-f'], packed).equals(raw)) throw new Error(`repack: ${name} didn't survive a round trip`);
  if (packed.length >= stored.length) {
    console.log(`repack: ${name}: kept (${stored.length} bytes; -22 makes ${packed.length})`);
    return all;
  }
  manifest.assets[name] = { ...a, compression: 'zstd', stored: packed.length, sha256: sha(packed), size: raw.length, sha256Raw: a.sha256Raw || sha(raw) };
  saved += stored.length - packed.length;
  console.log(`repack: ${name}: ${stored.length} -> ${packed.length} bytes`);
  return open + packed.toString('base64') + close;
});
fs.rmSync(tmp, { recursive: true, force: true });

// The manifest's JSON has no "<" (pack.mjs escapes it; JSON.stringify of these values makes none).
const json = JSON.stringify(manifest).replace(/</g, '\\u003c');
const result = out.replace(MANIFEST, (all, open, _json, close) => open + json + close);
fs.writeFileSync(OUT, result, 'latin1');
console.log(`repack: ${(before / 1048576).toFixed(2)} MB -> ${(result.length / 1048576).toFixed(2)} MB (${(saved / 1048576).toFixed(2)} MB less stored)`);
