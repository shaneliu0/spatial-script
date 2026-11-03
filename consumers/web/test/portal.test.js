// A portal's world group must render only through the portal surface. This runs
// the effects example in headless Chromium, computes the portal quad's screen
// rectangle from the scene itself, and asserts that every pixel outside it is
// background.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../harness/server.mjs';
import { launchBrowser, openScene, runSteps } from '../harness/browser.mjs';

const WIDTH = 700;
const HEIGHT = 475;

test('no world-group content renders outside the portal rectangle', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, {
    origin: server.url,
    scriptPath: 'examples/effects.js',
    preset: 'mac',
    width: WIDTH,
    height: HEIGHT,
    panelWidth: 0,
  });
  await runSteps(page, [{ frames: 120 }]);

  const result = await page.evaluate(() => {
    const consumer = window.spatialConsumer;
    consumer.render();

    // The portal quad's screen rectangle, from the mesh three actually draws.
    const portal = [...consumer.portals.values()][0];
    const mesh = portal.mesh;
    mesh.updateWorldMatrix(true, false);
    consumer.camera.updateMatrixWorld(true);
    const canvas = consumer.renderer.domElement;
    const attribute = mesh.geometry.getAttribute('position');
    const xs = [];
    const ys = [];
    const point = mesh.position.clone();
    for (let i = 0; i < attribute.count; i++) {
      point.set(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
      point.applyMatrix4(mesh.matrixWorld).project(consumer.camera);
      xs.push((point.x + 1) / 2 * canvas.width);
      ys.push((1 - point.y) / 2 * canvas.height);
    }
    // One pixel of slack for the quad's own antialiased edge.
    const rect = {
      x0: Math.floor(Math.min(...xs)) - 1,
      x1: Math.ceil(Math.max(...xs)) + 1,
      y0: Math.floor(Math.min(...ys)) - 1,
      y1: Math.ceil(Math.max(...ys)) + 1,
    };

    const gl = consumer.renderer.getContext();
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Everything in the world group is blue or cyan; the rest of the scene is
    // orange sparks, a purple cube and white text.
    const isWorldColoured = (r, g, b) => (b > r + 25 && b > 60) || (g > r + 40 && b > r + 20 && g > 60);
    let inside = 0;
    let outside = 0;
    const samples = [];
    for (let row = 0; row < canvas.height; row++) {
      // readPixels is bottom-up.
      const y = canvas.height - 1 - row;
      for (let x = 0; x < canvas.width; x++) {
        const i = (row * canvas.width + x) * 4;
        if (!isWorldColoured(pixels[i], pixels[i + 1], pixels[i + 2])) continue;
        if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) inside += 1;
        else {
          outside += 1;
          if (samples.length < 5) samples.push([x, y, pixels[i], pixels[i + 1], pixels[i + 2]]);
        }
      }
    }
    return { rect, inside, outside, samples };
  });

  console.log(`  portal rect ${JSON.stringify(result.rect)}: ${result.inside} world pixels inside, `
    + `${result.outside} outside`);
  assert.ok(result.inside > 200, 'the portal actually shows its world');
  assert.equal(result.outside, 0,
    `world content leaked outside the portal: ${JSON.stringify(result.samples)}`);
});
