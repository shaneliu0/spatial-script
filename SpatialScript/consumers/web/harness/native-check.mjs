// AR-01 / AR-22 / AR-41: the core dump says what the script asked for; the
// native dump says what three.js actually built. Every conformance case and
// every scenario compares the two, so a consumer that ignores an opcode — or
// any field of one — cannot pass by leaning on the core's own dump.

import { diffValue } from '../../../verification/parity/compare.mjs';

/** Object types the core dumps that never become renderer objects. */
const NON_RENDERED = new Set([
  'Camera', 'PerspectiveCamera', 'OrthographicCamera',
  'Audio', 'PositionalAudio', 'AmbientAudio',
]);

/**
 * Keys inside a compared block that legitimately differ between the core's
 * description and what three.js holds. Each one is a documented case, not a
 * blanket allowance:
 *
 * - `uuid`: per-process, and the native dump omits it (SPEC 8).
 * - `nativeType`: the three.js class, which the core has no notion of.
 * - `maps`: the core reports the texture ids it sent; the consumer reports the
 *   ids it bound, which is the same fact tested by `boundMap:` in `components`.
 * - `requestedShape` / `requestedType`: what the script asked for before the
 *   core normalised it; the consumer only ever sees the normalised value.
 * - `fallback` / `source` / `name` / `parameters` / `generation`: a shader graph
 *   renders as its fallback here, so the block's shape differs by design
 *   (SPEC 14.6).
 */
const BLOCK_EXEMPT = new Set([
  'uuid', 'nativeType', 'maps',
  'requestedShape', 'requestedType',
  'fallback', 'source', 'parameters', 'generation',
]);

/** Object kinds whose native material is the renderer's own, not the script's. */
const NATIVE_MATERIAL_KINDS = new Set(['Portal', 'ParticleEmitter']);

/**
 * @param {object} dump the core dump (`Spatial.dump()`)
 * @param {object} native the consumer dump (`spatialNativeDump()`)
 * @returns {string[]} one line per divergence
 */
export function nativeConsistency(dump, native) {
  if (!native || !Array.isArray(native.objects)) return [];
  const diffs = [];
  const byName = new Map();
  for (const object of native.objects) if (object.name) byName.set(object.name, object);

  for (const expected of dump.objects || []) {
    if (!expected.name || NON_RENDERED.has(expected.type)) continue;
    const actual = byName.get(expected.name);
    if (!actual) {
      diffs.push(`native scene lacks "${expected.name}" (${expected.type}) that the core dump reports`);
      continue;
    }
    if (expected.visible !== undefined && actual.visible !== expected.visible) {
      diffs.push(`native "${expected.name}".visible is ${actual.visible}, core dump says ${expected.visible}`);
    }
    if (expected.geometry && expected.geometry.type && !(actual.geometry && actual.geometry.type)) {
      diffs.push(`native "${expected.name}" has no geometry; core dump says ${expected.geometry.type}`);
    }

    // AR-41: the whole material, light and rigid body blocks, field for field,
    // with the parity gate's own comparator so there is one implementation of
    // "these two dumps agree".
    for (const block of ['material', 'light', 'rigidBody']) {
      const wanted = expected[block];
      const built = actual[block];
      if (wanted === null || wanted === undefined) continue;
      if (built === null || built === undefined) {
        diffs.push(`native "${expected.name}" has no ${block}; core dump says `
          + `${JSON.stringify(wanted.type ?? wanted)}`);
        continue;
      }
      // A portal's window material and a particle emitter's sprite material are
      // the renderer's own; only their presence is comparable.
      if (block === 'material' && NATIVE_MATERIAL_KINDS.has(expected.type)) continue;
      // A shader graph renders as its fallback, so the two blocks describe
      // different materials by design (SPEC 14.6).
      const shaderGraph = (Array.isArray(wanted) ? wanted : [wanted])
        .some((m) => m && m.type === 'ShaderGraphMaterial');
      const issues = [];
      diffValue(`"${expected.name}".${block}`, wanted, built, issues, 1e-2,
        shaderGraph ? new Set([...BLOCK_EXEMPT, 'type', 'color', 'opacity', 'metalness',
          'roughness', 'emissive', 'emissiveIntensity', 'side', 'wireframe', 'transparent',
          'depthWrite', 'depthTest', 'blending', 'clearcoat', 'clearcoatRoughness'])
          : BLOCK_EXEMPT,
        false);
      // `diffValue` names the core side "mac" and the consumer side "web"; here
      // the two sides are the core dump and this consumer's own dump.
      for (const issue of issues) {
        diffs.push(`native ${issue.replace(/\bmac\b/, 'core dump').replace(/\bweb\b/, 'three.js')}`);
      }
    }
  }
  return diffs;
}

/**
 * AR-31, SPEC 14.4: a scene is a room, not a solar system. Every scenario in the
 * suite stays within a couple of metres and a couple of metres per second, so
 * these bounds are scene scale with room to spare rather than the 100 m / 100
 * m/s that let a force field send three pebbles 27.8 m off a 0.8 m slab and
 * still report PASS.
 */
export const MAX_SPEED = 20;
export const MAX_DISTANCE = 10;

export function runawayBodies(native) {
  const out = [];
  for (const object of native.objects || []) {
    const world = object.worldPosition;
    if (Array.isArray(world)) {
      const distance = Math.hypot(world[0], world[1], world[2]);
      if (!Number.isFinite(distance)) {
        out.push(`"${object.name || object.id}" is at a non-finite position`);
      } else if (distance > MAX_DISTANCE) {
        out.push(`"${object.name || object.id}" is ${distance.toFixed(1)} m from the origin `
          + `(more than ${MAX_DISTANCE} m): the scene diverged`);
      }
    }
    if (Array.isArray(object.velocity)) {
      const speed = Math.hypot(object.velocity[0], object.velocity[1], object.velocity[2]);
      if (!Number.isFinite(speed)) out.push(`"${object.name || object.id}" has a non-finite velocity`);
      else if (speed > MAX_SPEED) {
        out.push(`"${object.name || object.id}" is moving at ${speed.toFixed(1)} m/s `
          + `(more than ${MAX_SPEED} m/s): the scene diverged`);
      }
    }
  }
  return out.slice(0, 5);
}

