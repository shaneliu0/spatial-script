// Bundles the page entry point and the development stub core into web/dist.

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');

const shared = {
  bundle: true,
  // Every `console` reference inside the bundle, three.js included, resolves to
  // the copy index.html captured before the core installed its own console.
  define: { console: 'window.__spatialConsole' },
  format: 'iife',
  platform: 'browser',
  target: ['chrome110', 'safari16'],
  sourcemap: true,
  logLevel: 'info',
};

await esbuild.build({
  ...shared,
  entryPoints: [path.join(webRoot, 'src/page.js')],
  outfile: path.join(webRoot, 'dist/page.js'),
});
