// Builds the page into web/dist/: one bundled app.js plus index.html and the icon. `node web/build.mjs`
// The script tag gets ?v=<build time> because the web host caches app.js.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const dist = new URL('dist/', here);
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [new URL('app.js', here).pathname],
  outfile: new URL('app.js', dist).pathname,
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none', logLevel: 'warning',
});
const v = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
writeFileSync(new URL('index.html', dist), readFileSync(new URL('index.html', here), 'utf8').replace('app.js?v=dev', `app.js?v=${v}`));
copyFileSync(new URL('icon.svg', here), new URL('icon.svg', dist));
console.log(`web/dist built (v=${v})`);
