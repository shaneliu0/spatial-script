// The one ancestor walk the consumer uses. It was written out five times across
// consumer.js, input.js and native-dump.js; MAINT-03 asked for a single helper.

/**
 * Walks `object` and then its ancestors, returning the first node `test`
 * accepts, or null.
 * @param {import('three').Object3D|null} object
 * @param {(node: import('three').Object3D) => boolean} test
 */
export function walkUp(object, test) {
  let node = object;
  while (node) {
    if (test(node)) return node;
    node = node.parent;
  }
  return null;
}

/** True when `candidate` is `node` or one of its descendants. */
export function isDescendantOf(candidate, node) {
  return walkUp(candidate, (current) => current === node) !== null;
}

/** The `__spatialId` of the nearest node that carries one, or undefined. */
export function idOf(object) {
  const owner = walkUp(object, (node) => node.userData && node.userData.__spatialId !== undefined);
  return owner ? owner.userData.__spatialId : undefined;
}
