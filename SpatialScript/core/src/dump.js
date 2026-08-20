// Spatial.dump() (SPEC section 8). A plain-object description of the core
// scene, used by the conformance suite and by the dev transport.

import { Vector3 } from "./three-exports.js";
import { safeString, push } from "./builtins.js";
import { materialSnapshot } from "./materials.js";
import { lightSnapshot } from "./diff.js";
import { interactiveFlags, refreshWorldMatrices } from "./object-extensions.js";
import { ParticleEmitter } from "./particles.js";
import { kindFor, entryForKind } from "./kinds.js";
import { Portal } from "./portal.js";

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
      if (nameFilter === null || nameFilter.has(object.name)) {
        let entry;
        try {
          entry = compact
            ? describeCompact(object, id, parentId)
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
    let parentId = -1;
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
    scene: scene ? { name: scene.name, userData: scene.userData } : null,
    objects,
    joints,
    gravity: [gravity.x, gravity.y, gravity.z],
    environment: runtime.environmentPayload(),
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
 * The cheap entry a polling host asks for: identity, hierarchy and pose,
 * rounded, with no geometry parameters, material, light or userData.
 */
function describeCompact(object, id, parentId) {
  worldPosition.setFromMatrixPosition(object.matrixWorld);
  return {
    id,
    name: object.name,
    type: object.type,
    parent: parentId,
    visible: object.visible,
    position: [round4(object.position.x), round4(object.position.y), round4(object.position.z)],
    quaternion: [
      round4(object.quaternion.x),
      round4(object.quaternion.y),
      round4(object.quaternion.z),
      round4(object.quaternion.w),
    ],
    scale: [round4(object.scale.x), round4(object.scale.y), round4(object.scale.z)],
    worldPosition: [round4(worldPosition.x), round4(worldPosition.y), round4(worldPosition.z)],
  };
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

  const material = object.material
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
  if (object.rigidBody) {
    const body = object.rigidBody;
    entry.velocity = [body.linearVelocity.x, body.linearVelocity.y, body.linearVelocity.z];
    entry.isSleeping = body.isSleeping;
  }

  return entry;
}
