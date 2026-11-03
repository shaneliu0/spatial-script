// Frame-rate and command-apply measurements for the three.js consumer.
//
//   node harness/bench.mjs [--script verification/scenarios/stress.js] [--seconds 5]
//                          [--headless] [--headed] [--width N] [--height N]
//
// Runs the script under the real animation-frame loop and reports the frame rate
// and the per-frame command apply time the consumer records in window.spatialStats().

import path from 'node:path';
import { startServer, SPATIAL_ROOT } from './server.mjs';
import { launchBrowser, assertWebGL } from './browser.mjs';
import { benchmarkTransforms, meshGridSource } from './scene-bench.mjs';

const DEFAULTS = { script: 'verification/scenarios/stress.js', seconds: 5, width: 1000, height: 750 };

function parseArgs(argv) {
  const out = { ...DEFAULTS, modes: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--script') out.script = argv[++i];
    else if (arg === '--seconds') out.seconds = Number(argv[++i]);
    else if (arg === '--width') out.width = Number(argv[++i]);
    else if (arg === '--height') out.height = Number(argv[++i]);
    else if (arg === '--headless') out.modes.push('headless');
    else if (arg === '--headed') out.modes.push('headed');
  }
  if (!out.modes.length) out.modes = ['headless', 'headed'];
  return out;
}

function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    median: at(0.5),
    p95: at(0.95),
    worst: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
  };
}

async function measure(server, options, headless) {
  const browser = await launchBrowser({ headless });
  try {
    const page = await browser.newPage({ viewport: { width: options.width + 380, height: options.height } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `${server.url}/consumers/web/index.html?script=${encodeURIComponent(options.script)}`
      + `&w=${options.width}&h=${options.height}`;
    await page.goto(url, { waitUntil: 'load' });
    const webgl = await assertWebGL(page);
    await page.waitForFunction(() => window.spatialBooted === true, null, { timeout: 30000 });
    await page.bringToFront();

    // Let the scene build and the loop settle before the measured window.
    await page.waitForFunction(() => window.spatialDump() && window.spatialDump().frame > 30,
      null, { timeout: 60000 });
    await page.waitForTimeout(options.seconds * 1000);

    const stats = await page.evaluate(() => window.spatialStats());
    const render = await page.evaluate(() => window.spatialRenderInfo());
    const objects = await page.evaluate(() => window.spatialDump().objects.length);

    // The first sample has no previous frame to measure an interval against.
    const intervals = stats.map((s) => s.frameIntervalMs).filter((v) => v > 0);
    const applies = stats.map((s) => s.applyMs);
    const coreTicks = stats.map((s) => s.coreTickMs);
    const records = stats.map((s) => s.transformRecords);

    await page.close();
    return {
      mode: headless ? 'headless' : 'headed',
      renderer: webgl.renderer,
      frames: stats.length,
      objects,
      drawCalls: render ? render.drawCalls : null,
      geometries: stats.length ? stats[stats.length - 1].geometryCount : null,
      materials: stats.length ? stats[stats.length - 1].materialCount : null,
      transformRecords: records.length ? Math.max(...records) : 0,
      interval: summarise(intervals),
      apply: summarise(applies),
      coreTick: summarise(coreTicks),
      errors,
    };
  } finally {
    await browser.close();
  }
}

async function measureTransformBenchmark(server) {
  const browser = await launchBrowser({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(`${server.url}/consumers/web/index.html?mode=manual&w=640&h=480`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.spatialBooted === true, null, { timeout: 30000 });
    await page.evaluate((source) => {
      const result = window.spatialLoad(source);
      if (!result.ok) throw new Error(result.error.message);
    }, meshGridSource(2000));
    return await benchmarkTransforms(page, { count: 2000 });
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = await startServer();
  try {
    console.log(`script: ${options.script}  window: ${options.width}x${options.height}  `
      + `measured over ${options.seconds}s\n`);

    for (const mode of options.modes) {
      const result = await measure(server, options, mode === 'headless');
      const fps = 1000 / result.interval.median;
      const lowFps = 1000 / result.interval.p95;
      console.log(`${result.mode}`);
      console.log(`  renderer        ${result.renderer}`);
      console.log(`  objects         ${result.objects}  draw calls ${result.drawCalls}  `
        + `geometries ${result.geometries}  materials ${result.materials}`);
      console.log(`  frame rate      ${fps.toFixed(1)} fps median, ${lowFps.toFixed(1)} fps at the 95th percentile frame`);
      console.log(`  frame interval  median ${result.interval.median.toFixed(2)}ms, p95 ${result.interval.p95.toFixed(2)}ms`);
      console.log(`  command apply   median ${result.apply.median.toFixed(2)}ms, p95 ${result.apply.p95.toFixed(2)}ms, `
        + `worst ${result.apply.worst.toFixed(2)}ms  (${result.transformRecords} transform records/frame)`);
      console.log(`  core tick       median ${result.coreTick.median.toFixed(2)}ms, p95 ${result.coreTick.p95.toFixed(2)}ms`);
      if (result.errors.length) console.log(`  page errors     ${result.errors.join(' | ')}`);
      console.log('');
    }

    const spec = await measureTransformBenchmark(server);
    console.log('SPEC 12 benchmark (2000 records in one transforms command, headless)');
    console.log(`  apply           median ${spec.median.toFixed(2)}ms, p95 ${spec.p95.toFixed(2)}ms, `
      + `worst ${spec.worst.toFixed(2)}ms  (budget 8ms)`);
    console.log(`  shared          ${spec.geometries} geometry, ${spec.materials} materials`);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
