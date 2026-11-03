// FA-21: point-light shadows are a real feature on the web backend, not an
// ignored flag. A point light above a cube must darken the floor beneath it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../harness/server.mjs';
import { launchBrowser, openScene, runSteps } from '../harness/browser.mjs';

test('FA-21: a point light casts a real shadow on the web backend', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, {
    origin: server.url, scriptPath: 'consumers/web/test/scripts/point-shadow.js',
    width: 400, height: 300, panelWidth: 0,
  });
  await runSteps(page, [{ frames: 4 }]);

  const result = await page.evaluate(() => {
    const consumer = window.spatialConsumer;
    const lamp = [...consumer.objects.values()].find((o) => o.isPointLight);
    const floor = [...consumer.objects.values()].find((o) => o.name === 'floor');
    const cube = [...consumer.objects.values()].find((o) => o.name === 'cube');

    // Reads the floor's brightness straight under the cube and well beside it.
    const sample = () => {
      consumer.render();
      const canvas = consumer.renderer.domElement;
      const gl = consumer.renderer.getContext();
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      consumer.camera.updateMatrixWorld(true);
      const brightnessAt = (world) => {
        const p = world.clone().project(consumer.camera);
        const x = Math.round((p.x + 1) / 2 * canvas.width);
        // readPixels is bottom-up, and so is this projection.
        const y = Math.round((p.y + 1) / 2 * canvas.height);
        let total = 0;
        let count = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const i = ((y + dy) * canvas.width + (x + dx)) * 4;
            if (i < 0 || i + 2 >= pixels.length) continue;
            total += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
            count += 1;
          }
        }
        return count ? total / count : 0;
      };
      const THREE = consumer.THREE || window.THREE;
      return {
        // Straight under the cube, and 0.6 m to the side on the same floor.
        shadowed: brightnessAt(new (floor.position.constructor)(0, -0.28, 0)),
        lit: brightnessAt(new (floor.position.constructor)(0.6, -0.28, 0)),
      };
    };

    const withShadow = sample();
    // The same frame with the flag off: the difference must be the shadow.
    lamp.castShadow = false;
    const withoutShadow = sample();
    lamp.castShadow = true;
    return {
      shadowMapEnabled: consumer.renderer.shadowMap.enabled,
      lampCastsShadow: true,
      cubeCastsShadow: cube.castShadow,
      floorReceives: floor.receiveShadow,
      shadowType: lamp.shadow ? lamp.shadow.constructor.name : null,
      withShadow,
      withoutShadow,
    };
  });

  assert.equal(result.shadowMapEnabled, true, 'the renderer draws shadow maps');
  assert.equal(result.cubeCastsShadow, true);
  assert.equal(result.floorReceives, true);
  assert.equal(result.shadowType, 'PointLightShadow', 'the point light has a cube shadow');
  // With shadows on, the floor under the cube is much darker than beside it.
  assert.ok(result.withShadow.shadowed < result.withShadow.lit * 0.6,
    `shadowed ${result.withShadow.shadowed.toFixed(1)} vs lit ${result.withShadow.lit.toFixed(1)}`);
  // With the flag off the same spot is lit, so the darkness was the shadow.
  assert.ok(result.withoutShadow.shadowed > result.withShadow.shadowed + 10,
    `unshadowed ${result.withoutShadow.shadowed.toFixed(1)} vs shadowed ${result.withShadow.shadowed.toFixed(1)}`);
});

test('FA-37: the debug model view covers meshes created after it is set', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, { origin: server.url, width: 320, height: 240, panelWidth: 0 });
  // The debug view is switched on first, and only then is the mesh created.
  await page.evaluate(() => window.spatialLoad(`
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
S.debug.modelView = "normal";
S.onFrame(() => {
  if (S.time.frame === 2 && !scene.userData.added) {
    scene.userData.added = true;
    const later = new S.Mesh(new S.BoxGeometry(0.4, 0.4, 0.4), new S.MeshStandardMaterial({ color: 0xff0000 }));
    later.name = "later";
    scene.add(later);
  }
});
S.mount(scene);
`, { preserveState: false }));
  await runSteps(page, [{ frames: 8 }]);

  const result = await page.evaluate(() => {
    const consumer = window.spatialConsumer;
    consumer.render();
    const canvas = consumer.renderer.domElement;
    const gl = consumer.renderer.getContext();
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const i = ((canvas.height >> 1) * canvas.width + (canvas.width >> 1)) * 4;
    return {
      modelView: consumer.nativeDump().debug.modelView,
      override: consumer.scene.overrideMaterial ? consumer.scene.overrideMaterial.type : null,
      centre: [pixels[i], pixels[i + 1], pixels[i + 2]],
      hasLater: [...consumer.objects.values()].some((o) => o.name === 'later'),
    };
  });

  assert.equal(result.hasLater, true, 'the mesh was created after the debug view was set');
  assert.equal(result.modelView, 'normal');
  assert.equal(result.override, 'MeshNormalMaterial');
  // A normal-view front face is the blue-dominant (0.5, 0.5, 1) normal, not the
  // red the material asked for.
  const [r, g, b] = result.centre;
  assert.ok(b > r && b > 120, `the later mesh renders in the debug view (${result.centre})`);
  assert.ok(r < 200, `and not in its own red (${result.centre})`);
});

test('SPEC 8: a browser scene with no sound reports a suspended audio engine', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  // The harness supplies its gesture on every load (SPEC 14.1); a scene that
  // never asks for audio must still report the core's "suspended".
  const { page } = await openScene(browser, { origin: server.url, width: 320, height: 240, panelWidth: 0 });
  await page.evaluate(() => window.spatialLoad(`
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
const m = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), new S.MeshStandardMaterial());
m.name = "quiet";
scene.add(m);
S.mount(scene);
`, { preserveState: false }));
  await runSteps(page, [{ frames: 6 }]);

  const silent = await page.evaluate(() => ({
    state: window.spatialNativeDump().audioMixer.state,
    coreState: window.spatialDump().audioMixer.state,
    listener: !!window.spatialConsumer.audio.listener,
  }));
  assert.equal(silent.listener, false, 'no AudioContext was opened');
  assert.equal(silent.state, 'suspended', 'the native dump agrees with the core');
  assert.equal(silent.coreState, 'suspended');

  // A scene that does play a sound still starts, and reports it.
  await page.evaluate(() => window.spatialLoad(`
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
const chime = new S.Audio();
chime.name = "chime";
chime.setBuffer(new S.AudioLoader().load("asset://spatial-tone.wav"));
scene.add(chime);
S.onFrame(() => { if (S.time.frame === 2) { S.audio.resume(); chime.play(); } });
S.mount(scene);
`, { preserveState: false }));
  await runSteps(page, [{ frames: 10 }]);
  await page.waitForTimeout(300);
  await runSteps(page, [{ frames: 10 }]);

  const loud = await page.evaluate(() => ({
    state: window.spatialNativeDump().audioMixer.state,
    listener: !!window.spatialConsumer.audio.listener,
  }));
  assert.equal(loud.listener, true, 'the sound opened the engine');
  assert.equal(loud.state, 'running', 'and the dump reports what the context is doing');
});

test('SPEC 14.13a: a plan frame waits for the consumer to finish loading', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, { origin: server.url, width: 320, height: 240, panelWidth: 0 });
  // Three frames is far too few for a network load to land by luck; the plan
  // must wait for each load before the frame that follows it.
  await page.evaluate(() => window.spatialLoad(`
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
const good = new S.TextureLoader().load("asset://checker.png",
  () => { scene.userData.loaded = true; },
  undefined,
  () => { scene.userData.loadFailed = true; });
const bad = new S.TextureLoader().load("asset://does-not-exist.png",
  () => { scene.userData.ghostLoaded = true; },
  undefined,
  () => { scene.userData.textureError = true; });
const m = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), new S.MeshStandardMaterial({ map: good }));
m.name = "textured";
scene.add(m);
S.loadAsset({ glb: "asset://rig.glb" })
  .then((asset) => { scene.userData.assetJoints = asset.skeleton ? asset.skeleton.joints.length : 0; })
  .catch(() => { scene.userData.assetFailed = true; });
S.mount(scene);
`, { preserveState: false }));
  await runSteps(page, [{ frames: 3 }]);

  const result = await page.evaluate(() => ({
    userData: window.spatialDump().scene.userData,
    warnings: window.spatialDump().warnings,
    pending: window.spatialPendingLoads(),
  }));

  // Both results are in the script's hands inside a three-frame plan.
  assert.equal(result.userData.loaded, true, `the texture loaded (${JSON.stringify(result.userData)})`);
  assert.equal(result.userData.textureError, true, 'and the missing one reported its failure');
  assert.equal(result.userData.assetJoints, 2, 'the asset loaded and reported its rig');
  assert.equal(result.pending, 0, 'nothing is left in flight');

  // SPEC 3.5: the core's backend-neutral warning, and no consumer copy.
  assert.ok(result.warnings.some((w) => w === 'Texture "asset://does-not-exist.png" failed to load'),
    JSON.stringify(result.warnings));
  assert.deepEqual(result.warnings.filter((w) => w.startsWith('texture failed to load')), []);
});

test('AR-36: one unsupported fact produces exactly one warning in the dump', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  // The whole product: the real core, the real consumer, and the dump a script
  // would read. Both facts below are ones the core already warns about.
  const { page } = await openScene(browser, { origin: server.url, width: 320, height: 240, panelWidth: 0 });
  await page.evaluate(() => window.spatialLoad(`
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
S.render.adaptiveResolution = true;
S.sceneUnderstanding.collision = true;
const screen = new S.VideoScreen({ url: "asset://spatial-bars.webm", width: 0.3, muted: true, docking: true });
screen.name = "screen";
scene.add(screen);
S.mount(scene);
`, { preserveState: false }));
  await runSteps(page, [{ frames: 4 }]);

  const warnings = await page.evaluate(() => window.spatialDump().warnings);

  // One line per fact, from whichever layer owns it: the core says a feature has
  // no effect here, and the consumer says only what the core cannot know.
  const facts = [
    ['adaptiveResolution has no effect', (w) => /adaptive.?resolution/i.test(w)],
    ['sceneUnderstanding has no effect',
      (w) => /scene.?understanding/i.test(w) && !w.includes('raycasts will not see')],
    ['video docking has no effect', (w) => /docking/i.test(w)],
    ['raycasts do not see the real world', (w) => w.includes('raycasts will not see the real world')],
  ];
  for (const [fact, matches] of facts) {
    const said = warnings.filter(matches);
    assert.equal(said.length, 1, `${fact}: ${JSON.stringify(said)} in ${JSON.stringify(warnings)}`);
  }

  // And no two entries say the same thing.
  const seen = new Set();
  for (const warning of warnings) {
    assert.equal(seen.has(warning), false, `"${warning}" appears twice`);
    seen.add(warning);
  }
});
