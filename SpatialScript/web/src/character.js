// Kinematic character controllers and force fields (SPEC 14.4), on top of the
// Rapier world the consumer already owns.

import * as THREE from 'three';

const FALLOFFS = new Set(['none', 'linear', 'inverseSquare']);

export class CharacterControllers {
  /** @param {import('./physics.js').PhysicsWorld} physics */
  constructor(physics, deps) {
    this.physics = physics;
    this.deps = deps;
    /** @type {Map<number, object>} */
    this.controllers = new Map();
    this._records = new Float32Array(0);
  }

  /** `characterController`: full state, or null to remove it. */
  set(id, object, spec) {
    if (!spec) {
      this.remove(id);
      return;
    }
    const RAPIER = this.physics.RAPIER;
    let entry = this.controllers.get(id);
    if (entry) {
      this.remove(id);
      entry = null;
    }
    object.updateWorldMatrix(true, false);
    object.matrixWorld.decompose(_position, _quaternion, _scale);

    // P2-B-51: a NaN reaching Rapier is a wasm panic, not a catchable throw.
    const radius = Math.max(0.01, finite(spec.radius, 0.2));
    const height = Math.max(2 * radius, finite(spec.height, 1));
    const halfHeight = Math.max(0.001, height / 2 - radius);

    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(_position.x, _position.y, _position.z);
    const body = this.physics.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius);
    const collider = this.physics.world.createCollider(colliderDesc, body);

    const controller = this.physics.world.createCharacterController(0.01);
    controller.setUp({ x: 0, y: 1, z: 0 });
    const slopeLimit = finite(spec.slopeLimit, 0.785);
    const stepLimit = Math.max(0, finite(spec.stepLimit, 0.3));
    controller.setMaxSlopeClimbAngle(slopeLimit);
    controller.setMinSlopeSlideAngle(slopeLimit);
    controller.enableAutostep(stepLimit, radius * 0.5, true);
    controller.enableSnapToGround(Math.max(0.02, stepLimit * 0.5));

    this.controllers.set(id, {
      spec, object, body, collider, controller,
      pending: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      fallSpeed: 0,
      falling: false,
      isOnGround: false,
    });
  }

  /** `characterMove`: a displacement applied on the next step. */
  move(id, dx, dy, dz) {
    const entry = this.controllers.get(id);
    if (!entry) return;
    if (![dx, dy, dz].every(Number.isFinite)) {
      this.deps.warnOnce('characterMove', 'a character move with a non-finite displacement was ignored');
      return;
    }
    entry.pending.add(_move.set(dx, dy, dz));
    if (entry.spec.gravity !== false) entry.falling = true;
  }

  /** `characterTeleport`: place the body without sliding. */
  teleport(id, x, y, z) {
    const entry = this.controllers.get(id);
    if (!entry) return;
    if (![x, y, z].every(Number.isFinite)) {
      this.deps.warnOnce('characterTeleport', 'a character teleport with a non-finite position was ignored');
      return;
    }
    entry.body.setNextKinematicTranslation({ x, y, z });
    entry.body.setTranslation({ x, y, z }, true);
    entry.pending.set(0, 0, 0);
    entry.velocity.set(0, 0, 0);
    entry.fallSpeed = 0;
    entry.falling = false;
    // P2-B-27: the command carries world coordinates; `position` is local.
    _world.set(x, y, z);
    const parent = entry.object.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      _inverse.copy(parent.matrixWorld).invert();
      _world.applyMatrix4(_inverse);
    }
    entry.object.position.copy(_world);
    entry.object.updateMatrix();
  }

  /** Runs every controller for one fixed step, sliding along obstacles. */
  step(dt) {
    for (const entry of this.controllers.values()) {
      // SPEC 14.4: move() asks for a displacement and the controller moves
      // nothing on its own, so a frame with no request does not integrate
      // gravity either. This is what RealityKit's moveCharacter does.
      if (entry.pending.lengthSq() === 0 && !entry.falling) continue;
      const desired = _move.copy(entry.pending);
      entry.pending.set(0, 0, 0);
      if (entry.spec.gravity !== false) {
        entry.fallSpeed = entry.isOnGround ? 0 : entry.fallSpeed + this.physics.world.gravity.y * dt;
        desired.y += entry.fallSpeed * dt;
      }
      entry.controller.computeColliderMovement(entry.collider, desired);
      const applied = entry.controller.computedMovement();
      const translation = entry.body.translation();
      const next = {
        x: translation.x + applied.x,
        y: translation.y + applied.y,
        z: translation.z + applied.z,
      };
      entry.body.setNextKinematicTranslation(next);
      entry.body.setTranslation(next, true);
      entry.isOnGround = entry.controller.computedGrounded();
      if (entry.isOnGround) entry.fallSpeed = 0;
      // Keep integrating only while the character is still in the air.
      entry.falling = entry.spec.gravity !== false && !entry.isOnGround;
      entry.velocity.set(applied.x / dt, applied.y / dt, applied.z / dt);
    }
  }

  /** Flat `[id, px, py, pz, isOnGround, vx, vy, vz]` records for `syncCharacter`. */
  syncRecords() {
    const ids = [...this.controllers.keys()];
    if (this._records.length !== ids.length * 8) this._records = new Float32Array(ids.length * 8);
    let o = 0;
    for (const id of ids) {
      const entry = this.controllers.get(id);
      const translation = entry.body.translation();
      this._records[o++] = id;
      this._records[o++] = translation.x;
      this._records[o++] = translation.y;
      this._records[o++] = translation.z;
      this._records[o++] = entry.isOnGround ? 1 : 0;
      this._records[o++] = entry.velocity.x;
      this._records[o++] = entry.velocity.y;
      this._records[o++] = entry.velocity.z;
    }
    return this._records;
  }

  describe(id) {
    const entry = this.controllers.get(id);
    if (!entry) return null;
    return { ...entry.spec, isOnGround: entry.isOnGround };
  }

  remove(id) {
    const entry = this.controllers.get(id);
    if (!entry) return;
    this.controllers.delete(id);
    this.physics.world.removeCharacterController(entry.controller);
    this.physics.world.removeRigidBody(entry.body);
  }

  reset() {
    for (const id of [...this.controllers.keys()]) this.remove(id);
  }
}

/**
 * The five force fields of SPEC 14.4, applied to every dynamic body inside the
 * field's radius once per fixed step.
 */
export class ForceFields {
  constructor(physics, deps) {
    this.physics = physics;
    this.deps = deps;
    /** @type {Map<number, object>} */
    this.fields = new Map();
    this.time = 0;
  }

  set(id, object, spec) {
    if (!spec) {
      this.fields.delete(id);
      return;
    }
    // P2-B-11: collision groups are not modelled on the web, so a mask that asks
    // for anything other than "everything" is called out rather than guessed at.
    if (spec.mask !== undefined && spec.mask !== null && spec.mask !== -1) {
      this.deps.warnOnce(
        'forceFieldMask',
        'force field masks are not applied by the three.js consumer; the field affects every dynamic body',
      );
    }
    if (spec.falloff && !FALLOFFS.has(spec.falloff)) {
      this.deps.warnOnce(`falloff:${spec.falloff}`, `unknown force falloff "${spec.falloff}"; "none" is used`);
    }
    this.fields.set(id, { spec, object });
  }

  step(dt) {
    if (!this.fields.size) return;
    this.time += dt;
    for (const entry of this.fields.values()) {
      if (entry.spec.enabled === false) continue;
      entry.object.updateWorldMatrix(true, false);
      _position.setFromMatrixPosition(entry.object.matrixWorld);
      this._apply(entry.spec, _position, dt);
    }
  }

  _apply(spec, origin, dt) {
    const radius = spec.radius ?? Infinity;
    for (const [, body] of this.physics.bodies) {
      if ((body.spec.type || 'dynamic') !== 'dynamic' || body.spec.isTrigger === true) continue;

      const translation = body.body.translation();
      _toBody.set(translation.x - origin.x, translation.y - origin.y, translation.z - origin.z);
      const distance = _toBody.length();
      if (distance > radius) continue;
      const force = this._force(spec, _toBody, distance, body.body, dt);
      if (!force) continue;
      body.body.addForce({ x: force.x, y: force.y, z: force.z }, true);
    }
  }

  _force(spec, toBody, distance, body, dt) {
    switch (spec.kind) {
      case 'ConstantForceField': {
        const f = spec.force || [0, 0, 0];
        return _force.set(finite(f[0], 0), finite(f[1], 0), finite(f[2], 0));
      }
      case 'RadialForceField': {
        const minimum = spec.minimumDistance ?? 0;
        const effective = Math.max(minimum, distance, 1e-4);
        let scale = finite(spec.strength, 0);
        if (spec.falloff === 'linear') scale *= 1 - Math.min(1, effective / (spec.radius || 1));
        else if (spec.falloff === 'inverseSquare') scale /= effective * effective;
        return _force.copy(toBody).normalize().multiplyScalar(scale);
      }
      case 'VortexForceField': {
        const axis = spec.axis || [0, 1, 0];
        _axis.set(axis[0], axis[1], axis[2]).normalize();
        return _force.copy(_axis).cross(toBody).multiplyScalar(finite(spec.strength, 0));
      }
      case 'DragForceField': {
        const velocity = body.linvel();
        return _force.set(velocity.x, velocity.y, velocity.z).multiplyScalar(-finite(spec.coefficient, 0));
      }
      case 'TurbulenceForceField': {
        // Cheap value noise: enough to look unsteady without a noise table.
        const scale = finite(spec.noiseScale, 1);
        const t = this.time;
        const x = Math.sin((toBody.x * scale + t) * 1.7) * Math.cos((toBody.z * scale - t) * 2.3);
        const y = Math.sin((toBody.y * scale + t * 1.3) * 2.1);
        const z = Math.cos((toBody.z * scale + t * 0.7) * 1.9) * Math.sin((toBody.x * scale + t) * 1.1);
        return _force.set(x, y, z).multiplyScalar(finite(spec.strength, 0));
      }
      default:
        this.deps.warnOnce(`forceField:${spec.kind}`, `unknown force field "${spec.kind}" has no effect`);
        return null;
    }
  }

  describe(id) {
    const entry = this.fields.get(id);
    return entry ? { ...entry.spec } : null;
  }

  reset() {
    this.fields.clear();
    this.time = 0;
  }
}

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _move = new THREE.Vector3();
const _toBody = new THREE.Vector3();
const _force = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _world = new THREE.Vector3();
const _inverse = new THREE.Matrix4();

/** A finite number, or the fallback. Guards Rapier from a wasm panic. */
function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
