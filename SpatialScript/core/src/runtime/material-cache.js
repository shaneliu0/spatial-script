// One material payload per material per frame.
//
// A material instance is usually shared by many meshes, so its own state is
// compared once and each mesh only checks payload identity (PERF-08's dirty
// gate; the payload shape itself is SPEC section 5).

import {
  materialSnapshot,
  materialSnapshotEquals,
  MATERIAL_DIRTY,
  MATERIAL_FRAME,
  MATERIAL_PAYLOAD,
  MATERIAL_RAW,
  UNTRACKED_PROPERTIES,
} from "../materials.js";
import { push } from "../builtins.js";

export function materialPayload(runtime, material, frame) {
    material[MATERIAL_FRAME] = frame;

    let raw = material[MATERIAL_RAW];
    const color = material.color;
    const emissive = material.emissive;
    const colorR = color === undefined ? undefined : color.r;
    const colorG = color === undefined ? undefined : color.g;
    const colorB = color === undefined ? undefined : color.b;
    const emissiveR = emissive === undefined ? undefined : emissive.r;
    const emissiveG = emissive === undefined ? undefined : emissive.g;
    const emissiveB = emissive === undefined ? undefined : emissive.b;

    // Fast path: no tracked property was written and no colour channel moved.
    if (
      raw !== undefined &&
      material[MATERIAL_DIRTY] !== true &&
      raw.colorR === colorR &&
      raw.colorG === colorG &&
      raw.colorB === colorB &&
      raw.emissiveR === emissiveR &&
      raw.emissiveG === emissiveG &&
      raw.emissiveB === emissiveB &&
      raw.uuid === material.uuid &&
      untrackedUnchanged(runtime, material, raw)
    ) {
      return material[MATERIAL_PAYLOAD];
    }

    if (raw === undefined) {
      raw = { untracked: [] };
      material[MATERIAL_RAW] = raw;
    }
    material[MATERIAL_DIRTY] = false;
    raw.uuid = material.uuid;
    raw.colorR = colorR;
    raw.colorG = colorG;
    raw.colorB = colorB;
    raw.emissiveR = emissiveR;
    raw.emissiveG = emissiveG;
    raw.emissiveB = emissiveB;
    for (let i = 0; i < UNTRACKED_PROPERTIES.length; i += 1) {
      raw.untracked[i] = material[UNTRACKED_PROPERTIES[i]];
    }

    const built = materialSnapshot(material, runtime.boundTextureIdFor, runtime.boundWarnOnce);
    const previous = material[MATERIAL_PAYLOAD];
    // Keep the previous object when nothing observable changed, so meshes that
    // already flushed it compare equal by identity.
    const result = previous !== undefined && materialSnapshotEquals(previous, built) ? previous : built;
    material[MATERIAL_PAYLOAD] = result;
    return result;
  }

  /** Properties three.js already defines an accessor for, compared by value. */
export function untrackedUnchanged(runtime, material, raw) {
    const names = UNTRACKED_PROPERTIES;
    for (let i = 0; i < names.length; i += 1) {
      if (raw.untracked[i] !== material[names[i]]) return false;
    }
    return true;
  }

