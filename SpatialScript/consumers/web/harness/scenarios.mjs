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
import { nativeConsistency, runawayBodies } from './native-check.mjs';

const run = promisify(execFile);
const OUT_DIR = path.join(SPATIAL_ROOT, 'consumers/web/harness/out/scenarios');
const HERE = path.join(SPATIAL_ROOT, 'consumers/web/harness');

/** The rendered objects by name, from the consumer's own dump. */

function nativeByName(native) {
  const out = {};
  for (const object of (native && native.objects) || []) if (object.name) out[object.name] = object;
  return out;
}

function sceneUserData(dump) {
  return (dump && dump.scene && dump.scene.userData) || {};
}

/** The colour three.js is really rendering an object with, if it has a material. */
function materialColour(object) {
  const material = Array.isArray(object.material) ? object.material[0] : object.material;
  return material && Array.isArray(material.color) ? material.color : null;
}

const DEFAULT_FRAMES = 120;


/** Per-script overrides the coordinator asked for. */
const OVERRIDES = {
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
      // AR-46: the hinge really holds the bob below it, in this lane too.
      if (userData.bobHangsBelowHinge !== true) {
        failures.push(`bobHangsBelowHinge is ${JSON.stringify(userData.bobHangsBelowHinge)}, expected true`);
      }
      if (userData.rayTop !== 'stack-2') {
        failures.push(`rayTop is ${JSON.stringify(userData.rayTop)}, expected "stack-2"`);
      }
      return failures;
    },
  },
  // AR-22: the visual scenarios assert what three.js actually holds — visibility,
  // material colour, geometry and world placement — so a consumer that drops an
  // opcode fails here and not only in conformance.
  'dynamic-updates.js': {
    // The blinker flips every 30 frames, so an odd number of flips leaves it
    // hidden: the run ends in a state that proves visibility really reaches the
    // renderer (AR-22 — with `visible` ignored, every frame count looks alike).
    frames: 105,
    expect(dump, native) {
      const failures = [];
      const byName = nativeByName(native);
      const userData = sceneUserData(dump);
      // Every ring the script is holding is a box in the renderer, with a colour
      // of its own; a ring it destroyed is gone from both.
      const rings = (native.objects || []).filter((o) => /^ring-\d+$/.test(o.name || ''));
      if (!(userData.ringCount >= 5)) failures.push(`the script holds ${userData.ringCount} rings, expected at least 5`);
      if (rings.length !== userData.ringCount) {
        failures.push(`the renderer holds ${rings.length} rings, the script holds ${userData.ringCount}`);
      }
      const colours = new Set();
      for (const ring of rings) {
        if (!ring.geometry || ring.geometry.type !== 'BoxGeometry') failures.push(`${ring.name} is not a box`);
        const colour = materialColour(ring);
        if (!colour) failures.push(`${ring.name} has no material`);
        else colours.add(colour.map((c) => c.toFixed(3)).join(','));
      }
      if (colours.size < rings.length) failures.push(`${rings.length - colours.size} rings share a colour`);
      // The blinker really blinks: it is a real mesh whose visibility is driven.
      const blinker = byName.blinker;
      if (!blinker) failures.push('no blinker in the rendered scene');
      else {
        if (!blinker.geometry || blinker.geometry.type !== 'SphereGeometry') failures.push('the blinker is not a sphere');
        if (blinker.visible !== false) failures.push('the blinker is visible after an odd number of flips');
      }
      const morph = byName.morph;
      if (!morph || !morph.geometry) failures.push('no morph geometry in the rendered scene');
      return failures;
    },
  },
  'hierarchy.js': {
    expect(dump, native) {
      const failures = [];
      const byName = nativeByName(native);
      const userData = sceneUserData(dump);
      const hand = byName.hand;
      if (!hand) return ['no hand in the rendered scene'];
      // The script reports the world position it expects; three.js must agree,
      // which is the whole point of a nested transform.
      const reported = userData.handWorld;
      if (!Array.isArray(reported)) failures.push('the script recorded no handWorld');
      else if (reported.some((v, i) => Math.abs(v - hand.worldPosition[i]) > 1e-3)) {
        failures.push(`hand world position ${JSON.stringify(hand.worldPosition)} `
          + `does not match the script's ${JSON.stringify(reported)}`);
      }
      // The script re-attaches the orphan to the hand mid-run and expects its
      // world position to survive the move (Object3D.attach).
      const orphan = byName.orphan;
      if (!orphan) failures.push('no orphan in the rendered scene');
      else {
        if (orphan.parent === 0) failures.push('the orphan was never re-attached to the hand');
        if (Math.abs(orphan.worldPosition[0] - -0.3) > 1e-3 || Math.abs(orphan.worldPosition[1] - 0.2) > 0.05) {
          failures.push(`attach moved the orphan to ${JSON.stringify(orphan.worldPosition)}, `
            + 'expected it to stay near (-0.3, 0.2, 0)');
        }
      }
      return failures;
    },
  },
  'materials-lights.js': {
    expect(dump, native) {
      const failures = [];
      const byName = nativeByName(native);
      const lights = (native.objects || []).filter((o) => o.light);
      const kinds = new Set(lights.map((o) => o.light.type));
      for (const kind of ['ambient', 'directional', 'point', 'spot']) {
        if (!kinds.has(kind)) failures.push(`no ${kind} light reached the renderer`);
      }
      const floor = byName.floor;
      if (!floor) failures.push('no floor in the rendered scene');
      else if (!materialColour(floor)) failures.push('the floor has no material');
      // The grid of spheres is really there, with materials.
      const spheres = (native.objects || []).filter((o) => /^sphere-/.test(o.name || ''));
      if (spheres.length < 9) failures.push(`only ${spheres.length} spheres were built`);
      if (spheres.some((o) => !materialColour(o))) failures.push('a sphere has no material');
      return failures;
    },
  },
  'transforms.js': {
    expect(dump, native) {
      const failures = [];
      const byName = nativeByName(native);
      const userData = sceneUserData(dump);
      if (userData.shearRejected !== true) failures.push('the shear was not rejected');
      if (userData.shearRestored !== true) failures.push('the last valid transform was not restored');
      const looker = byName.looker;
      if (!looker) return ['no looker in the rendered scene'];
      const reported = userData.lookerWorld;
      if (Array.isArray(reported)) {
        const position = reported.slice(0, 3);
        if (position.some((v, i) => Math.abs(v - looker.worldPosition[i]) > 1e-3)) {
          failures.push(`looker world position ${JSON.stringify(looker.worldPosition)} `
            + `does not match the script's ${JSON.stringify(position)}`);
        }
        const quaternion = reported.slice(3);
        if (quaternion.length === 4 && quaternion.some((v, i) => Math.abs(v - looker.quaternion[i]) > 1e-2)) {
          failures.push(`looker rotation ${JSON.stringify(looker.quaternion)} `
            + `does not match the script's ${JSON.stringify(quaternion)}`);
        }
      }
      return failures;
    },
  },
  'events.js': {
    injects: ['tap:grandchild', 'tap:stopper', 'hover:child'],
    expect(dump) {
      const log = sceneUserData(dump).log || [];
      const wanted = ['tap@grandchild<-grandchild', 'tap@parent<-grandchild', 'tap@stopper<-stopper',
        'hoverenter@child<-child'];
      const missing = wanted.filter((entry) => !log.includes(entry));
      if (log.includes('tap@scene<-stopper')) {
        return ['the stopper did not stop propagation'];
      }
      return missing.map((entry) => `the event log is missing "${entry}" (got ${JSON.stringify(log)})`);
    },
  },
  'stress.js': {
    expect(dump, native) {
      const failures = [];
      const meshes = (native.objects || []).filter((o) => /^c\d+$/.test(o.name || ''));
      if (meshes.length !== 1500) failures.push(`${meshes.length} of 1500 meshes reached the renderer`);
      if (meshes.some((o) => !o.geometry || o.geometry.type !== 'BoxGeometry')) {
        failures.push('a stress mesh lost its geometry');
      }
      if (meshes.some((o) => !materialColour(o))) failures.push('a stress mesh lost its material');
      const dt = sceneUserData(dump).avgDt;
      if (!(dt > 0)) failures.push(`the frame loop reported avgDt ${dt}`);
      return failures;
    },
  },
  'texture-404.js': {
    // FA-01: SPEC 3.5 says a failed texture load reaches the script through the
    // texture's own error event. The scenario sets a flag inside that callback,
    // so the run only passes when the callback really fired.
    expect(dump) {
      const userData = (dump.scene && dump.scene.userData) || {};
      if (userData.textureError !== true) {
        return ['scene.userData.textureError is not true; the texture error callback never fired'];
      }
      if (userData.loaded === true) return ['scene.userData.loaded is true for a texture that 404s'];
      return [];
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
    ...(await listScripts('verification/scenarios')),
    ...(await listScripts('verification/scenarios/robustness')),
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
  // AR-22: what three.js actually holds, so an expectation can constrain the
  // consumer and not just the core.
  let native = null;
  try {
    native = JSON.parse(await fs.readFile(path.join(OUT_DIR, `${name}.native.json`), 'utf8'));
  } catch {
    native = null;
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
    // AR-31: a scene whose bodies run away is a failure, not a PASS with a
    // pretty screenshot. SPEC 14.4 bounds what a force field may do; these
    // bounds catch the divergence a mis-scaled recipe still produces.
    if (native) {
      for (const line of runawayBodies(native)) {
        status = 'fail';
        notes.push(line);
      }
    }
    // AR-22: every scenario constrains the consumer, not only the core. What
    // three.js built has to agree with what the core says the script asked for.
    if (dump && native) {
      const divergence = nativeConsistency(dump, native);
      if (divergence.length) {
        status = 'fail';
        for (const line of divergence.slice(0, 5)) notes.push(line);
        if (divergence.length > 5) notes.push(`... ${divergence.length - 5} more native divergences`);
      }
    } else if (dump && !native) {
      status = 'fail';
      notes.push('no native dump was written');
    }
    if (dump && override.expect) {
      const failures = override.expect(dump, native);
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
