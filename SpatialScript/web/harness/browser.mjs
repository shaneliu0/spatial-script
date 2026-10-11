// Shared Playwright plumbing for the conformance runner and the screenshot tool.

import { chromium } from 'playwright';

/** Flags that make WebGL work in headless Chromium through the SwiftShader backend. */
export const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--disable-gpu-sandbox',
  '--disable-dev-shm-usage',
  // SPEC 14.14: audio and video must run without a gesture or a real device.
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
];

/**
 * Headless runs force the SwiftShader software backend so WebGL always works.
 * A headed run uses the machine's real GPU, which is what the frame-rate numbers
 * should be measured on.
 */
export async function launchBrowser({ headless = true } = {}) {
  if (headless) return chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  return chromium.launch({ headless: false, channel: 'chromium' });
}

/** Fails loudly rather than producing black screenshots when WebGL is unavailable. */
export async function assertWebGL(page) {
  const info = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return null;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      version: gl.getParameter(gl.VERSION),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  });
  if (!info) throw new Error('headless Chromium could not create a WebGL context');
  return info;
}

/**
 * Opens the consumer page in manual-tick mode with a script loaded.
 * @param {import('playwright').Browser} browser
 * @param {object} options
 */
export async function openScene(browser, {
  origin, scriptPath, camera, preset = null, width = 800, height = 600, panelWidth = 380,
  hostFunctions = null, demoHost = true, initScript = null,
}) {
  const page = await browser.newPage({ viewport: { width: width + panelWidth, height } });
  // Runs before the page's own scripts, for tests that need to watch the boot.
  if (initScript) await page.addInitScript(initScript);
  const consoleMessages = [];
  page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => consoleMessages.push({ type: 'error', text: err.message }));

  const params = new URLSearchParams({ mode: 'manual', w: String(width), h: String(height) });
  if (panelWidth === 0) params.set('ui', 'off');
  if (preset) params.set('preset', preset);
  if (hostFunctions && hostFunctions.length) params.set('hostFunctions', hostFunctions.join(','));
  // A conformance case declares the functions its app registered, so the page's
  // demo registration is off for those runs.
  if (!demoHost) params.set('demoHost', 'off');
  if (scriptPath) params.set('script', scriptPath);
  if (camera) params.set('camera', camera.join(','));

  await page.goto(`${origin}/web/index.html?${params}`, { waitUntil: 'load' });
  const webgl = await assertWebGL(page);
  await page.waitForFunction(() => window.spatialBooted === true || !!window.spatialBootError, null, { timeout: 30000 });
  const bootError = await page.evaluate(() => window.spatialBootError || null);
  if (bootError) throw new Error(`page boot failed: ${bootError}`);

  // SPEC 14.1: audio needs a user gesture to start, and the harness is the one
  // that supplies it. Without this a run only works because of the autoplay flag.
  await page.evaluate(() => {
    if (typeof window.spatialResumeAudio === 'function') window.spatialResumeAudio();
  });

  return { page, consoleMessages, webgl };
}

/**
 * Runs a conformance step list, mirroring conformance/run-node.mjs step for step:
 * `{ frames }`, `{ inject }`, `{ dispatch }`, `{ sync }`, `{ syncBodies }`,
 * `{ setInput }` and `{ dispose }` (SPEC section 9).
 *
 * Injected events are queued in the core and delivered at the start of the next
 * tick, exactly as in the node runner, so an inject step never ticks by itself.
 */
export async function runSteps(page, steps, dt = 1 / 60) {
  for (const step of steps) {
    if (step.frames !== undefined) {
      await page.evaluate(async ([count, delta]) => {
        for (let i = 0; i < count; i++) {
          window.spatialTick(delta);
          // Yield so promise callbacks (loadAsset, texture loadAsync) run between
          // ticks exactly as they would under a real animation frame loop.
          await null;
        }
      }, [step.frames, dt]);
      // Textures and assets load over the network; settle them so the next step
      // sees a stable scene.
      await settleLoads(page);
      continue;
    }
    if (step.dispose) {
      await page.evaluate(() => window.spatialDispose());
      continue;
    }
    if (step.setInput) {
      await page.evaluate((input) => window.spatialSetInput(input), step.setInput);
      continue;
    }
    if (step.sync) {
      await page.evaluate((records) => {
        const flat = [];
        for (const record of records) {
          flat.push(window.spatialResolveId(record.target),
            ...(record.position || [0, 0, 0]),
            ...(record.quaternion || [0, 0, 0, 1]),
            ...(record.scale || [1, 1, 1]));
        }
        window.spatialSync(flat);
      }, step.sync);
      continue;
    }
    if (step.syncBodies) {
      await page.evaluate((records) => {
        const flat = [];
        for (const record of records) {
          flat.push(window.spatialResolveId(record.target),
            ...(record.linear || [0, 0, 0]),
            ...(record.angular || [0, 0, 0]),
            record.sleeping ? 1 : 0);
        }
        window.spatialSyncBodies(flat);
      }, step.syncBodies);
      continue;
    }
    if (step.dispatch) {
      await page.evaluate((spec) => {
        const { type, target, texture, asset, call, fetch: fetchUrl, payload } = spec;
        let id;
        if (texture !== undefined) id = window.spatialTextureIdForUrl(texture);
        else if (asset !== undefined) id = window.spatialAssetIdForUrl(asset);
        else if (call !== undefined) id = window.spatialPendingCallId(call);
        else if (fetchUrl !== undefined) id = window.spatialPendingFetchId(fetchUrl);
        else if (target === undefined || target === null) id = 0;
        else id = window.spatialResolveId(target);
        if (id === undefined) throw new Error(`dispatch step could not resolve ${JSON.stringify(spec)}`);
        const resolved = { ...(payload || {}) };
        if (typeof resolved.other === 'string') resolved.other = window.spatialResolveId(resolved.other);
        window.spatialDispatch(type, id, resolved);
      }, step.dispatch);
      continue;
    }
    if (step.reload !== undefined) {
      // SPEC 14.10, conformance/README.md: a hot reload on the same host.
      await page.evaluate(([source, preserve]) => {
        const result = window.spatialReload(source, preserve !== false);
        if (!result.ok) throw new Error(`reload failed: ${result.error.message}`);
      }, [step.reload, step.preserveState]);
      continue;
    }
    if (step.setActive !== undefined) {
      await page.evaluate((active) => window.spatialSetActive(active), step.setActive);
      continue;
    }
    if (step.hostEvent) {
      await page.evaluate((event) => window.spatialHostEvent(event.name, event.payload), step.hostEvent);
      continue;
    }
    if (step.hostFunctions) {
      await page.evaluate((names) => window.spatialSetHostFunctions(names), step.hostFunctions);
      continue;
    }
    if (step.syncAudio || step.syncVideo) {
      const records = step.syncAudio || step.syncVideo;
      const channel = step.syncAudio ? 'spatialSyncAudio' : 'spatialSyncVideo';
      await page.evaluate(([name, list]) => {
        const flat = [];
        for (const record of list) {
          flat.push(window.spatialResolveId(record.target), record.playing ? 1 : 0,
            record.currentTime || 0, record.duration || 0);
        }
        window[name](flat);
      }, [channel, records]);
      continue;
    }
    if (step.syncCharacter) {
      await page.evaluate((list) => {
        const flat = [];
        for (const record of list) {
          const p = record.position || [0, 0, 0];
          const v = record.velocity || [0, 0, 0];
          flat.push(window.spatialResolveId(record.target), p[0], p[1], p[2],
            record.isOnGround ? 1 : 0, v[0], v[1], v[2]);
        }
        window.spatialSyncCharacter(flat);
      }, step.syncCharacter);
      continue;
    }
    if (step.syncSkeleton) {
      await page.evaluate((record) => {
        window.spatialSyncSkeleton(window.spatialResolveId(record.target), record.joints || {});
      }, step.syncSkeleton);
      continue;
    }
    if (step.inject) {
      if (step.inject === 'controller') {
        await page.evaluate((state) => window.spatialInject('controller', state, {}), step.state || {});
        continue;
      }
      await page.evaluate(([type, target, options]) => window.spatialInject(type, target, options), [
        step.inject,
        step.target ?? step.code ?? null,
        {
          point: step.point,
          translation: step.translation,
          steps: step.steps,
          entering: step.entering,
          down: step.down,
        },
      ]);
      continue;
    }
    throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
}

/** A step list that drives sync, syncBodies or dispatch owns the consumer-to-core channel. */
export function stepsDriveBridge(steps) {
  return steps.some((step) => step && (step.sync || step.syncBodies || step.dispatch
    || step.syncAudio || step.syncVideo || step.syncCharacter || step.syncSkeleton));
}

async function settleLoads(page) {
  try {
    await page.waitForFunction(() => window.spatialPendingLoads() === 0, null, { timeout: 5000 });
  } catch {
    // A stuck load is reported through the dump's warnings, not by hanging here.
  }
}

export async function screenshotCanvas(page, outPath) {
  const canvas = page.locator('#view');
  await canvas.screenshot({ path: outPath });
}
