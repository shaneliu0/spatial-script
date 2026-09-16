// MAINT-07: web/src/page.js had no test, so a regression in the hot-swap path or
// the console bound only showed up as a screenshot diff. This drives the real
// page in headless Chromium against the real core bundle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../harness/server.mjs';
import { launchBrowser, openScene, runSteps } from '../harness/browser.mjs';

const SCENE_A = `
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
const m = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), new S.MeshStandardMaterial({ color: 0xff0000 }));
m.name = "alpha"; scene.add(m);
S.onFrame(() => { m.rotation.y += 0.01; });
S.mount(scene);
`;

const SCENE_B = `
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
const m = new S.Mesh(new S.SphereGeometry(0.15, 16, 12), new S.MeshStandardMaterial({ color: 0x00ff00 }));
m.name = "beta"; scene.add(m);
S.mount(scene);
`;

test('spatialLoad hot-swaps one scene for another without leaking the first', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, { origin: server.url, width: 320, height: 240 });

  const first = await page.evaluate((source) => {
    const result = window.spatialLoad(source);
    window.spatialTick(1 / 60);
    const consumer = window.spatialConsumer;
    return {
      ok: result.ok,
      names: window.spatialDump().objects.map((o) => o.name),
      generation: consumer.generation,
      objects: consumer.objects.size,
    };
  }, SCENE_A);
  assert.equal(first.ok, true);
  assert.ok(first.names.includes('alpha'));
  assert.ok(first.objects > 0);

  const second = await page.evaluate((source) => {
    const consumer = window.spatialConsumer;
    const before = consumer.generation;
    const result = window.spatialLoad(source);
    window.spatialTick(1 / 60);
    return {
      ok: result.ok,
      names: window.spatialDump().objects.map((o) => o.name),
      generationMoved: consumer.generation > before,
      // Nothing from the first scene may survive the swap.
      geometries: consumer.geometries.size,
      materials: consumer.materials.size,
      pendingLoads: consumer.pendingLoads,
      hovered: consumer.input.hovered,
      drag: consumer.input.drag,
    };
  }, SCENE_B);
  assert.equal(second.ok, true);
  assert.deepEqual(second.names.filter((n) => n === 'alpha'), [], 'the first scene is gone');
  assert.ok(second.names.includes('beta'));
  assert.equal(second.generationMoved, true);
  assert.equal(second.materials, 1, 'only the new scene owns a material');
  assert.equal(second.pendingLoads, 0);
  assert.equal(second.hovered, null);
  assert.equal(second.drag, null);

  // A load error is reported and leaves the page usable.
  const failure = await page.evaluate(() => {
    const result = window.spatialLoad('this is not javascript {{{');
    return { ok: result.ok, message: result.error.message, recorded: window.spatialLoadError !== null };
  });
  assert.equal(failure.ok, false);
  assert.match(failure.message, /SyntaxError/);
  assert.equal(failure.recorded, true);

  const recovered = await page.evaluate((source) => {
    const result = window.spatialLoad(source);
    window.spatialTick(1 / 60);
    return { ok: result.ok, names: window.spatialDump().objects.map((o) => o.name) };
  }, SCENE_A);
  assert.equal(recovered.ok, true, 'the page still loads after a failed script');
  assert.ok(recovered.names.includes('alpha'));
});

test('the page console store is bounded per frame and in total', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, { origin: server.url, width: 320, height: 240 });
  const result = await page.evaluate(() => {
    window.spatialLoad(`
      const S = require("spatial");
      const scene = new S.Scene();
      scene.add(new S.AmbientLight(0xffffff, 1));
      S.onFrame(() => { for (let i = 0; i < 400; i++) console.log("noise " + i); });
      S.mount(scene);
    `);
    for (let frame = 0; frame < 40; frame++) window.spatialTick(1 / 60);
    return {
      lines: window.spatialConsole.length,
      dropped: window.spatialConsoleDropped,
      consumerLines: window.spatialConsumer.logs.length,
      consumerDropped: window.spatialConsumer.droppedLogs,
    };
  });

  // 40 frames x 400 logs is 16 000 lines; neither store may keep them all.
  assert.ok(result.lines <= 5000, `page console kept ${result.lines}`);
  assert.ok(result.consumerLines <= 5000, `consumer kept ${result.consumerLines}`);
  assert.ok(result.dropped > 0, 'the page counts what it dropped');
  assert.ok(result.consumerDropped > 0, 'and so does the consumer');
});
