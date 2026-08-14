// Physics objects (SPEC 3.7). The core owns configuration and the command
// stream; simulation lives in the consumer.

import { push } from "./builtins.js";
import { Vector3 } from "./three-exports.js";
import { atLeast, vector3Array, finite, pick } from "./sanitize.js";
import { SpatialUnsupportedError } from "./errors.js";
import { host } from "./host.js";

const BODY_TYPES = new Set(["dynamic", "static", "kinematic"]);
const BODY_SHAPES = new Set(["auto", "box", "sphere", "capsule", "convex", "mesh"]);
const JOINT_TYPES = new Set(["fixed", "revolute", "spherical", "prismatic", "distance"]);


export class RigidBody {
  constructor(options = {}) {
    const type = pick(options, "type", "dynamic");
    if (!BODY_TYPES.has(type)) {
      throw new TypeError(`RigidBody.type must be dynamic, static or kinematic (got "${type}")`);
    }
    const shape = pick(options, "shape", "auto");
    if (!BODY_SHAPES.has(shape)) {
      throw new TypeError(`RigidBody.shape "${shape}" is not a supported shape`);
    }
    if (shape === "mesh" && type === "dynamic") {
      throw new SpatialUnsupportedError(
        'RigidBody shape "mesh" is static only and cannot be used on a dynamic body',
        "RigidBody.shape=mesh",
        null,
      );
    }

    this.type = type;
    this.mass = pick(options, "mass", 1);
    this.shape = shape;
    this.friction = pick(options, "friction", 0.5);
    this.restitution = pick(options, "restitution", 0.2);
    this.linearDamping = pick(options, "linearDamping", 0);
    this.angularDamping = pick(options, "angularDamping", 0);
    this.isTrigger = pick(options, "isTrigger", false) === true;
    this.gravity = pick(options, "gravity", true) !== false;

    // Consumer-owned, refreshed by syncBodies(). Exposed read-only: a script
    // assignment would silently desynchronise from the consumer.
    this._linearVelocity = new Vector3();
    this._angularVelocity = new Vector3();
    this._isSleeping = false;

    this.object = null;
  }

  get linearVelocity() {
    return this._linearVelocity;
  }

  get angularVelocity() {
    return this._angularVelocity;
  }

  get isSleeping() {
    return this._isSleeping;
  }

  /** Re-checks constraints that depend on the object the body is attached to. */
  validateForObject(object) {
    if (this.shape === "mesh" && this.type === "dynamic") {
      throw new SpatialUnsupportedError(
        'RigidBody shape "mesh" is static only and cannot be used on a dynamic body',
        "RigidBody.shape=mesh",
        object,
      );
    }
  }

  /** Resolves shape "auto" against the attached geometry (SPEC 3.7). */
  resolvedShape() {
    if (this.shape !== "auto") return this.shape;
    const geometry = this.object ? this.object.geometry : null;
    const type = geometry ? geometry.type : null;
    if (type === "BoxGeometry") return "box";
    if (type === "SphereGeometry") return "sphere";
    if (type === "CapsuleGeometry") return "capsule";
    return "convex";
  }

  applyImpulse(vector, atWorldPoint) {
    const runtime = host();
    if (!runtime || !runtime.canCommand(this.object, "RigidBody.applyImpulse")) return this;
    const point = atWorldPoint || null;
    runtime.queueCommand([
      "bodyImpulse",
      runtime.idForObject(this.object),
      vector.x,
      vector.y,
      vector.z,
      point ? point.x : null,
      point ? point.y : null,
      point ? point.z : null,
    ]);
    return this;
  }

  applyForce(vector) {
    const runtime = host();
    if (!runtime || !runtime.canCommand(this.object, "RigidBody.applyForce")) return this;
    runtime.queueCommand(["bodyForce", runtime.idForObject(this.object), vector.x, vector.y, vector.z]);
    return this;
  }

  applyTorque(vector) {
    const runtime = host();
    if (!runtime || !runtime.canCommand(this.object, "RigidBody.applyTorque")) return this;
    runtime.queueCommand(["bodyTorque", runtime.idForObject(this.object), vector.x, vector.y, vector.z]);
    return this;
  }

  setLinearVelocity(vector) {
    this._linearVelocity.copy(vector);
    this.#velocityCommand(vector, null);
    return this;
  }

  setAngularVelocity(vector) {
    this._angularVelocity.copy(vector);
    this.#velocityCommand(null, vector);
    return this;
  }

  #velocityCommand(linear, angular) {
    const runtime = host();
    if (!runtime || !runtime.canCommand(this.object, "RigidBody.setVelocity")) return;
    runtime.queueCommand([
      "bodyVelocity",
      runtime.idForObject(this.object),
      linear ? linear.x : null,
      linear ? linear.y : null,
      linear ? linear.z : null,
      angular ? angular.x : null,
      angular ? angular.y : null,
      angular ? angular.z : null,
    ]);
  }

  toJSON() {
    // Every scalar is finite and non-negative: a negative mass or damping is a
    // simulation blow-up in both consumers.
    return {
      type: this.type,
      mass: atLeast(this.mass, 0, 1),
      shape: this.resolvedShape(),
      requestedShape: this.shape,
      friction: atLeast(this.friction, 0, 0.5),
      restitution: atLeast(this.restitution, 0, 0.2),
      linearDamping: atLeast(this.linearDamping, 0, 0),
      angularDamping: atLeast(this.angularDamping, 0, 0),
      isTrigger: this.isTrigger,
      gravity: this.gravity,
    };
  }
}

export function rigidBodyJSONEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.type === b.type &&
    a.mass === b.mass &&
    a.shape === b.shape &&
    a.requestedShape === b.requestedShape &&
    a.friction === b.friction &&
    a.restitution === b.restitution &&
    a.linearDamping === b.linearDamping &&
    a.angularDamping === b.angularDamping &&
    a.isTrigger === b.isTrigger &&
    a.gravity === b.gravity
  );
}

export class Joint {
  constructor(options = {}) {
    const type = pick(options, "type", "fixed");
    if (!JOINT_TYPES.has(type)) {
      throw new TypeError(`Joint.type "${type}" is not a supported joint type`);
    }
    this.type = type;
    this.bodyA = pick(options, "bodyA", null);
    this.bodyB = pick(options, "bodyB", null);
    this.anchorA = pick(options, "anchorA", new Vector3());
    this.anchorB = pick(options, "anchorB", new Vector3());
    this.axis = pick(options, "axis", new Vector3(0, 1, 0));
    this.limits = pick(options, "limits", null);

    for (const key of ["bodyA", "bodyB"]) {
      const body = this[key];
      if (body && !body.rigidBody) {
        throw new SpatialUnsupportedError(
          `Joint.${key} "${body.name || body.type}" has no rigidBody`,
          "Joint.body",
          body,
        );
      }
    }
  }

  toJSON() {
    const runtime = host();
    const idOf = (object) => (object && runtime ? runtime.referenceIdFor(object) : null);
    return {
      type: this.type,
      bodyA: idOf(this.bodyA),
      bodyB: idOf(this.bodyB),
      anchorA: vector3Array(this.anchorA),
      anchorB: vector3Array(this.anchorB),
      axis: vector3Array(this.axis, 0, 1, 0),
      limits: this.limits ? [finite(this.limits[0], 0), finite(this.limits[1], 0)] : null,
    };
  }
}

export function jointJSONEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type || a.bodyA !== b.bodyA || a.bodyB !== b.bodyB) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a.anchorA[i] !== b.anchorA[i]) return false;
    if (a.anchorB[i] !== b.anchorB[i]) return false;
    if (a.axis[i] !== b.axis[i]) return false;
  }
  if ((a.limits === null) !== (b.limits === null)) return false;
  if (a.limits && (a.limits[0] !== b.limits[0] || a.limits[1] !== b.limits[1])) return false;
  return true;
}

export class PhysicsWorld {
  constructor() {
    this._gravity = new Vector3(0, -9.81, 0);
    this.joints = [];
  }

  get gravity() {
    return this._gravity;
  }

  set gravity(value) {
    this._gravity.copy(value);
  }

  add(joint) {
    if (!(joint instanceof Joint)) throw new TypeError("Spatial.physics.add expects a Spatial.Joint");
    if (!this.joints.includes(joint)) push(this.joints, joint);
    return joint;
  }

  remove(joint) {
    const index = this.joints.indexOf(joint);
    if (index !== -1) this.joints.splice(index, 1);
    return joint;
  }
}
