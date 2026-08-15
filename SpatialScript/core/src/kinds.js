// The kind registry (MAINT-05).
//
// One table drives the `create` kind, the diff's kind-specific branch and the
// dump's per-kind fields, so a phase-2 object type is a row here plus its own
// module rather than a change at a dozen sites.

import { ParticleEmitter } from "./particles.js";
import { Anchor } from "./anchor.js";
import { Portal } from "./portal.js";
import { AssetGroup } from "./asset.js";

/**
 * @typedef {object} KindEntry
 * @property {string} kind          the `create` kind string in SPEC section 5
 * @property {(object: any) => boolean} match   recognises an instance
 * @property {string|null} snapshotKey  snapshot field holding the last payload
 * @property {string|null} opcode       command emitted when that payload changes
 * @property {string|null} lane         command batch lane for that opcode
 * @property {(object: any, runtime: any) => object|null} toJSON
 * @property {(object: any, entry: object, runtime: any) => void} [describe]
 *           extra fields the dump reports for this kind
 */

/** @type {KindEntry[]} */
export const KINDS = [
  {
    kind: "particles",
    match: (object) => object instanceof ParticleEmitter,
    snapshotKey: "particles",
    opcode: "particles",
    lane: "object",
    toJSON: (object, runtime) => object.toJSON(runtime.boundTextureIdFor),
    describe: (object, entry, runtime) => {
      entry.particles = object.toJSON(runtime.boundTextureIdFor);
    },
  },
  {
    kind: "anchor",
    match: (object) => object instanceof Anchor,
    snapshotKey: "anchor",
    opcode: "anchor",
    lane: "object",
    toJSON: (object) => object.toJSON(),
    describe: (object, entry) => {
      entry.anchor = object.toJSON();
      entry.isAnchored = object.isAnchored;
    },
  },
  {
    kind: "asset",
    match: (object) => object instanceof AssetGroup,
    snapshotKey: "asset",
    opcode: "asset",
    lane: "object",
    toJSON: (object) => object.toJSON(),
    describe: (object, entry) => {
      entry.asset = object.toJSON();
      entry.animations = object.animations.slice();
      entry.loaded = object.loaded;
    },
  },
  {
    // The payload references another object, so it is resolved after the walk.
    kind: "portal",
    match: (object) => object instanceof Portal,
    snapshotKey: "portal",
    opcode: null,
    lane: null,
    toJSON: (object, runtime) => object.toJSON(runtime.boundReferenceIdFor),
    describe: (object, entry, runtime) => {
      entry.portal = object.toJSON(runtime.boundReferenceIdFor);
    },
  },
  { kind: "ambientLight", match: (object) => object.isAmbientLight === true, snapshotKey: null, opcode: null, lane: null, toJSON: () => null },
  { kind: "directionalLight", match: (object) => object.isDirectionalLight === true, snapshotKey: null, opcode: null, lane: null, toJSON: () => null },
  { kind: "pointLight", match: (object) => object.isPointLight === true, snapshotKey: null, opcode: null, lane: null, toJSON: () => null },
  { kind: "spotLight", match: (object) => object.isSpotLight === true, snapshotKey: null, opcode: null, lane: null, toJSON: () => null },
  { kind: "mesh", match: (object) => object.isMesh === true, snapshotKey: null, opcode: null, lane: null, toJSON: () => null },
];

const BY_KIND = new Map();
for (const entry of KINDS) BY_KIND.set(entry.kind, entry);

/** The `create` kind for an object (SPEC section 5). */
export function kindFor(object) {
  for (let i = 0; i < KINDS.length; i += 1) {
    if (KINDS[i].match(object)) return KINDS[i].kind;
  }
  return "group";
}

/** The registry row for a kind, or null for a plain group or a light. */
export function entryForKind(kind) {
  const entry = BY_KIND.get(kind);
  return entry === undefined || entry.snapshotKey === null ? null : entry;
}
