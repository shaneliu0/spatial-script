// Cross-backend parity capture.
//
//   node harness/parity.mjs <script.js> [--steps steps.json] [--dt seconds]
//                           [--out-dir dir] [--camera-preset mac]
//
// Runs one script through the three.js consumer with an exact, deterministic tick
// plan and writes the four artefacts the parity gate diffs against the RealityKit
// run: screenshot.png, dump.json (core Spatial.dump()), native.json (the three.js
// scene in the Swift nativeDump shape) and console.json (every line, in order).
//
// Exits non-zero only when the page crashed. A script that fails to load is a
// result: the load error is recorded in console.json and the run still writes its
// artefacts.

import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, SPATIAL_ROOT } from './server.mjs';
import { launchBrowser, openScene, runSteps, screenshotCanvas } from './browser.mjs';
import { CAMERA_PRESET_SIZES } from './presets.mjs';

const DEFAULT_DT = 1 / 60;
const DEFAULT_STEPS = [{ frames: 3 }];

function usage() {
  console.log(`usage: node harness/parity.mjs <script.js> [--steps steps.json] [--dt seconds]
       [--out-dir dir] [--camera-preset mac] [--width N] [--height N]

Steps use the conformance format: an array of { "frames": N } and
{ "inject": "tap"|"drag"|"hover"|"key", "target": name, "translation": [x,y,z],
  "point": [x,y,z], "entering": bool, "code": string, "down": bool }.`);
}

function parseArgs(argv) {
  const out = {
    script: null, steps: null, dt: DEFAULT_DT, outDir: null,
    preset: null, width: null, height: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--steps') out.steps = argv[++i];
    else if (arg === '--dt') out.dt = Number(argv[++i]);
    else if (arg === '--out-dir') out.outDir = argv[++i];
    else if (arg === '--camera-preset') out.preset = argv[++i];
    else if (arg === '--width') out.width = Number(argv[++i]);
    else if (arg === '--height') out.height = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else if (!out.script) out.script = arg;
  }
  return out;
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

  const steps = options.steps
    ? JSON.parse(await fs.readFile(path.resolve(process.cwd(), options.steps), 'utf8'))
    : DEFAULT_STEPS;

  const outDir = path.resolve(process.cwd(), options.outDir
    || path.join(SPATIAL_ROOT, 'web/harness/out/parity', path.basename(absolute, '.js')));
  await fs.mkdir(outDir, { recursive: true });

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
      preset: options.preset,
      width,
      height,
      // The parity screenshot must be the canvas alone, with no editor panel.
      panelWidth: 0,
    });
    const { page } = scene;

    const loadError = await page.evaluate(() => window.spatialLoadError || null);
    if (!loadError) {
      // `asset` commands are answered the way the consumer normally answers them:
      // a real GLTF fetch when a glb or gltf key exists, assetError otherwise.
      await runSteps(page, steps, options.dt);
    }

    const dump = await page.evaluate(() => window.spatialDump());
    const native = await page.evaluate(() => window.spatialNativeDump());
    await screenshotCanvas(page, path.join(outDir, 'screenshot.png'));

    // The script's own console output, in order, as the core routed it through
    // `log` commands and `__spatialNative.log`. Browser and WebGL driver
    // messages are not the script's and are left out.
    const console_ = await page.evaluate(() => window.spatialConsumer.logs.map(
      (line) => ({ level: line.level, message: line.message }),
    ));
    if (loadError) {
      console_.unshift({
        level: 'error',
        message: `${loadError.name || 'Error'}: ${loadError.message}`,
        line: loadError.line ?? null,
        column: loadError.column ?? null,
      });
    }

    await fs.writeFile(path.join(outDir, 'dump.json'), JSON.stringify(dump, null, 2));
    await fs.writeFile(path.join(outDir, 'native.json'), JSON.stringify(native, null, 2));
    await fs.writeFile(path.join(outDir, 'console.json'), JSON.stringify(console_, null, 2));

    const geometry = await page.evaluate(() => {
      const canvas = document.getElementById('view');
      const rect = canvas.getBoundingClientRect();
      return {
        backing: [canvas.width, canvas.height],
        css: [Math.round(rect.width), Math.round(rect.height)],
        aspect: window.spatialConsumer.camera.aspect,
        fov: window.spatialConsumer.camera.fov,
      };
    });
    if (geometry.backing[0] !== width || geometry.backing[1] !== height
      || geometry.css[0] !== width || geometry.css[1] !== height
      || Math.abs(geometry.aspect - width / height) > 1e-6) {
      console.error(`viewport mismatch: backing ${geometry.backing}, css ${geometry.css}, `
        + `aspect ${geometry.aspect} for a ${width}x${height} capture`);
      exitCode = 1;
    }

    console.log(`script:     ${relative}`);
    console.log(`preset:     ${options.preset || 'default'} (${width}x${height}, fov ${geometry.fov}, `
      + `aspect ${geometry.aspect.toFixed(4)}, dt ${options.dt})`);
    console.log(`loaded:     ${loadError ? `no (${loadError.message})` : 'yes'}`);
    console.log(`screenshot: ${path.join(outDir, 'screenshot.png')}`);
    console.log(`dump:       ${path.join(outDir, 'dump.json')}`);
    console.log(`native:     ${path.join(outDir, 'native.json')}`);
    console.log(`console:    ${path.join(outDir, 'console.json')}`);
  } catch (err) {
    // Only a crashed page is a failure of the run itself.
    console.error(`parity run failed: ${err.message}`);
    exitCode = 1;
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
