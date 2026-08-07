import { MAX_PARAMETER_KEYS, MAX_PARAMETER_STRING, MAX_PARAMETER_ARRAY, MAX_NAME_LENGTH } from "./limits.js";
import { objectKeys, push, cut } from "./builtins.js";

// Numeric guards. SPEC section 2's robustness rule: no script input may crash
// the host or reach a consumer as a non-finite number.
//
// These are all allocation-free and used on the per-frame path, so they stay
// plain numeric checks.

/** Returns `value` when it is a finite number, otherwise `fallback`. */
export function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Finite and clamped into [min, max]. */
export function clamp(value, min, max, fallback) {
  const number = finite(value, fallback);
  if (number < min) return min;
  if (number > max) return max;
  return number;
}

/** Finite and at least `min` (used for masses, damping, rates). */
export function atLeast(value, min, fallback) {
  const number = finite(value, fallback);
  return number < min ? min : number;
}

/** Finite integer, at least `min` (used for segment counts). */
export function intAtLeast(value, min, fallback) {
  const number = finite(value, fallback);
  const rounded = Math.round(number);
  return rounded < min ? min : rounded;
}

/**
 * A geometry extent: negative sizes become their absolute value and zero
 * becomes 0.001, so a degenerate mesh never reaches the consumer.
 */
export function extent(value, fallback) {
  const number = finite(value, fallback);
  const magnitude = Math.abs(number);
  return magnitude === 0 ? 0.001 : magnitude;
}

/** Finite [x, y, z] for a command payload. */
export function vector3Array(v, fallbackX = 0, fallbackY = 0, fallbackZ = 0) {
  return [finite(v.x, fallbackX), finite(v.y, fallbackY), finite(v.z, fallbackZ)];
}

/** Finite [x, y] for a command payload. */
export function vector2Array(v, fallbackX = 0, fallbackY = 0) {
  return [finite(v.x, fallbackX), finite(v.y, fallbackY)];
}

/** Linear [r, g, b], clamped to 0..1 and finite. */
export function colorArray(color, fallback = 1) {
  if (!color) return [fallback, fallback, fallback];
  return [clamp(color.r, 0, 1, fallback), clamp(color.g, 0, 1, fallback), clamp(color.b, 0, 1, fallback)];
}

/**
 * Copies a geometry `parameters` object, keeping only what the wire may carry:
 * finite numbers, booleans, short strings, and short arrays of finite numbers.
 * Anything else — a function, a cyclic object, a huge array — is dropped and
 * named in `dropped` so the caller can warn (ROBUST-06, the feeder for the
 * crash in ROBUST-01).
 */
export function sanitizeParameters(parameters, dropped) {
  if (!parameters) return null;
  const out = {};
  let keys;
  try {
    keys = objectKeys(parameters);
  } catch {
    return null;
  }
  const limit = keys.length > MAX_PARAMETER_KEYS ? MAX_PARAMETER_KEYS : keys.length;
  for (let i = 0; i < limit; i += 1) {
    const key = keys[i];
    let value;
    try {
      value = parameters[key];
    } catch {
      if (dropped) push(dropped, key);
      continue;
    }
    const kind = typeof value;
    if (kind === "number") {
      out[key] = finite(value, 0);
    } else if (kind === "boolean") {
      out[key] = value;
    } else if (kind === "string") {
      out[key] = value.length > MAX_PARAMETER_STRING ? cut(value, MAX_PARAMETER_STRING) : value;
    } else if (Array.isArray(value) && value.length <= MAX_PARAMETER_ARRAY) {
      const numbers = [];
      let ok = true;
      for (let j = 0; j < value.length; j += 1) {
        if (typeof value[j] !== "number" || !Number.isFinite(value[j])) {
          ok = false;
          break;
        }
        push(numbers, value[j]);
      }
      if (ok) out[key] = numbers;
      else if (dropped) push(dropped, key);
    } else if (dropped) {
      push(dropped, key);
    }
  }
  if (keys.length > limit && dropped) push(dropped, `… ${keys.length - limit} more keys`);
  return out;
}

/** A name the wire may carry: capped, with the caller warning when it changed. */
export function cappedName(name) {
  if (typeof name !== "string") return "";
  return name.length > MAX_NAME_LENGTH ? cut(name, MAX_NAME_LENGTH) : name;
}

/** `"name"` when the object has one, otherwise its type. Used in every report. */
export function labelFor(object) {
  try {
    const name = object.name;
    if (typeof name === "string" && name.length > 0) return `"${cappedName(name)}"`;
    const type = object.type;
    return typeof type === "string" ? type : "Object3D";
  } catch {
    return "Object3D";
  }
}

/** Shared option reader for the classes that take an options bag. */
export function pick(options, key, fallback) {
  const value = options[key];
  return value === undefined ? fallback : value;
}

/**
 * Checks the ten local TRS floats a `transform` command carries. A zero-length
 * quaternion is invalid too: it cannot describe a rotation.
 */
export function trsIsValid(trs) {
  for (let i = 0; i < 10; i += 1) {
    if (!Number.isFinite(trs[i])) return false;
  }
  const qx = trs[3];
  const qy = trs[4];
  const qz = trs[5];
  const qw = trs[6];
  return qx * qx + qy * qy + qz * qz + qw * qw > 1e-12;
}
