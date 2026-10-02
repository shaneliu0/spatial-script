// The SpatialScript runtime: script loading, the frame loop, the flush diff,
// and the consumer-facing entry points from SPEC sections 2, 5, 6 and 7.

import {
  BufferGeometry,
  Light,
  Raycaster,
  AdditiveBlending,
  PerspectiveCamera,
} from "./three-exports.js";
import {
  SpatialLoadError,
  cleanMessage,
  extractLocation,
  probeLineOffset,
} from "./errors.js";
import {
  installObjectExtensions,
  dispatchBubbling,
  hasShear,
  takeRawMatrix,
  markRawMatrix,
  markDestroyed,
  isDestroyed,
  worldToLocalMatrix,
  DIRTY,
  DIRTY_NAME,
  DIRTY_VISIBLE,
  DIRTY_SHADOW,
  DIRTY_FLAGS,
  DIRTY_GEOMETRY,
  DIRTY_LISTENERS,
  DIRTY_RIGIDBODY,
  DIRTY_MATERIAL,
  DIRTY_LIGHT,
} from "./object-extensions.js";
import { constructedScenes, resetConstructedScenes } from "./scene-classes.js";
import {
  materialSnapshot,
  materialSnapshotEquals,
  installMaterialTracking,
  MATERIAL_DIRTY,
  MATERIAL_FRAME,
  MATERIAL_PAYLOAD,
  MATERIAL_RAW,
  UNTRACKED_PROPERTIES,
} from "./materials.js";
import { PhysicsWorld, rigidBodyJSONEquals, jointJSONEquals } from "./physics.js";
import { Anchor, anchorJSONEquals } from "./anchor.js";
import { portalJSONEquals } from "./portal.js";
import { SUBSTITUTED } from "./scene-classes.js";
import { vector3Array, trsIsValid, cappedName, labelFor, jsonSafe } from "./sanitize.js";
import {
  MAX_NAME_LENGTH,
  MAX_LOG_MESSAGE,
  MAX_LOGS_PER_FRAME,
  MAX_RECORDED_WARNINGS,
  MAX_RECORDED_ERRORS,
  MAX_ID,
  MAX_DEFERRED_COMMANDS,
  MAX_INACTIVE_EVENTS,
  MAX_INACTIVE_SYNC_OBJECTS,
} from "./limits.js";
import { push, slice, safeString, safeStringify, cut } from "./builtins.js";
import { InputState } from "./input.js";
import { AudioMixer, Audio } from "./audio.js";
import { VideoScreen } from "./video.js";
import { HostChannel, FetchChannel } from "./host-channel.js";
import { createCameraScratch, installCameraTracking, isCamera } from "./camera.js";
import { installCharacterController } from "./character.js";
import { TimerQueue } from "./timers.js";
import {
  createSnapshot,
  installGeometryTracking,
  GEOMETRY_REVISION,
  lightSnapshot,
  lightSnapshotEquals,
  textureSnapshot,
  textureSnapshotEquals,
  geometryPayload,
} from "./diff.js";
import { buildDump } from "./dump.js";
import { kindFor } from "./kinds.js";
import { SNAPSHOT, TRANSFORM_RECORD, createBatch, BATCH_ORDER } from "./runtime/state.js";
import { shallowJSONEquals, copyLightSnapshot } from "./runtime/payloads.js";
import { diffObject } from "./runtime/diff-object.js";
import { load, mount, destroy, DEFAULT_CAPABILITIES } from "./runtime/loading.js";
import { tick } from "./runtime/frame.js";
import { materialPayload } from "./runtime/material-cache.js";
import { log, warnOnce, recordWarning, reportOnce, reportError } from "./runtime/channel.js";
import {
  referenceIdFor,
  allocateId,
  releaseId,
  idForObject,
  canCommand,
  objectForId,
  textureIdFor,
  registerTexture,
  disposeTexture,
  jointIdFor,
  diffTextures,
  diffTextureReleases,
  diffWorlds,
  diffPortals,
  diffJoints,
} from "./runtime/resources.js";
import { flush, walk, skipObject } from "./runtime/flush.js";
import { resolveUrl, environmentPayload, raycast, loadAsset } from "./runtime/queries.js";
import { acceptSync, drainInactiveSync } from "./runtime/inactive.js";
import {
  registerAudio,
  setCamera,
  rayFromPoint,
  applyWorldPosition,
  syncSkeleton,
  setActive,
  captureState,
} from "./runtime/phase2.js";

// `Spatial` and `console` are installed as globals rather than passed as
// parameters: a script is free to write `const Spatial = require("spatial")`
// and a parameter of the same name would be a redeclaration error.
const SCRIPT_PARAMETERS = ["require", "module", "exports"];

// The script body is evaluated as an async function so top-level await works
// (SPEC section 2). AsyncFunction is not a global, so it is reached through the
// prototype of an async function expression.
const AsyncFunction = Object.getPrototypeOf(async function asyncProbe() {}).constructor;





export class Runtime {
  constructor() {
    installObjectExtensions(Light);
    installMaterialTracking();
    installGeometryTracking(BufferGeometry);
    installCameraTracking(PerspectiveCamera);
    installCharacterController();
    this.version = "0.1.0";
    this.reset();
  }

  reset() {
    this.scene = null;
    this.script = {};
    this.assetRoot = "";
    this.env = {
      backend: "three",
      platform: "web",
      capabilities: { ...DEFAULT_CAPABILITIES.three.web },
    };

    this.nextId = 1;
    this.objectIds = new Map();
    this.idObjects = new Map();
    this.textureIds = new Map();
    this.idTextures = new Map();
    this.textures = new Set();
    this.textureSnapshots = new Map();
    this.pendingTextureRelease = new Set();
    // geometry uuid -> revision already delivered with its buffers.
    this.sentGeometry = new Map();
    // geometry uuid -> number of live objects that received that delivery. A
    // uuid whose last user is destroyed drops out of `sentGeometry`, so the
    // next mesh built on the same geometry carries its buffers again: a
    // consumer that freed the resource on last use must be able to rebuild.
    this.geometryUsers = new Map();
    this.jointIds = new Map();
    this.jointSnapshots = new Map();
    this.snapshots = new Map();
    // Same snapshots in a plain array so the per-frame scan for objects that
    // left the graph is an indexed loop rather than a Map iterator, which
    // allocates a key/value pair per entry.
    this.trackedSnapshots = [];
    this.detachedCount = 0;
    this.liveCount = 0;
    this.extraRoots = new Set();
    this.pendingDestroyCandidates = null;
    this.pendingDestroys = [];
    // Objects whose matrix currently contains shear, and objects whose local
    // TRS is currently non-finite. Both are reported once per object and only
    // reported again after the value has become valid in between.
    this.shearedObjects = new Set();
    this.invalidTransforms = new Set();
    // Objects whose last sync record was rejected, so it is reported once.
    this.syncedObjects = new Set();
    // Objects the diff threw on: reported once, then skipped.
    this.brokenObjects = new Set();
    this.loadPromise = Promise.resolve();

    this.frameCallbacks = [];
    this.pendingSync = [];
    this.pendingBodySync = [];
    this.pendingInput = null;
    this.injectedKeys = [];
    this.eventQueue = [];

    this.pendingCommands = [];
    // Imperative commands waiting for their object's first flush.
    this.deferredCommands = [];
    this.logQueue = [];
    this.suppressedLogs = 0;
    this.warnings = [];
    this.warned = new Set();
    this.errors = [];
    this.droppedErrors = 0;
    this.errorTimes = new Map();

    this.physics = new PhysicsWorld();
    this.gravitySnapshot = null;
    this.environment = null;
    this.environmentSnapshot = null;

    // ---- phase 2 (SPEC 14) -------------------------------------------------
    this.audio = new AudioMixer();
    // The mixer's defaults are the consumer's defaults, so nothing is emitted
    // until a script actually changes one.
    this.audioRevision = 0;
    this.camera = null;
    this.cameraScratch = createCameraScratch();
    this.cameraSnapshot = null;
    this.cameraId = 0;
    // Set when the core adopted the camera as an extra root, so clearing it
    // does not leave a phantom root behind.
    this.cameraAdopted = null;
    this.sceneUnderstanding = { collision: false, occlusion: false, physics: false, shadows: false };
    this.sceneUnderstandingSnapshot = null;
    this.render = { adaptiveResolution: false };
    this.environmentLighting = { intensityExponent: 1 };
    this.debug = { modelView: null };
    this.renderOptionsSnapshot = null;
    // The host channel outlives a script reload: the functions the app
    // registered are the app's, not the script's (SPEC 14.10).
    if (this.hostChannel === undefined) {
      this.hostChannel = new HostChannel(this);
      this.fetchChannel = new FetchChannel(this);
    } else {
      this.hostChannel.reset();
      this.fetchChannel.reset();
    }
    this.active = true;
    this.previousState = undefined;
    this.pendingAudioSync = [];
    this.pendingVideoSync = [];
    this.pendingCharacterSync = [];
    // channel -> the latest record per object, while inactive.
    this.inactiveSync = new Map();
    this.audioObjects = new Set();

    this.input = new InputState();
    this.timers = new TimerQueue((key, message) => this.warnOnce(key, message));
    this.time = { delta: 0, elapsed: 0, frame: 0 };
    this.raycaster = new Raycaster();
    // Reused by the light diff so an unchanged light allocates nothing.
    this.lightScratch = {};
    // Reused between flushes so the scene walk allocates nothing per object.
    this.walkStack = [];
    this.walkParents = new Int32Array(256);
    this.walkDirty = new Uint8Array(256);
    // Packed [id, p, q, s] records for the frame's `transforms` command. The
    // buffer only grows, so the steady state allocates nothing but the
    // subarray view handed to the consumer.
    this.transformBuffer = new Float32Array(TRANSFORM_RECORD * 64);
    this.transformCount = 0;
    this.flushFrame = 0;
    this.framePortals = [];
    this.worldFlagged = new Set();
    this.worldScratch = new Set();
    // Last flushed local TRS for every tracked object, ten doubles per slot in
    // one contiguous array. Doubles, not floats, so an unchanged object
    // compares exactly equal to what the script holds.
    this.trs = new Float64Array(10 * 256);
    this.slotCount = 0;
    this.freeSlots = [];
    this.rootTRS = new Float64Array(10).fill(NaN);
    this.rootDirty = true;
    // Last flushed local matrix per slot, so a direct `matrix` write is picked
    // up even with matrixAutoUpdate left on (SPEC 3.2).
    this.mtx = new Float64Array(16 * 256);
    this.freeIds = [];
    this.droppedErrors = 0;
    // Bound once so the hot path never allocates a closure.
    this.boundTextureIdFor = (texture) => this.textureIdFor(texture);
    this.boundReferenceIdFor = (object) => this.referenceIdFor(object);
    this.boundWarnOnce = (key, message) => this.warnOnce(key, message);
    this.boundResolveUrl = (url) => this.resolveUrl(url);
    this.disposed = false;
    this.loaded = false;
    this.loadGeneration = 0;
    // Set by load(); used to turn an engine error location into a script line.
    this.lineOffset = 0;
    this.scriptLineCount = 0;
    resetConstructedScenes();
  }

  // ---------------------------------------------------------------- identity

  /**
   * Id for a referenced object, or null when it has been freed by destroy().
   * Used for the cross-object references in portal and joint payloads so a
   * released id is never resurrected.
   */
  referenceIdFor(object) {
    return referenceIdFor(this, object);
  }

  allocateId() {
    return allocateId(this);
  }

  releaseId(id) {
    releaseId(this, id);
  }

  idForObject(object) {
    return idForObject(this, object);
  }

  canCommand(object, feature) {
    return canCommand(this, object, feature);
  }

  objectForId(id) {
    return objectForId(this, id);
  }

  textureIdFor(texture) {
    return textureIdFor(this, texture);
  }

  registerTexture(texture) {
    registerTexture(this, texture);
  }

  disposeTexture(texture) {
    disposeTexture(this, texture);
  }

  jointIdFor(joint) {
    return jointIdFor(this, joint);
  }

  /**
   * An imperative command for `object`. One issued before the object's first
   * flush waits for the frame after its `create`, in order, rather than being
   * dropped: a script that acts on an object it just built is normal, and the
   * consumer must not be told about an id it has never seen (SPEC 5).
   */
  queueCommand(command, object) {
    if (object !== undefined && object !== null && object[SNAPSHOT] === undefined) {
      if (this.deferredCommands.length >= MAX_DEFERRED_COMMANDS) {
        this.warnOnce(
          "deferred-commands",
          `More than ${MAX_DEFERRED_COMMANDS} commands are waiting for an object's first flush; ` +
            `the ${command[0]} command was dropped`,
        );
        return;
      }
      push(this.deferredCommands, { object, command });
      return;
    }
    push(this.pendingCommands, command);
  }

  now() {
    const native = globalThis.__spatialNative;
    if (native && typeof native.now === "function") return native.now();
    return Date.now();
  }

  load(source, options) {
    return load(this, source, options);
  }

  mount(scene) {
    return mount(this, scene);
  }

  destroy(object) {
    return destroy(this, object);
  }

  tick(deltaTime) {
    return tick(this, deltaTime);
  }

  materialPayload(material, frame) {
    return materialPayload(this, material, frame);
  }

  log(level, args) {
    return log(this, level, args);
  }

  warnOnce(key, message) {
    warnOnce(this, key, message);
  }

  recordWarning(message) {
    recordWarning(this, message);
  }

  reportOnce(error) {
    reportOnce(this, error);
  }

  reportError(error) {
    reportError(this, error);
  }

  onFrame(callback) {
    if (typeof callback !== "function") throw new TypeError("Spatial.onFrame expects a function");
    if (!this.frameCallbacks.includes(callback)) push(this.frameCallbacks, callback);
    return callback;
  }

  offFrame(callback) {
    const index = this.frameCallbacks.indexOf(callback);
    if (index !== -1) this.frameCallbacks.splice(index, 1);
  }

  // ------------------------------------------------------------- consumer in

  sync(records) {
    this.acceptSync("sync", this.pendingSync, records, 11);
  }

  syncBodies(records) {
    this.acceptSync("syncBodies", this.pendingBodySync, records, 8);
  }

  acceptSync(channel, pending, records, stride) {
    acceptSync(this, channel, pending, records, stride);
  }

  drainInactiveSync() {
    drainInactiveSync(this);
  }

  setInput(state) {
    this.pendingInput = state;
  }

  dispatch(type, id, payload) {
    // Nothing drains the queue while the scene is inactive, so the backlog is
    // capped and the overflow is reported rather than delivered in one frame
    // once the view comes back (SPEC 14.10, P2-B-05).
    if (this.active === false && this.eventQueue.length >= MAX_INACTIVE_EVENTS) {
      this.warnOnce(
        "inactive-events",
        `More than ${MAX_INACTIVE_EVENTS} events arrived while the scene was inactive; ` +
          "the rest were dropped",
      );
      return;
    }
    push(this.eventQueue, { type, id, payload: payload === undefined ? {} : payload });
  }

  // ---------------------------------------------------------------- the tick

  flush() {
    return flush(this);
  }

  walk(frame, out) {
    return walk(this, frame, out);
  }

  skipObject(object, error) {
    skipObject(this, object, error);
  }

  matrixWasWritten(snapshot, object) {
    const store = this.mtx;
    const base = snapshot.slot * 16;
    const elements = object.matrix.elements;
    for (let i = 0; i < 16; i += 1) {
      if (store[base + i] !== elements[i]) return true;
    }
    return false;
  }

  storeMatrix(snapshot, object) {
    const store = this.mtx;
    const base = snapshot.slot * 16;
    const elements = object.matrix.elements;
    for (let i = 0; i < 16; i += 1) store[base + i] = elements[i];
  }

  /** The name the command stream carries: capped, warned once per object. */
  wireName(object) {
    const name = object.name;
    if (typeof name !== "string" || name.length === 0) return "";
    if (name.length <= MAX_NAME_LENGTH) return name;
    this.warnOnce(
      `name-length:${object.uuid}`,
      `A name of ${name.length} characters was truncated to ${MAX_NAME_LENGTH}`,
    );
    return cappedName(name);
  }

  createSnapshotFor(object) {
    const id = this.idForObject(object);
    const snapshot = createSnapshot(id, this.allocateSlot(), kindFor(object), object.isLight === true);
    // `create` already carries the name, so record it as flushed.
    snapshot.name = object.name;
    object[SNAPSHOT] = snapshot;
    this.snapshots.set(object, snapshot);
    snapshot.index = this.trackedSnapshots.length;
    push(this.trackedSnapshots, snapshot);
    return snapshot;
  }

  allocateSlot() {
    let slot;
    if (this.freeSlots.length > 0) {
      slot = this.freeSlots.pop();
    } else {
      slot = this.slotCount;
      this.slotCount += 1;
      const needed = (slot + 1) * 10;
      if (needed > this.trs.length) {
        const grown = new Float64Array(Math.max(this.trs.length * 2, needed));
        grown.set(this.trs);
        this.trs = grown;
      }
      const matrixNeeded = (slot + 1) * 16;
      if (matrixNeeded > this.mtx.length) {
        const grownMatrix = new Float64Array(Math.max(this.mtx.length * 2, matrixNeeded));
        grownMatrix.set(this.mtx);
        this.mtx = grownMatrix;
      }
    }
    // NaN never equals anything, so a fresh slot always reads as changed.
    const base = slot * 10;
    for (let i = 0; i < 10; i += 1) this.trs[base + i] = NaN;
    const matrixBase = slot * 16;
    for (let i = 0; i < 16; i += 1) this.mtx[matrixBase + i] = NaN;
    return slot;
  }

  /**
   * Records that this object is one of the live users of `uuid`. Moving to a
   * different geometry releases the previous one first.
   */
  noteGeometryUse(snapshot, uuid) {
    const previous = snapshot.geometryUuid;
    if (previous === uuid) return;
    if (previous !== null) this.dropGeometryUser(previous);
    snapshot.geometryUuid = uuid;
    const users = this.geometryUsers.get(uuid);
    this.geometryUsers.set(uuid, users === undefined ? 1 : users + 1);
  }

  /** Drops one user of `uuid`, forgetting the delivery when the last one goes. */
  dropGeometryUser(uuid) {
    const users = this.geometryUsers.get(uuid);
    if (users === undefined) return;
    if (users > 1) {
      this.geometryUsers.set(uuid, users - 1);
      return;
    }
    this.geometryUsers.delete(uuid);
    this.sentGeometry.delete(uuid);
  }

  releaseSnapshot(object, snapshot) {
    if (snapshot.geometryUuid !== null) {
      this.dropGeometryUser(snapshot.geometryUuid);
      snapshot.geometryUuid = null;
    }
    this.snapshots.delete(object);
    object[SNAPSHOT] = undefined;
    push(this.freeSlots, snapshot.slot);
    if (snapshot.parentId === -1) this.detachedCount -= 1;
    // Swap-remove keeps the tracked array compact without shifting.
    const tracked = this.trackedSnapshots;
    const last = tracked.pop();
    if (last !== snapshot) {
      tracked[snapshot.index] = last;
      last.index = snapshot.index;
    }
  }

  /**
   * The material payload for this frame. The raw property values are compared
   * once per material per frame, not once per mesh, and the payload object
   * keeps its identity while the material is unchanged so the per-mesh check
   * is a single reference compare.
   */
  warnMaterial(material) {
    if (this.env.backend !== "realitykit") return;
    if (material.wireframe === true) {
      this.warnOnce(
        `wireframe-${material.type}`,
        `${material.type}.wireframe is unsupported in RealityKit`,
      );
    }
    if (material.blending === AdditiveBlending) {
      this.warnOnce(
        "additive-blending",
        "AdditiveBlending is unsupported in RealityKit; the material renders as transparent",
      );
    }
  }

  resolveUrl(url) {
    return resolveUrl(this, url);
  }

  environmentPayload() {
    return environmentPayload(this);
  }

  raycast(origin, direction, options) {
    return raycast(this, origin, direction, options);
  }

  loadAsset(urls) {
    return loadAsset(this, urls);
  }

  // -------------------------------------------------------------- phase 2

  registerAudio(audio) {
    registerAudio(this, audio);
  }

  setCamera(value) {
    return setCamera(this, value);
  }

  rayFromPoint(x, y) {
    return rayFromPoint(this, x, y);
  }

  applyWorldPosition(object, world) {
    applyWorldPosition(this, object, world);
  }

  fetchText(url) {
    return this.fetchChannel.request(url, "text");
  }

  fetchJSON(url) {
    return this.fetchChannel.request(url, "json");
  }

  syncAudio(records) {
    this.acceptSync("syncAudio", this.pendingAudioSync, records, 4);
  }

  syncVideo(records) {
    this.acceptSync("syncVideo", this.pendingVideoSync, records, 4);
  }

  syncCharacter(records) {
    this.acceptSync("syncCharacter", this.pendingCharacterSync, records, 8);
  }

  syncSkeleton(id, joints) {
    syncSkeleton(this, id, joints);
  }

  setActive(value) {
    setActive(this, value);
  }

  hostEvent(name, payload) {
    this.hostChannel.deliver(name, payload);
  }

  captureState() {
    return captureState(this);
  }

  dump(options) {
    return buildDump(this, options);
  }

  dispose() {
    if (this.disposed) return [];
    this.hostChannel.clearPending("the scene was disposed");
    this.fetchChannel.clearPending("the scene was disposed");
    const script = this.script;
    if (script && typeof script.willRemove === "function") {
      try {
        script.willRemove();
      } catch (error) {
        this.reportError(error);
      }
    }

    const commands = this.logQueue;
    this.logQueue = [];

    // Scene-level state the consumer would otherwise keep into the next
    // script: only what this script actually set is reset.
    if (this.cameraSnapshot !== null) push(commands, ["camera", 0, { kind: null, fov: null, near: null, far: null, left: null, right: null, top: null, bottom: null }]);
    if (this.audioRevision !== 0) push(commands, ["audioMixer", 0, { masterVolume: 1, groups: {}, state: "suspended" }]);
    if (this.sceneUnderstandingSnapshot !== null) {
      push(commands, ["sceneUnderstanding", 0, { collision: false, occlusion: false, physics: false, shadows: false }]);
    }
    if (this.renderOptionsSnapshot !== null) {
      push(commands, ["renderOptions", 0, { adaptiveResolution: false, environmentIntensityExponent: 1, debugModelView: null }]);
    }

    // Joints first: a consumer must drop them before the entities they pin.
    for (const joint of this.jointSnapshots.keys()) {
      push(commands, ["joint", this.jointIdFor(joint), null]);
    }

    // Descendants before their ancestors, then anything tracked but detached.
    const ordered = [];
    if (this.scene !== null) {
      const stack = [];
      const children = this.scene.children;
      for (let i = 0; i < children.length; i += 1) push(stack, children[i]);
      const post = [];
      while (stack.length > 0) {
        const object = stack.pop();
        push(post, object);
        const kids = object.children;
        for (let i = 0; i < kids.length; i += 1) push(stack, kids[i]);
      }
      // `post` is parents-before-children; reversing gives descendants first.
      for (let i = post.length - 1; i >= 0; i -= 1) {
        const snapshot = post[i][SNAPSHOT];
        if (snapshot !== undefined) {
          push(ordered, post[i]);
          snapshot.disposed = true;
        }
      }
    }
    for (const object of ordered) push(commands, ["destroy", object[SNAPSHOT].id]);
    for (const [object, snapshot] of this.snapshots) {
      if (snapshot.disposed !== true) {
        push(commands, ["destroy", snapshot.id]);
        push(ordered, object);
      }
    }

    if (this.environmentSnapshot !== null) push(commands, ["environment", 0, null]);

    // Every object is destroyed: marked so a later add throws, and detached
    // from the snapshot that reset() is about to drop.
    for (const object of ordered) {
      object[SNAPSHOT] = undefined;
      markDestroyed(object);
    }

    // One teardown, not two: reset() owns the field list, so a field added
    // there can never be forgotten here (MAINT-10).
    const generation = this.loadGeneration;
    this.reset();
    this.loadGeneration = generation;
    this.disposed = true;
    return commands;
  }

}





