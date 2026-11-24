#!/usr/bin/env node
// Signs proxyfox.html for proxyfox.svg: writes proxyfox.html.sig with the file's SHA-256 and size,
// and an ECDSA P-256 signature over them. The loader carries the public key (PUBLIC_KEY in
// svg/loader.js) and runs only a file that matches a signature made with the private key.
//
//   PROXYFOX_SIGNING_KEY="$(cat key.pem)" node svg/sign.mjs
//
// The private key is the repository secret PROXYFOX_SIGNING_KEY (the sign workflow uses it). Keep
// a copy somewhere safe. If it is lost or leaks: make a new pair (node svg/sign.mjs --new-key),
// put the new public key in loader.js, rebuild proxyfox.svg (npm run build), sign again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const message = (sha256, size) => `proxyfox.html\n${sha256}\n${size}\n`;

if (process.argv.includes('--new-key')) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const raw = publicKey.export({ format: 'jwk' });
  console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  console.log(`PUBLIC_KEY for svg/loader.js: ${JSON.stringify({ kty: 'EC', crv: 'P-256', x: raw.x, y: raw.y })}`);
  process.exit(0);
}
const pem = process.env.PROXYFOX_SIGNING_KEY;
if (!pem || !pem.includes('PRIVATE KEY')) {
  console.error('sign: set PROXYFOX_SIGNING_KEY to the private key (PEM)');
  process.exit(1);
}
const file = fs.readFileSync(path.join(ROOT, 'proxyfox.html'));
const sha256 = crypto.createHash('sha256').update(file).digest('hex');
const signature = crypto.sign('sha256', Buffer.from(message(sha256, file.length)), { key: pem, dsaEncoding: 'ieee-p1363' }).toString('base64');
const parts = partsOf(file);
fs.writeFileSync(path.join(ROOT, 'proxyfox.html.sig'), JSON.stringify({ format: 1, file: 'proxyfox.html', sha256, size: file.length, signature, parts }, null, 1) + '\n');
console.log(`sign: proxyfox.html.sig for ${sha256.slice(0, 16)}... (${file.length} bytes, ${parts.length} parts)`);

// The file's parts, for partial updates (svg/loader.js): each embedded asset's Base64 is a part, and
// so is the page text between them. An update downloads only the parts whose hash changed; the rest
// comes from the copy the loader keeps. Not signed itself: the rebuilt file is checked against the
// signed SHA-256, so a wrong list only costs a full download. svg/loader.js (partsOf) cuts the same way.
function partsOf(buf) {
  const OPEN = Buffer.from('<script type="application/octet-stream" data-asset="');
  const cuts = [0];
  for (let pos = 0; ;) {
    const tag = buf.indexOf(OPEN, pos);
    if (tag < 0) break;
    const start = buf.indexOf(0x3e, tag + OPEN.length) + 1; // after the tag's '>'
    const end = buf.indexOf(0x3c, start); // Base64 has no '<': the next one opens </script>
    if (start <= 0 || end < 0) break;
    cuts.push(start, end);
    pos = end;
  }
  cuts.push(buf.length);
  const parts = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const at = cuts[i], len = cuts[i + 1] - cuts[i];
    if (len > 0) parts.push({ at, len, sha256: crypto.createHash('sha256').update(buf.subarray(at, at + len)).digest('hex') });
  }
  return parts;
}
