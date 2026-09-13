// SpatialScript three.js consumer.
// Mirrors the shared core's command stream (SPEC section 5) into a three.js scene,
// owns Rapier physics, input, particles, portals and native asset animation, and
// pushes the results back to the core through sync/dispatch (SPEC section 6).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { PhysicsWorld } from './physics.js';
import { ParticleEmitter } from './particles.js';
import { Portal } from './portals.js';
import { InputController } from './input.js';
import { nativeDump } from './native-dump.js';
import { walkUp, idOf, isDescendantOf } from './scene-walk.js';

/**
 * The RealityKit consumer renders a macOS window whose default camera sits about a
 * metre from the origin; matching that keeps parity screenshots framed alike.
 */
export const DEFAULT_CAMERA = [0, 0, 1.2];
export const DEFAULT_BACKGROUND = 0x15171b;
export const DEFAULT_FOV = 45;

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
    camera: [0, 0.25, 1.4],
    fov: 60,
    width: 1400,
    height: 950,
    background: 0x000000,
  },
};

const SIDES = { FrontSide: THREE.FrontSide, BackSide: THREE.BackSide, DoubleSide: THREE.DoubleSide };
const BLENDING = { NormalBlending: THREE.NormalBlending, AdditiveBlending: THREE.AdditiveBlending };
const WRAPPING = {
  RepeatWrapping: THREE.RepeatWrapping,
  ClampToEdgeWrapping: THREE.ClampToEdgeWrapping,
  MirroredRepeatWrapping: THREE.MirroredRepeatWrapping,
};

export class SpatialConsumer {
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
    this.camera.position.set(cam[0], cam[1], cam[2]);
    this.camera.lookAt(0, 0, 0);
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
    /** @type {Map<number, {tap:boolean,hover:boolean,drag:boolean}>} */
    this.interactive = new Map();
    this.manipulable = new Set();
    this.billboards = new Set();
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
    });

    /**
     * When a conformance case drives sync/syncBodies/dispatch itself, the live
     * consumer stops pushing its own results so the two do not fight.
     */
    this.manualBridge = false;
    this._inputOverride = null;
    this.pendingLoads = 0;
    /** @type {Map<number, object>} asset id -> the `asset` command payload */
    this.assetSpecs = new Map();

    /** Ids whose Rapier body is currently pointer-driven (WEB-10). */
    this._manipulatedBodies = new Set();

    this._pendingBodies = new Map();
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
    if (rapier) this.physics = new PhysicsWorld(rapier, (m) => this.warnOnce(m, m));
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

  /** Sends this exact input state on the next tick instead of the live one. */
  overrideInput(state) {
    this._inputOverride = state;
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
    }
    // Session state: a stale drag or hover would otherwise be delivered to
    // whatever object owns that id in the next scene (WEB-21).
    this.input.clearSessions();
    this._pendingBodies.clear();
    this._pendingTeleports.clear();
    this._pendingJoints.clear();
    this._pendingBodyOps.length = 0;
    this._manipulatedBodies.clear();
    this._inputOverride = null;
    this.manualBridge = false;
    this.pendingLoads = 0;
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
    this._pushLog('warn', text);
    this.write('warn', text);
    const runtime = this.core && this.core.runtime;
    if (runtime && typeof runtime.warnOnce === 'function') {
      try {
        runtime.warnOnce(`consumer:${key}`, text);
      } catch {
        // A core that predates warnOnce keeps the warning consumer-side only.
      }
    }
  }

  /** Consumer-side output; never the core's console (see the constructor). */
  write(level, message) {
    const sink = this.console;
    if (sink && typeof sink[level] === 'function') sink[level](message);
  }

  // ------------------------------------------------------------- dispatch

  dispatch(type, id, payload) {
    if (!this.core || id === undefined || id === null) return;
    // WEB-15: a case that drives sync/dispatch itself owns the input and
    // collision channel, but load results must still reach the script.
    if (this.manualBridge && !LOAD_EVENTS.has(type)) return;
    try {
      this.core.dispatch(type, id, payload || {});
    } catch (err) {
      this.errors.push(`dispatch(${type}, ${id}) failed: ${err.message}`);
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

  // -------------------------------------------------------------- commands

  /**
   * Applies one command batch, then settles physics, opacity and lighting.
   * Every step is inside the error boundary and the pending queues are always
   * cleared, so one failing command or post-batch step records an error and the
   * next frame starts clean instead of retrying it forever.
   */
  apply(commands) {
    const started = now();
    this._lastCommandCount = commands ? commands.length : 0;
    this._lastTransformRecords = 0;
    if (commands) {
      for (const command of commands) {
        try {
          this.applyCommand(command);
        } catch (err) {
          this.recordError(`command ${command && command[0]}`, command && command[1], err);
        }
      }
    }
    try {
      this._afterBatch();
    } catch (err) {
      this.recordError('post-batch', null, err);
    } finally {
      this._pendingBodies.clear();
      this._pendingTeleports.clear();
      this._pendingJoints.clear();
      this._pendingBodyOps.length = 0;
    }
    this._lastApplyMs = now() - started;
    return this._lastApplyMs;
  }

  /**
   * Records one consumer error, naming the opcode and object. WEB-26: the list
   * is capped, and a repeat of the same message is counted rather than appended,
   * so a persistently failing command cannot flood `dump().errors`.
   */
  recordError(what, id, error) {
    const object = id === null || id === undefined ? null : this.objects.get(id);
    const name = object && object.name ? ` "${object.name}"` : '';
    const target = id === null || id === undefined ? '' : ` on id ${id}${name}`;
    const message = `${what}${target} failed: ${error && error.message ? error.message : error}`;
    this.write('error', `${message}\n${(error && error.stack) || ''}`);
    if (this._errorCounts.has(message)) {
      this._errorCounts.set(message, this._errorCounts.get(message) + 1);
      return;
    }
    this._errorCounts.set(message, 1);
    if (this.errors.length < MAX_ERRORS) {
      this.errors.push(message);
    } else {
      this.droppedErrors += 1;
    }
  }

  applyCommand(command) {
    const op = command[0];
    const id = command[1];
    switch (op) {
      case 'create': this.createObject(id, command[2], command[3]); break;
      case 'destroy': this.destroyObject(id); break;
      case 'parent': this.setParent(id, command[2]); break;
      case 'name': this.withObject(id, (o) => { o.name = command[2] || ''; }); break;
      case 'transform': this.setTransform(id, command); break;
      case 'transforms': this.setTransforms(command[2]); break;
      case 'visible': this.setVisible(id, !!command[2]); break;
      case 'geometry': this.setGeometry(id, command[2], command[3], command[4], command[5], command[6]); break;
      case 'material': this.setMaterial(id, command[2]); break;
      case 'texture': this.setTexture(id, command[2]); break;
      case 'light': this.setLight(id, command[2]); break;
      case 'shadow': this.withObject(id, (o) => { o.castShadow = !!command[2]; o.receiveShadow = !!command[3]; }); break;
      case 'opacity':
        if (this.objects.has(id)) {
          this.opacities.set(id, command[2]);
          this.opacityDirty = true;
        } else {
          this.warnOnce(`unknownId:${id}`, `opacity for unknown object id ${id} was ignored`);
        }
        break;
      case 'billboard': this.setBillboard(id, !!command[2]); break;
      case 'groundingShadow':
        if (command[2]) {
          this.warnOnce('groundingShadow', 'Object3D.groundingShadow is unsupported in the three.js consumer');
        }
        break;
      case 'hoverEffect': this.withObject(id, (o) => { o.userData.__hoverEffect = command[2]; }); break;
      case 'manipulable': this.setManipulable(id, !!command[2]); break;
      case 'renderOrder': this.withObject(id, (o) => { o.renderOrder = command[2] | 0; }); break;
      case 'interactive':
        if (this.objects.has(id)) {
          this.interactive.set(id, command[2] || { tap: false, hover: false, drag: false });
        } else {
          this.warnOnce(`unknownId:${id}`, `interactive for unknown object id ${id} was ignored`);
        }
        break;
      case 'rigidBody':
        this.checkPayloadKeys('rigidBody', command[2], KNOWN_KEYS.rigidBody);
        this._pendingBodies.set(id, command[2] || null);
        break;
      case 'bodyImpulse':
        this._pendingBodyOps.push(['impulse', id, command[2], command[3], command[4], command[5], command[6], command[7]]);
        break;
      case 'bodyForce': this._pendingBodyOps.push(['force', id, command[2], command[3], command[4]]); break;
      case 'bodyTorque': this._pendingBodyOps.push(['torque', id, command[2], command[3], command[4]]); break;
      case 'bodyVelocity':
        this._pendingBodyOps.push(['velocity', id, command[2], command[3], command[4], command[5], command[6], command[7]]);
        break;
      case 'joint':
        this.checkPayloadKeys('joint', command[2], KNOWN_KEYS.joint);
        this._pendingJoints.set(id, command[2] || null);
        break;
      case 'gravity':
        if (this.physics) this.physics.setGravity(command[2], command[3], command[4]);
        else this.warnOnce('noPhysics', 'no physics module was supplied; gravity is recorded but not simulated');
        break;
      case 'particles': this.setParticles(id, command[2]); break;
      case 'particlesBurst': { const e = this.emitters.get(id); if (e) e.burst(); break; }
      case 'anchor': this.setAnchor(id, command[2]); break;
      case 'portal': this.setPortal(id, command[2]); break;
      case 'world': this.setWorld(id, !!command[2]); break;
      case 'asset': this.loadAsset(id, command[2]); break;
      case 'assetAnimation': this.setAssetAnimation(id, command[2], command[3], command[4]); break;
      case 'environment': this.setEnvironment(command[2]); break;
      case 'log': this.handleLog(command[2], command[3]); break;
      default:
        this.warnOnce(`opcode:${op}`, `unknown command opcode "${op}"`);
    }
  }

  /**
   * MAINT-09: a key the consumer does not know about is a phase-2 field shipping
   * half-implemented, so it warns once per opcode and key rather than being read
   * and ignored.
   */
  checkPayloadKeys(opcode, payload, known) {
    if (!payload || typeof payload !== 'object') return;
    for (const key of Object.keys(payload)) {
      if (known.has(key)) continue;
      this.warnOnce(
        `payloadKey:${opcode}:${key}`,
        `the ${opcode} payload carries an unknown key "${key}", which this consumer ignores`,
      );
    }
  }

  withObject(id, fn) {
    const object = this.objects.get(id);
    if (object) fn(object);
  }

  _afterBatch() {
    this.root.updateMatrixWorld(true);

    for (const [id, spec] of this._pendingBodies) {
      // The spec is recorded even without Rapier so nativeDump stays truthful and
      // a later init() could replay it (WEB-13).
      if (spec) this.bodySpecs.set(id, spec.spec || spec); else this.bodySpecs.delete(id);
    }
    if (this.physics) {
      for (const [id, pending] of this._pendingBodies) {
        const object = this.objects.get(id);
        if (!object) continue;
        const spec = pending && pending.spec !== undefined ? pending.spec : pending;
        const rebuild = !!(pending && pending.rebuild);
        try {
          this.physics.setBody(id, object, spec, rebuild);
        } catch (err) {
          this.recordError('rigidBody', id, err);
        }
      }
      for (const id of this._pendingTeleports) {
        try {
          if (this.physics.isDynamic(id)) this.physics.teleport(id, this.objects.get(id));
        } catch (err) {
          this.recordError('transform teleport', id, err);
        }
      }
      for (const [jointId, spec] of this._pendingJoints) {
        try {
          this.physics.setJoint(jointId, spec);
        } catch (err) {
          this.recordError(`joint ${jointId}`, null, err);
        }
      }
      for (const op of this._pendingBodyOps) {
        try {
          this._runBodyOp(op);
        } catch (err) {
          this.recordError(op[0], op[1], err);
        }
      }
    } else if (this._pendingBodies.size || this._pendingJoints.size || this._pendingBodyOps.length) {
      this.warnOnce(
        'noPhysics',
        'no physics module was supplied; rigid bodies, joints and body forces are recorded but not simulated',
      );
    }
    if (this.opacityDirty) {
      this.applyOpacity();
      this.opacityDirty = false;
    }
  }

  _runBodyOp(op) {
    const [kind, id] = op;
    if (kind === 'impulse') this.physics.applyImpulse(id, op[2], op[3], op[4], op[5], op[6], op[7]);
    else if (kind === 'force') this.physics.applyForce(id, op[2], op[3], op[4]);
    else if (kind === 'torque') this.physics.applyTorque(id, op[2], op[3], op[4]);
    else if (kind === 'velocity') this.physics.setVelocity(id, op[2], op[3], op[4], op[5], op[6], op[7]);
  }

  // ------------------------------------------------------------ scene graph

  createObject(id, kind, name) {
    if (this.objects.has(id)) this.destroyObject(id);
    let object;
    switch (kind) {
      case 'group':
      case 'anchor':
      case 'asset':
      case 'particles':
        object = new THREE.Group();
        break;
      case 'mesh':
      case 'text': {
        const placeholder = new THREE.MeshStandardMaterial();
        placeholder.userData.__placeholder = true;
        object = new THREE.Mesh(new THREE.BufferGeometry(), placeholder);
        break;
      }
      case 'ambientLight':
        object = new THREE.AmbientLight(0xffffff, 1);
        break;
      case 'directionalLight':
        object = new THREE.DirectionalLight(0xffffff, 1);
        this._attachLightTarget(object);
        break;
      case 'pointLight':
        object = new THREE.PointLight(0xffffff, 1);
        break;
      case 'spotLight':
        object = new THREE.SpotLight(0xffffff, 1);
        this._attachLightTarget(object);
        break;
      case 'portal':
        object = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial());
        break;
      default:
        this.warnOnce(`kind:${kind}`, `unknown object kind "${kind}", created as a Group`);
        object = new THREE.Group();
    }
    object.name = name || '';
    object.matrixAutoUpdate = true;
    object.userData.__spatialId = id;
    object.userData.__spatialKind = kind;
    if (object.isLight) this.lightIds.add(id);
    this.objects.set(id, object);
    // Objects stay detached until a `parent` command places them (SPEC section 5 ordering).
  }

  _attachLightTarget(light) {
    // Directional and spot lights aim at a target object; the core sends the
    // resolved world direction, so the target is kept at identity in the scene.
    light.target = new THREE.Object3D();
    this.scene.add(light.target);
  }

  destroyObject(id) {
    const object = this.objects.get(id);
    if (!object) return;
    const emitter = this.emitters.get(id);
    if (emitter) { emitter.dispose(); this.emitters.delete(id); }
    const portal = this.portals.get(id);
    if (portal) { portal.dispose(); this.portals.delete(id); }
    const asset = this.assets.get(id);
    if (asset) {
      asset.mixer.stopAllAction();
      // WEB-11: a loaded gltf owns its own geometries, materials and textures.
      if (asset.root) disposeSubtree(asset.root);
      this.assets.delete(id);
    }
    this.assetSpecs.delete(id);
    if (this.physics) this.physics.removeBody(id);
    if (object.isLight && object.target && object.target.parent) object.target.removeFromParent();
    object.removeFromParent();
    // Shared geometry and material entries free their GPU resources with the last
    // user; anything else on this object (the placeholder material, or a loaded
    // asset's own resources) is disposed here.
    const geometryEntry = this.geometryOf.get(id);
    const materialEntry = this.materialOf.get(id);
    const owned = new Set();
    if (geometryEntry) owned.add(geometryEntry.geometry);
    if (materialEntry) owned.add(materialEntry.material);
    const clone = this.opacityMaterials.get(id);
    if (clone) owned.add(clone);
    this._releaseGeometry(id);
    this._releaseMaterial(id);
    object.traverse((node) => {
      if (!node.isMesh) return;
      if (node.geometry && !owned.has(node.geometry) && !this._isSharedGeometry(node.geometry)) {
        node.geometry.dispose();
      }
      const material = node.material;
      if (material && !Array.isArray(material) && !owned.has(material) && !this._isSharedMaterial(material)) {
        material.dispose();
      }
    });
    this.objects.delete(id);
    this.interactive.delete(id);
    this.manipulable.delete(id);
    this.billboards.delete(id);
    this.opacities.delete(id);
    this.lightDirections.delete(id);
    this.lightIds.delete(id);
    this.worldGroups.delete(id);
    this.bodySpecs.delete(id);
  }

  _isSharedGeometry(geometry) {
    return this._sharedGeometries.has(geometry);
  }

  _isSharedMaterial(material) {
    return this._sharedMaterials.has(material);
  }

  setParent(id, parentId) {
    const object = this.objects.get(id);
    if (!object) return;
    if (parentId === -1) {
      object.removeFromParent();
      this.opacityDirty = true;
      return;
    }
    const parent = parentId === 0 ? this.root : this.objects.get(parentId);
    if (!parent) {
      this.warnOnce(`parent:${parentId}`, `parent id ${parentId} is unknown; "${object.name}" left detached`);
      return;
    }
    // `add` keeps the local transform, which is what the command stream carries.
    parent.add(object);
    this.opacityDirty = true;
  }

  setTransform(id, command) {
    const object = this.objects.get(id);
    if (!object) return;
    if (!finiteRecord(command, 1)) {
      this.recordError('transform', id, new Error('the transform is not finite and was skipped'));
      return;
    }
    object.position.set(command[2], command[3], command[4]);
    object.quaternion.set(command[5], command[6], command[7], command[8]);
    object.scale.set(command[9], command[10], command[11]);
    object.updateMatrix();
    // TRANSFORM on a dynamic body is a teleport (SPEC 3.7); applied after the batch
    // so the object's world matrix is final.
    if (this.physics && this.physics.isDynamic(id)) this._pendingTeleports.add(id);
  }

  /**
   * Batched local TRS for every object that moved this frame (SPEC 5
   * `transforms`): packed `[id, px,py,pz, qx,qy,qz,qw, sx,sy,sz]` records. The
   * core reuses its buffer between frames, so the records are consumed here and
   * never retained.
   */
  setTransforms(records) {
    if (!records || !records.length) return;
    const count = Math.floor(records.length / 11);
    for (let record = 0, o = 0; record < count; record++, o += 11) {
      // Ids are integers below 2^24, which float32 holds exactly.
      const id = records[o];
      const object = this.objects.get(id);
      if (!object) continue;
      if (!finiteRecord(records, o)) {
        this.recordError('transforms record', id, new Error('the record is not finite and was skipped'));
        continue;
      }
      object.position.set(records[o + 1], records[o + 2], records[o + 3]);
      object.quaternion.set(records[o + 4], records[o + 5], records[o + 6], records[o + 7]);
      object.scale.set(records[o + 8], records[o + 9], records[o + 10]);
      object.updateMatrix();
      // Same semantics as `transform`: a dynamic body is teleported.
      if (this.physics && this.physics.isDynamic(id)) this._pendingTeleports.add(id);
    }
    this._lastTransformRecords += count;
  }

  setVisible(id, visible) {
    this.withObject(id, (o) => { o.visible = visible; });
  }

  setBillboard(id, on) {
    if (on) this.billboards.add(id); else this.billboards.delete(id);
  }

  setManipulable(id, on) {
    if (on) this.manipulable.add(id); else this.manipulable.delete(id);
  }

  // -------------------------------------------------------------- geometry

  setGeometry(id, info, positions, normals, uvs, indices) {
    const object = this.objects.get(id);
    if (!object || !object.isMesh) return;
    if (this.portals.has(id)) return;

    const previous = object.geometry;
    this.checkPayloadKeys('geometry', info, KNOWN_KEYS.geometry);
    const entry = this._acquireGeometry(id, info, positions, normals, uvs, indices);
    object.geometry = entry.geometry;
    object.userData.__spatialGeometry = entry.info;

    // WEB-03: a swapped or rewritten geometry means the collider must be derived
    // again, which the in-place body update would not do.
    if (this.bodySpecs.has(id) && (entry.changed || previous !== entry.geometry)) {
      this._pendingBodies.set(id, { spec: this.bodySpecs.get(id), rebuild: true });
    }
  }

  /**
   * Returns the shared BufferGeometry for this uuid, building or refilling it
   * only when the buffers actually differ. Without a uuid (an older core) every
   * command gets its own geometry.
   */
  _acquireGeometry(id, info, positions, normals, uvs, indices) {
    const uuid = info && info.uuid;
    const revision = info && info.revision;
    let entry = uuid ? this.geometries.get(uuid) : null;
    let changed = true;

    if (entry) {
      // A `geometry` command for a uuid and revision the core has already sent
      // arrives with null buffers, so the cached instance is reused untouched.
      changed = revision === undefined || revision !== entry.revision;
      if (changed) {
        if (!positions) {
          // New revision but no data: nothing can be rebuilt from this command.
          this.warnOnce(
            `geometryBuffers:${uuid}`,
            `geometry ${uuid} changed to revision ${revision} without buffers; the previous data is kept`,
          );
          changed = false;
        } else {
          this._fillGeometry(entry.geometry, positions, normals, uvs, indices);
          entry.revision = revision;
        }
      }
      entry.info = info;
    } else {
      if (!positions) {
        // The core believes this consumer already has the geometry, but the
        // cache entry is gone: keeping idle entries below is what avoids this.
        this.warnOnce(
          `geometryMissing:${uuid}`,
          `geometry ${uuid} was re-sent without buffers but is no longer cached; the mesh has no geometry`,
        );
      }
      const geometry = new THREE.BufferGeometry();
      if (positions) this._fillGeometry(geometry, positions, normals, uvs, indices);
      entry = { geometry, users: new Set(), info, uuid, revision };
      if (uuid) this.geometries.set(uuid, entry);
      this._sharedGeometries.add(geometry);
    }

    entry.changed = changed;
    this._releaseGeometry(id, entry);
    entry.users.add(id);
    this.geometryOf.set(id, entry);
    this._idleGeometries.delete(uuid);
    return entry;
  }

  /**
   * A geometry with no users keeps its cache entry, because the core will not
   * re-send the buffers for a uuid and revision it has already delivered. The
   * GPU side is released; the idle entries are kept in insertion order and the
   * oldest are dropped once there are too many.
   */
  _retireGeometry(entry) {
    entry.geometry.dispose();
    if (!entry.uuid) {
      this._sharedGeometries.delete(entry.geometry);
      return;
    }
    this._idleGeometries.delete(entry.uuid);
    this._idleGeometries.add(entry.uuid);
    while (this._idleGeometries.size > MAX_IDLE_GEOMETRIES) {
      const oldest = this._idleGeometries.values().next().value;
      this._idleGeometries.delete(oldest);
      const stale = this.geometries.get(oldest);
      if (!stale || stale.users.size) continue;
      this.geometries.delete(oldest);
      this._sharedGeometries.delete(stale.geometry);
    }
  }

  /**
   * Writes the buffers into a geometry. Attributes are refilled in place when the
   * counts match, so three re-uploads them and the bounding volumes, on which
   * raycasting and culling depend, stay in step.
   */
  _fillGeometry(geometry, positions, normals, uvs, indices) {
    this._setAttribute(geometry, 'position', positions, 3);
    this._setAttribute(geometry, 'normal', normals, 3);
    this._setAttribute(geometry, 'uv', uvs, 2);
    if (indices) {
      const array = toUint32(indices);
      const existing = geometry.index;
      if (existing && existing.array.length === array.length) {
        existing.array.set(array);
        existing.needsUpdate = true;
      } else {
        geometry.setIndex(new THREE.BufferAttribute(array, 1));
      }
    } else {
      geometry.setIndex(null);
    }
    if (!normals) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }

  _setAttribute(geometry, name, values, itemSize) {
    if (!values) {
      if (geometry.getAttribute(name)) geometry.deleteAttribute(name);
      return;
    }
    const array = toFloat32(values);
    const existing = geometry.getAttribute(name);
    if (existing && existing.array.length === array.length) {
      // Same shape: copy into the live buffer and let three re-upload it.
      if (existing.array !== array) existing.array.set(array);
      existing.needsUpdate = true;
      return;
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }

  /** Drops `id` from its previous geometry, freeing the GPU buffers with the last user. */
  _releaseGeometry(id, keep = null) {
    const previous = this.geometryOf.get(id);
    if (!previous || previous === keep) return;
    previous.users.delete(id);
    this.geometryOf.delete(id);
    if (previous.users.size === 0) this._retireGeometry(previous);
  }

  // -------------------------------------------------------------- materials

  setMaterial(id, spec) {
    const object = this.objects.get(id);
    if (!object || !object.isMesh || !spec) return;
    if (this.portals.has(id)) return;
    const previous = object.material;
    const entry = this._acquireMaterial(id, spec);
    object.material = entry.material;
    // The placeholder material a mesh is created with is owned by nobody else.
    if (previous && previous !== entry.material && previous.userData.__placeholder) previous.dispose();
    this.opacityDirty = true;
  }

  /**
   * Returns the shared material for this uuid. A changed spec is written into the
   * existing instance so every mesh using it updates at once (SPEC 5).
   */
  _acquireMaterial(id, spec) {
    const uuid = spec.uuid;
    let entry = uuid ? this.materials.get(uuid) : null;
    if (entry && entry.type !== spec.type) {
      // A different material class under a recycled uuid: start over.
      this._disposeMaterialEntry(entry);
      entry = null;
    }
    if (entry) {
      const key = JSON.stringify(spec);
      if (entry.key !== key) {
        this.applyMaterial(entry.material, spec);
        entry.key = key;
        entry.revision += 1;
        this.opacityDirty = true;
      }
    } else {
      const material = this.buildMaterial(spec);
      entry = { material, users: new Set(), key: JSON.stringify(spec), revision: 0, uuid, type: spec.type };
      if (uuid) this.materials.set(uuid, entry);
      this._sharedMaterials.add(material);
    }
    this._releaseMaterial(id, entry);
    entry.users.add(id);
    this.materialOf.set(id, entry);
    return entry;
  }

  /** Drops `id` from its previous material, disposing it with the last user. */
  _releaseMaterial(id, keep = null) {
    const previous = this.materialOf.get(id);
    const clone = this.opacityMaterials.get(id);
    if (clone && previous !== keep) {
      clone.dispose();
      this.opacityMaterials.delete(id);
    }
    if (!previous || previous === keep) return;
    previous.users.delete(id);
    this.materialOf.delete(id);
    if (previous.users.size === 0) this._disposeMaterialEntry(previous);
  }

  _disposeMaterialEntry(entry) {
    entry.material.dispose();
    this._sharedMaterials.delete(entry.material);
    if (entry.uuid && this.materials.get(entry.uuid) === entry) this.materials.delete(entry.uuid);
  }

  buildMaterial(spec) {
    let material;
    switch (spec.type) {
      case 'MeshBasicMaterial':
        material = new THREE.MeshBasicMaterial();
        break;
      case 'MeshPhysicalMaterial':
        material = new THREE.MeshPhysicalMaterial();
        break;
      case 'OcclusionMaterial':
        // Depth-only: occludes what is behind it without drawing colour.
        material = new THREE.MeshBasicMaterial();
        material.colorWrite = false;
        break;
      default:
        material = new THREE.MeshStandardMaterial();
    }
    this.applyMaterial(material, spec);
    return material;
  }

  /** Writes the full material state from a `material` command onto an instance. */
  applyMaterial(material, spec) {
    this.checkPayloadKeys('material', spec, KNOWN_KEYS.material);
    if (spec.color) material.color.setRGB(spec.color[0], spec.color[1], spec.color[2], THREE.LinearSRGBColorSpace);
    material.opacity = spec.opacity ?? 1;
    material.transparent = !!spec.transparent;
    material.side = resolveConstant(spec.side, SIDES, THREE.FrontSide);
    material.wireframe = !!spec.wireframe;
    material.depthWrite = spec.depthWrite ?? true;
    material.depthTest = spec.depthTest ?? true;
    material.blending = resolveConstant(spec.blending, BLENDING, THREE.NormalBlending);

    if (material.isMeshStandardMaterial) {
      material.metalness = spec.metalness ?? 0;
      material.roughness = spec.roughness ?? 1;
      if (spec.emissive) {
        material.emissive.setRGB(spec.emissive[0], spec.emissive[1], spec.emissive[2], THREE.LinearSRGBColorSpace);
      }
      material.emissiveIntensity = spec.emissiveIntensity ?? 1;
    }
    if (material.isMeshPhysicalMaterial) {
      material.clearcoat = spec.clearcoat ?? 0;
      material.clearcoatRoughness = spec.clearcoatRoughness ?? 0;
    }

    const maps = spec.maps || {};
    this._bindMap(material, 'map', maps.map, THREE.SRGBColorSpace);
    this._bindMap(material, 'normalMap', maps.normalMap, THREE.NoColorSpace);
    this._bindMap(material, 'roughnessMap', maps.roughnessMap, THREE.NoColorSpace);
    this._bindMap(material, 'metalnessMap', maps.metalnessMap, THREE.NoColorSpace);
    this._bindMap(material, 'emissiveMap', maps.emissiveMap, THREE.SRGBColorSpace);

    material.userData.__baseOpacity = material.opacity;
    material.userData.__baseTransparent = material.transparent;
    return material;
  }

  _bindMap(material, slot, textureId, colorSpace) {
    if (!(slot in material)) return;
    if (textureId === null || textureId === undefined) {
      material[slot] = null;
      return;
    }
    const entry = this.textures.get(textureId);
    if (!entry) {
      this.warnOnce(`texture:${textureId}`, `material references unknown texture id ${textureId}`);
      return;
    }
    material[slot] = this._textureForColorSpace(entry, colorSpace);
    material.needsUpdate = true;
  }

  /**
   * WEB-18: colour space belongs to the binding, not the image. The first binding
   * uses the loaded texture; a second binding that needs a different space gets a
   * clone sharing the same image, so neither material is decoded wrongly.
   */
  _textureForColorSpace(entry, colorSpace) {
    if (entry.texture.colorSpace === colorSpace || entry.views.size === 0) {
      entry.texture.colorSpace = colorSpace;
      entry.views.set(colorSpace, entry.texture);
      return entry.texture;
    }
    const existing = entry.views.get(colorSpace);
    if (existing) return existing;
    const clone = entry.texture.clone();
    clone.colorSpace = colorSpace;
    clone.needsUpdate = !!clone.image;
    entry.views.set(colorSpace, clone);
    return clone;
  }

  // --------------------------------------------------------------- textures

  /**
   * Resolves a script url. `asset://name` and a relative path are contained to
   * the asset root: the path is normalised and anything that climbs out of the
   * root is refused with a warning rather than reaching the network or the disk
   * (SPEC 3.5). Absolute http, file, data and blob urls are passed through, with
   * any `user:password@` stripped so credentials never reach a log or a dump.
   */
  resolveUrl(url) {
    if (!url) return url;
    if (url.startsWith('asset://')) {
      return this._containedUrl(this.options.assetRoot || '/web/assets', url.slice('asset://'.length), url);
    }
    if (/^(https?:|file:|data:|blob:)/.test(url)) return stripCredentials(url);
    // A root-relative path is already absolute for the page, and cannot escape.
    if (url.startsWith('/')) return url;
    const root = this.options.scriptRoot;
    if (!root) return url;
    return this._containedUrl(root, url, url);
  }

  /** Joins `path` onto `root`, refusing a result outside it. */
  _containedUrl(root, path, original) {
    const base = String(root).replace(/\/+$/, '');
    // Percent-encoded separators are still separators: `..%2f..%2fx` must be read
    // as `../../x`, so the path is decoded until it stops changing before it is
    // split. Each surviving segment is re-encoded for the request.
    const segments = [];
    for (const raw of fullyDecode(String(path)).split(/[/\\]/)) {
      if (raw === '' || raw === '.') continue;
      if (raw === '..') {
        if (segments.length === 0) {
          this.warnOnce(
            `urlEscape:${original}`,
            `"${original}" resolves outside the asset root and was refused`,
          );
          return null;
        }
        segments.pop();
        continue;
      }
      segments.push(encodeURIComponent(raw));
    }
    if (!segments.length) {
      this.warnOnce(`urlEmpty:${original}`, `"${original}" names no file inside the asset root and was refused`);
      return null;
    }
    return `${base}/${segments.join('/')}`;
  }

  /**
   * SPEC 5 `texture`. A `null` payload releases the id. A changed url keeps the
   * same THREE.Texture instance and loads new pixels into it, so materials that
   * are already bound stay valid (WEB-12).
   */
  setTexture(textureId, spec) {
    if (spec === null || spec === undefined) {
      this.releaseTexture(textureId);
      return;
    }
    this.checkPayloadKeys('texture', spec, KNOWN_KEYS.texture);
    const url = this.resolveUrl(spec.url);
    if (url === null) return;
    let entry = this.textures.get(textureId);
    if (!entry) {
      entry = {
        texture: this._createTexture(textureId, url),
        views: new Map(),
        url,
        sourceUrl: spec.url,
      };
      this.textures.set(textureId, entry);
    } else if (entry.url !== url) {
      entry.url = url;
      entry.sourceUrl = spec.url;
      this._loadImageInto(entry, url, textureId);
    }

    for (const texture of this._textureViews(entry)) {
      if (spec.repeat) texture.repeat.set(spec.repeat[0], spec.repeat[1]);
      if (spec.offset) texture.offset.set(spec.offset[0], spec.offset[1]);
      texture.wrapS = resolveConstant(spec.wrapS, WRAPPING, THREE.ClampToEdgeWrapping);
      texture.wrapT = resolveConstant(spec.wrapT, WRAPPING, THREE.ClampToEdgeWrapping);
      texture.flipY = spec.flipY ?? true;
      // Marking an image-less texture for update makes three warn on every frame;
      // the loader sets needsUpdate itself once the pixels arrive.
      if (texture.image) texture.needsUpdate = true;
    }
  }

  _textureViews(entry) {
    const views = new Set([entry.texture]);
    for (const view of entry.views.values()) views.add(view);
    return views;
  }

  /** Frees the texture once nothing references it and drops the id (SPEC 5). */
  releaseTexture(textureId) {
    const entry = this.textures.get(textureId);
    if (!entry) return;
    this.textures.delete(textureId);
    // In-flight loads for this id are now stale.
    entry.released = true;
    if (this._textureIsReferenced(entry)) {
      this.warnOnce(
        `textureRelease:${textureId}`,
        `texture ${textureId} was released while a material still references it; it is kept until the material changes`,
      );
      return;
    }
    for (const texture of this._textureViews(entry)) texture.dispose();
  }

  _textureIsReferenced(entry) {
    const views = this._textureViews(entry);
    const uses = (material) => MAP_SLOTS.some((slot) => views.has(material[slot]));
    for (const cached of this.materials.values()) if (uses(cached.material)) return true;
    for (const clone of this.opacityMaterials.values()) if (uses(clone)) return true;
    return false;
  }

  /**
   * Creates the texture for an id. Loader callbacks are tied to the generation
   * they started in, so a result that lands after a hot swap is dropped instead
   * of resolving against whatever object now owns that id (WEB-07).
   */
  _createTexture(textureId, url) {
    if (this.options.loadTexture) return this.options.loadTexture(url, textureId);
    if (!this.textureLoader) {
      // Headless (node) consumer: record the texture without fetching pixels.
      const texture = new THREE.Texture();
      texture.userData.__pending = true;
      return texture;
    }
    const texture = new THREE.Texture();
    this._loadImageInto({ texture, views: new Map() }, url, textureId);
    return texture;
  }

  /** Loads `url` into an existing texture instance and every colour-space view. */
  _loadImageInto(entry, url, textureId) {
    if (!this.textureLoader || this.manualBridge) return;
    if (!this.imageLoader) this.imageLoader = new THREE.ImageLoader();
    const generation = this.generation;
    this.pendingLoads += 1;
    this.imageLoader.load(
      url,
      (image) => {
        this.pendingLoads -= 1;
        if (generation !== this.generation || entry.released) return;
        for (const texture of this._textureViews(entry)) {
          texture.image = image;
          texture.needsUpdate = true;
        }
        if (textureId !== null && this.textures.get(textureId) === entry) {
          this.dispatch('textureLoaded', textureId, {});
        }
      },
      undefined,
      () => {
        this.pendingLoads -= 1;
        if (generation !== this.generation || entry.released) return;
        // A missing texture is a resource problem, not a scene error: the script
        // hears about it through the texture's own error event.
        const message = `texture failed to load: ${url}`;
        this.warnOnce(`textureLoad:${url}`, message);
        if (textureId !== null && this.textures.get(textureId) === entry) {
          this.dispatch('textureError', textureId, { message });
        }
      },
    );
  }

  // ----------------------------------------------------------------- lights

  setLight(id, spec) {
    const light = this.objects.get(id);
    if (!light || !light.isLight || !spec) return;
    this.checkPayloadKeys('light', spec, KNOWN_KEYS.light);
    if (spec.type && !LIGHT_TYPES.has(spec.type)) {
      this.warnOnce(`lightType:${spec.type}`, `unknown light type "${spec.type}" was applied as ${lightKindOf(light)}`);
    }
    if (spec.color) light.color.setRGB(spec.color[0], spec.color[1], spec.color[2], THREE.LinearSRGBColorSpace);
    // three.js already uses the physical units the SPEC describes; the lumen and
    // lux conversions in SPEC 3.6 are for the RealityKit consumer only.
    light.intensity = spec.intensity ?? 1;
    if (light.isPointLight || light.isSpotLight) {
      light.distance = spec.distance ?? 0;
      light.decay = spec.decay ?? 2;
    }
    if (light.isSpotLight) {
      light.angle = spec.angle ?? Math.PI / 3;
      light.penumbra = spec.penumbra ?? 0;
    }
    light.castShadow = !!spec.castShadow;
    if (light.shadow) this._configureShadow(light);
    this.lightDirections.set(id, spec.direction || null);
    this._updateLightTarget(id);
  }

  _configureShadow(light) {
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.02;
    const camera = light.shadow.camera;
    camera.near = 0.01;
    camera.far = 30;
    if (light.isDirectionalLight) {
      // Scenes are roughly a metre across; a tight frustum keeps the map sharp.
      camera.left = -2; camera.right = 2; camera.top = 2; camera.bottom = -2;
    }
    camera.updateProjectionMatrix();
  }

  /** Places the light's target one metre along the world direction from the light. */
  _updateLightTarget(id) {
    const light = this.objects.get(id);
    if (!light || !light.target) return;
    const direction = this.lightDirections.get(id);
    light.updateWorldMatrix(true, false);
    _v3.setFromMatrixPosition(light.matrixWorld);
    if (direction) {
      light.target.position.set(_v3.x + direction[0], _v3.y + direction[1], _v3.z + direction[2]);
    } else {
      light.target.position.set(_v3.x, _v3.y - 1, _v3.z);
    }
    light.target.updateMatrixWorld(true);
  }

  /**
   * The consumer never adds lights of its own. The macOS host does not either, so a
   * scene that declares none renders black on both backends; inventing a key
   * light here would make the browser disagree with RealityKit (SPEC 12: nothing
   * silently no-ops, so the condition is warned about instead).
   */
  ensureDefaultLighting() {
    if (this.lightIds.size > 0) return;
    this.warnOnce(
      'noLights',
      'the scene has no lights; meshes with lit materials render black',
    );
  }

  // -------------------------------------------------------------- opacity

  /**
   * OpacityComponent semantics: multiply down the hierarchy without touching the
   * material's own opacity. Materials are shared between meshes, so an object
   * whose effective opacity is below one gets a private clone; at full opacity it
   * goes back to the shared instance.
   */
  applyOpacity() {
    const walk = (object, accumulated) => {
      const id = object.userData ? object.userData.__spatialId : undefined;
      const own = id !== undefined ? (this.opacities.get(id) ?? 1) : 1;
      const value = accumulated * own;
      // A portal owns its render-target surface; nothing else may reassign it.
      if (object.isMesh && object.material && !Array.isArray(object.material) && !this.portals.has(id)) {
        const entry = id === undefined ? null : this.materialOf.get(id);
        if (entry) this._applyObjectOpacity(object, id, entry, value);
        else this._applyInlineOpacity(object.material, value);
      }
      const emitter = id === undefined ? null : this.emitters.get(id);
      // SPEC 3.2 multiplies down the whole subtree, particles included (WEB-30).
      if (emitter) emitter.setOpacity(value);
      for (const child of object.children) walk(child, value);
    };
    for (const root of this.consumerRoots()) walk(root, 1);
  }

  _applyObjectOpacity(object, id, entry, value) {
    const clone = this.opacityMaterials.get(id);
    if (value >= 1) {
      if (clone) {
        clone.dispose();
        this.opacityMaterials.delete(id);
      }
      object.material = entry.material;
      return;
    }
    let target = clone;
    if (!target || target.userData.__sourceRevision !== entry.revision) {
      if (target) target.dispose();
      target = entry.material.clone();
      target.userData.__sourceRevision = entry.revision;
      this.opacityMaterials.set(id, target);
    }
    target.opacity = (entry.material.userData.__baseOpacity ?? 1) * value;
    target.transparent = true;
    object.material = target;
  }

  /** Materials the command stream does not own, such as those inside a loaded asset. */
  _applyInlineOpacity(material, value) {
    const base = material.userData.__baseOpacity ?? material.opacity;
    material.userData.__baseOpacity = base;
    const baseTransparent = material.userData.__baseTransparent ?? material.transparent;
    material.userData.__baseTransparent = baseTransparent;
    material.opacity = base * value;
    material.transparent = baseTransparent || value < 1;
  }

  // ------------------------------------------------------------- particles

  setParticles(id, spec) {
    const object = this.objects.get(id);
    if (!object) return;
    this.checkPayloadKeys('particles', spec, KNOWN_KEYS.particles);
    let emitter = this.emitters.get(id);
    if (!emitter) {
      emitter = new ParticleEmitter(object, id * 2654435761 + 1);
      this.emitters.set(id, emitter);
    }
    emitter.configure(spec, (textureId) => {
      if (textureId === null || textureId === undefined) return null;
      const entry = this.textures.get(textureId);
      return entry ? this._textureForColorSpace(entry, THREE.SRGBColorSpace) : null;
    });
  }

  // -------------------------------------------------------- anchors, portals

  setAnchor(id, spec) {
    const object = this.objects.get(id);
    if (!object || !spec) return;
    object.userData.__spatialAnchor = spec;
    this.checkPayloadKeys('anchor', spec, KNOWN_KEYS.anchor);
    if (spec.kind && !ANCHOR_KINDS.has(spec.kind)) {
      this.warnOnce(`anchorKind:${spec.kind}`, `unknown anchor kind "${spec.kind}" was created as a plain group`);
    }
    const isHead = spec.kind === 'head';
    if (isHead) {
      // Head-anchored content rides the camera on web.
      this.camera.add(object);
    }
    // Every other anchor type is a plain group; `isAnchored` stays false on web.
  }

  setPortal(id, spec) {
    const mesh = this.objects.get(id);
    if (!mesh || !spec) return;
    this.checkPayloadKeys('portal', spec, KNOWN_KEYS.portal);
    let portal = this.portals.get(id);
    if (!portal) {
      // The Portal replaces the plane the core sent, so give up its shared
      // geometry and material entries before taking ownership of the surface.
      this._releaseGeometry(id);
      this._releaseMaterial(id);
      portal = new Portal(mesh, spec, this.options.portalResolution || 1024);
      this.portals.set(id, portal);
    } else {
      portal.resize(spec);
    }
    portal.spec = spec;
    if (spec.crossing) {
      this.warnOnce('portalCrossing', 'Portal crossing is unsupported in the three.js consumer');
    }
  }

  setWorld(id, isWorld) {
    if (isWorld) this.worldGroups.add(id); else this.worldGroups.delete(id);
  }

  // ---------------------------------------------------------------- assets

  loadAsset(id, spec) {
    const object = this.objects.get(id);
    if (!object || !spec) return;
    this.checkPayloadKeys('asset', spec, KNOWN_KEYS.asset);
    this.assetSpecs.set(id, spec);
    const url = spec.glb || spec.gltf;
    if (!url) {
      const message = 'no glb or gltf source for this asset';
      this.warnOnce(`asset:${id}`, message);
      this.dispatch('assetError', id, { message });
      return;
    }
    // WEB-05/07: the load is tied to this object and this generation. A result
    // that lands after the object was destroyed, or after a hot swap, is thrown
    // away rather than resurrecting the entry or dispatching to a reused id.
    if (this.manualBridge) {
      // The caller is standing in for the loader and will dispatch the result.
      return;
    }
    const resolved = this.resolveUrl(url);
    if (resolved === null) {
      const message = `asset url "${url}" resolves outside the asset root`;
      this.dispatch('assetError', id, { message });
      return;
    }
    const generation = this.generation;
    this.pendingLoads += 1;
    this.gltfLoader.load(
      resolved,
      (gltf) => {
        this.pendingLoads -= 1;
        if (generation !== this.generation || this.objects.get(id) !== object) {
          disposeSubtree(gltf.scene);
          return;
        }
        object.add(gltf.scene);
        const clips = gltf.animations || [];
        const mixer = new THREE.AnimationMixer(gltf.scene);
        this.assets.set(id, { mixer, clips, action: null, root: gltf.scene });
        const box = new THREE.Box3().setFromObject(gltf.scene);
        this.dispatch('assetLoaded', id, {
          animations: clips.map((clip) => clip.name),
          boundingBox: [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z],
        });
        this.opacityDirty = true;
      },
      undefined,
      (err) => {
        this.pendingLoads -= 1;
        if (generation !== this.generation || this.objects.get(id) !== object) return;
        const message = `asset failed to load: ${url} (${err && err.message ? err.message : err})`;
        this.warnOnce(`assetLoad:${url}`, message);
        this.dispatch('assetError', id, { message });
      },
    );
  }

  setAssetAnimation(id, name, loop, speed) {
    const entry = this.assets.get(id);
    if (!entry) return;
    if (entry.action) {
      entry.action.stop();
      entry.action = null;
    }
    if (name === null || name === undefined) return;
    const clip = entry.clips.find((c) => c.name === name);
    if (!clip) {
      this.warnOnce(`clip:${id}:${name}`, `asset animation "${name}" not found`);
      return;
    }
    const action = entry.mixer.clipAction(clip);
    action.setLoop(loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = loop === false;
    action.timeScale = speed ?? 1;
    action.reset().play();
    entry.action = action;
  }

  // ----------------------------------------------------------- environment

  setEnvironment(spec) {
    if (!spec) {
      this._disposeEnvironment();
      return;
    }
    this.checkPayloadKeys('environment', spec, KNOWN_KEYS.environment);
    const url = this.resolveUrl(spec.url);
    this.scene.environmentIntensity = spec.intensity ?? 1;
    if (url === null) {
      this._disposeEnvironment();
      return;
    }
    // SPEC 3.6: equirectangular .hdr, .png and .jpg load on both backends;
    // .exr is RealityKit only and warns once here.
    if (/\.exr(\?|#|$)/i.test(spec.url || '')) {
      this.warnOnce(
        'environmentFormat',
        `.exr environments are unsupported in the three.js consumer (${spec.url})`,
      );
      this._disposeEnvironment();
      this.scene.environmentIntensity = spec.intensity ?? 1;
      return;
    }
    if (/\.hdr(\?|#|$)/i.test(spec.url || '')) {
      this._loadRadianceEnvironment(url);
      return;
    }
    const texture = new THREE.Texture();
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    this._setEnvironmentTexture(texture);
    this._loadImageInto({ texture, views: new Map() }, url, null);
  }

  /** Owns the environment texture so a replacement or a reset frees it (WEB-11). */
  _setEnvironmentTexture(texture) {
    if (this._environmentTexture && this._environmentTexture !== texture) {
      this._environmentTexture.dispose();
    }
    this._environmentTexture = texture;
    this.scene.environment = texture;
  }

  _disposeEnvironment() {
    if (this._environmentTexture) {
      this._environmentTexture.dispose();
      this._environmentTexture = null;
    }
    if (this._environmentTarget) {
      this._environmentTarget.dispose();
      this._environmentTarget = null;
    }
    this.scene.environment = null;
  }

  /**
   * Radiance .hdr equirectangular maps, through three's HDRLoader. The float data
   * is prefiltered here rather than left to the renderer's automatic conversion,
   * which does not pick up a half-float DataTexture.
   */
  _loadRadianceEnvironment(url) {
    if (!this.hdrLoader) this.hdrLoader = new HDRLoader();
    const generation = this.generation;
    this.pendingLoads += 1;
    this.hdrLoader.load(
      url,
      (texture) => {
        this.pendingLoads -= 1;
        if (generation !== this.generation) {
          texture.dispose();
          return;
        }
        texture.mapping = THREE.EquirectangularReflectionMapping;
        this._setEnvironmentTexture(this._prefilterEnvironment(texture));
      },
      undefined,
      () => {
        this.pendingLoads -= 1;
        if (generation !== this.generation) return;
        this.warnOnce(`environmentLoad:${url}`, `environment failed to load: ${url}`);
      },
    );
  }

  /** Builds the prefiltered radiance map, keeping the source texture disposed. */
  _prefilterEnvironment(texture) {
    if (!this.renderer) return texture;
    if (this._environmentTarget) this._environmentTarget.dispose();
    // The prefiltered target owns the result; the source is freed below.
    const generator = new THREE.PMREMGenerator(this.renderer);
    generator.compileEquirectangularShader();
    this._environmentTarget = generator.fromEquirectangular(texture);
    generator.dispose();
    texture.dispose();
    return this._environmentTarget.texture;
  }

  /** Texture id for the url the script used, for `dispatch` conformance steps. */
  textureIdForUrl(url) {
    for (const [id, entry] of this.textures) {
      if (entry.sourceUrl === url || entry.url === url) return id;
    }
    return undefined;
  }

  /** Asset id for any of the urls in its `asset` command. */
  assetIdForUrl(url) {
    for (const [id, spec] of this.assetSpecs) {
      for (const key of Object.keys(spec || {})) if (spec[key] === url) return id;
    }
    return undefined;
  }

  /**
   * Console output from the script. A script's own `console.error` is a log line,
   * not a scene error, so it never lands in `dump().errors`.
   */
  handleLog(level, message) {
    // PERF-10: a noisy script must not retain unbounded console output. At most
    // MAX_LOGS_PER_FRAME lines are kept per frame and MAX_LOGS in total; the rest
    // are counted so the drop is visible rather than silent.
    this._logsThisFrame += 1;
    if (this._logsThisFrame > MAX_LOGS_PER_FRAME) {
      if (this._logsThisFrame === MAX_LOGS_PER_FRAME + 1) {
        this._pushLog('warn', `... more log lines this frame were suppressed after ${MAX_LOGS_PER_FRAME}`);
      }
      this.droppedLogs += 1;
      return;
    }
    this._pushLog(level, message);
    this.write(level, message);
  }

  _pushLog(level, message) {
    if (this.logs.length >= MAX_LOGS) {
      this.logs.shift();
      this.droppedLogs += 1;
    }
    this.logs.push({ level, message });
  }

  // ------------------------------------------------------------------ frame

  /**
   * One deterministic frame: step physics, sync back, feed input, run the core,
   * apply the resulting commands, then advance consumer-side visuals.
   */
  tick(dt) {
    if (!this.core) return [];
    const frameStarted = now();
    this._logsThisFrame = 0;
    try {
      if (this.physics) {
        for (const event of this.physics.step(dt)) this._dispatchCollision(event);
        this._pushScriptDrivenBodies();
      }
      // WEB-14: manipulation reaches the core whether or not physics exists.
      if (!this.manualBridge) {
        this.core.sync(this._syncRecords());
        if (this.physics) this.core.syncBodies(this.physics.bodyRecords());
      }
    } catch (err) {
      this.recordError('physics sync', null, err);
    }
    try {
      const liveInput = this.input.consumeState();
      this.core.setInput(this._inputOverride || liveInput);
    } catch (err) {
      this.recordError('setInput', null, err);
    }
    this._inputOverride = null;
    let commands = [];
    const coreStarted = now();
    try {
      commands = this.core.tick(dt) || [];
    } catch (err) {
      // WEB-01: a failing tick is recorded, not thrown; the loop keeps running.
      this.recordError('core.tick', null, err);
    }
    const coreMs = now() - coreStarted;
    this.apply(commands);
    try {
      this.updateVisuals(dt);
    } catch (err) {
      this.recordError('frame update', null, err);
    }
    this.frame += 1;
    this.elapsed += dt;
    this._record(frameStarted, coreMs);
    return commands;
  }

  /** Keeps the last 120 frames, the same window the macOS host's /stats reports. */
  _record(frameStarted, coreMs) {
    const entry = {
      frame: this.frame,
      coreTickMs: coreMs,
      applyMs: this._lastApplyMs || 0,
      commandCount: this._lastCommandCount || 0,
      transformRecords: this._lastTransformRecords || 0,
      frameIntervalMs: this._lastFrameStart ? frameStarted - this._lastFrameStart : 0,
      objectCount: this.objects.size,
      geometryCount: this.geometries.size,
      materialCount: this.materials.size,
    };
    this._lastFrameStart = frameStarted;
    this.stats.push(entry);
    if (this.stats.length > 120) this.stats.shift();
  }

  _dispatchCollision(event) {
    const payload = (other, normal) => ({
      other,
      point: event.point,
      normal,
      impulse: event.impulse,
    });
    this.dispatch(event.type, event.idA, payload(event.idB, event.normal));
    if (this.mirrorCollisionEvents) {
      const flipped = [-event.normal[0], -event.normal[1], -event.normal[2]];
      this.dispatch(event.type, event.idB, payload(event.idA, flipped));
    }
  }

  /** Static and kinematic bodies are script-driven; push the core's pose into Rapier. */
  _pushScriptDrivenBodies() {
    for (const [id, entry] of this.physics.bodies) {
      // Triggers are kinematic whatever their `type` says (SPEC 3.7), so ask the
      // physics world rather than the spec.
      if (this.physics.isDynamic(id)) continue;
      const object = this.objects.get(id);
      if (!object) continue;
      object.matrixWorld.decompose(_v3, _quat, _scale);
      // WEB-29: billboard rotation is a consumer-side effect written behind the
      // core's back; feeding it into the body would spin the collider with the
      // camera, so only the position is pushed for a billboarded body.
      const billboarded = this.billboards.has(id);
      if (entry.body.isKinematic()) {
        entry.body.setNextKinematicTranslation({ x: _v3.x, y: _v3.y, z: _v3.z });
        if (!billboarded) {
          entry.body.setNextKinematicRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
        }
      } else {
        // Static bodies only move when the script moves them; re-posing every frame
        // would keep waking whatever is resting on them.
        const t = entry.body.translation();
        const r = entry.body.rotation();
        const moved = Math.abs(t.x - _v3.x) > 1e-6 || Math.abs(t.y - _v3.y) > 1e-6 || Math.abs(t.z - _v3.z) > 1e-6;
        const turned = Math.abs(r.x - _quat.x) > 1e-6 || Math.abs(r.y - _quat.y) > 1e-6
          || Math.abs(r.z - _quat.z) > 1e-6 || Math.abs(r.w - _quat.w) > 1e-6;
        if (moved) entry.body.setTranslation({ x: _v3.x, y: _v3.y, z: _v3.z }, true);
        if (turned && !billboarded) {
          entry.body.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true);
        }
      }
    }
  }

  /**
   * Physics transforms plus anything the consumer is driving through
   * manipulation. WEB-10: an id appears exactly once. A manipulated dynamic body
   * is driven by the pointer, so it is switched to kinematic for the duration and
   * its simulated pose is not reported.
   */
  _syncRecords() {
    const manipulated = this.input.manipulatedObjects();
    const manipulatedIds = new Set();
    for (const object of manipulated) {
      const id = this.idOf(object);
      if (id !== undefined) manipulatedIds.add(id);
    }
    this._applyManipulationToBodies(manipulatedIds);

    const physicsRecords = this.physics ? this.physics.transformRecords(manipulatedIds) : EMPTY_RECORDS;
    if (!manipulated.length) return physicsRecords;

    const total = physicsRecords.length + manipulatedIds.size * 11;
    if (this._syncScratch.length !== total) this._syncScratch = new Float32Array(total);
    this._syncScratch.set(physicsRecords, 0);
    let o = physicsRecords.length;
    const written = new Set();
    for (const object of manipulated) {
      const id = this.idOf(object);
      if (id === undefined || written.has(id)) continue;
      written.add(id);
      object.updateWorldMatrix(true, false);
      object.matrixWorld.decompose(_v3, _quat, _scale);
      this._syncScratch[o++] = id;
      this._syncScratch[o++] = _v3.x; this._syncScratch[o++] = _v3.y; this._syncScratch[o++] = _v3.z;
      this._syncScratch[o++] = _quat.x; this._syncScratch[o++] = _quat.y;
      this._syncScratch[o++] = _quat.z; this._syncScratch[o++] = _quat.w;
      this._syncScratch[o++] = _scale.x; this._syncScratch[o++] = _scale.y; this._syncScratch[o++] = _scale.z;
    }
    return this._syncScratch.subarray(0, o);
  }

  /**
   * Keeps Rapier in step with a manipulated body: kinematic and pointer-driven
   * while the gesture runs, dynamic again when it ends.
   */
  _applyManipulationToBodies(manipulatedIds) {
    if (!this.physics) return;
    for (const id of manipulatedIds) {
      if (this._manipulatedBodies.has(id)) continue;
      if (this.physics.beginManipulation(id)) this._manipulatedBodies.add(id);
    }
    for (const id of [...this._manipulatedBodies]) {
      if (manipulatedIds.has(id)) {
        const object = this.objects.get(id);
        if (object) this.physics.driveManipulated(id, object);
        continue;
      }
      this.physics.endManipulation(id);
      this._manipulatedBodies.delete(id);
    }
  }

  updateVisuals(dt) {
    this.ensureDefaultLighting();
    for (const id of this.lightDirections.keys()) this._updateLightTarget(id);
    this._updateBillboards();
    for (const emitter of this.emitters.values()) emitter.update(dt);
    for (const entry of this.assets.values()) entry.mixer.update(dt);
    if (this.opacityDirty) {
      this.applyOpacity();
      this.opacityDirty = false;
    }
    this.root.updateMatrixWorld(true);
  }

  _updateBillboards() {
    if (!this.billboards.size) return;
    this.camera.updateMatrixWorld(true);
    this.camera.getWorldQuaternion(_quat);
    for (const id of this.billboards) {
      const object = this.objects.get(id);
      if (!object) continue;
      if (object.parent) {
        object.parent.updateWorldMatrix(true, false);
        object.parent.getWorldQuaternion(_parentQuat);
        object.quaternion.copy(_parentQuat.invert()).multiply(_quat);
      } else {
        object.quaternion.copy(_quat);
      }
      object.updateMatrix();
    }
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

const _v3 = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _size = new THREE.Vector2();

const MAX_ERRORS = 200;
/** Geometries kept after their last user, so a re-send with null buffers works. */
const MAX_IDLE_GEOMETRIES = 128;
const MAX_LOGS_PER_FRAME = 200;
const MAX_LOGS = 5000;

/** The keys each payload is allowed to carry (SPEC 5). */
const KNOWN_KEYS = {
  material: new Set(['type', 'uuid', 'color', 'opacity', 'transparent', 'side', 'wireframe',
    'metalness', 'roughness', 'emissive', 'emissiveIntensity', 'clearcoat', 'clearcoatRoughness',
    'depthWrite', 'depthTest', 'blending', 'maps']),
  rigidBody: new Set(['type', 'mass', 'shape', 'requestedShape', 'friction', 'restitution',
    'linearDamping', 'angularDamping', 'isTrigger', 'gravity']),
  light: new Set(['type', 'color', 'intensity', 'distance', 'decay', 'angle', 'penumbra',
    'castShadow', 'direction']),
  particles: new Set(['preset', 'shape', 'shapeSize', 'birthRate', 'lifetime', 'lifetimeVariation',
    'speed', 'speedVariation', 'size', 'sizeVariation', 'color', 'colorEnd', 'opacity', 'opacityEnd',
    'spreadAngle', 'acceleration', 'isEmitting', 'burstCount', 'loops', 'texture']),
  anchor: new Set(['kind', 'plane', 'minimumBounds', 'hand', 'location', 'image', 'matrix']),
  portal: new Set(['worldId', 'width', 'height', 'crossing']),
  texture: new Set(['url', 'repeat', 'offset', 'wrapS', 'wrapT', 'flipY']),
  geometry: new Set(['type', 'uuid', 'revision', 'parameters']),
  asset: new Set(['usdz', 'reality', 'glb', 'gltf']),
  joint: new Set(['type', 'bodyA', 'bodyB', 'anchorA', 'anchorB', 'axis', 'limits']),
  environment: new Set(['url', 'intensity']),
};

/** Light `type` values SPEC 3.6 defines. */
const LIGHT_TYPES = new Set(['ambient', 'directional', 'point', 'spot']);
/** Anchor kinds SPEC 3.11 defines. */
const ANCHOR_KINDS = new Set(['head', 'plane', 'hand', 'image', 'world']);

/** Removes a `user:password@` authority so credentials never reach a log. */
function lightKindOf(light) {
  if (light.isDirectionalLight) return 'directional';
  if (light.isPointLight) return 'point';
  if (light.isSpotLight) return 'spot';
  return 'ambient';
}

function stripCredentials(url) {
  return url.replace(/^(https?:\/\/)[^/@]*@/i, '$1');
}

/** Percent-decodes until stable, never throwing on a malformed escape. */
function fullyDecode(value) {
  let current = value;
  for (let pass = 0; pass < 3; pass++) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}
const EMPTY_RECORDS = new Float32Array(0);
const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'];
/** Dispatch types that carry a load result rather than user input. */
const LOAD_EVENTS = new Set(['textureLoaded', 'textureError', 'assetLoaded', 'assetError']);

/** Frees the geometries, materials and textures a loaded subtree owns. */
function disposeSubtree(root) {
  if (!root) return;
  const seen = new Set();
  root.traverse((node) => {
    if (!node.isMesh) return;
    if (node.geometry && !seen.has(node.geometry)) {
      seen.add(node.geometry);
      node.geometry.dispose();
    }
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      for (const slot of MAP_SLOTS) {
        const texture = material[slot];
        if (texture && !seen.has(texture)) {
          seen.add(texture);
          texture.dispose();
        }
      }
      material.dispose();
    }
  });
  root.removeFromParent();
}

/** True when the 10 transform floats starting after `offset` are all finite. */
function finiteRecord(values, offset) {
  for (let i = 1; i <= 10; i++) if (!Number.isFinite(values[offset + i])) return false;
  return true;
}

const now = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

function resolveConstant(value, table, fallback) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value in table) return table[value];
  return fallback;
}

export function toFloat32(value) {
  if (value instanceof Float32Array) return value;
  return Float32Array.from(value || []);
}

export function toUint32(value) {
  if (value instanceof Uint32Array) return value;
  if (ArrayBuffer.isView(value)) return Uint32Array.from(value);
  return Uint32Array.from(value || []);
}
