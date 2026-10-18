// The phase 2 entry points and accessors (SPEC 14): media registration, the
// active camera, pointer queries, the consumer sync channels, the activation
// lifecycle and the state a hot reload carries across.
//
// Each takes the runtime explicitly; `Runtime` keeps a thin facade over them,
// the same way the phase 1 phases are split out.

import { Vector3, Matrix4 } from "../util/three-exports.js";
import { push } from "../util/builtins.js";
import { jsonSafe } from "../util/sanitize.js";
import { safeStringify } from "../util/builtins.js";
import { MAX_STATE_BYTES } from "../util/limits.js";
import { isCamera } from "../scene/camera.js";
import { SNAPSHOT } from "./state.js";
import { isDestroyed } from "../scene/object-extensions.js";

const worldMatrix = new Matrix4();
const localPosition = new Vector3();

// -------------------------------------------------------------- phase 2

/**
 * An `Audio` the script never added to the graph still needs to reach the
 * consumer, so playing one adopts it as an extra root (the same treatment a
 * pending `AssetGroup` gets).
 */
export function registerAudio(runtime, audio) {
  // A destroyed sound is never adopted again (P2-B-04).
  if (isDestroyed(audio)) return;
  runtime.audioObjects.add(audio);
  if (audio.parent === null && !runtime.extraRoots.has(audio)) runtime.extraRoots.add(audio);
}

/**
 * `Spatial.camera` (SPEC 14.3). A camera that is not in the scene graph is
 * adopted as an extra root, so it is created and its transform is flushed like
 * any other object; the `camera` command then names its id (SPEC 14.13).
 */
export function setCamera(runtime, value) {
  if (value === null || value === undefined) {
    releaseAdoptedCamera(runtime);
    runtime.camera = null;
    return null;
  }
  if (!isCamera(value)) {
    throw new TypeError("Spatial.camera expects a PerspectiveCamera, an OrthographicCamera or null");
  }
  if (runtime.env.platform === "visionos") {
    runtime.warnOnce(
      "camera-visionos",
      "On visionOS the user is the camera; Spatial.camera is kept and reported but has no effect",
    );
  }
  if (runtime.camera !== value) releaseAdoptedCamera(runtime);
  runtime.camera = value;
  if (value.parent === null && !runtime.extraRoots.has(value)) {
    runtime.extraRoots.add(value);
    runtime.cameraAdopted = value;
  }
  return value;
}

/** Drops a camera the core adopted, so a cleared camera is not kept alive. */
function releaseAdoptedCamera(runtime) {
  const adopted = runtime.cameraAdopted;
  if (adopted === null || adopted === undefined) return;
  runtime.cameraAdopted = null;
  if (adopted.parent === null) runtime.extraRoots.delete(adopted);
}

/**
 * A world-space ray for a view pixel. The consumer owns the viewport, so
 * this is a native query; without the hook (and always on visionOS) it is
 * null rather than a guess (SPEC 14.3).
 */
export function rayFromPoint(runtime, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError("Spatial.rayFromPoint expects two finite numbers");
  }
  if (runtime.env.platform === "visionos") return null;
  const native = globalThis.__spatialNative;
  if (!native || typeof native.rayFromPoint !== "function") {
    runtime.warnOnce(
      "ray-from-point",
      "Spatial.rayFromPoint needs the consumer's rayFromPoint hook; it returned null",
    );
    return null;
  }
  let flat;
  try {
    flat = native.rayFromPoint(x, y);
  } catch (error) {
    runtime.reportOnce(error);
    return null;
  }
  if (!flat || flat.length < 6) return null;
  for (let i = 0; i < 6; i += 1) if (!Number.isFinite(flat[i])) return null;
  return {
    origin: new Vector3(flat[0], flat[1], flat[2]),
    direction: new Vector3(flat[3], flat[4], flat[5]),
  };
}

/**
 * Writes a world-space position onto an object and records it as flushed, so
 * a consumer-driven character move does not echo back as a transform.
 */
export function applyWorldPosition(runtime, object, world) {
  const parent = object.parent;
  if (parent !== null) {
    parent.updateWorldMatrix(true, false);
    worldMatrix.copy(parent.matrixWorld).invert();
    localPosition.copy(world).applyMatrix4(worldMatrix);
  } else {
    localPosition.copy(world);
  }
  if (!Number.isFinite(localPosition.x) || !Number.isFinite(localPosition.y) || !Number.isFinite(localPosition.z)) {
    return;
  }
  object.position.copy(localPosition);
  const snapshot = object[SNAPSHOT];
  if (snapshot === undefined) return;
  const trs = runtime.trs;
  const base = snapshot.slot * 10;
  trs[base] = localPosition.x;
  trs[base + 1] = localPosition.y;
  trs[base + 2] = localPosition.z;
  object.matrixWorldNeedsUpdate = true;
  if (object.matrixAutoUpdate) object.updateMatrix();
  runtime.storeMatrix(snapshot, object);
}





/** Consumer to core: the joint transforms an asset's rig actually has. */
export function syncSkeleton(runtime, id, joints) {
  const object = runtime.idObjects.get(id);
  if (object === undefined || object.skeleton === null || object.skeleton === undefined) return;
  object.skeleton._sync(joints);
}


/**
 * The view appeared or went away (SPEC 14.10). While inactive the frame loop
 * is paused: `tick` returns no commands and time, timers and callbacks all
 * stand still.
 */
export function setActive(runtime, value) {
  const next = value !== false;
  if (next === runtime.active) return;
  runtime.active = next;
  // The collapsed backlog is handed to the frame loop as one batch per channel.
  if (next) runtime.drainInactiveSync();
  const script = runtime.script;
  const hook = next ? "didActivate" : "willDeactivate";
  if (script && typeof script[hook] === "function") {
    try {
      script[hook]();
    } catch (error) {
      runtime.reportError(error);
    }
  }
}


/** The state a reloading script hands to its replacement (SPEC 14.10). */
export function captureState(runtime) {
  const script = runtime.script;
  if (!script || script.state === undefined || script.state === null) return null;
  const report = [];
  let state;
  try {
    state = jsonSafe(script.state, report);
  } catch (error) {
    runtime.reportOnce(error);
    return null;
  }

  // Anything the conversion could not carry is named, so a script does not
  // silently get back a different object after a reload (P2-B-19).
  if (report.length > 0) {
    const named = [];
    for (let i = 0; i < report.length && i < 8; i += 1) {
      push(named, `${report[i].path} (${report[i].reason})`);
    }
    runtime.recordWarning(
      `this.state did not survive JSON unchanged: ${named.join("; ")}` +
        (report.length > 8 ? `, and ${report.length - 8} more` : ""),
    );
  }

  // And it is bounded: a reload must not carry an unbounded payload across.
  let size = 0;
  try {
    size = safeStringify(state).length;
  } catch (error) {
    size = 0;
  }
  if (size > MAX_STATE_BYTES) {
    runtime.recordWarning(
      `this.state is ${size} bytes, past the ${MAX_STATE_BYTES} byte limit; no state was preserved`,
    );
    return null;
  }
  return state;
}
