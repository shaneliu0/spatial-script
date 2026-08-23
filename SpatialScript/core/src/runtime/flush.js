// The flush: one pre-order walk that updates matrices change-driven, diffs
// every object, and fills the packed transforms buffer, then the scene-level
// lanes. The lane order in `BATCH_ORDER` is the SPEC section 5 ordering
// guarantee.

import { vector3Array } from "../sanitize.js";
import { markDestroyed } from "../object-extensions.js";
import { environmentJSONEquals } from "../asset.js";
import { push } from "../builtins.js";
import { SNAPSHOT, TRANSFORM_RECORD, createBatch, BATCH_ORDER } from "./state.js";
import { diffObject } from "./diff-object.js";
import { diffTextures, diffTextureReleases, diffWorlds, diffPortals, diffJoints } from "./resources.js";
import { labelFor } from "../sanitize.js";
import { safeString } from "../builtins.js";

/** One lost frame rather than a dead scene: the batch built so far is returned. */
export function flush(runtime) {
  try {
    return flushInner(runtime);
  } catch (error) {
    runtime.reportError(error);
    return [];
  }
}

export function flushInner(runtime) {
    const frame = (runtime.flushFrame += 1);
    runtime.transformCount = 0;
    const out = createBatch();
    out.log = runtime.logQueue;
    runtime.logQueue = [];
    if (runtime.suppressedLogs > 0) {
      push(out.log, ["log", 0, "warn", `${runtime.suppressedLogs} more log lines were suppressed this frame`]);
      runtime.suppressedLogs = 0;
    }

    // 1a. Explicit Spatial.destroy() calls, already ordered descendants first.
    if (runtime.pendingDestroys.length > 0) {
      for (const command of runtime.pendingDestroys) push(out.destroy, command);
      runtime.pendingDestroys.length = 0;
    }

    updateRootMatrices(runtime);
    walk(runtime, frame, out);

    // 1b. Objects the mount replacement removed.
    if (runtime.pendingDestroyCandidates) {
      const doomed = runtime.pendingDestroyCandidates;
      for (let i = doomed.length - 1; i >= 0; i -= 1) {
        const object = doomed[i];
        const snapshot = object[SNAPSHOT];
        if (snapshot === undefined || snapshot.liveFrame === frame) continue;
        push(out.destroy, ["destroy", snapshot.id]);
        runtime.releaseSnapshot(object, snapshot);
        // Replacing a scene destroys it, so its ids are released and its
        // objects are marked the same way Spatial.destroy marks them.
        const id = runtime.objectIds.get(object);
        if (id !== undefined) {
          runtime.objectIds.delete(object);
          runtime.idObjects.delete(id);
          runtime.releaseId(id);
        }
        runtime.shearedObjects.delete(object);
        runtime.invalidTransforms.delete(object);
        runtime.syncedObjects.delete(object);
        markDestroyed(object);
      }
      runtime.pendingDestroyCandidates = null;
    }

    // 2. Objects that left the graph but were not destroyed. Every tracked
    // object is either live this frame or already detached, so the scan only
    // runs when that accounting does not add up.
    const tracked = runtime.trackedSnapshots;
    if (runtime.liveCount + runtime.detachedCount !== tracked.length) {
      for (let i = 0; i < tracked.length; i += 1) {
        const snapshot = tracked[i];
        if (snapshot.liveFrame === frame || snapshot.parentId === -1) continue;
        snapshot.parentId = -1;
        runtime.detachedCount += 1;
        push(out.hierarchy, ["parent", snapshot.id, -1]);
      }
    }

    // 3. Textures, before any material that references them.
    if (runtime.textures.size > 0) diffTextures(runtime, out.texture);

    // 4. Textures nothing references any more, after this frame's materials.
    diffTextureReleases(runtime, frame, out.release);

    // 5. Portal worlds, marked before the portal that references them.
    if (out.portals.length > 0 || runtime.worldFlagged.size > 0) {
      diffWorlds(runtime, frame, out.portals, out.world);
      diffPortals(runtime, frame, out.portals, out.portal);
    }

    // 6. Joints and scene-level state.
    diffJoints(runtime, out.joint);

    const gravity = vector3Array(runtime.physics.gravity, 0, -9.81, 0);
    if (
      runtime.gravitySnapshot === null ||
      runtime.gravitySnapshot[0] !== gravity[0] ||
      runtime.gravitySnapshot[1] !== gravity[1] ||
      runtime.gravitySnapshot[2] !== gravity[2]
    ) {
      runtime.gravitySnapshot = gravity;
      push(out.global, ["gravity", 0, gravity[0], gravity[1], gravity[2]]);
    }

    const environmentJSON = runtime.environmentPayload();
    if (environmentJSON !== null || runtime.environmentSnapshot !== null) {
      if (!environmentJSONEquals(runtime.environmentSnapshot, environmentJSON)) {
        runtime.environmentSnapshot = environmentJSON;
        push(out.global, ["environment", 0, environmentJSON]);
      }
    }

    // An imperative command queued before a destroy in the same frame would
    // name an id this very batch has torn down (SPEC 5 ordering).
    let imperative = runtime.pendingCommands;
    runtime.pendingCommands = [];
    if (out.destroy.length > 0 && imperative.length > 0) {
      const destroyed = new Set();
      for (let i = 0; i < out.destroy.length; i += 1) destroyed.add(out.destroy[i][1]);
      imperative = imperative.filter((command) => {
        if (!destroyed.has(command[1])) return true;
        runtime.warnOnce(
          `imperative-destroyed:${command[0]}`,
          `A ${command[0]} command was dropped: the object was destroyed in the same frame`,
        );
        return false;
      });
    }
    out.imperative = imperative;

    // One packed command for every transform that changed this frame, placed
    // directly after the frame's create, parent and name commands so a newly
    // created object already exists and is parented when its pose arrives.
    out.transforms =
      runtime.transformCount > 0
        ? [["transforms", 0, runtime.transformBuffer.subarray(0, runtime.transformCount * TRANSFORM_RECORD)]]
        : [];

    // The declared lane order is the SPEC section 5 ordering guarantee.
    let commands = out[BATCH_ORDER[0]];
    for (let i = 1; i < BATCH_ORDER.length; i += 1) commands = commands.concat(out[BATCH_ORDER[i]]);
    return commands;
  }

  /** The mounted scene is not a command-stream object, but its matrices matter. */
export function updateRootMatrices(runtime) {
    const scene = runtime.scene;
    if (scene === null) return;
    const snap = runtime.rootTRS;
    const p = scene.position;
    const q = scene.quaternion;
    const sc = scene.scale;
    const changed =
      snap[0] !== p.x ||
      snap[1] !== p.y ||
      snap[2] !== p.z ||
      snap[3] !== q.x ||
      snap[4] !== q.y ||
      snap[5] !== q.z ||
      snap[6] !== q.w ||
      snap[7] !== sc.x ||
      snap[8] !== sc.y ||
      snap[9] !== sc.z;
    if (changed) {
      snap[0] = p.x;
      snap[1] = p.y;
      snap[2] = p.z;
      snap[3] = q.x;
      snap[4] = q.y;
      snap[5] = q.z;
      snap[6] = q.w;
      snap[7] = sc.x;
      snap[8] = sc.y;
      snap[9] = sc.z;
      if (scene.matrixAutoUpdate) scene.updateMatrix();
    }
    if (changed || scene.matrixWorldNeedsUpdate === true) {
      const parent = scene.parent;
      if (parent === null) scene.matrixWorld.copy(scene.matrix);
      else scene.matrixWorld.multiplyMatrices(parent.matrixWorld, scene.matrix);
      scene.matrixWorldNeedsUpdate = false;
      runtime.rootDirty = true;
    } else {
      runtime.rootDirty = false;
    }
  }

  /**
   * Depth-first pre-order walk of the mounted scene: parents before children,
   * siblings in order. A node's children are copied into a reused stack before
   * any of them is visited, so a mutation during the walk cannot skip a
   * sibling, and nothing is allocated per node.
   */
export function walk(runtime, frame, out) {
    // Deliberately one flat function with plain locals: `top` and the stack
    // were closure variables before, and every scoped access costs several
    // times a local read in the interpreter, once per object per frame.
    runtime.liveCount = 0;
    // Three same-typed arrays rather than one mixed array: a JavaScript array
    // holding objects, integers and booleans together falls back to a slower
    // storage mode, and this is touched six times per object per frame.
    let stack = runtime.walkStack;
    let parents = runtime.walkParents;
    let dirtyFlags = runtime.walkDirty;
    let capacity = parents.length;
    let top = 0;
    let highWater = 0;
    let liveCount = 0;

    const scene = runtime.scene;
    if (scene !== null) {
      const roots = scene.children;
      const rootDirty = runtime.rootDirty ? 1 : 0;
      if (top + roots.length > capacity) {
        capacity = growWalk(runtime, top + roots.length);
        parents = runtime.walkParents;
        dirtyFlags = runtime.walkDirty;
      }
      for (let i = roots.length - 1; i >= 0; i -= 1) {
        stack[top] = roots[i];
        parents[top] = 0;
        dirtyFlags[top] = rootDirty;
        top += 1;
      }
      if (top > highWater) highWater = top;
    }

    // Detached roots (an awaited asset, for example) are drained one at a time
    // after the scene, so one that has meanwhile been added to the scene is
    // not visited twice.
    const extras = runtime.extraRoots.size > 0 ? Array.from(runtime.extraRoots) : null;
    let extraIndex = 0;

    for (;;) {
      while (top > 0) {
        top -= 1;
        const object = stack[top];
        let snapshot;
        try {
          snapshot = diffObject(runtime, object, parents[top], dirtyFlags[top] === 1, frame, out);
        } catch (error) {
          // A frozen object, a hostile getter or a patched prototype must cost
          // one object, not the frame loop (ROBUST-03, ROBUST-04).
          skipObject(runtime, object, error);
          continue;
        }
        if (snapshot === null) continue;
        liveCount += 1;
        const children = object.children;
        const count = children.length;
        if (count === 0) continue;
        const id = snapshot.id;
        const dirty = snapshot.worldDirty ? 1 : 0;
        if (top + count > capacity) {
          capacity = growWalk(runtime, top + count);
          parents = runtime.walkParents;
          dirtyFlags = runtime.walkDirty;
        }
        for (let i = count - 1; i >= 0; i -= 1) {
          stack[top] = children[i];
          parents[top] = id;
          dirtyFlags[top] = dirty;
          top += 1;
        }
        if (top > highWater) highWater = top;
      }

      if (extras === null) break;
      let pushed = false;
      while (extraIndex < extras.length) {
        const root = extras[extraIndex];
        extraIndex += 1;
        const existing = root[SNAPSHOT];
        if (existing !== undefined && existing.liveFrame === frame) continue;
        if (top + 1 > capacity) {
          capacity = growWalk(runtime, top + 1);
          parents = runtime.walkParents;
          dirtyFlags = runtime.walkDirty;
        }
        stack[top] = root;
        parents[top] = -1;
        dirtyFlags[top] = 0;
        top += 1;
        if (top > highWater) highWater = top;
        pushed = true;
        break;
      }
      if (!pushed) break;
    }

    runtime.liveCount = liveCount;
    // Release the references the walk parked in the reusable stack.
    for (let i = 0; i < highWater; i += 1) stack[i] = null;
  }

  /**
   * Records one error naming an object the diff could not process, and skips
   * it for the rest of the session so the report cannot repeat every frame.
   */
export function skipObject(runtime, object, error) {
    if (runtime.brokenObjects.has(object)) return;
    runtime.brokenObjects.add(object);
    runtime.reportOnce({
      name: "SpatialUnsupportedError",
      message:
        `${labelFor(object)} could not be processed and is skipped for the rest of the session: ` +
        `${error && error.message ? safeString(error.message) : safeString(error)}`,
    });
  }

  /** Grows the walk stacks to hold at least `needed` entries. */
export function growWalk(runtime, needed) {
    let size = runtime.walkParents.length;
    while (size < needed) size *= 2;
    const parents = new Int32Array(size);
    parents.set(runtime.walkParents);
    const dirtyFlags = new Uint8Array(size);
    dirtyFlags.set(runtime.walkDirty);
    runtime.walkParents = parents;
    runtime.walkDirty = dirtyFlags;
    return size;
  }

  /**
   * Diffs one object and updates its matrices. Returns its snapshot, or null
   * when the object was already visited this frame (a repeated reference).
   */
