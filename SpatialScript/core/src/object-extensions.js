// SpatialScript additions to three's Object3D: the extra display flags from
// SPEC 3.2, rigid body attachment, bubbling event dispatch (SPEC 3.8), and
// shear bookkeeping for direct matrix writes.

import { Object3D, Matrix4, Vector3 } from "./three-exports.js";
import { SpatialUnsupportedError } from "./errors.js";
import { MAX_DEPTH, MAX_LISTENERS_PER_EVENT } from "./limits.js";
import { labelFor } from "./sanitize.js";
import { push, slice } from "./builtins.js";
import { host } from "./host.js";

const SHEAR_TOLERANCE = 1e-4;

const RIGID_BODY = Symbol("spatial.rigidBody");
const RAW_MATRIX = Symbol("spatial.rawMatrix");
const DESTROYED = Symbol("spatial.destroyed");

// Everything the diff would otherwise have to re-read from every object on
// every frame is behind a setter that raises a bit here instead. A static
// object then costs one integer read per frame rather than a dozen property
// reads and compares, which is what dominates in an interpreter.
export const DIRTY = Symbol("spatial.dirty");

export const DIRTY_NAME = 1;
export const DIRTY_VISIBLE = 2;
export const DIRTY_SHADOW = 4;
export const DIRTY_FLAGS = 8;
export const DIRTY_GEOMETRY = 16;
export const DIRTY_LISTENERS = 32;
export const DIRTY_RIGIDBODY = 64;
export const DIRTY_MATERIAL = 128;
export const DIRTY_LIGHT = 256;
export const DIRTY_ALL = 511;

/**
 * Defines an own-property-backed accessor on a prototype that raises `bit`
 * whenever the value is written. `initial` is what an object reads before
 * anything has been assigned.
 */
function trackedProperty(proto, name, bit, initial, allowed) {
  const backing = Symbol(`spatial.${name}`);
  Object.defineProperty(proto, name, {
    configurable: true,
    enumerable: true,
    get() {
      const value = this[backing];
      return value === undefined ? initial : value;
    },
    set(value) {
      if (allowed !== undefined && value !== null && allowed.indexOf(value) === -1) {
        throw new TypeError(
          `Object3D.${name} must be one of ${allowed.join(", ")} or null (got ${String(value)})`,
        );
      }
      this[backing] = value;
      this[DIRTY] = (this[DIRTY] | 0) | bit;
    },
  });
}

// SPEC 3.2 constrains hoverEffect to these values.
const HOVER_EFFECTS = ["highlight", "lift", "spotlight"];

const TAP_EVENTS = ["tap"];
const HOVER_EVENTS = ["hoverenter", "hoverexit"];
const DRAG_EVENTS = ["dragstart", "drag", "dragend"];
const MANIPULATION_EVENTS = ["manipulationstart", "manipulation", "manipulationend"];
const COLLISION_EVENTS = ["collisionstart", "collisionend"];

export { MAX_DEPTH };

// Every event type the core routes through bubbling dispatch.
const SPATIAL_EVENT_TYPES = new Set([
  "tap",
  "hoverenter",
  "hoverexit",
  "dragstart",
  "drag",
  "dragend",
  "manipulationstart",
  "manipulation",
  "manipulationend",
  "collisionstart",
  "collisionend",
  "anchored",
  "unanchored",
  "assetLoaded",
  "assetError",
]);

let installed = false;

export function installObjectExtensions(Light) {
  if (installed) return;
  installed = true;

  // Light state is re-derived only when one of these is written (PERF-03).
  if (Light !== undefined) {
    const lightProto = Light.prototype;
    lightProto[DIRTY] = DIRTY_ALL;
    for (const name of ["intensity", "distance", "decay", "angle", "penumbra", "target"]) {
      trackedProperty(lightProto, name, DIRTY_LIGHT, undefined);
    }
    // `color` is a Color instance three mutates in place, so its channels are
    // compared instead of hooked.
  }

  const proto = Object3D.prototype;

  // A fresh object has never been flushed, so everything is dirty.
  proto[DIRTY] = DIRTY_ALL;

  // Display flags from SPEC 3.2, plus the three.js fields the diff mirrors.
  // All of them raise a dirty bit on write.
  trackedProperty(proto, "opacity", DIRTY_FLAGS, 1);
  trackedProperty(proto, "billboard", DIRTY_FLAGS, false);
  trackedProperty(proto, "groundingShadow", DIRTY_FLAGS, false);
  trackedProperty(proto, "hoverEffect", DIRTY_FLAGS, null, HOVER_EFFECTS);
  trackedProperty(proto, "manipulable", DIRTY_FLAGS, false);
  trackedProperty(proto, "renderOrder", DIRTY_FLAGS, 0);
  trackedProperty(proto, "name", DIRTY_NAME, "");
  trackedProperty(proto, "visible", DIRTY_VISIBLE, true);
  trackedProperty(proto, "castShadow", DIRTY_SHADOW | DIRTY_LIGHT, false);
  trackedProperty(proto, "receiveShadow", DIRTY_SHADOW, false);

  Object.defineProperty(proto, "rigidBody", {
    configurable: true,
    get() {
      return this[RIGID_BODY] === undefined ? null : this[RIGID_BODY];
    },
    set(body) {
      const previous = this[RIGID_BODY];
      if (previous && previous !== body) previous.object = null;
      if (body === null || body === undefined) {
        this[RIGID_BODY] = null;
        this[DIRTY] = (this[DIRTY] | 0) | DIRTY_RIGIDBODY;
        return;
      }
      if (typeof body !== "object" || typeof body.toJSON !== "function") {
        throw new TypeError("Object3D.rigidBody must be a Spatial.RigidBody or null");
      }
      if (body.object !== null && body.object !== undefined && body.object !== this) {
        // Impulses and syncBodies resolve through body.object, so a shared
        // instance would send one object's forces to another.
        const owner = body.object.name ? `"${body.object.name}"` : body.object.type;
        throw new SpatialUnsupportedError(
          `This RigidBody is already attached to ${owner}; construct one RigidBody per object`,
          "rigidbody-shared",
          this,
        );
      }
      body.object = this;
      body.validateForObject(this);
      this[RIGID_BODY] = body;
      this[DIRTY] = (this[DIRTY] | 0) | DIRTY_RIGIDBODY;
    },
  });

  // Hierarchy edits are the most common place an agent-written script goes
  // wrong, so add/remove/attach validate before three sees the argument:
  //   - a destroyed object has no native entity to re-parent
  //   - a non-Object3D is a programming error and throws
  //   - null and undefined are ignored with a warning, as three.js does
  //   - an ancestor moved under its own descendant would make updateMatrixWorld
  //     recurse forever, so the edit is refused and reported
  const baseAdd = proto.add;
  proto.add = function add(...objects) {
    const accepted = [];
    for (const object of objects) {
      if (!checkHierarchyArgument("add", object)) continue;
      rejectDestroyed(object);
      try {
        if (createsCycle(this, object)) continue;
        if (exceedsDepth(this, object)) continue;
      } catch (error) {
        // A Proxy trap or a hostile getter threw while the graph was being
        // checked. The object is not added; the dump explains why.
        const runtime = host();
        if (runtime) {
          runtime.reportOnce({
            name: "SpatialUnsupportedError",
            message: `Object3D.add could not inspect ${labelFor(object)}: ${describeError(error)}`,
          });
        }
        throw error;
      }
      push(accepted, object);
    }
    if (accepted.length === 0) return this;
    return baseAdd.apply(this, accepted);
  };

  const baseRemove = proto.remove;
  proto.remove = function remove(...objects) {
    const accepted = [];
    for (const object of objects) {
      if (!checkHierarchyArgument("remove", object)) continue;
      push(accepted, object);
    }
    if (accepted.length === 0) return this;
    return baseRemove.apply(this, accepted);
  };

  const baseAttach = proto.attach;
  proto.attach = function attach(object) {
    if (!checkHierarchyArgument("attach", object)) return this;
    rejectDestroyed(object);
    if (createsCycle(this, object)) return this;
    if (exceedsDepth(this, object)) return this;
    // three's attach builds inverse(newParent.matrixWorld) * oldParent.matrixWorld
    // and hands it to applyMatrix4. With a rotated, non-uniformly scaled parent
    // that matrix legitimately contains shear, and decomposing it is the right
    // answer, so the raw matrix is not recorded for the shear check.
    reparenting = true;
    try {
      return baseAttach.call(this, object);
    } finally {
      reparenting = false;
    }
  };

  // Registering or removing a listener changes whether the object is an input
  // target, which the diff reports as an `interactive` command.
  const baseAddListener = proto.addEventListener;
  proto.addEventListener = function addEventListener(type, listener) {
    if (listenerCount(this, type) >= MAX_LISTENERS_PER_EVENT) {
      const runtime = host();
      if (runtime) {
        runtime.warnOnce(
          `listener-limit:${type}`,
          `More than ${MAX_LISTENERS_PER_EVENT} "${type}" listeners on ${labelFor(this)}; ` +
            "the registration was dropped",
        );
      }
      return undefined;
    }
    this[DIRTY] = (this[DIRTY] | 0) | DIRTY_LISTENERS;
    return baseAddListener.call(this, type, listener);
  };

  const baseRemoveListener = proto.removeEventListener;
  proto.removeEventListener = function removeEventListener(type, listener) {
    this[DIRTY] = (this[DIRTY] | 0) | DIRTY_LISTENERS;
    return baseRemoveListener.call(this, type, listener);
  };

  // Traversal must survive a callback that removes or destroys objects, so
  // every walk iterates a snapshot of `children` rather than the live array.
  proto.traverse = function traverse(callback) {
    // Iterative: a deep hierarchy must never overflow the engine stack, and a
    // callback that removes objects must not skip siblings.
    const stack = [this];
    while (stack.length > 0) {
      const object = stack.pop();
      callback(object);
      const children = object.children;
      for (let i = children.length - 1; i >= 0; i -= 1) push(stack, children[i]);
    }
  };

  proto.traverseVisible = function traverseVisible(callback) {
    if (this.visible === false) return;
    const stack = [this];
    while (stack.length > 0) {
      const object = stack.pop();
      callback(object);
      const children = object.children;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        if (children[i].visible !== false) push(stack, children[i]);
      }
    }
  };

  proto.traverseAncestors = function traverseAncestors(callback) {
    // Snapshot the chain first: a callback may detach the object it is given.
    const chain = [];
    let node = this.parent;
    while (node) {
      push(chain, node);
      node = node.parent;
    }
    for (let i = 0; i < chain.length; i += 1) callback(chain[i]);
  };

  // clone()/copy() must carry the SpatialScript flags across.
  const baseCopy = proto.copy;
  proto.copy = function copy(source, recursive) {
    baseCopy.call(this, source, recursive);
    this.opacity = source.opacity;
    this.billboard = source.billboard;
    this.groundingShadow = source.groundingShadow;
    this.hoverEffect = source.hoverEffect;
    this.manipulable = source.manipulable;
    return this;
  };

  // Direct matrix writes and applyMatrix4 may contain shear that three's
  // decompose() would silently discard. Keep the raw matrix so the flush diff
  // can reject it (SPEC 3.2).
  const baseApplyMatrix4 = proto.applyMatrix4;
  proto.applyMatrix4 = function applyMatrix4(matrix) {
    if (this.matrixAutoUpdate) this.updateMatrix();
    this.matrix.premultiply(matrix);
    if (!reparenting) this[RAW_MATRIX] = this.matrix.clone();
    this.matrix.decompose(this.position, this.quaternion, this.scale);
    return this;
  };
  // Keep a reference so the unpatched behaviour is still reachable in tests.
  proto.applyMatrix4.__base = baseApplyMatrix4;

  // Bubbling dispatch for the SpatialScript event set. Non-spatial event types
  // keep three's plain single-target behaviour.
  const baseDispatch = proto.dispatchEvent;
  proto.dispatchEvent = function dispatchEvent(event) {
    if (event && SPATIAL_EVENT_TYPES.has(event.type)) {
      dispatchBubbling(this, event);
      return;
    }
    return baseDispatch.call(this, event);
  };
  proto.dispatchEvent.__base = baseDispatch;
}

/**
 * Returns true when `object` should be passed on to three. Throws for a wrong
 * type, and reports (without throwing) for null and undefined, which three.js
 * also tolerates.
 */
function checkHierarchyArgument(method, object) {
  if (object === null || object === undefined) {
    const runtime = host();
    if (runtime) {
      runtime.warnOnce(
        `object3d-${method}-nullish`,
        `Object3D.${method} was called with ${object === null ? "null" : "undefined"}; the call was ignored`,
      );
    }
    return false;
  }
  if (object.isObject3D !== true) {
    throw new TypeError(
      `Object3D.${method} expects an Object3D, received ${describeArgument(object)}`,
    );
  }
  return true;
}

function describeArgument(value) {
  const kind = typeof value;
  if (kind === "string") return `the string ${JSON.stringify(value)}`;
  if (kind === "number" || kind === "boolean") return `the ${kind} ${String(value)}`;
  if (kind === "function") return `a function`;
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  const name = value.constructor && value.constructor.name ? value.constructor.name : "Object";
  return `a plain ${name}`;
}

/**
 * Refuses a re-parent that would make the graph cyclic. three.js only guards
 * the self-add case; an ancestor moved under its own descendant makes
 * updateMatrixWorld recurse until the stack overflows.
 */
function createsCycle(parent, object) {
  let isCycle = object === parent;
  if (!isCycle) {
    let node = parent.parent;
    while (node) {
      if (node === object) {
        isCycle = true;
        break;
      }
      node = node.parent;
    }
  }
  if (!isCycle) return false;
  const runtime = host();
  if (runtime) {
    runtime.reportError(
      new SpatialUnsupportedError(
        `Adding ${labelFor(object)} to ${labelFor(parent)} would make the scene graph cyclic; ` +
          "the call was ignored",
        "cyclic-parent",
        object,
      ),
    );
  }
  return true;
}

// Set while three's own attach math is running.
let reparenting = false;

/** Depth of `object` below the outermost root, capped so a cycle cannot spin. */
function depthOf(object) {
  let depth = 0;
  let node = object.parent;
  while (node !== null && depth <= MAX_DEPTH + 1) {
    depth += 1;
    node = node.parent;
  }
  return depth;
}

/** Height of the subtree rooted at `object`, capped the same way. */
function subtreeHeight(object) {
  const children = object.children;
  if (children.length === 0) return 0;
  const stack = [object];
  const depths = [0];
  let height = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    const depth = depths.pop();
    if (depth > height) height = depth;
    if (height > MAX_DEPTH + 1) return height;
    const kids = node.children;
    for (let i = 0; i < kids.length; i += 1) {
      push(stack, kids[i]);
      push(depths, depth + 1);
    }
  }
  return height;
}

/**
 * Refuses a hierarchy edit that would push an object past MAX_DEPTH. Reported,
 * not thrown, so the frame loop survives a script that builds a runaway chain.
 */
function exceedsDepth(parent, object) {
  const depth = depthOf(parent) + 1 + subtreeHeight(object);
  if (depth <= MAX_DEPTH) return false;
  const runtime = host();
  if (runtime) {
    runtime.reportOnce(
      new SpatialUnsupportedError(
        `Adding ${labelFor(object)} would make the scene graph ${depth} levels deep; ` +
          `the limit is ${MAX_DEPTH}`,
        "depth-limit",
        object,
      ),
    );
  }
  return true;
}

function describeError(error) {
  try {
    return `${error && error.name ? error.name : "Error"}: ${error && error.message ? error.message : error}`;
  } catch {
    return "an error that cannot be described";
  }
}

function rejectDestroyed(object) {
  if (!object || object[DESTROYED] !== true) return;
  throw new SpatialUnsupportedError(
    `${labelFor(object)} was destroyed by Spatial.destroy and cannot be added to the scene again`,
    "destroyed-object",
    object,
  );
}

export function markDestroyed(object) {
  object[DESTROYED] = true;
}

export function isDestroyed(object) {
  return object[DESTROYED] === true;
}

export function markRawMatrix(object) {
  object[RAW_MATRIX] = object.matrix.clone();
}

export function takeRawMatrix(object) {
  const matrix = object[RAW_MATRIX];
  if (matrix === undefined) return null;
  object[RAW_MATRIX] = undefined;
  return matrix;
}

const shearA = new Vector3();
const shearB = new Vector3();
const shearC = new Vector3();

/**
 * Returns true when the upper-left 3x3 of `matrix` contains shear: the three
 * column vectors are not mutually orthogonal once scale is removed.
 */
export function hasShear(matrix, tolerance = SHEAR_TOLERANCE) {
  const e = matrix.elements;
  shearA.set(e[0], e[1], e[2]);
  shearB.set(e[4], e[5], e[6]);
  shearC.set(e[8], e[9], e[10]);
  const la = shearA.length();
  const lb = shearB.length();
  const lc = shearC.length();
  if (la < 1e-8 || lb < 1e-8 || lc < 1e-8) return false;
  shearA.divideScalar(la);
  shearB.divideScalar(lb);
  shearC.divideScalar(lc);
  return (
    Math.abs(shearA.dot(shearB)) > tolerance ||
    Math.abs(shearA.dot(shearC)) > tolerance ||
    Math.abs(shearB.dot(shearC)) > tolerance
  );
}

/**
 * Dispatches `event` on `object` and then on each ancestor, stopping when a
 * listener calls stopPropagation(). The mounted Scene always sees the event
 * last, even for objects that are not currently under it.
 */
export function dispatchBubbling(object, event) {
  let stopped = false;
  const payload = event;
  payload.target = payload.target === undefined ? object : payload.target;
  payload.currentTarget = object;
  payload.stopPropagation = function stopPropagation() {
    stopped = true;
  };

  const chain = [];
  let node = object;
  while (node) {
    push(chain, node);
    node = node.parent;
  }

  const runtime = host();
  const scene = runtime ? runtime.scene : null;
  if (scene && chain.indexOf(scene) === -1) push(chain, scene);

  // three's EventDispatcher.dispatchEvent overwrites event.target with the
  // object it is dispatching on and clears it afterwards, which would break
  // the rule that `target` stays the originating object while an event
  // bubbles. Invoke the listeners directly instead.
  for (const target of chain) {
    payload.currentTarget = target;
    invokeListeners(target, payload);
    if (stopped) break;
  }
  payload.currentTarget = null;
  return payload;
}

function invokeListeners(object, event) {
  const listeners = object._listeners;
  if (!listeners) return;
  const list = listeners[event.type];
  if (!list || list.length === 0) return;
  const snapshot = slice(list, 0);
  for (let i = 0; i < snapshot.length; i += 1) snapshot[i].call(object, event);
}

function listenerCount(object, type) {
  const listeners = object._listeners;
  if (!listeners) return 0;
  const list = listeners[type];
  return list ? list.length : 0;
}

export function interactiveFlags(object) {
  return {
    tap: TAP_EVENTS.some((type) => listenerCount(object, type) > 0),
    hover: HOVER_EVENTS.some((type) => listenerCount(object, type) > 0),
    drag: DRAG_EVENTS.some((type) => listenerCount(object, type) > 0),
    manipulation: MANIPULATION_EVENTS.some((type) => listenerCount(object, type) > 0),
    collision: COLLISION_EVENTS.some((type) => listenerCount(object, type) > 0),
  };
}

const tmpMatrix = new Matrix4();

/**
 * Brings every world matrix under `root` up to date, iteratively and without
 * letting one object stop the walk. three's own updateMatrixWorld recurses per
 * level and throws straight out on a frozen object or a patched prototype
 * (ROBUST-03, ROBUST-04, CORE-01).
 */
export function refreshWorldMatrices(root, onError) {
  const stack = [root];
  const forced = [true];
  while (stack.length > 0) {
    const object = stack.pop();
    const force = forced.pop();
    let dirty = force;
    try {
      if (object.matrixAutoUpdate) object.updateMatrix();
      if (object.matrixWorldNeedsUpdate || force) {
        if (object.matrixWorldAutoUpdate !== false) {
          const parent = object.parent;
          if (parent === null) object.matrixWorld.copy(object.matrix);
          else object.matrixWorld.multiplyMatrices(parent.matrixWorld, object.matrix);
        }
        object.matrixWorldNeedsUpdate = false;
        dirty = true;
      }
    } catch (error) {
      if (onError) onError(object, error);
    }
    const children = object.children;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      push(stack, children[i]);
      push(forced, dirty);
    }
  }
}

/** Computes the local matrix of `object` for a given world matrix. */
export function worldToLocalMatrix(object, worldMatrix, out) {
  if (object.parent) {
    object.parent.updateWorldMatrix(true, false);
    tmpMatrix.copy(object.parent.matrixWorld).invert();
    out.multiplyMatrices(tmpMatrix, worldMatrix);
  } else {
    out.copy(worldMatrix);
  }
  return out;
}
