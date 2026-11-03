// Shared test scaffolding: every test evaluates the built bundle in its own
// vm context so the module-level runtime singleton never leaks between tests.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// The suite runs with --no-incremental-marking (see package.json): node 24.18
// segfaults in ClearStaleLeftTrimmedPointerVisitor while marking the many vm
// contexts these tests create, which fails a file whose tests all passed.

const here = path.dirname(fileURLToPath(import.meta.url));
export const bundlePath = path.resolve(here, "../dist/spatial-core.js");
export const bundleSource = fs.readFileSync(bundlePath, "utf8");

// One compiled script for the whole file: every context evaluates the same
// 1.1 MB bundle, and recompiling it per test is heap the suite does not need.
const bundleScript = new vm.Script(bundleSource, { filename: "spatial-core.js" });

export const FRAME = 1 / 60;

/**
 * Creates a context whose only globals are `globalThis` and `__spatialNative`,
 * matching what a JavaScriptCore host provides.
 */
export function createBareContext(native = {}) {
  const context = { __spatialNative: native };
  context.globalThis = context;
  vm.createContext(context);
  return context;
}

export function createHost({ native, backend = "realitykit", platform = "macos" } = {}) {
  const logs = [];
  const context = createBareContext(
    native || {
      log(level, message) {
        logs.push(`${level}: ${message}`);
      },
      now() {
        return Date.now();
      },
    },
  );
  bundleScript.runInContext(context);
  const spatial = context.__spatial;
  const frames = [];

  return {
    context,
    spatial,
    logs,
    frames,
    load(source, options = {}, extra) {
      spatial.load(source, { backend, platform, ...options }, extra);
    },
    tick(dt = FRAME) {
      const commands = spatial.tick(dt);
      // Index assignment, not push: a test may patch Array.prototype.
      frames[frames.length] = commands;
      return commands;
    },
    dump() {
      return spatial.dump();
    },
    idFor(name) {
      const object = spatial.Spatial.find(name);
      if (!object) throw new Error(`no object named "${name}"`);
      return spatial.idForObject(object);
    },
  };
}

export function opcodes(commands) {
  return commands.map((command) => command[0]);
}

export function commandsFor(commands, opcode) {
  return commands.filter((command) => command[0] === opcode);
}

export function indexOfCommand(commands, predicate) {
  return commands.findIndex(predicate);
}

export const TRANSFORM_RECORD = 11;

/** Unpacks the frame's single `transforms` command into per-object records. */
export function transformRecords(commands) {
  const command = commands.find((entry) => entry[0] === "transforms");
  if (!command) return [];
  const data = command[2];
  const records = [];
  for (let i = 0; i + TRANSFORM_RECORD <= data.length; i += TRANSFORM_RECORD) {
    records.push({
      id: data[i],
      position: [data[i + 1], data[i + 2], data[i + 3]],
      quaternion: [data[i + 4], data[i + 5], data[i + 6], data[i + 7]],
      scale: [data[i + 8], data[i + 9], data[i + 10]],
    });
  }
  return records;
}

/** The ids that changed pose this frame, in emission order. */
export function transformIds(commands) {
  return transformRecords(commands).map((record) => record.id);
}

/**
 * Values that cross the vm boundary keep the context's own Array/Object
 * prototypes, which strict deep-equality rejects. Round-tripping through JSON
 * gives host-realm plain data for comparison.
 */
export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
