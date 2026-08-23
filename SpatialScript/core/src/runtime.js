// The SpatialScript runtime: script loading, the frame loop, the flush diff,
// and the consumer-facing entry points from SPEC sections 2, 5, 6 and 7.

import {
  BufferGeometry,
  Light,
  Vector3,
  Quaternion,
  Matrix4,
  Raycaster,
  AdditiveBlending,
} from "./three-exports.js";
import {
  SpatialLoadError,
  SpatialUnsupportedError,
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
  refreshWorldMatrices,
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
import { AssetGroup, environmentJSONEquals } from "./asset.js";

/** The asset url keys SPEC 3.12 defines, in the order loadAsset reports them. */
const ASSET_KEYS = ["usdz", "reality", "glb", "gltf"];
import { SUBSTITUTED } from "./scene-classes.js";
import { vector3Array, trsIsValid, cappedName, labelFor } from "./sanitize.js";
import {
  MAX_NAME_LENGTH,
  MAX_LOG_MESSAGE,
  MAX_LOGS_PER_FRAME,
  MAX_RECORDED_WARNINGS,
  MAX_RECORDED_ERRORS,
  MAX_ID,
} from "./limits.js";
import { push, slice, safeString, safeStringify, cut } from "./builtins.js";
import { resolveUrl as containUrl } from "./urls.js";
import { InputState } from "./input.js";
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
  worldNormal,
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

// `Spatial` and `console` are installed as globals rather than passed as
// parameters: a script is free to write `const Spatial = require("spatial")`
// and a parameter of the same name would be a redeclaration error.
const SCRIPT_PARAMETERS = ["require", "module", "exports"];

// The script body is evaluated as an async function so top-level await works
// (SPEC section 2). AsyncFunction is not a global, so it is reached through the
// prototype of an async function expression.
const AsyncFunction = Object.getPrototypeOf(async function asyncProbe() {}).constructor;




const trsScratch = new Float64Array(10);
const syncMatrix = new Matrix4();
const syncLocal = new Matrix4();
const syncPosition = new Vector3();
const syncQuaternion = new Quaternion();
const syncScale = new Vector3();
const syncScratch = new Float64Array(10);

export class Runtime {
  constructor() {
    installObjectExtensions(Light);
    installMaterialTracking();
    installGeometryTracking(BufferGeometry);
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

  queueCommand(command) {
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
    if (records && records.length) push(this.pendingSync, records);
  }

  syncBodies(records) {
    if (records && records.length) push(this.pendingBodySync, records);
  }

  setInput(state) {
    this.pendingInput = state;
  }

  dispatch(type, id, payload) {
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
    const result = containUrl(url, this.assetRoot);
    if (result.warning !== null) this.warnOnce(`url:${url}`, result.warning);
    return result.url;
  }

  /**
   * The environment payload the command stream carries, with its url contained
   * the same way a texture url is. A refused url means no environment at all
   * rather than one the consumer would resolve against its own file system.
   */
  environmentPayload() {
    const environment = this.environment;
    if (!environment || typeof environment.toJSON !== "function") return null;
    const json = environment.toJSON();
    if (json === null || json === undefined) return null;
    const url = this.resolveUrl(json.url);
    if (url === null) {
      this.warnOnce(
        `environment-url:${json.url}`,
        "Spatial.environment was dropped because its url was refused",
      );
      return null;
    }
    if (url === json.url) return json;
    json.url = url;
    return json;
  }

  raycast(origin, direction, options = {}) {
    const maxDistance = options.maxDistance === undefined ? Infinity : options.maxDistance;
    const recursive = options.recursive !== false;
    const native = globalThis.__spatialNative;

    if (native && typeof native.raycast === "function") {
      const flat = native.raycast(
        origin.x,
        origin.y,
        origin.z,
        direction.x,
        direction.y,
        direction.z,
        Number.isFinite(maxDistance) ? maxDistance : -1,
        recursive,
      );
      const hits = [];
      if (flat && flat.length) {
        for (let i = 0; i + 8 <= flat.length; i += 8) {
          const object = this.objectForId(flat[i]);
          if (!object) continue;
          push(hits, {
            object,
            point: new Vector3(flat[i + 1], flat[i + 2], flat[i + 3]),
            normal: new Vector3(flat[i + 4], flat[i + 5], flat[i + 6]),
            distance: flat[i + 7],
          });
        }
      }
      hits.sort((a, b) => a.distance - b.distance);
      return hits;
    }

    if (!this.scene) return [];
    // Leaf objects defer their world matrix, so refresh before hit testing.
    refreshWorldMatrices(this.scene, (object, error) => this.skipObject(object, error));
    this.raycaster.set(origin, direction.clone().normalize());
    this.raycaster.near = 0;
    this.raycaster.far = Number.isFinite(maxDistance) ? maxDistance : Infinity;

    // SPEC 3.7: visible meshes only, at most one hit per object, sorted by
    // distance. `recursive: false` limits hits to direct children of the scene.
    const targets = [];
    if (recursive) {
      this.scene.traverseVisible((object) => {
        if (object.isMesh === true) push(targets, object);
      });
    } else {
      const children = this.scene.children;
      for (let i = 0; i < children.length; i += 1) {
        if (children[i].isMesh === true && children[i].visible !== false) push(targets, children[i]);
      }
    }

    const intersections = this.raycaster.intersectObjects(targets, false);
    const results = [];
    const seen = new Set();
    for (const hit of intersections) {
      if (seen.has(hit.object)) continue;
      seen.add(hit.object);
      const normal = new Vector3(0, 0, 1);
      if (hit.normal) normal.copy(hit.normal);
      else if (hit.face) worldNormal(hit.object, hit.face.normal, normal);
      push(results, { object: hit.object, point: hit.point.clone(), normal, distance: hit.distance });
    }
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  loadAsset(urls = {}) {
    // Every asset url is contained the same way a texture url is: the file
    // system on the other side of the command stream is reached through one
    // gate, not four (SPEC 3.5 url forms).
    const contained = {};
    const refused = [];
    for (let i = 0; i < ASSET_KEYS.length; i += 1) {
      const key = ASSET_KEYS[i];
      const raw = urls[key];
      if (raw === undefined || raw === null || raw === "") continue;
      const url = this.resolveUrl(raw);
      if (url === null) push(refused, key);
      else contained[key] = url;
    }

    const group = new AssetGroup(contained);
    const backend = this.env.backend;
    const needed = backend === "realitykit" ? ["usdz", "reality"] : ["glb", "gltf"];
    if (!needed.some((key) => group.urls[key])) {
      // A refused url is a load failure, not a silent asset with no source.
      const reason =
        refused.length > 0
          ? `loadAsset refused ${refused.join(" and ")}: the url leaves the asset root or uses a scheme ` +
            "that is not allowed"
          : `loadAsset needs one of ${needed.join(" or ")} for the ${backend} backend`;
      return Promise.reject(new SpatialUnsupportedError(reason, "loadAsset", group));
    }
    this.extraRoots.add(group);
    const promise = new Promise((resolve, reject) => {
      group._resolve = resolve;
      group._reject = reject;
    });
    group.promise = promise;
    return promise;
  }

  dump(options) {
    return buildDump(this, options);
  }

  dispose() {
    if (this.disposed) return [];
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





