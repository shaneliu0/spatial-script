// C-28: an equirectangular Radiance .hdr environment must actually light the
// scene on the web backend. Only a real render can show that, so this runs in
// headless Chromium against the real core, like the benchmark.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../harness/server.mjs';
import { launchBrowser, openScene, runSteps } from '../harness/browser.mjs';

/** Mean pixel value over the centre of the sphere, 0 to 255. */
async function sphereBrightness(browser, origin, script) {
  const { page } = await openScene(browser, { origin, scriptPath: script, width: 400, height: 300 });
  await runSteps(page, [{ frames: 10 }]);
  const value = await page.evaluate(() => {
    const consumer = window.spatialConsumer;
    consumer.render();
    const gl = consumer.renderer.getContext();
    const width = 40;
    const buffer = new Uint8Array(width * width * 4);
    gl.readPixels(200 - width / 2, 150 - width / 2, width, width, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 4) sum += (buffer[i] + buffer[i + 1] + buffer[i + 2]) / 3;
    return sum / (buffer.length / 4);
  });
  const warnings = await page.evaluate(() => window.spatialConsumer.warnings);
  await page.close();
  return { value, warnings };
}

test('a .hdr environment lights a metal sphere, and .png still does', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const hdr = await sphereBrightness(browser, server.url, 'consumers/web/test/scripts/hdr-environment.js');
  const png = await sphereBrightness(browser, server.url, 'consumers/web/test/scripts/png-environment.js');

  console.log(`  environment lighting: .hdr sphere ${hdr.value.toFixed(1)}, .png sphere ${png.value.toFixed(1)} (of 255)`);
  // A metal sphere has no diffuse response, so without the environment it is black.
  assert.ok(hdr.value > 60, `.hdr environment did not light the sphere (mean pixel ${hdr.value.toFixed(1)})`);
  assert.ok(png.value > 60, `.png environment did not light the sphere (mean pixel ${png.value.toFixed(1)})`);
  assert.deepEqual(hdr.warnings.filter((w) => w.includes('.hdr')), [], '.hdr must not warn');
});
