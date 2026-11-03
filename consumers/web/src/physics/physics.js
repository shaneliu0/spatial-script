// Rapier-backed physics for the SpatialScript three.js consumer.
// Owns rigid bodies, colliders, joints, collision events, and the fixed-step loop.
// Only objects that carry a `rigidBody` command get a collider; raycasting uses
// three.js Raycaster over meshes instead (SPEC 3.7).

import * as THREE from 'three';

const FIXED_STEP = 1 / 60;
const MAX_SUBSTEPS = 8;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();

/** Reads the geometry descriptor the consumer stashed on the mesh. */
function geometryInfo(object) {
  return object.userData.__spatialGeometry || null;
}

function decomposeWorld(object) {
  object.matrixWorld.decompose(_pos, _quat, _scale);
  return {
    position: { x: _pos.x, y: _pos.y, z: _pos.z },
    rotation: { x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w },
    scale: _scale.clone(),
  };
}

/** Positions scaled into body-local space, used by convex hull and trimesh shapes. */
function scaledPositions(object, scale) {
  const attr = object.geometry && object.geometry.getAttribute('position');
  if (!attr) return null;
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    out[i * 3 + 0] = attr.getX(i) * scale.x;
    out[i * 3 + 1] = attr.getY(i) * scale.y;
    out[i * 3 + 2] = attr.getZ(i) * scale.z;
  }
  return out;
}

export class PhysicsWorld {
  /**
   * @param {*} RAPIER the initialised @dimforge/rapier3d-compat module
   * @param {(message: string) => void} warn
   */
  constructor(RAPIER, warn = () => {}) {
    this.RAPIER = RAPIER;
    this.warn = warn;
    this.gravity = { x: 0, y: -9.81, z: 0 };
    this.world = new RAPIER.World(this.gravity);
    this.eventQueue = new RAPIER.EventQueue(true);
    /** @type {Map<number, {body:any, collider:any, spec:any, object:THREE.Object3D}>} */
    this.bodies = new Map();
    /**
     * AR-31: Rapier keeps an added force until it is reset, so a force applied
     * once would push for ever and a per-step field force would compound. Every
     * body that was pushed this step is cleared after the solver has used it.
     */
    this.forcedBodies = new Set();
    /** @type {Map<number, number>} rapier collider handle -> spatial object id */
    this.colliderToId = new Map();
    /** @type {Map<number, {joint:any, spec:any}>} */
    this.joints = new Map();
    this.accumulator = 0;
    this.beforeStep = null;
    this.pendingEvents = [];
    this._syncBuffer = new Float32Array(0);
    this._bodyBuffer = new Float32Array(0);
  }

  dispose() {
    for (const id of [...this.bodies.keys()]) this.removeBody(id);
    this.joints.clear();
    this.eventQueue.free();
    this.world.free();
  }

  setGravity(x, y, z) {
    this.gravity = { x, y, z };
    this.world.gravity = this.gravity;
    // Wake everything so a gravity change takes effect on sleeping bodies.
    for (const entry of this.bodies.values()) entry.body.wakeUp();
  }

  // ---------------------------------------------------------------- bodies

  /**
   * Creates or replaces the body for `id`. Requires object.matrixWorld to be
   * current. `rebuild` forces the collider to be re-derived, which a geometry
   * swap needs even when the body spec itself is unchanged.
   */
  setBody(id, object, spec, rebuild = false) {
    if (!spec) {
      this.removeBody(id);
      return;
    }
    // SPEC 3.7 builds the collision shape from the mesh; RealityKit ignores a body
    // on anything else, so the web consumer does too instead of inventing a box.
    if (!hasGeometry(object)) {
      this.removeBody(id);
      this.warn(`rigidBody on ${label(object)} has no geometry to build a collision shape from; it was ignored`);
      return;
    }
    const existing = this.bodies.get(id);
    if (existing && !rebuild && this._canUpdateInPlace(existing.spec, spec)) {
      this._updateInPlace(existing, spec);
      existing.spec = spec;
      return;
    }
    // WEB-04: a respec goes through removeBody, which drops the joints attached
    // to this body. The core does not re-emit them, so they are restored here.
    const attachedJoints = [];
    for (const [jointId, joint] of this.joints) {
      if (joint.spec && (joint.spec.bodyA === id || joint.spec.bodyB === id)) {
        attachedJoints.push([jointId, joint.spec]);
      }
    }
    this.removeBody(id);

    const RAPIER = this.RAPIER;
    const world = decomposeWorld(object);
    // SPEC 3.7: a trigger is never simulated. Whatever its `type` says, it becomes
    // a kinematic position-based body carrying a sensor collider, so it has no
    // mass, never falls, never pushes, and follows its object's transform.
    const type = bodyType(spec);
    let desc;
    if (type === 'static') desc = RAPIER.RigidBodyDesc.fixed();
    else if (type === 'kinematic') desc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    else desc = RAPIER.RigidBodyDesc.dynamic();

    desc.setTranslation(world.position.x, world.position.y, world.position.z);
    desc.setRotation(world.rotation);
    desc.setLinearDamping(spec.linearDamping ?? 0);
    desc.setAngularDamping(spec.angularDamping ?? 0);
    desc.setGravityScale(spec.gravity === false ? 0 : 1, false);
    // Small fast bodies would otherwise pass straight through a thin static floor
    // between two steps; sweep-based detection keeps them on it.
    if (type === 'dynamic') desc.setCcdEnabled(true);
    const body = this.world.createRigidBody(desc);

    const colliderDesc = this._colliderDesc(object, spec, world.scale, type);
    let collider = null;
    if (colliderDesc) {
      colliderDesc.setFriction(spec.friction ?? 0.5);
      colliderDesc.setRestitution(spec.restitution ?? 0.2);
      colliderDesc.setSensor(spec.isTrigger === true);
      colliderDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      if (spec.isTrigger === true) {
        // A kinematic sensor must still see static bodies that pass through it.
        colliderDesc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
      }
      if (type === 'dynamic') colliderDesc.setMass(spec.mass ?? 1);
      collider = this.world.createCollider(colliderDesc, body);
      this.colliderToId.set(collider.handle, id);
    }
    this.bodies.set(id, { body, collider, spec, object });
    for (const [jointId, jointSpec] of attachedJoints) this.setJoint(jointId, jointSpec);
  }

  _canUpdateInPlace(oldSpec, newSpec) {
    if (!oldSpec) return false;
    return (
      bodyType(oldSpec) === bodyType(newSpec) &&
      (oldSpec.shape || 'auto') === (newSpec.shape || 'auto') &&
      (oldSpec.isTrigger === true) === (newSpec.isTrigger === true)
    );
  }

  _updateInPlace(entry, spec) {
    entry.body.setLinearDamping(spec.linearDamping ?? 0);
    entry.body.setAngularDamping(spec.angularDamping ?? 0);
    entry.body.setGravityScale(spec.gravity === false ? 0 : 1, true);
    if (entry.collider) {
      entry.collider.setFriction(spec.friction ?? 0.5);
      entry.collider.setRestitution(spec.restitution ?? 0.2);
      if (bodyType(spec) === 'dynamic') entry.collider.setMass(spec.mass ?? 1);
    }
    entry.body.wakeUp();
  }

  _colliderDesc(object, spec, scale, type) {
    const RAPIER = this.RAPIER;
    // The core resolves "auto" before it sends the body (SPEC 3.7), so the
    // consumer consumes `shape` rather than keeping its own mapping table.
    let shape = spec.shape;
    if (!shape || shape === 'auto') {
      this.warn(`rigidBody on ${label(object)} arrived with an unresolved shape; a convex hull is used`);
      shape = 'convex';
    }
    if (shape === 'mesh' && type !== 'static') {
      this.warn(`RigidBody shape "mesh" is static-only; "${object.name || object.id}" is ${type}, using convex hull`);
      shape = 'convex';
    }
    const info = geometryInfo(object);
    const params = (info && info.parameters) || {};

    if (shape === 'box') {
      const hx = ((params.width ?? this._extent(object, 'x')) / 2) * Math.abs(scale.x);
      const hy = ((params.height ?? this._extent(object, 'y')) / 2) * Math.abs(scale.y);
      const hz = ((params.depth ?? this._extent(object, 'z')) / 2) * Math.abs(scale.z);
      return RAPIER.ColliderDesc.cuboid(Math.max(hx, 1e-4), Math.max(hy, 1e-4), Math.max(hz, 1e-4));
    }
    if (shape === 'sphere') {
      const base = params.radius ?? this._extent(object, 'x') / 2;
      const r = base * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
      return RAPIER.ColliderDesc.ball(Math.max(r, 1e-4));
    }
    if (shape === 'capsule') {
      const radius = (params.radius ?? 0.05) * Math.max(Math.abs(scale.x), Math.abs(scale.z));
      // three.js has used both `length` and `height` for the mid-section over revisions.
      const mid = params.height ?? params.length ?? 0.1;
      const halfHeight = (mid / 2) * Math.abs(scale.y);
      return RAPIER.ColliderDesc.capsule(Math.max(halfHeight, 1e-4), Math.max(radius, 1e-4));
    }
    if (shape === 'mesh') {
      const points = scaledPositions(object, scale);
      if (!points) return this._fallbackBox(object, scale);
      const index = object.geometry.index
        ? Uint32Array.from(object.geometry.index.array)
        : Uint32Array.from({ length: points.length / 3 }, (_, i) => i);
      return RAPIER.ColliderDesc.trimesh(points, index);
    }
    // convex
    const points = scaledPositions(object, scale);
    if (!points) return this._fallbackBox(object, scale);
    const desc = RAPIER.ColliderDesc.convexHull(points);
    if (!desc) {
      this.warn(`convex hull failed for "${object.name || object.id}", using bounding box`);
      return this._fallbackBox(object, scale);
    }
    return desc;
  }

  _extent(object, axis) {
    if (!object.geometry) return 0.1;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const bb = object.geometry.boundingBox;
    if (!bb) return 0.1;
    bb.getSize(_size);
    return _size[axis] || 0.1;
  }

  _fallbackBox(object, scale) {
    const hx = (this._extent(object, 'x') / 2) * Math.abs(scale.x);
    const hy = (this._extent(object, 'y') / 2) * Math.abs(scale.y);
    const hz = (this._extent(object, 'z') / 2) * Math.abs(scale.z);
    return this.RAPIER.ColliderDesc.cuboid(Math.max(hx, 1e-4), Math.max(hy, 1e-4), Math.max(hz, 1e-4));
  }

  removeBody(id) {
    const entry = this.bodies.get(id);
    if (!entry) return;
    if (entry.collider) this.colliderToId.delete(entry.collider.handle);
    // Drop joints that referenced this body first, or Rapier will hold dangling handles.
    for (const [jointId, j] of [...this.joints]) {
      if (j.spec && (j.spec.bodyA === id || j.spec.bodyB === id)) this.removeJoint(jointId);
    }
    this.world.removeRigidBody(entry.body);
    this.bodies.delete(id);
  }

  /** True only for bodies the simulation drives; a trigger never is (SPEC 3.7). */
  isDynamic(id) {
    const entry = this.bodies.get(id);
    return !!entry && bodyType(entry.spec) === 'dynamic';
  }

  /** TRANSFORM on a dynamic body is a teleport: move it and zero the velocities. */
  teleport(id, object) {
    const entry = this.bodies.get(id);
    if (!entry) return;
    const world = decomposeWorld(object);
    entry.body.setTranslation(world.position, true);
    entry.body.setRotation(world.rotation, true);
    entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  applyImpulse(id, x, y, z, px, py, pz) {
    const entry = this.bodies.get(id);
    if (!entry) return;
    if (px === null || px === undefined || Number.isNaN(px)) {
      entry.body.applyImpulse({ x, y, z }, true);
    } else {
      entry.body.applyImpulseAtPoint({ x, y, z }, { x: px, y: py, z: pz }, true);
    }
  }

  applyForce(id, x, y, z) {
    const entry = this.bodies.get(id);
    if (!entry) return;
    entry.body.addForce({ x, y, z }, true);
    this.forcedBodies.add(entry.body);
  }

  applyTorque(id, x, y, z) {
    const entry = this.bodies.get(id);
    if (!entry) return;
    entry.body.addTorque({ x, y, z }, true);
    this.forcedBodies.add(entry.body);
  }

  setVelocity(id, lx, ly, lz, ax, ay, az) {
    const entry = this.bodies.get(id);
    if (!entry) return;
    if (lx !== null && lx !== undefined) entry.body.setLinvel({ x: lx, y: ly, z: lz }, true);
    if (ax !== null && ax !== undefined) entry.body.setAngvel({ x: ax, y: ay, z: az }, true);
  }

  // ---------------------------------------------------------------- joints

  setJoint(jointId, spec) {
    this.removeJoint(jointId);
    if (!spec) return;
    const a = this.bodies.get(spec.bodyA);
    const b = this.bodies.get(spec.bodyB);
    if (!a || !b) {
      this.warn(`joint ${jointId} references a body without a rigidBody; ignored`);
      return;
    }
    const RAPIER = this.RAPIER;
    const anchorA = toVec(spec.anchorA);
    const anchorB = toVec(spec.anchorB);
    const axis = toVec(spec.axis, { x: 0, y: 1, z: 0 });
    let params;
    switch (spec.type) {
      case 'fixed':
        params = RAPIER.JointData.fixed(anchorA, IDENTITY_QUAT, anchorB, IDENTITY_QUAT);
        break;
      case 'revolute':
        params = RAPIER.JointData.revolute(anchorA, anchorB, axis);
        break;
      case 'spherical':
        params = RAPIER.JointData.spherical(anchorA, anchorB);
        break;
      case 'prismatic':
        params = RAPIER.JointData.prismatic(anchorA, anchorB, axis);
        break;
      case 'distance': {
        // SPEC 3.7: `limits` is the allowed separation; `null` fixes it at the
        // separation the bodies have when the joint is added.
        const current = distanceBetween(a.body, b.body, anchorA, anchorB);
        if (!spec.limits) {
          // A rope only caps the maximum, so a stiff spring at the current length
          // is what actually pins the separation.
          params = RAPIER.JointData.spring(current, PIN_STIFFNESS, PIN_DAMPING, anchorA, anchorB);
        } else {
          const [min, max] = spec.limits;
          if (min > 0) {
            // Rapier's rope joint carries a maximum length only.
            this.warn(`distance joint ${jointId} cannot express a minimum separation of ${min} in Rapier; `
              + `the maximum ${max} is applied as a rope`);
          }
          params = RAPIER.JointData.rope(max, anchorA, anchorB);
        }
        break;
      }
      default:
        this.warn(`joint type "${spec.type}" is not supported`);
        return;
    }
    if (spec.limits && (spec.type === 'revolute' || spec.type === 'prismatic')) {
      params.limitsEnabled = true;
      params.limits = [spec.limits[0], spec.limits[1]];
    }
    const joint = this.world.createImpulseJoint(params, a.body, b.body, true);
    this.joints.set(jointId, { joint, spec });
  }

  removeJoint(jointId) {
    const entry = this.joints.get(jointId);
    if (!entry) return;
    this.world.removeImpulseJoint(entry.joint, true);
    this.joints.delete(jointId);
  }

  // ------------------------------------------------------------------ step

  /** Fixed 1/60 stepping with an accumulator. Returns collision events for this frame. */
  step(dt) {
    const events = [];
    this.accumulator += Math.max(0, dt);
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_SUBSTEPS) {
      // Force fields and character controllers run before the solver.
      if (this.beforeStep) this.beforeStep(FIXED_STEP);
      this.world.timestep = FIXED_STEP;
      this.world.step(this.eventQueue);
      // SPEC 3.7 and 14.4: a force is applied for the step it was given for.
      // Rapier would otherwise keep it for ever, so one push becomes a rocket.
      if (this.forcedBodies.size) {
        for (const body of this.forcedBodies) {
          body.resetForces(true);
          body.resetTorques(true);
        }
        this.forcedBodies.clear();
      }
      this._collectEvents(events);
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    return events;
  }

  _collectEvents(out) {
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      const idA = this.colliderToId.get(h1);
      const idB = this.colliderToId.get(h2);
      if (idA === undefined || idB === undefined) return;
      let point = [0, 0, 0];
      let normal = [0, 1, 0];
      let impulse = 0;
      if (started) {
        const contact = this._contactDetails(h1, h2);
        if (contact) {
          point = contact.point;
          normal = contact.normal;
          impulse = contact.impulse;
        }
      }
      out.push({ type: started ? 'collisionstart' : 'collisionend', idA, idB, point, normal, impulse });
    });
  }

  _contactDetails(h1, h2) {
    const c1 = this.world.getCollider(h1);
    const c2 = this.world.getCollider(h2);
    if (!c1 || !c2) return null;
    let result = null;
    try {
      this.world.contactPair(c1, c2, (manifold, flipped) => {
        if (result) return;
        const n = manifold.normal();
        const count = manifold.numSolverContacts ? manifold.numSolverContacts() : 0;
        const p = count > 0 ? manifold.solverContactPoint(0) : null;
        let impulse = 0;
        try {
          if (manifold.numContacts && manifold.numContacts() > 0) impulse = manifold.contactImpulse(0);
        } catch {
          impulse = 0;
        }
        result = {
          point: p ? [p.x, p.y, p.z] : [0, 0, 0],
          normal: flipped ? [-n.x, -n.y, -n.z] : [n.x, n.y, n.z],
          impulse: Number.isFinite(impulse) ? impulse : 0,
        };
      });
    } catch {
      return null;
    }
    return result;
  }

  // --------------------------------------------------------- manipulation

  /** Switches a dynamic body to kinematic so the pointer can drive it. */
  beginManipulation(id) {
    const entry = this.bodies.get(id);
    if (!entry || bodyType(entry.spec) !== 'dynamic' || entry.manipulated) return false;
    entry.manipulated = true;
    entry.body.setBodyType(this.RAPIER.RigidBodyType.KinematicPositionBased, true);
    entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    return true;
  }

  /** Moves a manipulated body to the object's current world transform. */
  driveManipulated(id, object) {
    const entry = this.bodies.get(id);
    if (!entry || !entry.manipulated) return;
    const world = decomposeWorld(object);
    entry.body.setNextKinematicTranslation(world.position);
    entry.body.setNextKinematicRotation(world.rotation);
  }

  /** Hands the body back to the simulation when the gesture ends. */
  endManipulation(id) {
    const entry = this.bodies.get(id);
    if (!entry || !entry.manipulated) return;
    entry.manipulated = false;
    entry.body.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
    entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  // ------------------------------------------------------------------ sync

  /**
   * Flat `[id, px,py,pz, qx,qy,qz,qw, sx,sy,sz]` world records for dynamic bodies.
   * Scale is not simulated, so the object's current world scale is passed through.
   */
  transformRecords(exclude = null) {
    const ids = [];
    for (const [id, entry] of this.bodies) {
      // A manipulated body is pointer-driven, so its simulated pose is not
      // reported; the consumer sends the manipulated transform instead.
      if (exclude && exclude.has(id)) continue;
      if (bodyType(entry.spec) === 'dynamic') ids.push(id);
    }
    if (this._syncBuffer.length !== ids.length * 11) this._syncBuffer = new Float32Array(ids.length * 11);
    const buf = this._syncBuffer;
    let o = 0;
    for (const id of ids) {
      const entry = this.bodies.get(id);
      const t = entry.body.translation();
      const r = entry.body.rotation();
      entry.object.matrixWorld.decompose(_pos, _quat, _scale);
      buf[o++] = id;
      buf[o++] = t.x; buf[o++] = t.y; buf[o++] = t.z;
      buf[o++] = r.x; buf[o++] = r.y; buf[o++] = r.z; buf[o++] = r.w;
      buf[o++] = _scale.x; buf[o++] = _scale.y; buf[o++] = _scale.z;
    }
    return buf;
  }

  /** Flat `[id, lvx,lvy,lvz, avx,avy,avz, sleeping]` records for every body. */
  bodyRecords() {
    const ids = [...this.bodies.keys()];
    if (this._bodyBuffer.length !== ids.length * 8) this._bodyBuffer = new Float32Array(ids.length * 8);
    const buf = this._bodyBuffer;
    let o = 0;
    for (const id of ids) {
      const entry = this.bodies.get(id);
      const lv = entry.body.linvel();
      const av = entry.body.angvel();
      buf[o++] = id;
      buf[o++] = lv.x; buf[o++] = lv.y; buf[o++] = lv.z;
      buf[o++] = av.x; buf[o++] = av.y; buf[o++] = av.z;
      buf[o++] = entry.body.isSleeping() ? 1 : 0;
    }
    return buf;
  }
}

const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 };
// Stiff enough to hold a pinned distance joint, damped enough to stay stable.
const PIN_STIFFNESS = 1e5;
const PIN_DAMPING = 1e3;

/** A trigger is collision-only whatever its `type` says (SPEC 3.7). */
function bodyType(spec) {
  if (spec.isTrigger === true) return 'kinematic';
  return spec.type || 'dynamic';
}

function hasGeometry(object) {
  const attribute = object.geometry && object.geometry.getAttribute
    ? object.geometry.getAttribute('position')
    : null;
  return !!attribute && attribute.count > 0;
}

function label(object) {
  return object.name ? `"${object.name}"` : (object.type || 'object');
}

function toVec(v, fallback = { x: 0, y: 0, z: 0 }) {
  if (!v) return { ...fallback };
  if (Array.isArray(v)) return { x: v[0] || 0, y: v[1] || 0, z: v[2] || 0 };
  return { x: v.x || 0, y: v.y || 0, z: v.z || 0 };
}

function distanceBetween(bodyA, bodyB, anchorA, anchorB) {
  const a = bodyA.translation();
  const b = bodyB.translation();
  const dx = b.x + anchorB.x - (a.x + anchorA.x);
  const dy = b.y + anchorB.y - (a.y + anchorA.y);
  const dz = b.z + anchorB.z - (a.z + anchorA.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
}
