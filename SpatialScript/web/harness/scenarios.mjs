// Runs every scenario and robustness script through harness/screenshot.mjs and
// summarises what each one did: did it load, did it render anything, did the frame
// loop survive, and what errors did it record.
//
//   node harness/scenarios.mjs [--filter name]

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SPATIAL_ROOT } from './server.mjs';

const run = promisify(execFile);
const OUT_DIR = path.join(SPATIAL_ROOT, 'web/harness/out/scenarios');
const HERE = path.join(SPATIAL_ROOT, 'web/harness');

const DEFAULT_FRAMES = 120;

/** Per-script overrides the coordinator asked for. */
const OVERRIDES = {
  'events.js': {
    injects: ['tap:grandchild', 'tap:stopper', 'hover:child'],
  },
  'physics-scenarios.js': {
    frames: 300,
    // Parity with the RealityKit run: the ball must come to rest on the thin
    // floor rather than tunnelling through it, the trigger must fire, and the
    // downward raycast must find the top of the stack.
    expect(dump) {
      const failures = [];
      const userData = (dump.scene && dump.scene.userData) || {};
      const dropper = (dump.objects || []).find((o) => o.name === 'dropper');
      if (!dropper) {
        failures.push('no object named "dropper"');
      } else {
        const y = dropper.worldPosition[1];
        if (Math.abs(y - -0.26) > 0.02) failures.push(`dropper rests at y=${y.toFixed(4)}, expected -0.26 +/- 0.02`);
      }
      if (!(userData.triggerEnters >= 1)) {
        failures.push(`triggerEnters is ${userData.triggerEnters}, expected at least 1`);
      }
      if (userData.rayTop !== 'stack-2') {
        failures.push(`rayTop is ${JSON.stringify(userData.rayTop)}, expected "stack-2"`);
      }
      return failures;
    },
  },
};

/** Scripts whose load is expected to fail, and scripts expected to record errors. */
const EXPECTED_LOAD_ERROR = new Set(['two-scenes-no-mount.js', 'syntax-error.js']);
// These scripts throw on purpose and say so in their own comments: the shear
// rejection in transforms.js and the post-await throw in top-level-await.js are
// the behaviour under test.
const EXPECTED_ERRORS = new Set([
  'nan-transform.js', 'listener-throws.js', 'cyclic-parent.js',
  'transforms.js', 'top-level-await.js',
]);

async function listScripts(dir) {
  const entries = await fs.readdir(path.join(SPATIAL_ROOT, dir));
  return entries.filter((e) => e.endsWith('.js')).sort().map((e) => `${dir}/${e}`);
}

async function main() {
  const filterIndex = process.argv.indexOf('--filter');
  const filter = filterIndex >= 0 ? process.argv[filterIndex + 1] : null;
  await fs.mkdir(OUT_DIR, { recursive: true });

  const scripts = [
    ...(await listScripts('scenarios')),
    ...(await listScripts('scenarios/robustness')),
  ].filter((s) => !filter || s.includes(filter));

  const results = [];
  for (const script of scripts) {
    results.push(await runScript(script));
  }
  report(results);
  process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}

async function runScript(script) {
  const file = path.basename(script);
  const override = OVERRIDES[file] || {};
  const frames = override.frames || DEFAULT_FRAMES;
  const name = path.basename(file, '.js');
  const args = [
    path.join(HERE, 'screenshot.mjs'),
    path.join(SPATIAL_ROOT, script),
    '--frames', String(frames),
    '--out-dir', OUT_DIR,
    '--settle', '2',
  ];
  for (const inject of override.injects || []) args.push('--inject', inject);

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const result = await run(process.execPath, args, { cwd: SPATIAL_ROOT, maxBuffer: 32 * 1024 * 1024 });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || String(err);
    exitCode = err.code === undefined ? 1 : err.code;
  }

  const dumpPath = path.join(OUT_DIR, `${name}.dump.json`);
  let dump = null;
  try {
    dump = JSON.parse(await fs.readFile(dumpPath, 'utf8'));
  } catch {
    dump = null;
  }

  const loaded = !/script failed to load/.test(stdout + stderr);
  const drawCalls = Number((stdout.match(/drawCalls:\s+(\d+)/) || [])[1] ?? -1);
  const expectedLoadError = EXPECTED_LOAD_ERROR.has(file);
  const expectedErrors = EXPECTED_ERRORS.has(file);
  const errors = dump ? (dump.errors || []) : [];
  const consoleErrors = [...(stdout + stderr).matchAll(/^\s{2}(.+)$/gm)]
    .map((m) => m[1])
    .filter((line) => /error|Error/.test(line));

  const notes = [];
  let status = 'pass';

  if (expectedLoadError) {
    if (loaded) {
      status = 'fail';
      notes.push('expected a load error, but the script loaded');
    } else {
      notes.push('load error as expected');
    }
  } else if (!loaded) {
    status = 'fail';
    notes.push(`did not load: ${firstLine(stdout + stderr, /script failed to load:\s*([\s\S]*)/)}`);
  } else {
    // The frame loop must survive; every requested tick has to have run.
    const expectedFrames = frames + 2 + (override.injects || []).length;
    if (!dump) {
      status = 'fail';
      notes.push('no dump was written');
    } else if (dump.frame < frames) {
      status = 'fail';
      notes.push(`frame loop stopped at frame ${dump.frame} of ${expectedFrames}`);
    }
    if (drawCalls === 0) {
      status = 'fail';
      notes.push('rendered nothing (0 draw calls)');
    }
    if (dump && override.expect) {
      const failures = override.expect(dump);
      if (failures.length) {
        status = 'fail';
        for (const failure of failures) notes.push(failure);
      } else {
        notes.push('scene expectations met');
      }
    }
    if (errors.length && !expectedErrors) {
      status = 'fail';
      for (const error of errors) notes.push(`dump error: ${error}`);
    } else if (errors.length) {
      notes.push(`${errors.length} recorded error(s), expected: ${errors[0]}`);
    }
  }

  return {
    script, name, status, notes, exitCode,
    frames: dump ? dump.frame : null,
    objects: dump ? (dump.objects || []).length : null,
    drawCalls,
    warnings: dump ? (dump.warnings || []).length : 0,
    consoleErrors: consoleErrors.length,
  };
}

function firstLine(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1].split('\n')[0].trim() : 'unknown';
}

function report(results) {
  console.log('');
  for (const result of results) {
    const mark = result.status === 'pass' ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${result.script}  frames=${result.frames} objects=${result.objects} `
      + `draws=${result.drawCalls} warnings=${result.warnings}`);
    for (const note of result.notes) console.log(`        ${note}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log('');
  console.log(`${results.length - failed} passed, ${failed} failed, ${results.length} scripts`);
  console.log(`screenshots and dumps in ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
