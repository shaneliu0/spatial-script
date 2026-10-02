// The frame order of SPEC section 2: apply sync, apply input and dispatch
// queued events, run timers, run the script callbacks, then diff and flush.

import { push } from "../builtins.js";
import { Vector3, Quaternion, Matrix4 } from "../three-exports.js";
import { SpatialUnsupportedError } from "../errors.js";
import { dispatchBubbling, worldToLocalMatrix, isDestroyed, DIRTY, DIRTY_FEATURE } from "../object-extensions.js";
import { isAttached } from "./resources.js";
import { Controller } from "../input.js";
import { MAX_DEFERRED_FRAMES } from "../limits.js";
import { Skeleton, BlendShapes } from "../skeleton.js";
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
    // Inactive: the view is gone, so nothing advances (SPEC 14.10).
    if (runtime.active === false) return [];
    const dt = Number.isFinite(deltaTime) ? deltaTime : 0;
    runtime.time.delta = dt;
    runtime.time.elapsed += dt;
    runtime.time.frame += 1;

    promoteDeferredCommands(runtime);
    applySync(runtime);
    applyMediaSync(runtime);
    applyInputAndEvents(runtime);
    runtime.timers.run(runtime.time.elapsed, (error) => runtime.reportError(error));
    runCallbacks(runtime, dt);

    // Step 5 of the SPEC 2 frame order is folded into the flush walk, which
    // updates matrices change-driven and iteratively. three's recursive
    // updateMatrixWorld is not called here: it would undo the deferred leaf
    // matrices, overwrite a direct `matrix` write, and recurse per level.
    return runtime.flush();
  }

/**
 * Imperative commands issued before their object had ever been flushed go out
 * now, in the order they were made: the object's `create` reached the consumer
 * in an earlier frame, so naming its id is safe. One whose object left the
 * graph or was destroyed in between is dropped with the same warning it would
 * have had at the call (SPEC 5 ordering).
 */
export function promoteDeferredCommands(runtime) {
    const deferred = runtime.deferredCommands;
    if (deferred.length === 0) return;
    const frame = runtime.time.frame;
    const kept = [];
    for (let i = 0; i < deferred.length; i += 1) {
      const entry = deferred[i];
      const object = entry.object;
      const snapshot = object[SNAPSHOT];
      if (isDestroyed(object) || (snapshot === undefined && !isAttached(runtime, object))) {
        runtime.warnOnce(
          `uncreated:${entry.command[0]}`,
          `A ${entry.command[0]} command was dropped: the object is not in the mounted scene`,
        );
        continue;
      }
      // Still waiting for its first flush. An object that is never actually
      // walked (its Scene was never mounted) gets a couple of frames of grace
      // and is then dropped with the same warning.
      if (snapshot === undefined || snapshot.liveFrame >= frame) {
        entry.waited = (entry.waited | 0) + 1;
        if (entry.waited > MAX_DEFERRED_FRAMES) {
          runtime.warnOnce(
            `uncreated:${entry.command[0]}`,
            `A ${entry.command[0]} command was dropped: the object is not in the mounted scene`,
          );
          continue;
        }
        push(kept, entry);
        continue;
      }
      push(runtime.pendingCommands, entry.command);
    }
    runtime.deferredCommands = kept;
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

/**
 * Playback and character state the consumer owns (SPEC 14.13): audio, video
 * and character controllers. Each record names an object the core tracks; an
 * unknown id or a malformed record is dropped like any other sync.
 */
export function applyMediaSync(runtime) {
    for (const records of runtime.pendingAudioSync) {
      for (let i = 0; i + 4 <= records.length; i += 4) {
        const object = runtime.idObjects.get(records[i]);
        if (object === undefined || object.isAudio !== true) continue;
        const currentTime = records[i + 2];
        const duration = records[i + 3];
        if (!Number.isFinite(currentTime) || !Number.isFinite(duration)) {
          reportSync(runtime, object, "carried a non-finite playback time");
          continue;
        }
        object._sync(records[i + 1] !== 0, currentTime, duration);
      }
    }
    runtime.pendingAudioSync.length = 0;

    for (const records of runtime.pendingVideoSync) {
      for (let i = 0; i + 4 <= records.length; i += 4) {
        const object = runtime.idObjects.get(records[i]);
        if (object === undefined || object.isVideoScreen !== true) continue;
        const currentTime = records[i + 2];
        const duration = records[i + 3];
        if (!Number.isFinite(currentTime) || !Number.isFinite(duration)) {
          reportSync(runtime, object, "carried a non-finite playback time");
          continue;
        }
        object._sync(records[i + 1] !== 0, currentTime, duration);
      }
    }
    runtime.pendingVideoSync.length = 0;

    for (const records of runtime.pendingCharacterSync) {
      for (let i = 0; i + 8 <= records.length; i += 8) {
        const object = runtime.idObjects.get(records[i]);
        const controller = object === undefined ? null : object.characterController;
        if (!controller || object[SNAPSHOT] === undefined) continue;
        let valid = true;
        for (let k = 1; k <= 3; k += 1) if (!Number.isFinite(records[i + k])) valid = false;
        for (let k = 5; k <= 7; k += 1) if (!Number.isFinite(records[i + k])) valid = false;
        if (!valid) {
          reportSync(runtime, object, "carried a non-finite character state");
          continue;
        }
        controller._sync(records[i + 4] !== 0, records[i + 5], records[i + 6], records[i + 7]);
        // The position is world space, like `sync`, and lands on the object.
        syncPosition.set(records[i + 1], records[i + 2], records[i + 3]);
        runtime.applyWorldPosition(object, syncPosition);
      }
    }
    runtime.pendingCharacterSync.length = 0;
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
    runtime.input.beginFrame(runtime.pendingInput, runtime.injectedKeys, runtime.time.elapsed);
    runtime.pendingInput = null;
    runtime.injectedKeys.length = 0;

    // Controllers coming and going are scene events (SPEC 14.8).
    const connections = runtime.input.connectionEvents;
    if (connections.length > 0) {
      for (let i = 0; i < connections.length; i += 1) {
        const entry = connections[i];
        if (runtime.scene === null) continue;
        try {
          dispatchBubbling(runtime.scene, {
            type: entry.type,
            target: runtime.scene,
            controller: entry.controller,
          });
        } catch (error) {
          runtime.reportError(error);
        }
      }
      connections.length = 0;
    }

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

    // Answers to script-initiated requests: the id is a call or request id in
    // its own number space, not an object id (SPEC 14.13).
    if (type === "hostResult") {
      runtime.hostChannel.settle(id, entry.payload);
      return;
    }
    if (type === "fetchResult") {
      runtime.fetchChannel.settle(id, entry.payload);
      return;
    }
    // The consumer reports whether the audio engine is actually running; on
    // the web that only becomes true after a user gesture (SPEC 14.1).
    if (type === "audioState") {
      const state = entry.payload ? entry.payload.state : undefined;
      if (state === "running" || state === "suspended") runtime.audio._state = state;
      return;
    }

    // Controller connection events are about the scene, not an object.
    const object = id === 0 ? runtime.scene : runtime.idObjects.get(id);
    if (!object) return;
    const payload = hydratePayload(runtime, entry.payload);

    // A consumer that reports connections through `dispatch` rather than
    // through setInput still owes the listener a controller (P2-C-12).
    if (type === "controllerconnected" || type === "controllerdisconnected") {
      const controllers = runtime.input.controllers;
      const controllerId =
        typeof payload.id === "string" && payload.id.length > 0 ? payload.id : "controller-0";
      let controller = controllers.get(controllerId);
      if (type === "controllerconnected") {
        if (controller === null) {
          controller = new Controller(controllerId);
          if (typeof payload.name === "string") controller.name = payload.name;
          controllers._byId.set(controllerId, controller);
          const all = [];
          for (const entryController of controllers._byId.values()) push(all, entryController);
          controllers.all = all;
        }
      } else if (controller !== null) {
        controllers._byId.delete(controllerId);
        const all = [];
        for (const entryController of controllers._byId.values()) push(all, entryController);
        controllers.all = all;
        if (controllers.current === controller) controllers.current = null;
      }
      if (controller !== null) payload.controller = controller;
    }

    if (type === "ended" && object.isAudio === true) {
      object._playing = false;
      if (typeof object.onEnded === "function") {
        try {
          object.onEnded();
        } catch (error) {
          runtime.reportError(error);
        }
      }
    }

    if (object.isVideoScreen === true) {
      if (type === "loaded") {
        const width = entry.payload ? entry.payload.width : undefined;
        const height = entry.payload ? entry.payload.height : undefined;
        if (Number.isFinite(width) && Number.isFinite(height) && height !== 0) {
          object._applyAspect(width / height);
        }
        if (Number.isFinite(entry.payload && entry.payload.duration)) {
          object._duration = entry.payload.duration;
        }
      } else if (type === "ended") {
        object._playing = false;
      } else if (type === "error") {
        object.error = (entry.payload && entry.payload.message) || "the video failed to load";
      }
    }

    if (type === "anchored" || type === "unanchored") {
      if (object instanceof Anchor) object.isAnchored = type === "anchored";
    }

    if (type === "assetLoaded" && object instanceof AssetGroup) {
      object.loaded = true;
      object.animations = Array.isArray(payload.animations) ? payload.animations.slice() : [];
      // The rig the asset actually has (SPEC 14.5). Absent or empty means the
      // asset has none, and `asset.skeleton` stays null.
      const joints = entry.payload ? entry.payload.joints : undefined;
      if (Array.isArray(joints) && joints.length > 0) {
        object.skeleton = new Skeleton(object, joints);
        object[DIRTY] = (object[DIRTY] | 0) | DIRTY_FEATURE;
      }
      const shapes = entry.payload ? entry.payload.blendShapes : undefined;
      if (Array.isArray(shapes) && shapes.length > 0) {
        object.blendShapes = new BlendShapes(object, shapes);
        object[DIRTY] = (object[DIRTY] | 0) | DIRTY_FEATURE;
      }
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

