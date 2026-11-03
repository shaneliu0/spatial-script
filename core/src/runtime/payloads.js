// Small payload helpers shared by the diff and the flush.

import { objectKeys } from "../util/builtins.js";

/** Structural equality for a flat JSON payload with array-valued fields. */
export function shallowJSONEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = objectKeys(a);
  if (keys.length !== objectKeys(b).length) return false;
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length) return false;
      for (let i = 0; i < av.length; i += 1) if (av[i] !== bv[i]) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

/** A light payload the command stream owns, copied out of the reused scratch. */
export function copyLightSnapshot(source) {
  return {
    type: source.type,
    color: source.color,
    intensity: source.intensity,
    distance: source.distance,
    decay: source.decay,
    angle: source.angle,
    penumbra: source.penumbra,
    castShadow: source.castShadow,
    direction: source.direction,
  };
}
