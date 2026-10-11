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

test('14.10: the page host channel and a state-preserving reload', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, { origin: server.url, width: 320, height: 240 });

  const script = `
    const S = require("spatial");
    const scene = new S.Scene();
    scene.add(new S.AmbientLight(0xffffff, 1));
    this.state = { counter: 0 };
    this.scriptChanged = (previous) => { scene.userData.restored = previous; };
    S.host.on("bump", (payload) => { this.state.counter += payload.by; scene.userData.counter = this.state.counter; });
    S.onFrame(() => { scene.userData.ticks = (scene.userData.ticks || 0) + 1; });
    S.mount(scene);
  `;

  const result = await page.evaluate(async (source) => {
    const seen = [];
    window.spatialHost.on('report', (payload) => seen.push(payload));
    window.spatialHost.register('MyApp', 'double', (args) => args.value * 2);

    window.spatialLoad(source);
    window.spatialTick(1 / 60);
    // Host to script.
    window.spatialHost.send('bump', { by: 5 });
    window.spatialTick(1 / 60);
    const counter = window.spatialDump().scene.userData.counter;

    // Page visibility pauses the scene (SPEC 14.10).
    window.spatialSetActive(false);
    const ticksBefore = window.spatialDump().scene.userData.ticks;
    window.spatialTick(1 / 60);
    window.spatialTick(1 / 60);
    const ticksWhileInactive = window.spatialDump().scene.userData.ticks;
    window.spatialSetActive(true);
    window.spatialTick(1 / 60);
    const ticksAfter = window.spatialDump().scene.userData.ticks;

    // A preserved reload hands the old state to the new script.
    window.spatialLoad(source, { preserveState: true });
    window.spatialTick(1 / 60);
    const restored = window.spatialDump().scene.userData.restored;

    return {
      counter,
      functions: window.spatialHost.functions(),
      ticksBefore, ticksWhileInactive, ticksAfter,
      restored,
      seen,
    };
  }, script);

  assert.equal(result.counter, 5, 'a host event reached the script');
  // The page's own demo function is registered too (see the Preferences test).
  assert.deepEqual(result.functions, ['MyApp.double', 'Preferences.read']);
  assert.equal(result.ticksWhileInactive, result.ticksBefore, 'ticks pause while inactive');
  assert.ok(result.ticksAfter > result.ticksBefore, 'and resume when active again');
  assert.deepEqual(result.restored, { counter: 5 }, 'the reload handed the old state over');
});

test('the page registers the demo Preferences.read the macOS host registers', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, { origin: server.url, width: 320, height: 240 });
  const result = await page.evaluate(async () => {
    const script = `
      const S = require("spatial");
      const scene = new S.Scene();
      scene.add(new S.AmbientLight(0xffffff, 1));
      scene.userData.functions = S.host.functions.slice();
      S.host.call("Preferences.read", { key: "lampHue" }).then((value) => {
        scene.userData.lamp = value;
      });
      S.host.call("Preferences.read", { key: "other" }).then((value) => {
        scene.userData.other = value;
      });
      S.mount(scene);
    `;
    window.spatialLoad(script);
    for (let i = 0; i < 4; i++) {
      window.spatialTick(1 / 60);
      await null;
    }
    const dump = window.spatialDump();
    return {
      pageFunctions: window.spatialHost.functions(),
      scriptFunctions: dump.scene.userData.functions,
      dumpFunctions: dump.hostFunctions,
      nativeFunctions: window.spatialNativeDump().hostFunctions,
      lamp: dump.scene.userData.lamp,
      other: dump.scene.userData.other,
    };
  });

  assert.deepEqual(result.pageFunctions, ['Preferences.read']);
  assert.deepEqual(result.scriptFunctions, ['Preferences.read'], 'the script sees it before its first frame');
  assert.deepEqual(result.dumpFunctions, ['Preferences.read']);
  assert.deepEqual(result.nativeFunctions, ['Preferences.read'], 'and both dumps agree');
  assert.deepEqual(result.lamp, { hue: 0.58 }, 'lampHue answers with the demo hue');
  assert.equal(result.other, null, 'any other key answers null');

  // The page can replace it, which is the point of registering it in the page.
  const replaced = await page.evaluate(() => {
    window.spatialHost.unregister('Preferences', 'read');
    window.spatialHost.register('Preferences', 'read', () => ({ hue: 0.1 }));
    return window.spatialHost.functions();
  });
  assert.deepEqual(replaced, ['Preferences.read']);
});
