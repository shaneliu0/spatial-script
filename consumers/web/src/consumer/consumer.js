// SpatialScript three.js consumer.
// Mirrors the shared core's command stream (SPEC section 5) into a three.js scene,
// owns Rapier physics, input, particles, portals and native asset animation, and
// pushes the results back to the core through sync/dispatch (SPEC section 6).
//
// FA-57: the class is assembled from one module per responsibility — commands and
// the scene graph, resources, phase 2 features, assets and environment, and the
// frame — which mix into it in this file. Setup, the dispatch channel, rendering
// and the dumps stay here, with the shared tables in internals.js.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PhysicsWorld } from '../physics/physics.js';
import { ParticleEmitter } from './particles.js';
import { Portal } from './portals.js';
import { InputController } from '../input/input.js';
import { nativeDump } from '../dump/native-dump.js';
import { walkUp, idOf, isDescendantOf } from '../dump/scene-walk.js';
import { AudioEngine } from '../media/audio.js';
import { VideoScreens } from '../media/video.js';
import { CharacterControllers, ForceFields } from '../physics/character.js';
import { HostBridge } from './host.js';
import { AccessibilityMirror } from './accessibility.js';
import { withCommands } from './commands.js';
import { withResources } from './resources.js';
import { withFeatures } from './features.js';
import { withAssets } from './assets.js';
import { withFrame } from './frame.js';
import {
  DISPATCH_TYPES,
  LOAD_EVENTS,
  MEDIA_EVENTS,
  _size,
  now,
} from './internals.js';

/**
 * FA-19, SPEC 14.3: the default camera *is* the Mac RealityView camera —
 * (0, 0.25, 1.4) looking at the origin with a 60 degree vertical field of view —
 * so a page opened with no query string frames a scene exactly as the macOS host
 * does and parity screenshots line up without a preset flag. The calibration
 * behind these numbers is on CAMERA_PRESETS below.
 */
export const DEFAULT_CAMERA = [0, 0.25, 1.4];
export const DEFAULT_BACKGROUND = 0x15171b;
export const DEFAULT_FOV = 60;

/**
 * The macOS host's RealityView camera, so parity screenshots frame identically.
 *
 * Calibrated against the Mac capture at parity/out/basics/mac.png (window content
 * 1800 by 1220 device pixels at 2x, so aspect 1.4754 against this preset's
 * 1400/950 = 1.4737). Rendering examples/basics.js with parity/steps/basics.json
 * and measuring the projected 0.9 m floor and the 0.16 m cube as fractions of the
 * capture height gave, against the Mac reference (cube 0.15082, floor front edge
 * 0.76557):
 *
 *   fov 56 -> cube +7.48%, floor +8.90%
 *   fov 58 -> cube +3.30%, floor +4.50%
 *   fov 60 -> cube -0.89%, floor +0.37%   <- the only fit inside 3 percent
 *   fov 62 -> cube -4.38%, floor -3.48%
 *
 * The camera position (0, 0.25, 1.4) looking at the origin was confirmed by the
 * same run: the floor's front edge lands at 0.735 of the capture height against
 * the Mac's 0.736, which fixes the position independently of the field of view.
 * Lighting needs no preset switch: the consumer adds none on any path.
 */
export const CAMERA_PRESETS = {
  mac: {
    camera: DEFAULT_CAMERA,
    fov: DEFAULT_FOV,
    width: 1400,
    height: 950,
    background: 0x000000,
  },
};

export class SpatialConsumer extends withCommands(
  withResources(withFeatures(withAssets(withFrame(Object)))),
) {
  /**
   * @param {object} [options]
   * @param {HTMLCanvasElement|null} [options.canvas] omit for a headless (no-render) consumer
   * @param {number[]} [options.camera] camera position, defaults to DEFAULT_CAMERA
   * @param {string} [options.assetRoot] base for `asset://name` URLs
   * @param {string} [options.scriptRoot] base for relative URLs
   * @param {*} [options.rapier] an initialised @dimforge/rapier3d-compat module
   * @param {(url:string, id:number)=>THREE.Texture} [options.loadTexture] texture loader override
   * @param {boolean} [options.mirrorCollisionEvents] dispatch each collision to both objects
   */
  constructor(options = {}) {
    super();
    this.options = options;
    this.core = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(options.background ?? DEFAULT_BACKGROUND);

    /** Everything the core owns hangs off this group; id 0 is the mounted scene root. */
    this.root = new THREE.Group();
    this.root.name = '__spatialRoot';
    this.scene.add(this.root);

    const cam = options.camera || DEFAULT_CAMERA;
    this.camera = new THREE.PerspectiveCamera(options.fov ?? DEFAULT_FOV, options.aspect ?? 1, 0.01, 200);
    /** The consumer's own camera, used until a script assigns one (SPEC 14.3). */
    this.builtInCamera = this.camera;
    this.camera.position.set(cam[0], cam[1], cam[2]);
    this.camera.lookAt(0, 0, 0);
    // lookAt only writes the quaternion; picking and raycasting read the world
    // matrix, so it is composed once here rather than only at the first render.
    this.camera.updateMatrixWorld(true);
    this.scene.add(this.camera);

    /** @type {Map<number, THREE.Object3D>} */
    this.objects = new Map();
    /** @type {Map<number, THREE.Texture>} */
    this.textures = new Map();
    /**
     * Geometries and materials are shared between meshes by the uuid the core
     * sends (SPEC 5), so 1500 meshes built from one BoxGeometry hold one
     * BufferGeometry and one WebGL buffer set. Each entry counts its users and
     * disposes when the last one goes away.
     * @type {Map<string, {geometry:THREE.BufferGeometry, users:Set<number>, positions:*, normals:*, uvs:*, indices:*, info:object}>}
     */
    this.geometries = new Map();
    /** @type {Map<number, object>} object id -> its geometry cache entry */
    this.geometryOf = new Map();
    /** @type {Map<string, {material:THREE.Material, users:Set<number>, spec:object, revision:number}>} */
    this.materials = new Map();
    /** @type {Map<number, object>} object id -> its material cache entry */
    this.materialOf = new Map();
    /** Per-object material clones, used only where `opacity` is below one. */
    this.opacityMaterials = new Map();
    /** SPEC 14.12: the material array of a multi-material mesh, owned per id. */
    this.multiMaterials = new Map();
    /** @type {Map<number, {tap:boolean,hover:boolean,drag:boolean}>} */
    this.interactive = new Map();
    this.manipulable = new Set();
    this.billboards = new Set();
    /** id -> the rotation the script authored, for objects the facing overwrites. */
    this.authoredRotations = new Map();
    this.opacities = new Map();
    this.lightDirections = new Map();
    this.lightIds = new Set();
    /** @type {Map<number, ParticleEmitter>} */
    this.emitters = new Map();
    /** @type {Map<number, Portal>} */
    this.portals = new Map();
    this.worldGroups = new Set();
    /** @type {Map<number, {mixer:THREE.AnimationMixer, clips:THREE.AnimationClip[], action:THREE.AnimationAction|null}>} */
    this.assets = new Map();
    this.bodySpecs = new Map();

    this.warnings = [];
    this._warned = new Set();
    this.logs = [];
    this.errors = [];
    /** WEB-26: repeats are counted, not appended, and the list is capped. */
    this._errorCounts = new Map();
    this.droppedErrors = 0;
    /** PERF-10: console lines are capped per frame and in total. */
    this.droppedLogs = 0;
    this._logsThisFrame = 0;
    /**
     * WEB-05/06/07: every asynchronous load carries the generation it started in.
     * A callback from an earlier scene is dropped instead of resolving against
     * whatever object now owns that id.
     */
    this.generation = 0;
    /** Uuids whose geometry has no users, oldest first, bounded below. */
    this._idleGeometries = new Set();
    /** WEB-27: identity sets, so a destroy does not scan the caches. */
    this._sharedGeometries = new Set();
    this._sharedMaterials = new Set();
    /** WEB-11: the environment texture is owned here, not by `textures`. */
    this._environmentTexture = null;
    this._environmentTarget = null;

    this.frame = 0;
    this.elapsed = 0;
    /** Rolling window of the last 120 frames, mirroring the macOS host's /stats. */
    this.stats = [];
    this._lastFrameStart = 0;
    this.opacityDirty = false;
    // The core dispatches a collision to both objects of the pair itself, so the
    // consumer sends each event once. Opt in only for a core that does not mirror.
    this.mirrorCollisionEvents = options.mirrorCollisionEvents === true;

    // The core replaces globalThis.console and the timer globals when it loads a
    // script (SPEC 3.13). Capture the real console now, or every consumer warning
    // would be routed back into the core as a fresh `log` command each frame.
    this.console = options.console || (typeof console !== 'undefined' ? console : null);

    // ---- phase 2 (SPEC 14) ------------------------------------------------
    this.audio = new AudioEngine(this.camera, {
      resolveUrl: (url) => this.resolveUrl(url),
      dispatch: (type, id, payload) => this.dispatch(type, id, payload),
      warnOnce: (key, message) => this.warnOnce(key, message),
      beginLoad: (url) => this.beginLoad(url),
      endLoad: (token) => this.endLoad(token),
    });
    this.video = new VideoScreens({
      resolveUrl: (url) => this.resolveUrl(url),
      dispatch: (type, id, payload) => this.dispatch(type, id, payload),
      warnOnce: (key, message) => this.warnOnce(key, message),
      beginLoad: (url) => this.beginLoad(url),
      endLoad: (token) => this.endLoad(token),
    });
    this.host = new HostBridge({
      dispatch: (type, id, payload) => this.dispatch(type, id, payload),
      resolveUrl: (url) => this.resolveUrl(url),
      warnOnce: (key, message) => this.warnOnce(key, message),
    });
    this.accessibility = new AccessibilityMirror(options.document);
    this.characters = null;
    this.forceFields = null;
    /** The camera the script chose, or null for the consumer's own. */
    this.scriptCamera = null;
    /** The object id the scripted camera rides. */
    this.cameraId = null;
    this.cameraSpec = null;
    this.sceneUnderstanding = null;
    this.renderOptions = { adaptiveResolution: null, environmentIntensityExponent: 1, debugModelView: null };
    this.environmentIntensity = 1;
    /** @type {Map<number, {joints: object, track: boolean}>} */
    this.skeletons = new Map();
    /** @type {Map<number, object>} */
    this.blendShapes = new Map();
    this.shaderGraphs = new Map();
    /** `hostCall` and `fetch` ids, so a conformance step can answer them. */
    this.pendingCalls = new Map();
    this.pendingFetches = new Map();
    /** `type:id` media results a host injected, so the element does not repeat them. */
    this.hostAnswered = new Set();
    /** Element media results waiting one frame for a host answer to overtake them. */
    this._deferredMedia = new Map();
    this.isActive = true;

    this.gltfLoader = new GLTFLoader();
    this.textureLoader = options.canvas || typeof document !== 'undefined' ? new THREE.TextureLoader() : null;
    this.physics = null;
    this.renderer = null;
    this.input = new InputController({
      element: options.canvas || null,
      camera: this.camera,
      pickables: () => this.pickables(),
      idOf: (o) => this.idOf(o),
      interactiveAncestor: (o, kind) => this.interactiveAncestor(o, kind),
      isManipulable: (o) => !!o.userData && this.manipulable.has(o.userData.__spatialId),
      dispatch: (type, id, payload) => this.dispatch(type, id, payload),
      warnOnce: (key, message) => this.warnOnce(key, message),
      scenePositionAt: (x, y) => this.scenePositionAt(x, y),
    });

    /**
     * When a conformance case drives sync/syncBodies/dispatch itself, the live
     * consumer stops pushing its own results so the two do not fight.
     */
    this.manualBridge = false;
    this._inputOverride = null;
    this._inputOverridden = false;
    this.pendingLoads = 0;
    this._loadToken = 0;
    this._inFlightLoads = new Map();
    /** @type {Map<number, object>} asset id -> the `asset` command payload */
    this.assetSpecs = new Map();

    /** Ids whose Rapier body is currently pointer-driven (WEB-10). */
    this._manipulatedBodies = new Set();

    this._pendingBodies = new Map();
    this._pendingCharacters = new Map();
    this._pendingForceFields = new Map();
    this._pendingTeleports = new Set();
    this._pendingJoints = new Map();
    this._pendingBodyOps = [];
    this._syncScratch = new Float32Array(0);
  }
  // ------------------------------------------------------------------ setup

  /** Creates the renderer (when a canvas was supplied) and the physics world. */
  async init() {
    const { canvas, rapier } = this.options;
    if (canvas) {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        // Keeps the last frame readable for off-thread screenshot capture.
        preserveDrawingBuffer: true,
      });
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(canvas.width, canvas.height, false);
      // three r155+ is physically based by default; ACES tone mapping stays off so
      // colours match the RealityKit consumer's linear pipeline.
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.shadowMap.enabled = true;
      // PCFSoftShadowMap was removed in three r186.
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      this.camera.aspect = canvas.width / canvas.height;
      this.camera.updateProjectionMatrix();
    }
    if (rapier) {
      this.physics = new PhysicsWorld(rapier, (m) => this.warnOnce(m, m));
      this.characters = new CharacterControllers(this.physics, { warnOnce: (k, m) => this.warnOnce(k, m) });
      this.forceFields = new ForceFields(this.physics, { warnOnce: (k, m) => this.warnOnce(k, m) });
    }
    this.input.attach();
    return this;
  }

  setCore(core) {
    this.core = core;
  }

  /**
   * Hands the consumer-to-core channel to the caller: the consumer stops pushing
   * sync, syncBodies and input events, and stops fetching assets and textures,
   * because the caller supplies those results itself. Load events are never
   * suppressed (WEB-15): a load already in flight still reports back.
   */
  setManualBridge(on) {
    this.manualBridge = on === true;
  }

  /** SPEC 14.10: the view appeared or went away; ticks pause while inactive. */
  setActive(active) {
    const next = active === true;
    if (next === this.isActive) return;
    this.isActive = next;
    if (this.core && typeof this.core.setActive === 'function') this.core.setActive(next);
  }

  /**
   * SPEC 14.13a: every resource load the consumer starts is counted while it is
   * in flight, so a plan can wait for the scene to settle between frames. The
   * token names the url, which is what a stuck plan reports.
   */
  beginLoad(url) {
    this.pendingLoads += 1;
    this._loadToken += 1;
    this._inFlightLoads.set(this._loadToken, url || 'unknown');
    return this._loadToken;
  }

  /**
   * P2-B-28: a reset zeroes the counter while loads are still in flight, so a
   * late completion must not take it negative and stall `settleLoads` for ever.
   */
  endLoad(token) {
    this.pendingLoads = Math.max(0, this.pendingLoads - 1);
    if (token !== undefined && token !== null) this._inFlightLoads.delete(token);
  }

  /** The urls of the loads still in flight, for a plan that will not settle. */
  inFlightLoads() {
    return [...new Set(this._inFlightLoads.values())];
  }

  /** Sends this exact input state on the next tick instead of the live one. */
  overrideInput(state) {
    // Once a caller sets input explicitly it owns the channel: the consumer
    // stops sending its own, so the core keeps the state between the frames the
    // caller drives (SPEC 6: fields the payload omits persist).
    this._inputOverride = state;
    this._inputOverridden = true;
  }

  setCameraPosition(x, y, z) {
    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld(true);
  }

  dispose() {
    this.input.detach();
    // WEB-22: no throwaway Rapier world on the way out.
    this.reset({ recreatePhysics: false });
    // P2-B-49: the audio graph and the accessibility container are the consumer's
    // and must not outlive it.
    this.audio.dispose();
    this.accessibility.dispose();
    if (this.renderer) this.renderer.dispose();
  }

  /**
   * Tears the scene down but keeps the renderer, camera and canvas, ready for a
   * reload. The generation is bumped so every in-flight load is dropped instead
   * of resolving against the next scene's ids.
   */
  reset({ recreatePhysics = true } = {}) {
    this.generation += 1;
    // destroyObject already frees emitters, portals, geometries and materials.
    for (const id of [...this.objects.keys()]) this.destroyObject(id);
    for (const entry of this.textures.values()) {
      entry.released = true;
      for (const texture of this._textureViews(entry)) texture.dispose();
    }
    for (const entry of this.geometries.values()) entry.geometry.dispose();
    for (const entry of this.materials.values()) entry.material.dispose();
    for (const clone of this.opacityMaterials.values()) clone.dispose();
    this.textures.clear();
    this.geometries.clear();
    this.geometryOf.clear();
    this.materials.clear();
    this.materialOf.clear();
    this.opacityMaterials.clear();
    for (const materials of this.multiMaterials.values()) for (const m of materials) m.dispose();
    this.multiMaterials.clear();
    this.audio.reset();
    this.video.reset();
    this.host.reset();
    this.accessibility.reset();
    if (this.characters) this.characters.reset();
    if (this.forceFields) this.forceFields.reset();
    this.skeletons.clear();
    this.blendShapes.clear();
    this.shaderGraphs.clear();
    this.pendingCalls.clear();
    this.pendingFetches.clear();
    this.hostAnswered.clear();
    this._deferredMedia.clear();
    this.sceneUnderstanding = null;
    this.renderOptions = { adaptiveResolution: null, environmentIntensityExponent: 1, debugModelView: null };
    this.scene.overrideMaterial = null;
    this.cameraSpec = null;
    if (this.scriptCamera) {
      this.scriptCamera.removeFromParent();
      this.scriptCamera = null;
      this.cameraId = null;
      this.camera = this.builtInCamera;
      this._rebindCamera();
    }
    this._sharedGeometries.clear();
    this._sharedMaterials.clear();
    this._idleGeometries.clear();
    this.emitters.clear();
    this.portals.clear();
    this.assets.clear();
    this.assetSpecs.clear();
    this.objects.clear();
    this.interactive.clear();
    this.manipulable.clear();
    this.billboards.clear();
    this.authoredRotations.clear();
    this.opacities.clear();
    this.lightDirections.clear();
    this.lightIds.clear();
    this.worldGroups.clear();
    this.bodySpecs.clear();
    this.root.clear();
    this.camera.clear();
    this._disposeEnvironment();
    if (this.physics) {
      this.physics.dispose();
      this.physics = recreatePhysics && this.options.rapier
        ? new PhysicsWorld(this.options.rapier, (m) => this.warnOnce(m, m))
        : null;
      this.characters = this.physics
        ? new CharacterControllers(this.physics, { warnOnce: (k, m) => this.warnOnce(k, m) })
        : null;
      this.forceFields = this.physics
        ? new ForceFields(this.physics, { warnOnce: (k, m) => this.warnOnce(k, m) })
        : null;
    }
    // Session state: a stale drag or hover would otherwise be delivered to
    // whatever object owns that id in the next scene (WEB-21).
    this.input.clearSessions();
    this._pendingBodies.clear();
    this._pendingCharacters.clear();
    this._pendingForceFields.clear();
    this._pendingTeleports.clear();
    this._pendingJoints.clear();
    this._pendingBodyOps.length = 0;
    this._manipulatedBodies.clear();
    this._inputOverride = null;
    this._inputOverridden = false;
    this.manualBridge = false;
    this.pendingLoads = 0;
    this._inFlightLoads.clear();
    this._syncScratch = new Float32Array(0);
    this.warnings.length = 0;
    this.errors.length = 0;
    this._errorCounts.clear();
    this.droppedErrors = 0;
    this.logs.length = 0;
    this.droppedLogs = 0;
    this._logsThisFrame = 0;
    this._warned.clear();
    this.frame = 0;
    this.elapsed = 0;
    this.stats.length = 0;
    this._lastFrameStart = 0;
    this.opacityDirty = false;
  }

  /**
   * Warn once per feature per scene (SPEC 12). The warning is also registered with
   * the core under a `consumer:` key, the way the Swift consumer registers its
   * own, so both backends' `dump().warnings` carry consumer warnings alike.
   */
  warnOnce(key, message) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    const text = message || key;
    this.warnings.push(text);
    const runtime = this.core && this.core.runtime;
    let routed = false;
    if (runtime && typeof runtime.warnOnce === 'function') {
      try {
        runtime.warnOnce(`consumer:${key}`, text);
        routed = true;
      } catch {
        // A core that predates warnOnce keeps the warning consumer-side only.
      }
    }
    // SPEC 12: one console line per warning key. The core answers a registered
    // warning with a `log` command, which this consumer prints and records on
    // the way back in — so printing here too would say it twice. Only a core
    // that cannot take the warning leaves the line to the consumer.
    if (routed) return;
    this._pushLog('warn', text);
    this.write('warn', text);
  }

  /** Consumer-side output; never the core's console (see the constructor). */
  write(level, message) {
    const sink = this.console;
    if (sink && typeof sink[level] === 'function') sink[level](message);
  }
  // ------------------------------------------------------------- dispatch

  dispatch(type, id, payload) {
    if (!this.core || id === undefined || id === null) return;
    // AR-29, SPEC 6: an event type outside the closed list would reach a script
    // on this backend and nowhere else, so it is named rather than delivered.
    if (!DISPATCH_TYPES.has(type)) {
      this.warnOnce(`dispatchType:${type}`, `"${type}" is not a SPEC 6 event type; it was not dispatched`);
      return;
    }
    // WEB-15: a case that drives sync/dispatch itself owns the input and
    // collision channel, but load results must still reach the script.
    if (this.manualBridge && !LOAD_EVENTS.has(type)) return;
    if (this.manualBridge && MEDIA_EVENTS.has(type)) {
      const key = `${type}:${id}`;
      // A host driving the bridge answers for the media element, so the
      // element's own answer must not reach the script twice. Which of the two
      // fires first is a network race, so the element's answer waits until the
      // next frame and is dropped if the host's arrives in the meantime.
      if (this.hostAnswered.has(key)) return;
      this._deferredMedia.set(key, { type, id, payload, generation: this.generation });
      return;
    }
    // P2-B-29: the correlation id is spent only when its answer really goes out;
    // under the manual bridge the harness is the one that answers.
    if (type === 'hostResult' || type === 'fetchResult') this.settleCorrelation(id);
    this._emit(type, id, payload);
  }

  _emit(type, id, payload) {
    try {
      this.core.dispatch(type, id, payload || {});
    } catch (err) {
      this.errors.push(`dispatch(${type}, ${id}) failed: ${err.message}`);
    }
  }

  /**
   * Sends the media results the elements produced last frame, minus any the host
   * has answered for since, and minus any left over from a previous load.
   */
  flushDeferredMedia() {
    if (!this._deferredMedia.size) return;
    const pending = [...this._deferredMedia.values()];
    this._deferredMedia.clear();
    for (const entry of pending) {
      if (entry.generation !== this.generation) continue;
      if (this.hostAnswered.has(`${entry.type}:${entry.id}`)) continue;
      this._emit(entry.type, entry.id, entry.payload);
    }
  }

  idOf(object) {
    return idOf(object);
  }

  interactiveAncestor(object, kind) {
    return walkUp(object, (node) => {
      const id = node.userData && node.userData.__spatialId;
      if (id === undefined) return false;
      const flags = this.interactive.get(id);
      return !!(flags && flags[kind]);
    });
  }

  /**
   * Visible meshes eligible for hit testing and raycasting. Particle sprites are
   * excluded. With `recursive` false only the direct children of the mounted
   * scene are considered.
   */
  pickables(recursive = true) {
    const out = [];
    // Head-anchored content rides the camera, so both roots are walked (WEB-08).
    for (const root of this.consumerRoots()) {
      if (recursive) {
        root.traverseVisible((o) => {
          if (o.isMesh && o.name !== '__particles') out.push(o);
        });
        continue;
      }
      for (const child of root.children) {
        if (child.visible !== false && child.isMesh && child.name !== '__particles') out.push(child);
      }
    }
    return out;
  }

  /** Everything the consumer owns: the scene root plus head-anchored content. */
  consumerRoots() {
    return this.camera.children.length ? [this.root, this.camera] : [this.root];
  }

  /**
   * Backs `__spatialNative.raycast`; returns flat `[id,px,py,pz,nx,ny,nz,distance]`
   * records. SPEC 3.7: sorted by distance, at most one hit per object, visible
   * meshes only, and `recursive: false` limits hits to direct children of the
   * mounted scene.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDistance, recursive) {
    // A non-finite ray would produce NaN hits the script cannot sort or use.
    if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)
      || !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) {
      return [];
    }
    const dir = new THREE.Vector3(dx, dy, dz);
    if (dir.lengthSq() === 0) return [];
    dir.normalize();
    // The core sends -1 for an unbounded ray, since Infinity does not survive the
    // JavaScriptCore boundary; anything below zero means "no limit".
    const far = maxDistance === undefined || maxDistance === null
      || !Number.isFinite(maxDistance) || maxDistance < 0
      ? Infinity
      : maxDistance;
    const caster = new THREE.Raycaster(new THREE.Vector3(ox, oy, oz), dir, 0, far);
    // intersectObjects sorts by distance; the records stay in that order.
    const hits = caster.intersectObjects(this.pickables(recursive !== false && recursive !== 0), false);
    const out = [];
    // three.js reports one hit per triangle; RealityKit reports one per entity, so
    // only the nearest hit on each object is returned.
    const seen = new Set();
    for (const hit of hits) {
      const id = this.idOf(hit.object);
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      // three reports the surface normal in the mesh's local frame.
      const local = hit.normal || (hit.face && hit.face.normal);
      const normal = local
        ? local.clone().transformDirection(hit.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 1, 0);
      out.push(id, hit.point.x, hit.point.y, hit.point.z, normal.x, normal.y, normal.z, hit.distance);
    }
    return out;
  }
  // ----------------------------------------------------------------- render

  render() {
    if (!this.renderer) return;
    const size = this.renderer.getDrawingBufferSize(_size);
    for (const emitter of this.emitters.values()) emitter.setViewportScale(size.y, this.camera.fov);

    for (const portal of this.portals.values()) {
      const world = this.objects.get(portal.spec.worldId);
      if (!world) {
        // WEB-24: without a world the surface would keep showing the last frame.
        if (!portal.cleared) {
          this.renderer.setRenderTarget(portal.target);
          this.renderer.clear();
          this.renderer.setRenderTarget(null);
          portal.cleared = true;
        }
        continue;
      }
      portal.cleared = false;
      portal.resizeTarget(size.x, size.y);
      portal.updateCamera(this.camera);
      const restore = this._enterPortalPass(portal, world);
      this.renderer.setRenderTarget(portal.target);
      this.renderer.clear();
      this.renderer.render(this.scene, portal.camera);
      restore();
    }

    this.renderer.setRenderTarget(null);
    const restoreMain = this._hideWorlds();
    this.renderer.render(this.scene, this.camera);
    restoreMain();
  }

  /** Shows only this portal's world (plus lights) for the render-target pass. */
  /**
   * Shows only this portal's world, plus lights, for the render-target pass.
   * WEB-09: the world group may be nested anywhere, so an ancestor of it stays
   * visible and its own `visible` flag is never overridden. Head-anchored
   * content under the camera is hidden too, so it cannot leak into the target.
   */
  _enterPortalPass(portal, world) {
    const saved = [];
    const hide = (object) => {
      saved.push([object, object.visible]);
      object.visible = false;
    };
    const walk = (node) => {
      for (const child of node.children) {
        if (child === world || child.isLight === true) continue;
        // `isLight` is undefined on everything else, and three.js only skips an
        // object when `visible === false`, so this has to be a real boolean.
        if (isDescendantOf(world, child)) {
          // An ancestor of the world stays visible; its other branches do not.
          walk(child);
          continue;
        }
        hide(child);
      }
    };
    for (const root of this.consumerRoots()) walk(root);
    // The portal surface must not show up inside its own render target.
    if (portal.mesh.visible !== false) hide(portal.mesh);
    return () => {
      for (let i = saved.length - 1; i >= 0; i--) saved[i][0].visible = saved[i][1];
    };
  }

  /** Portal worlds are invisible in the main pass; they exist only inside portals. */
  _hideWorlds() {
    if (!this.worldGroups.size) return () => {};
    const saved = [];
    for (const id of this.worldGroups) {
      const object = this.objects.get(id);
      if (!object) continue;
      saved.push([object, object.visible]);
      object.visible = false;
    }
    return () => {
      for (const [object, visible] of saved) object.visible = visible;
    };
  }

  resize(width, height) {
    if (!this.renderer) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Renders at `ratio` device pixels per CSS pixel. The default is 1, because
   * the headless harness and the parity screenshots require the drawing buffer
   * to equal the size they asked for; an interactive page on a high density
   * display opts in to get a sharp image. `setSize` is told not to touch the
   * element's style, so the CSS box is the caller's to control.
   */
  setPixelRatio(ratio) {
    if (!this.renderer) return;
    const clamped = Math.max(1, Math.min(Number(ratio) || 1, 3));
    if (clamped === this.renderer.getPixelRatio()) return;
    this.renderer.setPixelRatio(clamped);
    const size = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setSize(size.x, size.y, false);
  }

  // ------------------------------------------------------------------- dump

  /**
   * The scene the consumer actually renders, in the Swift consumer's nativeDump
   * shape so the two backends can be diffed field by field.
   */
  nativeDump(options = {}) {
    return nativeDump(this, options);
  }

  /** The core dump, with consumer-side warnings folded into `warnings`. */
  dump() {
    const dump = this.core ? this.core.dump() : { objects: [], warnings: [], errors: [] };
    // Consumer warnings are registered with the core, so only add the ones a core
    // without `runtime.warnOnce` would have missed.
    const warnings = [...(dump.warnings || [])];
    for (const warning of this.warnings) if (!warnings.includes(warning)) warnings.push(warning);
    dump.warnings = warnings;
    dump.errors = [...(dump.errors || []), ...this.errors];
    return dump;
  }
}
