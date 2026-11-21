#!/usr/bin/env node
// Builds proxyfox.svg from svg/loader.js and svg/tls.js: bundles them and puts them in the
// SVG's script. Run after changing loader.js or tls.js:
//
//   npm install
//   npm run build
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'proxyfox.svg');
// The tab icon: the site's favicon at 32 px (svg/icon32.png), in the SVG so it shows anywhere.
const ICON = fs.readFileSync(path.join(HERE, 'icon32.png')).toString('base64');

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
     (LICENSE in https://github.com/The-Unblocked-Initiative-Repo-Access/proxyfox-html-public).
     It runs only a proxyfox.html signed by Proxyfox (proxyfox.html.sig).
     Built from svg/loader.js by svg/make-svg.mjs. -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml"
     width="100%" height="100%" style="display:block;margin:0;padding:0;background:#131211;">
  <title>Proxyfox</title>
  <xhtml:link rel="icon" type="image/png" href="data:image/png;base64,${ICON}"/>
  <foreignObject x="0" y="0" width="100%" height="100%">
    <xhtml:iframe id="pf-frame"
      allow="cross-origin-isolated; clipboard-read; clipboard-write; fullscreen; geolocation; autoplay; publickey-credentials-create; publickey-credentials-get"
      style="position:absolute;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;display:block;background:#131211;"></xhtml:iframe>
    <xhtml:div id="pf-progress" style="position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#131211;color:#ecebe8;font:600 14px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-variant-numeric:tabular-nums;">
      <xhtml:div style="width:min(260px,70vw);height:4px;border-radius:2px;background:#2c2b29;overflow:hidden;"><xhtml:div id="pf-bar" style="height:100%;width:0;background:#7bd648;transition:width .2s;"></xhtml:div></xhtml:div>
    </xhtml:div>
  </foreignObject>
  <script><![CDATA[
${js}
  ]]></script>
</svg>
`;
fs.writeFileSync(OUT, svg);
console.log(`make-svg: wrote ${OUT} (${(svg.length / 1048576).toFixed(2)} MB)`);
