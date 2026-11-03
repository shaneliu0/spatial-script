// Authors assets/rig.glb: a two-bone skinned mesh with one morph target, so
// the skeleton and blend-shape tests have a real GLB to load. three's
// GLTFExporter needs browser APIs, so the export runs in the harness browser.

import fs from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { startServer, SPATIAL_ROOT } from './server.mjs';
import { launchBrowser } from './browser.mjs';

// SPEC 3.5: the one shared asset root.
const OUT = path.join(SPATIAL_ROOT, 'assets/rig.glb');
const BUNDLE = path.join(SPATIAL_ROOT, 'consumers/web/dist/rig-export.js');

await esbuild.build({
  entryPoints: [path.join(SPATIAL_ROOT, 'consumers/web/harness/rig-export.js')],
  outfile: BUNDLE,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  logLevel: 'error',
});

const server = await startServer();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('page error:', err.message));
  await page.goto(`${server.url}/consumers/web/index.html?mode=manual&w=64&h=64`, { waitUntil: 'load' });
  await page.addScriptTag({ url: '/consumers/web/dist/rig-export.js' });
  const bytes = await page.evaluate(() => window.__exportRig());
  if (!bytes || !bytes.length) throw new Error('the exporter produced nothing');
  await fs.writeFile(OUT, Buffer.from(bytes));
  console.log(`wrote ${OUT} (${bytes.length} bytes)`);
} finally {
  await browser.close();
  await server.close();
}
