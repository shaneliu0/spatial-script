import {
  MAX_PARAMETER_KEYS,
  MAX_PARAMETER_STRING,
  MAX_PARAMETER_ARRAY,
  MAX_NAME_LENGTH,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
} from "./limits.js";
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

/**
 * A JSON-safe copy of a script value for a host payload (SPEC 14.10). Plain
 * data survives; functions, symbols, undefined, cycles, non-finite numbers and
 * anything past the depth or node budget do not. Never throws.
 */
export function jsonSafe(value, report) {
  const budget = { nodes: MAX_JSON_NODES, report: report === undefined ? null : report };
  return jsonSafeInner(value, 0, budget, new Set(), "state");
}

/** Records one lossy conversion, naming the path, once per path. */
function note(budget, path, reason) {
  const report = budget.report;
  if (report === null) return;
  if (report.length >= 32) return;
  for (let i = 0; i < report.length; i += 1) if (report[i].path === path) return;
  push(report, { path, reason });
}

function jsonSafeInner(value, depth, budget, seen, path) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "boolean" || type === "string") return value;
  if (type === "number") {
    if (Number.isFinite(value)) return value;
    note(budget, path, "a non-finite number became null");
    return null;
  }
  if (type !== "object") {
    note(budget, path, `a ${type} is not JSON and became null`);
    return null;
  }
  if (depth >= MAX_JSON_DEPTH) {
    note(budget, path, `nesting deeper than ${MAX_JSON_DEPTH} became null`);
    return null;
  }
  if (budget.nodes <= 0) {
    note(budget, path, `more than ${MAX_JSON_NODES} values became null`);
    return null;
  }
  if (seen.has(value)) {
    note(budget, path, "a cycle became null");
    return null;
  }
  budget.nodes -= 1;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        if (budget.nodes <= 0) {
          note(budget, path, `more than ${MAX_JSON_NODES} values were dropped`);
          break;
        }
        out[i] = jsonSafeInner(value[i], depth + 1, budget, seen, `${path}[${i}]`);
      }
      return out;
    }
    if (typeof value.toJSON === "function") {
      let produced;
      try {
        produced = value.toJSON();
      } catch (error) {
        note(budget, path, "toJSON threw and the value became null");
        return null;
      }
      // toJSON may hand back another object; one level of indirection only.
      if (produced === value) return null;
      return jsonSafeInner(produced, depth, budget, seen, path);
    }
    const out = {};
    const keys = objectKeys(value);
    // A Map, a Set or a class instance with no own enumerable keys is not the
    // object the script thinks it is handing over.
    if (keys.length === 0 && !isPlainObject(value)) {
      note(budget, path, `a ${constructorName(value)} has no JSON form and became {}`);
    }
    for (let i = 0; i < keys.length; i += 1) {
      if (budget.nodes <= 0) {
        note(budget, path, `more than ${MAX_JSON_NODES} values were dropped`);
        break;
      }
      const key = keys[i];
      const entry = jsonSafeInner(value[key], depth + 1, budget, seen, `${path}.${key}`);
      if (entry !== undefined) out[key] = entry;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function constructorName(value) {
  try {
    const name = value.constructor && value.constructor.name;
    return typeof name === "string" && name.length > 0 ? name : "value";
  } catch (error) {
    return "value";
  }
}
