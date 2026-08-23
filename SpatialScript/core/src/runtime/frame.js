// The frame order of SPEC section 2: apply sync, apply input and dispatch
// queued events, run timers, run the script callbacks, then diff and flush.

import { push } from "../builtins.js";
import { Vector3, Quaternion, Matrix4 } from "../three-exports.js";
import { SpatialUnsupportedError } from "../errors.js";
import { dispatchBubbling, worldToLocalMatrix } from "../object-extensions.js";
import { Anchor } from "../anchor.js";
import { AssetGroup } from "../asset.js";
import { trsIsValid, labelFor } from "../sanitize.js";
import { SNAPSHOT } from "./state.js";

const syncMatrix = new Matrix4();
const syncLocal = new Matrix4();
const syncPosition = new Vector3();
const syncQuaternion = new Quaternion();
const syncScale = new Vector3();
const syncScratch = new Float64Array(10);

export function tick(runtime, deltaTime) {
    if (runtime.disposed) return [];
    const dt = Number.isFinite(deltaTime) ? deltaTime : 0;
    runtime.time.delta = dt;
    runtime.time.elapsed += dt;
    runtime.time.frame += 1;

    applySync(runtime);
    applyInputAndEvents(runtime);
    runtime.timers.run(runtime.time.elapsed, (error) => runtime.reportError(error));
    runCallbacks(runtime, dt);

    // Step 5 of the SPEC 2 frame order is folded into the flush walk, which
    // updates matrices change-driven and iteratively. three's recursive
    // updateMatrixWorld is not called here: it would undo the deferred leaf
    // matrices, overwrite a direct `matrix` write, and recurse per level.
    return runtime.flush();
  }

export function applySync(runtime) {
    for (const records of runtime.pendingSync) {
      for (let i = 0; i + 11 <= records.length; i += 11) {
        const object = runtime.idObjects.get(records[i]);
        // An unknown id, an untracked object, or a malformed record is dropped
        // rather than written into the graph (SPEC 2 robustness rule).
        if (object === undefined || object[SNAPSHOT] === undefined) continue;
        syncScratch[0] = records[i + 1];
        syncScratch[1] = records[i + 2];
        syncScratch[2] = records[i + 3];
        syncScratch[3] = records[i + 4];
        syncScratch[4] = records[i + 5];
        syncScratch[5] = records[i + 6];
        syncScratch[6] = records[i + 7];
        syncScratch[7] = records[i + 8];
        syncScratch[8] = records[i + 9];
        syncScratch[9] = records[i + 10];
        if (!trsIsValid(syncScratch)) {
          reportSync(runtime, object, "carried a non-finite value or a zero-length quaternion");
          continue;
        }

        const parent = object.parent;
        if (parent !== null) {
          parent.updateWorldMatrix(true, false);
          // A singular parent (zero scale) inverts to the zero matrix, which
          // would collapse the child's local pose to the origin in silence.
          if (Math.abs(parent.matrixWorld.determinant()) < 1e-12) {
            reportSync(runtime, object, "has a parent with a singular world matrix");
            continue;
          }
        }

        syncPosition.set(syncScratch[0], syncScratch[1], syncScratch[2]);
        syncQuaternion.set(syncScratch[3], syncScratch[4], syncScratch[5], syncScratch[6]);
        syncScale.set(syncScratch[7], syncScratch[8], syncScratch[9]);
        syncMatrix.compose(syncPosition, syncQuaternion, syncScale);
        worldToLocalMatrix(object, syncMatrix, syncLocal);
        syncLocal.decompose(syncPosition, syncQuaternion, syncScale);
        syncScratch[0] = syncPosition.x;
        syncScratch[1] = syncPosition.y;
        syncScratch[2] = syncPosition.z;
        syncScratch[3] = syncQuaternion.x;
        syncScratch[4] = syncQuaternion.y;
        syncScratch[5] = syncQuaternion.z;
        syncScratch[6] = syncQuaternion.w;
        syncScratch[7] = syncScale.x;
        syncScratch[8] = syncScale.y;
        syncScratch[9] = syncScale.z;
        if (!trsIsValid(syncScratch)) {
          reportSync(runtime, object, "converted to a non-finite local transform");
          continue;
        }

        runtime.syncedObjects.delete(object);
        object.position.copy(syncPosition);
        object.quaternion.copy(syncQuaternion);
        object.scale.copy(syncScale);

        const snapshot = object[SNAPSHOT];
        const trs = runtime.trs;
        const base = snapshot.slot * 10;
        for (let k = 0; k < 10; k += 1) trs[base + k] = syncScratch[k];
        snapshot.sheared = false;
        // The pose changed without the diff seeing it, so descendants need
        // their world matrices rebuilt on the next flush.
        object.matrixWorldNeedsUpdate = true;
        if (object.matrixAutoUpdate) object.updateMatrix();
        else object.matrix.copy(syncLocal);
        runtime.storeMatrix(snapshot, object);
      }
    }
    runtime.pendingSync.length = 0;

    for (const records of runtime.pendingBodySync) {
      for (let i = 0; i + 8 <= records.length; i += 8) {
        const object = runtime.idObjects.get(records[i]);
        const body = object ? object.rigidBody : null;
        if (!body || object[SNAPSHOT] === undefined) continue;
        let valid = true;
        for (let k = 1; k < 7; k += 1) {
          if (!Number.isFinite(records[i + k])) valid = false;
        }
        if (!valid) {
          reportSync(runtime, object, "carried a non-finite velocity");
          continue;
        }
        runtime.syncedObjects.delete(object);
        body._linearVelocity.set(records[i + 1], records[i + 2], records[i + 3]);
        body._angularVelocity.set(records[i + 4], records[i + 5], records[i + 6]);
        body._isSleeping = records[i + 7] !== 0;
      }
    }
    runtime.pendingBodySync.length = 0;
  }

  /** One error per object until that object syncs cleanly again. */
export function reportSync(runtime, object, detail) {
    if (runtime.syncedObjects.has(object)) return;
    runtime.syncedObjects.add(object);
    const label = object.name ? `"${object.name}"` : object.type;
    runtime.reportOnce(
      new SpatialUnsupportedError(
        `A sync record for ${label} ${detail}; it was dropped and the last valid transform is kept`,
        "sync-record",
        object,
      ),
    );
  }

export function applyInputAndEvents(runtime) {
    runtime.input.beginFrame(runtime.pendingInput, runtime.injectedKeys);
    runtime.pendingInput = null;
    runtime.injectedKeys.length = 0;

    const queue = runtime.eventQueue;
    runtime.eventQueue = [];
    for (const entry of queue) {
      try {
        deliverEvent(runtime, entry);
      } catch (error) {
        runtime.reportError(error);
      }
    }
  }

export function deliverEvent(runtime, entry) {
    const { type, id } = entry;

    if (type === "textureLoaded" || type === "textureError") {
      const texture = runtime.idTextures.get(id);
      if (!texture) return;
      if (type === "textureLoaded") {
        texture.loaded = true;
        texture.error = null;
        if (texture._onLoad) texture._onLoad(texture);
        if (texture._promise) texture._promise.resolve();
        texture.dispatchEvent({ type: "load", target: texture });
      } else {
        const message = (entry.payload && entry.payload.message) || "texture failed to load";
        texture.error = message;
        const error = new Error(message);
        if (texture._onError) texture._onError(error);
        if (texture._promise) texture._promise.reject(error);
        texture.dispatchEvent({ type: "error", target: texture, message });
      }
      return;
    }

    const object = runtime.idObjects.get(id);
    if (!object) return;
    const payload = hydratePayload(runtime, entry.payload);

    if (type === "anchored" || type === "unanchored") {
      if (object instanceof Anchor) object.isAnchored = type === "anchored";
    }

    if (type === "assetLoaded" && object instanceof AssetGroup) {
      object.loaded = true;
      object.animations = Array.isArray(payload.animations) ? payload.animations.slice() : [];
      if (Array.isArray(entry.payload.boundingBox) && entry.payload.boundingBox.length >= 6) {
        const b = entry.payload.boundingBox;
        object.boundingBox.min.set(b[0], b[1], b[2]);
        object.boundingBox.max.set(b[3], b[4], b[5]);
      }
      if (object._resolve) {
        object._resolve(object);
        object._resolve = null;
        object._reject = null;
      }
    }

    if (type === "assetError" && object instanceof AssetGroup) {
      const error = new Error(payload.message || "asset failed to load");
      if (object._reject) {
        object._reject(error);
        object._resolve = null;
        object._reject = null;
      }
    }

    payload.type = type;
    payload.target = object;
    dispatchBubbling(object, payload);

    // A collision is one event about a pair; both objects must see it.
    if ((type === "collisionstart" || type === "collisionend") && payload.other) {
      const other = payload.other;
      const mirrored = { ...payload, target: other, other: object };
      delete mirrored.currentTarget;
      delete mirrored.stopPropagation;
      dispatchBubbling(other, mirrored);
    }
  }

export function hydratePayload(runtime, raw) {
    const payload = {};
    if (!raw || typeof raw !== "object") return payload;
    for (const key of Object.keys(raw)) {
      const value = raw[key];
      if ((key === "point" || key === "normal" || key === "translation") && Array.isArray(value)) {
        payload[key] = new Vector3(value[0], value[1], value[2]);
      } else if (key === "other" && typeof value === "number") {
        payload[key] = runtime.objectForId(value);
      } else {
        payload[key] = value;
      }
    }
    return payload;
  }

export function runCallbacks(runtime, dt) {
    const script = runtime.script;
    if (script && typeof script.update === "function") {
      try {
        script.update(dt);
      } catch (error) {
        runtime.reportError(error);
      }
    }
    const callbacks = runtime.frameCallbacks.slice();
    for (const callback of callbacks) {
      try {
        callback(dt, runtime.time.elapsed);
      } catch (error) {
        runtime.reportError(error);
      }
    }
  }

  // ------------------------------------------------------------------- flush
  //
  // One pre-order walk does everything: change-driven matrix updates, the
  // per-object diff, and filling the packed transforms buffer. The steady
  // state allocates nothing per object, so the cost of a static object is a
  // handful of property reads and ten float compares.

