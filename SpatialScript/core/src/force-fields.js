// Force effects (SPEC 14.4). Each field is an Object3D acting on dynamic
// bodies within `radius` of its world position; the consumer runs the effect.

import { Object3D, Vector3 } from "./three-exports.js";
import { atLeast, finite, vector3Array } from "./sanitize.js";
import { DIRTY, DIRTY_FEATURE } from "./object-extensions.js";

const FALLOFFS = ["none", "linear", "inverseSquare"];

class ForceField extends Object3D {
  constructor(kind, options = {}) {
    super();
    if (options === null || typeof options !== "object") {
      throw new TypeError(`${kind} expects an options object`);
    }
    this.type = kind;
    this.isForceField = true;
    this.kind = kind;
    this._enabled = options.enabled !== false;
    this._radius = atLeast(options.radius, 0, 1);
    // A collision mask, forwarded to the consumer unchanged.
    this._mask = Number.isFinite(options.mask) ? options.mask | 0 : -1;
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this._enabled = value !== false;
    this._touch();
  }

  get radius() {
    return this._radius;
  }

  set radius(value) {
    this._radius = atLeast(value, 0, this._radius);
    this._touch();
  }

  get mask() {
    return this._mask;
  }

  set mask(value) {
    this._mask = Number.isFinite(value) ? value | 0 : -1;
    this._touch();
  }

  _touch() {
    this[DIRTY] = (this[DIRTY] | 0) | DIRTY_FEATURE;
  }

  _base() {
    return { kind: this.kind, enabled: this._enabled, radius: this._radius, mask: this._mask };
  }

  toJSON() {
    return this._base();
  }
}

export class ConstantForceField extends ForceField {
  constructor(options = {}) {
    super("ConstantForceField", options);
    this.force = new Vector3();
    if (options.force) this.force.copy(options.force);
  }

  toJSON() {
    const json = this._base();
    json.force = vector3Array(this.force);
    return json;
  }
}

export class RadialForceField extends ForceField {
  constructor(options = {}) {
    super("RadialForceField", options);
    this._strength = finite(options.strength, 1);
    this._minimumDistance = atLeast(options.minimumDistance, 0, 0.01);
    this._falloff = FALLOFFS.indexOf(options.falloff) === -1 ? "inverseSquare" : options.falloff;
  }

  get strength() {
    return this._strength;
  }

  set strength(value) {
    this._strength = finite(value, this._strength);
    this._touch();
  }

  get minimumDistance() {
    return this._minimumDistance;
  }

  set minimumDistance(value) {
    this._minimumDistance = atLeast(value, 0, this._minimumDistance);
    this._touch();
  }

  get falloff() {
    return this._falloff;
  }

  set falloff(value) {
    if (FALLOFFS.indexOf(value) === -1) {
      throw new TypeError(`RadialForceField.falloff must be one of ${FALLOFFS.join(", ")}`);
    }
    this._falloff = value;
    this._touch();
  }

  toJSON() {
    const json = this._base();
    json.strength = this._strength;
    json.minimumDistance = this._minimumDistance;
    json.falloff = this._falloff;
    return json;
  }
}

export class VortexForceField extends ForceField {
  constructor(options = {}) {
    super("VortexForceField", options);
    this._strength = finite(options.strength, 1);
    this.axis = new Vector3(0, 1, 0);
    if (options.axis) this.axis.copy(options.axis);
  }

  get strength() {
    return this._strength;
  }

  set strength(value) {
    this._strength = finite(value, this._strength);
    this._touch();
  }

  toJSON() {
    const json = this._base();
    json.strength = this._strength;
    json.axis = vector3Array(this.axis, 0, 1, 0);
    return json;
  }
}

export class DragForceField extends ForceField {
  constructor(options = {}) {
    super("DragForceField", options);
    this._coefficient = atLeast(options.coefficient, 0, 1);
  }

  get coefficient() {
    return this._coefficient;
  }

  set coefficient(value) {
    this._coefficient = atLeast(value, 0, this._coefficient);
    this._touch();
  }

  toJSON() {
    const json = this._base();
    json.coefficient = this._coefficient;
    return json;
  }
}

export class TurbulenceForceField extends ForceField {
  constructor(options = {}) {
    super("TurbulenceForceField", options);
    this._strength = finite(options.strength, 1);
    this._noiseScale = atLeast(options.noiseScale, 0.0001, 1);
  }

  get strength() {
    return this._strength;
  }

  set strength(value) {
    this._strength = finite(value, this._strength);
    this._touch();
  }

  get noiseScale() {
    return this._noiseScale;
  }

  set noiseScale(value) {
    this._noiseScale = atLeast(value, 0.0001, this._noiseScale);
    this._touch();
  }

  toJSON() {
    const json = this._base();
    json.strength = this._strength;
    json.noiseScale = this._noiseScale;
    return json;
  }
}

export { ForceField };
