// Character controllers (SPEC 14.4). The object becomes native-driven like a
// dynamic body: the script asks for a displacement, the consumer resolves it
// against the world and reports the result through `syncCharacter`.

import { Object3D, Vector3 } from "../util/three-exports.js";
import { host } from "../host/host.js";
import { atLeast, clamp, finite } from "../util/sanitize.js";
import { SpatialUnsupportedError } from "../util/errors.js";
import { DIRTY, DIRTY_FEATURE } from "../scene/object-extensions.js";

export class CharacterController {
  constructor(options = {}) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("CharacterController expects an options object");
    }
    this.radius = atLeast(options.radius, 0.001, 0.2);
    this.height = atLeast(options.height, 0.001, 1);
    // Radians, like three's angles: the steepest slope the character climbs.
    this.slopeLimit = clamp(options.slopeLimit, 0, Math.PI / 2, 0.785);
    this.stepLimit = atLeast(options.stepLimit, 0, 0.3);
    this.gravity = options.gravity !== false;
    this.object = null;
    this._isOnGround = false;
    this._velocity = new Vector3();
  }

  get isOnGround() {
    return this._isOnGround;
  }

  /** Read-only: the consumer owns it. */
  get velocity() {
    return this._velocity;
  }

  /** A displacement for the coming frame; the consumer slides it along walls. */
  move(displacement) {
    if (!displacement || !Number.isFinite(displacement.x)) {
      throw new TypeError("CharacterController.move expects a Vector3");
    }
    const runtime = host();
    const object = this.object;
    if (runtime === null || object === null) return this;
    if (!runtime.canCommand(object, "CharacterController.move")) return this;
    if (
      !Number.isFinite(displacement.x) ||
      !Number.isFinite(displacement.y) ||
      !Number.isFinite(displacement.z)
    ) {
      return this;
    }
    runtime.queueCommand([
      "characterMove",
      runtime.idForObject(object),
      displacement.x,
      displacement.y,
      displacement.z,
    ], object);
    return this;
  }

  /** An unconditional placement, ignoring collision. */
  teleport(position) {
    if (!position || !Number.isFinite(position.x)) {
      throw new TypeError("CharacterController.teleport expects a Vector3");
    }
    const runtime = host();
    const object = this.object;
    if (object !== null) {
      object.position.copy(position);
      if (object.parent !== null) object.parent.worldToLocal(object.position);
    }
    if (runtime === null || object === null) return this;
    if (!runtime.canCommand(object, "CharacterController.teleport")) return this;
    runtime.queueCommand([
      "characterTeleport",
      runtime.idForObject(object),
      position.x,
      position.y,
      position.z,
    ], object);
    return this;
  }

  toJSON() {
    return {
      radius: this.radius,
      height: this.height,
      slopeLimit: this.slopeLimit,
      stepLimit: this.stepLimit,
      gravity: this.gravity,
    };
  }

  _sync(isOnGround, vx, vy, vz) {
    this._isOnGround = isOnGround;
    this._velocity.set(vx, vy, vz);
  }
}

const CONTROLLER = Symbol("spatial.characterController");

/**
 * Replaces the tracked property with one that validates and takes ownership,
 * the same contract `Object3D.rigidBody` has.
 */
export function installCharacterController() {
  Object.defineProperty(Object3D.prototype, "characterController", {
    configurable: true,
    enumerable: true,
    get() {
      return this[CONTROLLER] === undefined ? null : this[CONTROLLER];
    },
    set(controller) {
      const previous = this[CONTROLLER];
      if (previous && previous !== controller) previous.object = null;
      if (controller === null || controller === undefined) {
        this[CONTROLLER] = null;
        this[DIRTY] = (this[DIRTY] | 0) | DIRTY_FEATURE;
        return;
      }
      if (!(controller instanceof CharacterController)) {
        throw new TypeError("Object3D.characterController must be a Spatial.CharacterController or null");
      }
      if (controller.object !== null && controller.object !== this) {
        const owner = controller.object.name ? `"${controller.object.name}"` : controller.object.type;
        throw new SpatialUnsupportedError(
          `This CharacterController is already attached to ${owner}; construct one per object`,
          "character-shared",
          this,
        );
      }
      controller.object = this;
      this[CONTROLLER] = controller;
      this[DIRTY] = (this[DIRTY] | 0) | DIRTY_FEATURE;
    },
  });
}
