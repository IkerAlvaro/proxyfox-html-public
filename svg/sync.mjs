#!/usr/bin/env node
// Brings upstream's newest proxyfox.html into this fork: downloads it with its proxyfox.html.sig from
// The-Unblocked-Initiative-Repo-Access/proxyfox-html-public, checks that signature with UPSTREAM's
// public key (so only a file upstream signed gets in), repacks it smaller (svg/repack.mjs), and takes
// upstream's wisps.json too. Signing it with this fork's key is the next step:
//
//   node svg/sync.mjs            prints "changed" or "unchanged" as its last line
//   PROXYFOX_SIGNING_KEY="$(cat key.pem)" node svg/sign.mjs
//   npm run build                (the loader has the relays built in)
//
// upstream.json records which upstream file this fork's proxyfox.html was made from.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const UPSTREAM = 'https://raw.githubusercontent.com/The-Unblocked-Initiative-Repo-Access/proxyfox-html-public/main/';
// Upstream's key (PUBLIC_KEY of upstream's svg/loader.js).
const UPSTREAM_KEY = { kty: 'EC', crv: 'P-256', x: 'g6ninswrJTM9o-G1PSQXPRAXvrOILC7-fVOIVR8plng', y: 'x9iac4XTqmRNVRoynlrAeW1nkSoyyL4ijBX5LL0Xiz8' };
const RECORD = path.join(ROOT, 'upstream.json');
// What a signature covers (the same as svg/sign.mjs's message, which can't be imported: it signs on load).
const message = (sha256, size) => `proxyfox.html\n${sha256}\n${size}\n`;

async function download(name) {
  const res = await fetch(`${UPSTREAM}${name}${name.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`sync: upstream answered ${res.status} for ${name}`);
  return Buffer.from(await res.arrayBuffer());
}

const sig = JSON.parse((await download('proxyfox.html.sig')).toString('utf8'));
const key = crypto.createPublicKey({ key: UPSTREAM_KEY, format: 'jwk' });
const valid = sig?.format === 1 && /^[0-9a-f]{64}$/.test(sig.sha256) && Number.isInteger(sig.size) &&
  crypto.verify('sha256', Buffer.from(message(sig.sha256, sig.size)), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.signature, 'base64'));
if (!valid) throw new Error('sync: upstream proxyfox.html.sig is not signed by upstream');

let record = {};
try { record = JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch {}

// The relay list follows upstream's either way.
try {
  const wisps = JSON.parse((await download('wisps.json')).toString('utf8'));
  // A plain list, or { "filter name": [relays] } (what upstream uses now): the same check svg/make-svg.mjs makes.
  const relay = (u) => typeof u === 'string' && /^wss?:\/\/[^\s"]+$/.test(u);
  const lists = Array.isArray(wisps) ? [wisps] : wisps && typeof wisps === 'object' ? Object.values(wisps) : [];
  if (lists.length && lists.every((l) => Array.isArray(l) && l.length && l.every(relay))) {
    fs.writeFileSync(path.join(ROOT, 'wisps.json'), JSON.stringify(wisps, null, 2) + '\n');
  } else {
    console.warn('sync: upstream wisps.json has a shape this does not know: kept the current one');
  }
} catch (e) {
  console.warn(`sync: wisps.json not updated: ${e.message}`);
}

if (record.sha256 === sig.sha256) {
  console.log(`sync: upstream is still ${sig.sha256.slice(0, 16)}...`);
  console.log('unchanged');
  process.exit(0);
}

const file = await download(`proxyfox.html?v=${sig.sha256.slice(0, 16)}`);
if (file.length !== sig.size || crypto.createHash('sha256').update(file).digest('hex') !== sig.sha256) {
  throw new Error('sync: the downloaded proxyfox.html is not the one upstream signed (an update may be going out)');
}
const target = path.join(ROOT, 'proxyfox.html');
fs.writeFileSync(target, file);
execFileSync(process.execPath, [path.join(HERE, 'repack.mjs'), target], { stdio: 'inherit' });
fs.writeFileSync(RECORD, JSON.stringify({ sha256: sig.sha256, size: sig.size, synced: new Date().toISOString() }, null, 1) + '\n');
console.log(`sync: proxyfox.html is upstream's ${sig.sha256.slice(0, 16)}..., repacked`);
console.log('changed');
