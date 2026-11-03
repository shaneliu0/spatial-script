// Diff state that lives on the objects themselves rather than in a Map: a
// symbol read is measurably cheaper than a Map lookup once per object per
// frame in an interpreter.

export const SNAPSHOT = Symbol("spatial.snapshot");

// [id, px, py, pz, qx, qy, qz, qw, sx, sy, sz]
export const TRANSFORM_RECORD = 11;

/**
 * The frame's command lanes, by name. The concatenation order in `flush` is
 * the SPEC section 5 ordering guarantee; adding an opcode means adding a lane
 * here and a line there, not threading another positional parameter through
 * two hot-path signatures.
 */
export function createBatch() {
  return {
    log: [],
    destroy: [],
    create: [],
    hierarchy: [],
    texture: [],
    object: [],
    release: [],
    world: [],
    body: [],
    joint: [],
    portal: [],
    global: [],
    // Not a lane: the portals seen this frame, resolved after the walk.
    portals: [],
  };
}

/**
 * The lanes, in the order the command stream must carry them. `transforms` and
 * `imperative` are produced by the flush itself rather than by the walk.
 */
export const BATCH_ORDER = [
  "log",
  "destroy",
  "create",
  "hierarchy",
  "transforms",
  "texture",
  "object",
  "release",
  "world",
  "body",
  "joint",
  "portal",
  "global",
  "imperative",
];
