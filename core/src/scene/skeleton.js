// Skeletons and blend shapes on loaded assets (SPEC 14.5).
//
// The consumer reports what the asset actually has when it resolves; the
// script poses joints and sets weights, and those edits ride the `skeleton`
// and `blendShapes` commands. A native animation overrides script poses while
// it runs, which is why `track(true)` exists: it asks the consumer to report
// the real joint transforms back through `syncSkeleton`.

import { Vector3, Quaternion } from "../util/three-exports.js";
import { push } from "../util/builtins.js";
import { clamp } from "../util/sanitize.js";
import { MAX_SKELETON_JOINTS, MAX_BLEND_SHAPES } from "../util/limits.js";
import { DIRTY, DIRTY_FEATURE } from "./object-extensions.js";
import { host } from "../host/host.js";

export class Skeleton {
  constructor(object, names) {
    this.object = object;
    this.joints = [];
    for (let i = 0; i < names.length && i < MAX_SKELETON_JOINTS; i += 1) {
      if (typeof names[i] === "string") push(this.joints, names[i]);
    }
    this._known = new Set(this.joints);
    // Script-authored poses, by joint name.
    this._posed = new Map();
    // Transforms the consumer last reported, by joint name.
    this._synced = new Map();
    this._tracking = false;
    this.generation = 0;
  }

  /** The joint's current transform: what the consumer reported, else the pose. */
  getJointTransform(name) {
    const synced = this._synced.get(name);
    if (synced !== undefined) {
      return { position: synced.position.clone(), quaternion: synced.quaternion.clone() };
    }
    const posed = this._posed.get(name);
    if (posed !== undefined) {
      return { position: posed.position.clone(), quaternion: posed.quaternion.clone() };
    }
    return null;
  }

  setJointRotation(name, quaternion) {
    const pose = this._pose(name, "setJointRotation");
    if (pose === null) return this;
    pose.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    this._changed();
    return this;
  }

  setJointPosition(name, position) {
    const pose = this._pose(name, "setJointPosition");
    if (pose === null) return this;
    pose.position.set(position.x, position.y, position.z);
    this._changed();
    return this;
  }

  /** Drops every script pose; the asset returns to its authored rest pose. */
  reset() {
    if (this._posed.size === 0) return this;
    this._posed.clear();
    this._changed();
    return this;
  }

  /** Asks the consumer to report joint transforms through syncSkeleton. */
  track(enabled) {
    const next = enabled !== false;
    if (next === this._tracking) return this;
    this._tracking = next;
    this._changed();
    return this;
  }

  get tracking() {
    return this._tracking;
  }

  toJSON() {
    const joints = {};
    for (const [name, pose] of this._posed) {
      joints[name] = [
        pose.position.x,
        pose.position.y,
        pose.position.z,
        pose.quaternion.x,
        pose.quaternion.y,
        pose.quaternion.z,
        pose.quaternion.w,
      ];
    }
    return { joints, track: this._tracking };
  }

  /** Consumer to core: the transforms the rig actually has right now. */
  _sync(joints) {
    if (joints === null || typeof joints !== "object") return;
    for (const name of Object.keys(joints)) {
      if (!this._known.has(name)) continue;
      const value = joints[name];
      if (!value || value.length < 7) continue;
      let record = this._synced.get(name);
      if (record === undefined) {
        record = { position: new Vector3(), quaternion: new Quaternion() };
        this._synced.set(name, record);
      }
      record.position.set(value[0], value[1], value[2]);
      record.quaternion.set(value[3], value[4], value[5], value[6]);
    }
  }

  _pose(name, what) {
    if (!this._known.has(name)) {
      const runtime = hostOf(this.object);
      if (runtime) {
        runtime.warnOnce(
          `skeleton-joint:${name}`,
          `Skeleton.${what} was given "${name}", which this asset has no joint for; it was ignored`,
        );
      }
      return null;
    }
    let pose = this._posed.get(name);
    if (pose === undefined) {
      const known = this._synced.get(name);
      pose = {
        position: known === undefined ? new Vector3() : known.position.clone(),
        quaternion: known === undefined ? new Quaternion() : known.quaternion.clone(),
      };
      this._posed.set(name, pose);
    }
    return pose;
  }

  _changed() {
    this.generation += 1;
    if (this.object !== null) this.object[DIRTY] = (this.object[DIRTY] | 0) | DIRTY_FEATURE;
  }
}

export class BlendShapes {
  constructor(object, names) {
    this.object = object;
    this.names = [];
    for (let i = 0; i < names.length && i < MAX_BLEND_SHAPES; i += 1) {
      if (typeof names[i] === "string") push(this.names, names[i]);
    }
    this._known = new Set(this.names);
    this._weights = new Map();
    this.generation = 0;
  }

  get(name) {
    const weight = this._weights.get(name);
    return weight === undefined ? 0 : weight;
  }

  set(name, weight) {
    if (!this._known.has(name)) {
      const runtime = hostOf(this.object);
      if (runtime) {
        runtime.warnOnce(
          `blend-shape:${name}`,
          `BlendShapes.set was given "${name}", which this asset has no blend shape for; it was ignored`,
        );
      }
      return this;
    }
    const value = clamp(weight, 0, 1, 0);
    if (this._weights.get(name) === value) return this;
    this._weights.set(name, value);
    this.generation += 1;
    if (this.object !== null) this.object[DIRTY] = (this.object[DIRTY] | 0) | DIRTY_FEATURE;
    return this;
  }

  toJSON() {
    const out = {};
    for (const [name, weight] of this._weights) out[name] = weight;
    return out;
  }
}

function hostOf() {
  return host();
}
