#!/usr/bin/env node
// Runs every conformance case against the core in Node with a recording
// consumer: no rendering, no physics, just the command stream and the dump.
//
//   node conformance/run-node.mjs [caseName ...]

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { matchDump } from "./match.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bundlePath = path.join(root, "core/dist/spatial-core.js");
const casesDir = path.join(here, "cases");

const FRAME = 1 / 60;

export function createHost(bundleSource) {
  const recorded = [];
  const logs = [];

  const context = {
    __spatialNative: {
      log(level, message) {
        logs.push(`${level}: ${message}`);
      },
      now() {
        return Date.now();
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(bundleSource, context, { filename: "spatial-core.js" });

  const spatial = context.__spatial;

  const record = (commands) => {
    for (const command of commands) {
      recorded.push(command);
      if (command[0] === "log") logs.push(`${command[2]}: ${command[3]}`);
    }
    return commands;
  };

  return {
    context,
    spatial,
    recorded,
    logs,
    tick(dt) {
      return record(spatial.tick(dt));
    },
    dispose() {
      return record(spatial.dispose());
    },
    /** Resolves a name to the core object id through the public namespace. */
    idFor(name) {
      const object = spatial.Spatial.find(name);
      if (!object) throw new Error(`no object named "${name}" in the mounted scene`);
      return spatial.idForObject(object);
    },
    /** Finds a texture id from the recorded `texture` commands by url. */
    textureIdForUrl(url) {
      for (const command of recorded) {
        if (command[0] === "texture" && command[2] && command[2].url === url) return command[1];
      }
      throw new Error(`no texture command recorded for url "${url}"`);
    },
    /** Finds a pending host call id from the recorded `hostCall` commands. */
    callIdForFunction(name) {
      for (const command of recorded) {
        if (command[0] === "hostCall" && command[2] === name) return command[1];
      }
      throw new Error(`no hostCall command recorded for "${name}"`);
    },
    /** Finds a fetch request id from the recorded `fetch` commands by url. */
    fetchIdForUrl(url) {
      for (const command of recorded) {
        if (command[0] === "fetch" && command[2] && command[2].url === url) return command[1];
      }
      throw new Error(`no fetch command recorded for url "${url}"`);
    },
    /** Finds an asset id from the recorded `asset` commands by any of its urls. */
    assetIdForUrl(url) {
      for (const command of recorded) {
        if (command[0] !== "asset" || !command[2]) continue;
        for (const key of Object.keys(command[2])) {
          if (command[2][key] === url) return command[1];
        }
      }
      throw new Error(`no asset command recorded for url "${url}"`);
    },
  };
}

function applyStep(host, step, context) {
  if (typeof step.frames === "number") {
    for (let i = 0; i < step.frames; i += 1) host.tick(FRAME);
    return;
  }

  if (step.inject) {
    const inject = host.spatial.Spatial.inject;
    const Vector3 = host.spatial.Spatial.Vector3;
    switch (step.inject) {
      case "tap":
        inject.tap(step.target, step.point ? new Vector3(...step.point) : undefined);
        break;
      case "hover":
        inject.hover(step.target, step.entering !== false);
        break;
      case "drag":
        inject.drag(step.target, new Vector3(...step.translation), { steps: step.steps || 1 });
        break;
      case "key":
        inject.key(step.code, step.down !== false);
        break;
      case "controller":
        inject.controller(step.state === undefined ? {} : step.state);
        break;
      default:
        throw new Error(`unknown inject "${step.inject}"`);
    }
    return;
  }

  if (step.dispatch) {
    const { type, target, texture, asset, call, fetch, payload } = step.dispatch;
    let id;
    if (texture !== undefined) id = host.textureIdForUrl(texture);
    else if (asset !== undefined) id = host.assetIdForUrl(asset);
    else if (call !== undefined) id = host.callIdForFunction(call);
    else if (fetch !== undefined) id = host.fetchIdForUrl(fetch);
    else if (target === undefined) id = 0;
    else id = host.idFor(target);
    const resolved = { ...(payload || {}) };
    if (typeof resolved.other === "string") resolved.other = host.idFor(resolved.other);
    host.spatial.dispatch(type, id, resolved);
    return;
  }

  if (step.sync) {
    const flat = [];
    for (const record of step.sync) {
      const position = record.position || [0, 0, 0];
      const quaternion = record.quaternion || [0, 0, 0, 1];
      const scale = record.scale || [1, 1, 1];
      flat.push(host.idFor(record.target), ...position, ...quaternion, ...scale);
    }
    host.spatial.sync(new Float32Array(flat));
    return;
  }

  if (step.syncBodies) {
    const flat = [];
    for (const record of step.syncBodies) {
      const linear = record.linear || [0, 0, 0];
      const angular = record.angular || [0, 0, 0];
      flat.push(host.idFor(record.target), ...linear, ...angular, record.sleeping ? 1 : 0);
    }
    host.spatial.syncBodies(new Float32Array(flat));
    return;
  }

  if (step.setInput) {
    host.spatial.setInput(step.setInput);
    return;
  }

  // ---- phase 2 consumer channels (SPEC 14.13) -------------------------------

  if (step.syncAudio || step.syncVideo) {
    const records = step.syncAudio || step.syncVideo;
    const flat = [];
    for (const record of records) {
      flat.push(
        host.idFor(record.target),
        record.playing ? 1 : 0,
        record.currentTime || 0,
        record.duration || 0,
      );
    }
    const packed = new Float32Array(flat);
    if (step.syncAudio) host.spatial.syncAudio(packed);
    else host.spatial.syncVideo(packed);
    return;
  }

  if (step.syncCharacter) {
    const flat = [];
    for (const record of step.syncCharacter) {
      const position = record.position || [0, 0, 0];
      const velocity = record.velocity || [0, 0, 0];
      flat.push(host.idFor(record.target), ...position, record.isOnGround ? 1 : 0, ...velocity);
    }
    host.spatial.syncCharacter(new Float32Array(flat));
    return;
  }

  if (step.syncSkeleton) {
    host.spatial.syncSkeleton(host.idFor(step.syncSkeleton.target), step.syncSkeleton.joints || {});
    return;
  }

  if (step.setActive !== undefined) {
    host.spatial.setActive(step.setActive !== false);
    return;
  }

  if (step.hostEvent) {
    host.spatial.hostEvent(step.hostEvent.name, step.hostEvent.payload);
    return;
  }

  if (step.hostFunctions) {
    host.spatial.setHostFunctions(step.hostFunctions);
    return;
  }

  /**
   * A hot reload on the same host (SPEC 14.10): the outgoing script's
   * `this.state` is captured and handed to the new script's `scriptChanged`.
   * Without `preserveState` the hook is not called at all.
   */
  if (step.reload !== undefined) {
    const preserve = step.preserveState !== false;
    const previousState = preserve ? host.spatial.captureState() : undefined;
    const options = {
      backend: context.backend,
      platform: context.platform,
      assetRoot: context.assetRoot,
    };
    if (preserve) options.previousState = previousState;
    host.spatial.load(step.reload, options);
    return;
  }

  if (step.dispose) {
    host.dispose();
    return;
  }

  throw new Error(`unknown step ${JSON.stringify(step)}`);
}

export async function runCase(bundleSource, caseName, source, expected, steps, options = {}) {
  const host = createHost(bundleSource);
  const backend = options.backend || expected.backend || "realitykit";
  const platform = options.platform || expected.platform || (backend === "realitykit" ? "macos" : "web");

  // The app registers its functions before the script runs (SPEC 14.10); the
  // same key is then compared against `dump().hostFunctions`.
  if (Array.isArray(expected.hostFunctions)) host.spatial.setHostFunctions(expected.hostFunctions);

  const assetRoot = options.assetRoot || "assets";
  const context = { backend, platform, assetRoot };

  let loadError = null;
  try {
    host.spatial.load(source, { backend, platform, assetRoot });
  } catch (error) {
    loadError = error;
  }

  const tickErrors = [];
  if (!loadError) {
    const plan = steps && steps.length ? steps : [{ frames: 3 }];
    for (const step of plan) {
      try {
        applyStep(host, step, context);
      } catch (error) {
        tickErrors.push(`${error.name || "Error"}: ${error.message}`);
      }
      // Let promise callbacks inside the context run (loadAsset, loadAsync).
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  }

  let dump;
  if (loadError) {
    dump = {
      backend,
      platform,
      frame: 0,
      elapsed: 0,
      objects: [],
      joints: [],
      gravity: [0, -9.81, 0],
      environment: null,
      warnings: [],
      errors: [`${loadError.name || "Error"}: ${loadError.message}`],
    };
  } else {
    dump = host.spatial.dump();
    dump.errors = dump.errors.concat(tickErrors);
  }

  dump.objectCount = dump.objects.length;
  dump.logs = host.logs.slice();

  const diffs = matchDump(expected, dump);
  return { name: caseName, diffs, dump, host, loadError };
}

function loadJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  if (!fs.existsSync(bundlePath)) {
    console.error(`core bundle not found at ${bundlePath}; run "corepack pnpm --filter @spatialscript/core build" first`);
    process.exit(2);
  }
  const bundleSource = fs.readFileSync(bundlePath, "utf8");

  const filter = process.argv.slice(2);
  const names = fs
    .readdirSync(casesDir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.slice(0, -3))
    .filter((name) => filter.length === 0 || filter.includes(name))
    .sort();

  let passed = 0;
  const failures = [];

  for (const name of names) {
    const source = fs.readFileSync(path.join(casesDir, `${name}.js`), "utf8");
    const expectedPath = path.join(casesDir, `${name}.expected.json`);
    if (!fs.existsSync(expectedPath)) {
      failures.push({ name, diffs: [`missing ${name}.expected.json`] });
      continue;
    }
    const expected = loadJSON(expectedPath);
    const stepsPath = path.join(casesDir, `${name}.steps.json`);
    const steps = fs.existsSync(stepsPath) ? loadJSON(stepsPath) : null;

    let result;
    try {
      result = await runCase(bundleSource, name, source, expected, steps);
    } catch (error) {
      failures.push({ name, diffs: [`threw: ${error && error.stack ? error.stack : error}`] });
      console.log(`FAIL ${name}`);
      continue;
    }

    if (result.diffs.length === 0) {
      passed += 1;
      console.log(`pass ${name}`);
    } else {
      failures.push(result);
      console.log(`FAIL ${name}`);
      for (const diff of result.diffs) console.log(`     ${diff}`);
    }
  }

  console.log("");
  console.log(`${passed}/${names.length} cases passed`);
  if (failures.length > 0) {
    console.log(`failed: ${failures.map((failure) => failure.name).join(", ")}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
