// Built-ins captured at bundle evaluation, before any script can run.
//
// A script may replace Array.prototype.push, Object.prototype.toString or any
// other primitive the diff walks over. Everything the hot path and the teardown
// path need is bound here so a patched prototype cannot stop the frame loop
// (ROBUST-04).

const arrayPush = Array.prototype.push;
const arraySlice = Array.prototype.slice;
const arrayIndexOf = Array.prototype.indexOf;
const objectKeys = Object.keys;
const objectHasOwn = Object.prototype.hasOwnProperty;
const stringSlice = String.prototype.slice;
const jsonStringify = JSON.stringify;
const mathAbs = Math.abs;
const mathMin = Math.min;
const numberIsFinite = Number.isFinite;

export { objectKeys, numberIsFinite, mathAbs, mathMin };

/** `array.push(value)` that a script cannot intercept. */
export function push(array, value) {
  arrayPush.call(array, value);
  return array;
}

export function slice(array, start, end) {
  return arraySlice.call(array, start, end);
}

export function indexOf(array, value) {
  return arrayIndexOf.call(array, value);
}

export function hasOwn(object, key) {
  return objectHasOwn.call(object, key);
}

export function cut(text, length) {
  return stringSlice.call(text, 0, length);
}

/** JSON.stringify that never throws, whatever the value does. */
export function safeStringify(value) {
  try {
    const text = jsonStringify(value);
    return text === undefined ? "[unserializable]" : text;
  } catch {
    return "[unserializable]";
  }
}

/** String(value) that never throws, even for a hostile toString (ROBUST-08). */
export function safeString(value) {
  try {
    return String(value);
  } catch {
    return "[unstringifiable object]";
  }
}
