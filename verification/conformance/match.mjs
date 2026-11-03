// Subset matcher for conformance expectations (SPEC section 9).
//
// Rules:
//   - every key in expected must exist in actual with an equal value
//   - numbers match within 1e-3
//   - arrays match element-wise
//   - entries of `objects` are matched by `name`
//   - keys absent from expected are unconstrained
//   - `warnings`, `errors` and `logs` match by substring: each expected string
//     must appear inside some actual string
//
// Two additions the node runner relies on, both opt-in from the expectation
// file so a runner that does not implement them is unaffected:
//   - an entry in `objects` may carry `"absent": true` to assert that no object
//     with that name exists
//   - the runner augments the dump with `objectCount` and `logs`

export const NUMBER_TOLERANCE = 1e-3;

const SUBSTRING_KEYS = new Set(["warnings", "errors", "logs"]);

export function matchDump(expected, actual) {
  const diffs = [];
  if (!actual || typeof actual !== "object") {
    diffs.push("actual dump is missing");
    return diffs;
  }

  for (const key of Object.keys(expected)) {
    if (key === "objects") {
      matchObjects(expected.objects, actual.objects || [], diffs);
    } else if (SUBSTRING_KEYS.has(key)) {
      matchSubstrings(key, expected[key], actual[key] || [], diffs);
    } else {
      matchValue(expected[key], actual[key], key, diffs);
    }
  }

  // An unexpected error always fails the case. An empty `errors` array in the
  // expectation means "assert none", not "assert nothing": writing it must not
  // be a way to switch this check off (AR-02).
  // `matchSubstrings` already asserts "none" for a declared empty list, so
  // this only covers the case where the expectation says nothing at all.
  if (!Object.prototype.hasOwnProperty.call(expected, "errors")) {
    const errors = actual.errors || [];
    if (errors.length > 0) {
      diffs.push(`errors: expected none, got ${JSON.stringify(errors)}`);
    }
  }

  return diffs;
}

function matchObjects(expectedObjects, actualObjects, diffs) {
  if (!Array.isArray(expectedObjects)) {
    diffs.push("objects: expectation must be an array");
    return;
  }
  const byName = new Map();
  for (const object of actualObjects) {
    if (!byName.has(object.name)) byName.set(object.name, object);
  }

  for (const expectedObject of expectedObjects) {
    const name = expectedObject.name;
    if (typeof name !== "string") {
      diffs.push("objects: every expected object needs a name");
      continue;
    }
    const actualObject = byName.get(name);
    if (expectedObject.absent === true) {
      if (actualObject) diffs.push(`objects["${name}"]: expected to be absent but it is present`);
      continue;
    }
    if (!actualObject) {
      const available = Array.from(byName.keys()).join(", ");
      diffs.push(`objects["${name}"]: not found (present: ${available || "none"})`);
      continue;
    }
    for (const key of Object.keys(expectedObject)) {
      if (key === "absent") continue;
      matchValue(expectedObject[key], actualObject[key], `objects["${name}"].${key}`, diffs);
    }
  }
}

function matchSubstrings(key, expectedList, actualList, diffs) {
  if (!Array.isArray(expectedList)) {
    diffs.push(`${key}: expectation must be an array of substrings`);
    return;
  }
  // An empty list asserts that nothing was recorded on that channel at all.
  if (expectedList.length === 0) {
    if (actualList.length > 0) {
      diffs.push(`${key}: expected none, got ${JSON.stringify(actualList)}`);
    }
    return;
  }
  for (const needle of expectedList) {
    const found = actualList.some((entry) => typeof entry === "string" && entry.includes(needle));
    if (!found) {
      diffs.push(`${key}: no entry contains ${JSON.stringify(needle)} (got ${JSON.stringify(actualList)})`);
    }
  }
}

export function matchValue(expected, actual, path, diffs) {
  if (expected === null) {
    if (actual !== null && actual !== undefined) {
      diffs.push(`${path}: expected null, got ${format(actual)}`);
    }
    return;
  }

  if (typeof expected === "number") {
    if (typeof actual !== "number" || !Number.isFinite(actual)) {
      diffs.push(`${path}: expected number ${expected}, got ${format(actual)}`);
    } else if (Math.abs(expected - actual) > NUMBER_TOLERANCE) {
      diffs.push(`${path}: expected ${expected}, got ${actual}`);
    }
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push(`${path}: expected array, got ${format(actual)}`);
      return;
    }
    if (expected.length !== actual.length) {
      diffs.push(`${path}: expected ${expected.length} elements, got ${actual.length}`);
      return;
    }
    for (let i = 0; i < expected.length; i += 1) {
      matchValue(expected[i], actual[i], `${path}[${i}]`, diffs);
    }
    return;
  }

  if (typeof expected === "object") {
    if (!actual || typeof actual !== "object") {
      diffs.push(`${path}: expected object, got ${format(actual)}`);
      return;
    }
    for (const key of Object.keys(expected)) {
      matchValue(expected[key], actual[key], `${path}.${key}`, diffs);
    }
    return;
  }

  if (expected !== actual) {
    diffs.push(`${path}: expected ${format(expected)}, got ${format(actual)}`);
  }
}

function format(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
