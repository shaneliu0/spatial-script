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
}) {
  const page = await browser.newPage({ viewport: { width: width + panelWidth, height } });
  const consoleMessages = [];
  page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => consoleMessages.push({ type: 'error', text: err.message }));

  const params = new URLSearchParams({ mode: 'manual', w: String(width), h: String(height) });
  if (panelWidth === 0) params.set('ui', 'off');
  if (preset) params.set('preset', preset);
  if (scriptPath) params.set('script', scriptPath);
  if (camera) params.set('camera', camera.join(','));

  await page.goto(`${origin}/web/index.html?${params}`, { waitUntil: 'load' });
  const webgl = await assertWebGL(page);
  await page.waitForFunction(() => window.spatialBooted === true || !!window.spatialBootError, null, { timeout: 30000 });
  const bootError = await page.evaluate(() => window.spatialBootError || null);
  if (bootError) throw new Error(`page boot failed: ${bootError}`);

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
        const { type, target, texture, asset, payload } = spec;
        let id;
        if (texture !== undefined) id = window.spatialTextureIdForUrl(texture);
        else if (asset !== undefined) id = window.spatialAssetIdForUrl(asset);
        else id = window.spatialResolveId(target);
        if (id === undefined) throw new Error(`dispatch step could not resolve ${JSON.stringify(spec)}`);
        const resolved = { ...(payload || {}) };
        if (typeof resolved.other === 'string') resolved.other = window.spatialResolveId(resolved.other);
        window.spatialDispatch(type, id, resolved);
      }, step.dispatch);
      continue;
    }
    if (step.inject) {
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
  return steps.some((step) => step && (step.sync || step.syncBodies || step.dispatch));
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
