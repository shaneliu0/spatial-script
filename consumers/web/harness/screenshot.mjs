// One-off screenshot tool for agent verification.
//
//   node harness/screenshot.mjs <script.js> [--frames N] [--inject type:target[:x,y,z]]...
//                              [--out file.png] [--camera x,y,z]
//
// Prints the screenshot path, the dump path and any console errors.

import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, SPATIAL_ROOT } from './server.mjs';
import { launchBrowser, openScene, runSteps, screenshotCanvas } from './browser.mjs';
import { CAMERA_PRESET_SIZES } from './presets.mjs';

const OUT_DIR = path.join(SPATIAL_ROOT, 'consumers/web/harness/out');

function usage() {
  console.log(`usage: node harness/screenshot.mjs <script.js> [--frames N]
       [--inject type:target[:x,y,z]]... [--out file.png] [--camera x,y,z]
       [--width N] [--height N] [--settle N] [--camera-preset mac] [--out-dir dir]

--frames  ticks before the injections (default 3)
--settle  ticks after them so injected events and completed loads are visible
          (default 30 when injecting, otherwise 2)
--camera-preset mac
          the macOS host's RealityView camera and viewport, for parity shots`);
}

function parseArgs(argv) {
  const out = { script: null, frames: 3, settle: null, injects: [], outFile: null, outDir: null, camera: null, preset: null, width: null, height: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--frames') out.frames = Number(argv[++i]);
    else if (arg === '--settle') out.settle = Number(argv[++i]);
    else if (arg === '--out') out.outFile = argv[++i];
    else if (arg === '--out-dir') out.outDir = argv[++i];
    else if (arg === '--camera') out.camera = argv[++i].split(',').map(Number);
    else if (arg === '--camera-preset') out.preset = argv[++i];
    else if (arg === '--width') out.width = Number(argv[++i]);
    else if (arg === '--height') out.height = Number(argv[++i]);
    else if (arg === '--inject') out.injects.push(parseInject(argv[++i]));
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else if (!out.script) out.script = arg;
  }
  return out;
}

/** `type:target` or `type:target:x,y,z` — the vector is the point or translation. */
function parseInject(spec) {
  const [type, target, vector] = spec.split(':');
  const step = { inject: type, target };
  if (vector) {
    const v = vector.split(',').map(Number);
    if (type === 'drag') step.translation = v;
    else step.point = v;
  }
  if (type === 'key') step.down = true;
  return step;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.script) {
    usage();
    process.exit(1);
  }

  const absolute = path.resolve(process.cwd(), options.script);
  const relative = path.relative(SPATIAL_ROOT, absolute);
  if (relative.startsWith('..')) {
    console.error(`script must live inside ${SPATIAL_ROOT}`);
    process.exit(1);
  }
  await fs.access(absolute);
  await fs.mkdir(OUT_DIR, { recursive: true });

  const name = path.basename(absolute, '.js');
  const outDir = options.outDir ? path.resolve(process.cwd(), options.outDir) : OUT_DIR;
  await fs.mkdir(outDir, { recursive: true });
  const pngPath = options.outFile
    ? path.resolve(process.cwd(), options.outFile)
    : path.join(outDir, `${name}.png`);
  const dumpPath = path.join(outDir, `${name}.dump.json`);
  const nativePath = path.join(outDir, `${name}.native.json`);

  const size = CAMERA_PRESET_SIZES[options.preset] || { width: 800, height: 600 };
  const width = options.width || size.width;
  const height = options.height || size.height;

  const server = await startServer();
  const browser = await launchBrowser();
  let exitCode = 0;
  try {
    const scene = await openScene(browser, {
      origin: server.url,
      scriptPath: relative,
      camera: options.camera,
      preset: options.preset,
      width,
      height,
    });
    const { page, consoleMessages, webgl } = scene;

    const loaded = await page.evaluate(() => window.spatialState.loaded);
    if (!loaded) {
      const errors = await page.evaluate(() => window.spatialErrors);
      console.error(`script failed to load:\n  ${errors.join('\n  ')}`);
      exitCode = 1;
    } else {
      // Injected events are queued in the core and delivered on the next tick, so
      // settle frames follow the injections.
      // Async results (injected events, texture and asset loads) reach the script
      // on the tick after they arrive, so always finish with a few settle frames.
      const settle = options.settle ?? (options.injects.length ? 30 : 2);
      const plan = [{ frames: options.frames }, ...options.injects];
      if (settle > 0) plan.push({ frames: settle });
      await runSteps(page, plan, 1 / 60);
      const dump = await page.evaluate(() => window.spatialDump());
      await fs.writeFile(dumpPath, JSON.stringify(dump, null, 2));
      // AR-22: the scenario runner asserts against the scene three.js really
      // built, not only the one the core describes.
      const native = await page.evaluate(() => window.spatialNativeDump());
      await fs.writeFile(nativePath, JSON.stringify(native, null, 2));
      await screenshotCanvas(page, pngPath);

      const render = await page.evaluate(() => window.spatialRenderInfo());
      console.log(`renderer:   ${webgl.renderer}`);
      if (render) {
        console.log(`drawCalls:  ${render.drawCalls} (${render.triangles} triangles, `
          + `${render.geometries} geometries, ${render.textures} textures)`);
      }
      console.log(`core:       ${dump.coreSource}`);
      console.log(`screenshot: ${pngPath}`);
      console.log(`dump:       ${dumpPath}`);
      if (dump.warnings && dump.warnings.length) {
        console.log('warnings:');
        for (const w of dump.warnings) console.log(`  ${w}`);
      }
    }

    const errors = consoleMessages.filter((m) => m.type === 'error');
    if (errors.length) {
      console.log('console errors:');
      for (const error of errors) console.log(`  ${error.text}`);
      exitCode = 1;
    }
  } finally {
    await browser.close();
    await server.close();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
