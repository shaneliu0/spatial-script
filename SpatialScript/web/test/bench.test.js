// SPEC section 12: a tick of 2000 objects with transform changes must apply within
// 8 ms, and the benchmark has to cross the real engine boundary. This one runs in
// headless Chromium against the real core bundle, not against native arrays.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../harness/server.mjs';
import { launchBrowser, openScene } from '../harness/browser.mjs';
import { benchmarkTransforms, meshGridSource } from '../harness/scene-bench.mjs';

const OBJECT_COUNT = 2000;
const BUDGET_MS = 8;

test('applying 2000 batched transform records in the browser stays under 8 ms', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, { origin: server.url, width: 640, height: 480 });
  await page.evaluate((source) => {
    const result = window.spatialLoad(source);
    if (!result.ok) throw new Error(result.error.message);
  }, meshGridSource(OBJECT_COUNT));

  const result = await benchmarkTransforms(page, { count: OBJECT_COUNT });

  console.log(`  ${OBJECT_COUNT} records in one transforms command: median ${result.median.toFixed(2)}ms, `
    + `p95 ${result.p95.toFixed(2)}ms, worst ${result.worst.toFixed(2)}ms (budget ${BUDGET_MS}ms)`);
  console.log(`  shared resources: ${result.geometries} geometry, ${result.materials} materials`);

  assert.ok(result.median < BUDGET_MS, `median ${result.median.toFixed(2)}ms exceeds the ${BUDGET_MS}ms budget`);
});
