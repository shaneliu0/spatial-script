// Conformance and example runner.
//
// Serves the SpatialScript tree, runs every conformance case and every example in
// headless Chromium, ticks deterministically, compares the dump with
// verification/conformance/match.mjs, and writes screenshots and dumps to consumers/web/harness/out/.
// Exits non-zero when anything fails.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, SPATIAL_ROOT } from './server.mjs';
import { launchBrowser, openScene, runSteps, screenshotCanvas, stepsDriveBridge } from './browser.mjs';
import { nativeConsistency } from './native-check.mjs';

const OUT_DIR = path.join(SPATIAL_ROOT, 'consumers/web/harness/out');

/**
 * AR-01: the only diffs a case is allowed to have on the web backend, with the
 * reason each one is legitimate. Anything else fails, and an entry that stops
 * matching fails too. Kept next to the runner so it is reviewed with it.
 */
const ADVISORY = JSON.parse(
  await fs.readFile(path.join(SPATIAL_ROOT, 'consumers/web/harness/web-advisory.json'), 'utf8'),
);
const DEFAULT_FRAMES = 3;
const DT = 1 / 60;

const args = parseArgs(process.argv.slice(2));

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const matcher = await loadMatcher();
  const cases = [
    ...(await discover('verification/conformance/cases', true)),
    ...(await discover('examples', false)),
  ].filter((c) => !args.filter || c.name.includes(args.filter));

  if (!cases.length) {
    console.log('no conformance cases or examples found yet (verification/conformance/cases and examples are empty)');
  }

  const server = await startServer();
  const browser = await launchBrowser();
  const results = [];

  try {
    for (const testCase of cases) {
      results.push(await runCase(browser, server, testCase, matcher));
    }
  } finally {
    await browser.close();
    await server.close();
  }

  report(results, matcher);
  const failed = results.filter((r) => r.status === 'fail').length;
  process.exit(failed ? 1 : 0);
}

function parseArgs(argv) {
  const out = { filter: null, camera: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--filter') out.filter = argv[++i];
    else if (argv[i] === '--camera') out.camera = argv[++i].split(',').map(Number);
  }
  return out;
}

/** The shared subset matcher is owned by verification/conformance/; it is imported, never copied. */
async function loadMatcher() {
  const matchPath = path.join(SPATIAL_ROOT, 'verification/conformance/match.mjs');
  try {
    await fs.access(matchPath);
  } catch {
    return null;
  }
  const module = await import(pathToFileURL(matchPath).href);
  const fn = module.match || module.matchDump || module.default;
  if (typeof fn !== 'function') {
    console.warn('verification/conformance/match.mjs exports no callable matcher (expected `match`, `matchDump` or default)');
    return null;
  }
  return fn;
}

async function discover(relativeDir, expectExpected) {
  const dir = path.join(SPATIAL_ROOT, relativeDir);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const cases = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.js') || entry.endsWith('.expected.json')) continue;
    const name = entry.slice(0, -3);
    const expectedPath = path.join(dir, `${name}.expected.json`);
    const stepsPath = path.join(dir, `${name}.steps.json`);
    cases.push({
      name: relativeDir.startsWith('examples') ? `example-${name}` : name,
      scriptPath: `${relativeDir}/${entry}`,
      expected: await readJson(expectedPath),
      steps: await readJson(stepsPath),
      requiresExpected: expectExpected,
    });
  }
  return cases;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function normaliseSteps(steps) {
  if (!steps) return { steps: [{ frames: DEFAULT_FRAMES }], camera: null };
  if (Array.isArray(steps)) {
    const camera = steps.find((s) => s && s.camera);
    const list = steps.filter((s) => s && !s.camera);
    return {
      steps: list.length ? list : [{ frames: DEFAULT_FRAMES }],
      camera: camera ? camera.camera : null,
    };
  }
  // Object form: `{ frames, camera, steps }`.
  return {
    steps: steps.steps || [{ frames: steps.frames ?? DEFAULT_FRAMES }],
    camera: steps.camera || null,
  };
}


async function runCase(browser, server, testCase, matcher) {
  const { steps, camera } = normaliseSteps(testCase.steps);
  const started = Date.now();
  let page;
  try {
    const scene = await openScene(browser, {
      origin: server.url,
      scriptPath: testCase.scriptPath,
      camera: args.camera || camera,
      // The node runner applies these before load; so does this one.
      hostFunctions: testCase.expected && testCase.expected.hostFunctions,
      demoHost: false,
    });
    page = scene.page;

    const loadError = await page.evaluate(() => window.spatialLoadError || null);
    let dump;
    let native = null;
    if (loadError) {
      // A load error is a result, not a harness failure: cases assert on it.
      dump = emptyDump(`${loadError.name || 'Error'}: ${loadError.message}`);
    } else {
      if (stepsDriveBridge(steps)) await page.evaluate(() => window.spatialBridge(true));
      await runSteps(page, steps, DT);
      dump = await page.evaluate(() => window.spatialDump());
      native = await page.evaluate(() => window.spatialNativeDump());
    }
    // The node runner augments the dump the same way; expectations may use both.
    dump.objectCount = (dump.objects || []).length;
    dump.logs = await page.evaluate(() => (window.spatialConsumer
      ? window.spatialConsumer.logs.map((l) => `${l.level}: ${l.message}`)
      : []));
    // Only uncaught page exceptions fail a case; a 404 on an optional texture is
    // reported through the dump's warnings instead.
    const consoleErrors = scene.consoleMessages.filter((m) => m.type === 'pageerror').map((m) => m.text);

    await fs.writeFile(path.join(OUT_DIR, `${testCase.name}.dump.json`), JSON.stringify(dump, null, 2));
    await screenshotCanvas(page, path.join(OUT_DIR, `${testCase.name}.png`));

    const diffs = [];
    const dumpErrors = (dump.errors || []).filter(
      (e) => !(testCase.expected && (testCase.expected.errors || []).some((x) => String(e).includes(x))),
    );
    for (const error of dumpErrors) diffs.push(`dump.errors contains: ${error}`);
    for (const error of consoleErrors) diffs.push(`console error: ${error}`);

    // AR-01: the core dump alone barely constrains the consumer, so every case
    // also checks that what three.js actually holds agrees with what the core
    // says it asked for. A consumer that drops materials, visibility or geometry
    // fails here whatever its expectation file says.
    diffs.push(...nativeConsistency(dump, native));

    let matched = 'n/a';
    if (testCase.expected) {
      if (!matcher) {
        matched = 'skipped (verification/conformance/match.mjs not found)';
      } else {
        matched = 'compared';
        diffs.push(...interpretMatch(matcher(webExpectation(testCase.expected), dump)));
      }
    } else if (testCase.requiresExpected) {
      matched = 'no expected.json';
    }

    // AR-01: a case written for another backend is still compared in full. Only
    // the diffs an entry in harness/web-advisory.json names are allowed through,
    // and an entry that matches nothing is itself a failure, so the list cannot
    // rot or grow silently.
    const advisory = ADVISORY[testCase.name] || null;
    // `paths` must each match something, so the list cannot rot. `timingPaths`
    // are for diffs that depend on what a real network delivered before the last
    // frame: they are allowed to match nothing, and nothing else is.
    const strict = advisory ? advisory.paths || [] : [];
    const timing = advisory ? advisory.timingPaths || [] : [];
    const allowed = [...strict, ...timing];
    const used = new Set();
    const failing = [];
    const excused = [];
    for (const diff of diffs) {
      // Every entry that covers this diff counts as used: one path can be the
      // prefix of another, and neither should be reported as stale.
      const matches = allowed.filter((prefix) => diff.startsWith(prefix));
      if (matches.length) {
        for (const prefix of matches) used.add(prefix);
        excused.push(`advisory: ${diff}`);
      } else {
        failing.push(diff);
      }
    }
    for (const prefix of strict) {
      if (!used.has(prefix)) {
        failing.push(`stale web-advisory entry for "${testCase.name}": nothing matched "${prefix}"`);
      }
    }

    let status = 'pass';
    if (failing.length) status = 'fail';
    else if (excused.length) status = 'skip';

    return {
      name: testCase.name,
      status,
      diffs: [...failing, ...excused],
      matched,
      coreSource: dump.coreSource,
      note: advisory ? `web-advisory: ${advisory.reason}` : null,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { name: testCase.name, status: 'fail', diffs: [err.message], matched: 'error', ms: Date.now() - started };
  } finally {
    if (page) await page.close();
  }
}

/**
 * `backend` and `platform` are chosen by the runner, not by the scene, so the web
 * runner drops them. When a case was written against RealityKit, its
 * RealityKit-only warnings cannot appear here either (the core gates them on the
 * backend), so those expected warnings are dropped too.
 */
function webExpectation(expected) {
  const backend = expected.backend;
  const platform = expected.platform;
  let copy = { ...expected };
  delete copy.backend;
  delete copy.platform;
  if (backend && backend !== 'three') {
    // The case was parameterised for another backend. Rewrite the two runner-chosen
    // values wherever they appear (a case may assert `Spatial.env.backend`), and
    // drop warnings that the core only emits for that backend.
    copy = substituteStrings(copy, { [backend]: 'three', [platform || 'macos']: 'web' });
    if (Array.isArray(copy.warnings)) {
      copy.warnings = copy.warnings.filter((w) => !String(w).includes('RealityKit'));
    }
  }
  return copy;
}

function substituteStrings(value, table) {
  if (typeof value === 'string') return value in table ? table[value] : value;
  if (Array.isArray(value)) return value.map((v) => substituteStrings(v, table));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = substituteStrings(value[key], table);
    return out;
  }
  return value;
}

function emptyDump(message) {
  return {
    backend: 'three', platform: 'web', frame: 0, elapsed: 0, objects: [], joints: [],
    gravity: [0, -9.81, 0], environment: null, warnings: [], errors: [message],
  };
}

/** match.mjs may return a boolean, a list of diffs, or `{ ok, diffs }`. */
function interpretMatch(result) {
  if (result === true || result === undefined || result === null) return [];
  if (result === false) return ['dump did not match expected'];
  if (Array.isArray(result)) return result.map(String);
  if (typeof result === 'object') {
    if (result.ok === true) return [];
    const diffs = result.diffs || result.errors || result.differences || [];
    return diffs.length ? diffs.map(String) : ['dump did not match expected'];
  }
  return [String(result)];
}

function report(results, matcher) {
  console.log('');
  for (const result of results) {
    const mark = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }[result.status];
    console.log(`${mark}  ${result.name}  (${result.ms}ms, ${result.matched})${result.note ? ` [${result.note}]` : ''}`);
    for (const diff of result.diffs) console.log(`        ${diff}`);
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  const failed = results.length - passed - skipped;
  const source = results.find((r) => r.coreSource);
  console.log('');
  if (source) console.log(`core: ${source.coreSource}`);
  if (!matcher) console.log('matcher: verification/conformance/match.mjs not present, dump comparison skipped');
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped (backend-specific expectation), ${results.length} total`);
  console.log(`screenshots and dumps in ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
