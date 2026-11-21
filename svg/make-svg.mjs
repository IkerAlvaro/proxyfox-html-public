#!/usr/bin/env node
// Builds proxyfox.svg from svg/loader.js: bundles it (with epoxy-tls, inlined) and puts it in the
// SVG's script. Run after changing loader.js:
//
//   npm install
//   npm run build
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'proxyfox.svg');

const bundle = await build({
  entryPoints: [path.join(HERE, 'loader.js')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  legalComments: 'inline',
  write: false,
  logLevel: 'warning',
});
// Inside CDATA only "]]>" can end the script early: split it across two CDATA sections.
const js = bundle.outputFiles[0].text.replace(/]]>/g, ']]]]><![CDATA[>');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Proxyfox: Made by CodedbyZach, zaka13alt and cdrlol. A loader that downloads proxyfox.html
     through a WISP relay and runs it. Licensed under the GNU AGPL 3.0 with an attribution term
     (LICENSE in https://github.com/The-Unblocked-Initiative-Repo-Access/proxyfox-html-public);
     the built-in epoxy-tls is AGPL-3.0 (https://github.com/MercuryWorkshop/epoxy-tls).
     Built from svg/loader.js by svg/make-svg.mjs. -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml"
     width="100%" height="100%" style="display:block;margin:0;padding:0;background:#131211;">
  <title>Proxyfox</title>
  <foreignObject x="0" y="0" width="100%" height="100%">
    <xhtml:iframe id="pf-frame"
      allow="cross-origin-isolated; clipboard-read; clipboard-write; fullscreen; geolocation; autoplay; publickey-credentials-create; publickey-credentials-get"
      style="position:absolute;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;display:block;background:#131211;"></xhtml:iframe>
  </foreignObject>
  <script><![CDATA[
${js}
  ]]></script>
</svg>
`;
fs.writeFileSync(OUT, svg);
console.log(`make-svg: wrote ${OUT} (${(svg.length / 1048576).toFixed(2)} MB)`);
