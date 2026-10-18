// Spatial.dump() (SPEC section 8). A plain-object description of the core
// scene, used by the conformance suite and by the dev transport.

import { Vector3 } from "./three-exports.js";
import { safeString, push, objectKeys } from "./builtins.js";
import { materialSnapshot, materialForSlot, materialSlotCount } from "../materials/materials.js";
import { lightSnapshot } from "./diff.js";
import { interactiveFlags, refreshWorldMatrices } from "../scene/object-extensions.js";
import { ParticleEmitter } from "../scene/particles.js";
import { kindFor, entryForKind } from "./kinds.js";
import { Portal } from "../scene/portal.js";
import { accessibilityJSON } from "../runtime/features.js";
import { cameraPayload, createCameraScratch } from "../scene/camera.js";

const worldPosition = new Vector3();

/**
 * Builds the scene dump (SPEC section 8).
 *
 * `options` narrows the work so a host can poll cheaply (PERF-02):
 *   names   - only these objects, by name
 *   fields  - only these per-object keys (`name` is always present)
 *   compact - positions rounded to 4 decimals, no geometry parameters,
 *             no userData, no material or light payloads
 *   objects - false to omit the object list entirely
 */
export function buildDump(runtime, options) {
  const scene = runtime.scene;
  const opts = options === undefined || options === null ? EMPTY : options;
  const wantObjects = opts.objects !== false;
  const nameFilter = Array.isArray(opts.names) && opts.names.length > 0 ? new Set(opts.names) : null;
  const fieldFilter = Array.isArray(opts.fields) && opts.fields.length > 0 ? new Set(opts.fields) : null;
  const compact = opts.compact === true;


  // World matrices are only needed when object entries are built. The refresh
  // is iterative and per-object safe, so a frozen object cannot stop a dump.
  if (scene && wantObjects) {
    refreshWorldMatrices(scene, (object, error) => runtime.skipObject(object, error));
  }

  const objects = [];
  const worlds = new Set();
  const seen = new Set();

  if (scene && wantObjects && !compact) {
    // Collect portal worlds first so the `world` flag is right on every entry.
    scene.traverse((object) => {
      if (object instanceof Portal && object.world) worlds.add(object.world);
    });
  }

  // Iterative: a deep hierarchy must never overflow the stack here either.
  const stack = [];
  const parents = [];
  const pushChildren = (children, parentId) => {
    for (let i = children.length - 1; i >= 0; i -= 1) {
      push(stack, children[i]);
      push(parents, parentId);
    }
  };

  if (scene && wantObjects) pushChildren(scene.children, 0);
  const drain = () => {
    while (stack.length > 0) {
      const object = stack.pop();
      const parentId = parents.pop();
      if (seen.has(object)) continue;
      seen.add(object);
      const id = runtime.idForObject(object);
      // No id means the object is not tracked at all (the id space is
      // exhausted), so it is not in the command stream and not here (FA-47).
      if (id === 0) continue;
      if (nameFilter === null || nameFilter.has(object.name)) {
        let entry;
        try {
          entry = compact
            ? describeCompact(runtime, object, id, parentId, worlds)
            : describe(runtime, object, id, parentId, worlds);
        } catch (error) {
          // A frozen object or a hostile getter costs one entry, not the dump.
          entry = { id, name: safeString(object.name), parent: parentId, error: describeError(error) };
        }
        push(objects, fieldFilter === null ? entry : project(entry, fieldFilter));
      }
      pushChildren(object.children, id);
    }
  };
  drain();

  for (const root of wantObjects ? runtime.extraRoots : EMPTY_LIST) {
    if (seen.has(root)) continue;
    const parent = root.parent;
    // 0 is the mounted scene root; dump never mints an id for the Scene.
    // An adopted root reports the native root as its parent, the same as the
    // `["parent", id, 0]` the consumer was sent (SPEC 14.13).
    let parentId = 0;
    if (parent === scene && scene !== null) parentId = 0;
    else if (parent !== null && runtime.objectIds.has(parent)) parentId = runtime.objectIds.get(parent);
    push(stack, root);
    push(parents, parentId);
    drain();
  }

  const joints = runtime.physics.joints.map((joint) => ({
    id: runtime.jointIdFor(joint),
    ...joint.toJSON(),
  }));

  const gravity = runtime.physics.gravity;

  return {
    backend: runtime.env.backend,
    platform: runtime.env.platform,
    frame: runtime.time.frame,
    elapsed: runtime.time.elapsed,
    // Increments on every load so a consumer can tell one script's ids from
    // the next script's after a hot swap.
    loadGeneration: runtime.loadGeneration,
    // The script's own Scene, named exactly as the script named it (the empty
    // string when it never did), so the core dump and a native dump can be
    // compared on the scene block.
    scene: scene ? { name: typeof scene.name === "string" ? scene.name : "", userData: scene.userData } : null,
    objects,
    joints,
    gravity: [gravity.x, gravity.y, gravity.z],
    environment: runtime.environmentPayload(),
    // Phase 2 scene-level state (SPEC 14).
    isActive: runtime.active,
    audioMixer: runtime.audio.toJSON(),
    // The live value, not the last flushed one (P2-B-45): null means the
    // consumer's built-in camera.
    camera: runtime.camera === null ? null : cameraPayload(runtime.camera, createCameraScratch()),
    sceneUnderstanding: { ...runtime.sceneUnderstanding },
    render: { adaptiveResolution: runtime.render.adaptiveResolution === true },
    environmentLighting: { intensityExponent: runtime.environmentLighting.intensityExponent },
    debug: { modelView: runtime.debug.modelView },
    hostFunctions: runtime.hostChannel.functions,
    controllers: runtime.input.controllers.all.map((controller) => controller.toJSON()),
    warnings: runtime.warnings.slice(),
    errors: runtime.errors.slice(),
    droppedErrors: runtime.droppedErrors,
  };
}

const EMPTY = {};
const EMPTY_LIST = [];

function project(entry, fields) {
  const out = { id: entry.id, name: entry.name };
  for (const key of fields) {
    if (key in entry) out[key] = entry[key];
  }
  return out;
}

function describeError(error) {
  try {
    return `${error && error.name ? error.name : "Error"}: ${error && error.message ? error.message : error}`;
  } catch {
    return "Error";
  }
}

function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * The cheap entry a polling host asks for. SPEC 3.13 licenses exactly two
 * omissions — geometry parameters and userData — and rounds every number to
 * four decimals; everything else the full entry carries stays (FA-41).
 */
function describeCompact(runtime, object, id, parentId, worlds) {
  const entry = describe(runtime, object, id, parentId, worlds);
  // SPEC 3.13 omits the two keys entirely rather than nulling them (AR-21).
  if (entry.geometry !== null && entry.geometry !== undefined) delete entry.geometry.parameters;
  delete entry.userData;
  return round4Deep(entry, 0);
}

/** Rounds every number in a dump entry, in place, to four decimals. */
function round4Deep(value, depth) {
  if (typeof value === "number") return round4(value);
  if (value === null || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = round4Deep(value[i], depth + 1);
    return value;
  }
  const keys = objectKeys(value);
  for (let i = 0; i < keys.length; i += 1) {
    value[keys[i]] = round4Deep(value[keys[i]], depth + 1);
  }
  return value;
}

/** One payload per material slot, with the same clamping the diff applies. */
function materialSlots(runtime, object, materials) {
  const slots = [];
  const wanted = materialSlotCount(object, materials);
  for (let i = 0; i < wanted; i += 1) {
    const entry = materialForSlot(materials, i);
    push(slots, entry ? materialSnapshot(entry, runtime.boundTextureIdFor, null) : null);
  }
  return slots;
}

function describe(runtime, object, id, parentId, worlds) {
  worldPosition.setFromMatrixPosition(object.matrixWorld);

  const geometry = object.geometry
    ? {
        type: object.geometry.type,
        uuid: object.geometry.uuid,
        parameters: object.geometry.parameters ? { ...object.geometry.parameters } : null,
      }
    : null;

  // A mesh may carry one material or one per geometry group (SPEC 14.12). The
  // dump describes the slots the consumer was given, not the raw array: a
  // material no group can reach never left the core (FA-09).
  const material = Array.isArray(object.material)
    ? materialSlots(runtime, object, object.material)
    : object.material
      ? materialSnapshot(object.material, runtime.boundTextureIdFor, null)
      : null;

  const entry = {
    id,
    name: object.name,
    type: object.type,
    parent: parentId,
    visible: object.visible,
    position: [object.position.x, object.position.y, object.position.z],
    quaternion: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
    scale: [object.scale.x, object.scale.y, object.scale.z],
    worldPosition: [worldPosition.x, worldPosition.y, worldPosition.z],
    geometry,
    material,
    light: object.isLight ? lightSnapshot(object, null) : null,
    rigidBody: object.rigidBody ? object.rigidBody.toJSON() : null,
    // A ParticleEmitter reuses Object3D.opacity for the particle start opacity
    // (SPEC 3.10), so the object-level field reports the OpacityComponent
    // default instead, matching both native dumps.
    opacity: object instanceof ParticleEmitter ? 1 : object.opacity,
    billboard: object.billboard,
    groundingShadow: object.groundingShadow,
    hoverEffect: object.hoverEffect,
    manipulable: object.manipulable,
    castShadow: object.castShadow,
    receiveShadow: object.receiveShadow,
    renderOrder: object.renderOrder,
    interactive: interactiveFlags(object),
    world: worlds.has(object),
    userData: object.userData,
  };

  const kindEntry = entryForKind(kindFor(object));
  if (kindEntry !== null && typeof kindEntry.describe === "function") {
    kindEntry.describe(object, entry, runtime);
  }

  // Phase 2 state (SPEC 14), reported only on the objects that carry it.
  if (object.isAudio === true) {
    const audio = object.toJSON();
    audio.playing = object.isPlaying;
    audio.currentTime = object.currentTime;
    audio.duration = object.duration;
    entry.audio = audio;
  }
  if (object.isVideoScreen === true) {
    const video = object.toJSON();
    video.playing = object.isPlaying;
    video.currentTime = object.currentTime;
    video.duration = object.duration;
    video.error = object.error;
    entry.video = video;
  }
  if (object.characterController !== null && object.characterController !== undefined) {
    const controller = object.characterController;
    entry.characterController = controller.toJSON();
    entry.isOnGround = controller.isOnGround;
    entry.velocity = [controller.velocity.x, controller.velocity.y, controller.velocity.z];
  }
  if (object.isForceField === true) entry.forceField = object.toJSON();
  if (object.accessibility !== null && object.accessibility !== undefined) {
    entry.accessibility = accessibilityJSON(object.accessibility);
  }
  if (object.isAsset === true) {
    entry.skeleton = object.skeleton === null || object.skeleton === undefined ? null : object.skeleton.toJSON();
    entry.blendShapes =
      object.blendShapes === null || object.blendShapes === undefined ? null : object.blendShapes.toJSON();
  }
  if (object.rigidBody) {
    const body = object.rigidBody;
    entry.velocity = [body.linearVelocity.x, body.linearVelocity.y, body.linearVelocity.z];
    entry.isSleeping = body.isSleeping;
  }

  return entry;
}
