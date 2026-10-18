// OcclusionMaterial (SPEC 3.4) plus the material snapshot used by the diff.

import { push } from "../util/builtins.js";
import {
  Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  NormalBlending,
  FrontSide,
  BackSide,
  DoubleSide,
} from "../util/three-exports.js";
import { finite, clamp, atLeast, colorArray } from "../util/sanitize.js";
import { shaderGraphSnapshot } from "./shader-graph.js";

// Raised whenever a tracked material property is written, so the diff can skip
// re-reading a material that nobody touched. Colors are compared separately:
// three's Color has no change hook.
export const MATERIAL_DIRTY = Symbol("spatial.materialDirty");
// Per-material diff cache, keyed on the material itself.
export const MATERIAL_FRAME = Symbol("spatial.materialFrame");
export const MATERIAL_PAYLOAD = Symbol("spatial.materialPayload");
export const MATERIAL_RAW = Symbol("spatial.materialRaw");

// Scalar and texture-slot properties the material command carries. Each gets a
// tracking setter unless a three.js class already defines its own accessor for
// it, in which case the property stays in the diff's value compare.
const TRACKED_PROPERTIES = [
  "opacity",
  "transparent",
  "side",
  "wireframe",
  "metalness",
  "roughness",
  "emissiveIntensity",
  "clearcoat",
  "clearcoatRoughness",
  "depthWrite",
  "depthTest",
  "blending",
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "emissiveMap",
];

/** Properties that could not be hooked and must still be compared by value. */
export const UNTRACKED_PROPERTIES = [];

let materialTrackingInstalled = false;

export function installMaterialTracking() {
  if (materialTrackingInstalled) return;
  materialTrackingInstalled = true;

  const proto = Material.prototype;
  proto[MATERIAL_DIRTY] = true;

  const classes = [MeshBasicMaterial, MeshStandardMaterial, MeshPhysicalMaterial];

  for (const name of TRACKED_PROPERTIES) {
    // A subclass accessor would shadow one defined on Material.prototype, so
    // the property would silently stop reporting changes. Leave those alone.
    let shadowed = false;
    for (const constructor of classes) {
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, name);
      if (descriptor !== undefined && typeof descriptor.get === "function") shadowed = true;
    }
    const own = Object.getOwnPropertyDescriptor(proto, name);
    if (shadowed || (own !== undefined && typeof own.get === "function")) {
      push(UNTRACKED_PROPERTIES, name);
      continue;
    }

    const backing = Symbol(`spatial.material.${name}`);
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: true,
      get() {
        return this[backing];
      },
      set(value) {
        this[backing] = value;
        this[MATERIAL_DIRTY] = true;
      },
    });
  }
}

export class OcclusionMaterial extends MeshBasicMaterial {
  constructor(parameters = {}) {
    super(parameters);
    this.type = "OcclusionMaterial";
    this.colorWrite = false;
  }
}

const MATERIAL_MAP_SLOTS = ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap"];

export { MATERIAL_MAP_SLOTS };

/**
 * Full material state for the `material` command. Every key in the SPEC 3.4
 * table is always present; properties a given material type does not own carry
 * the three.js default so consumers can apply the object without key checks.
 *
 * Every scalar is clamped to its valid range and every value is finite, so a
 * NaN or an out-of-range number written by a script never reaches a consumer.
 * This runs for every material every frame, so the clamped values are plain
 * locals and the diagnostic string is only built when something changed.
 *
 * Colors are linear sRGB, which is how three stores Color channels when
 * ColorManagement is enabled.
 */
export function materialSnapshot(material, textureIdFor, warn) {
  // A shader graph carries its own shape, with the fallback's full material
  // JSON inside it (SPEC 14.6).
  if (material.isShaderGraphMaterial === true) {
    return shaderGraphSnapshot(material, textureIdFor, materialSnapshot);
  }

  const maps = {};
  for (const slot of MATERIAL_MAP_SLOTS) {
    const texture = material[slot];
    maps[slot] = texture ? textureIdFor(texture) : null;
  }

  const opacity = clamp(material.opacity, 0, 1, 1);
  const metalness = clamp(material.metalness, 0, 1, 0);
  const roughness = clamp(material.roughness, 0, 1, 1);
  const clearcoat = clamp(material.clearcoat, 0, 1, 0);
  const clearcoatRoughness = clamp(material.clearcoatRoughness, 0, 1, 0);
  const emissiveIntensity = atLeast(material.emissiveIntensity, 0, 1);
  let side = finite(material.side, FrontSide);
  if (side !== FrontSide && side !== BackSide && side !== DoubleSide) side = FrontSide;

  if (warn !== null && warn !== undefined) {
    let adjusted = null;
    const note = (key, given, used) => {
      if (given === undefined || given === used) return;
      if (adjusted === null) adjusted = [];
      push(adjusted, `${key} ${given} -> ${used}`);
    };
    note("opacity", material.opacity, opacity);
    note("metalness", material.metalness, metalness);
    note("roughness", material.roughness, roughness);
    note("clearcoat", material.clearcoat, clearcoat);
    note("clearcoatRoughness", material.clearcoatRoughness, clearcoatRoughness);
    note("emissiveIntensity", material.emissiveIntensity, emissiveIntensity);
    note("side", material.side, side);
    if (adjusted !== null) {
      warn(`material:${material.uuid}`, `${material.type} properties were clamped: ${adjusted.join(", ")}`);
    }
  }

  return {
    type: material.type,
    // Identifies the material instance so consumers can share one native
    // material between every mesh that uses it.
    uuid: material.uuid,
    color: colorArray(material.color, 1),
    opacity,
    transparent: material.transparent === true,
    side,
    wireframe: material.wireframe === true,
    metalness,
    roughness,
    emissive: material.emissive ? colorArray(material.emissive, 0) : [0, 0, 0],
    emissiveIntensity,
    clearcoat,
    clearcoatRoughness,
    depthWrite: material.depthWrite !== false,
    depthTest: material.depthTest !== false,
    blending: finite(material.blending, NormalBlending),
    maps,
  };
}

export function materialSnapshotEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type === "ShaderGraphMaterial" || b.type === "ShaderGraphMaterial") {
    return (
      a.type === b.type &&
      a.uuid === b.uuid &&
      a.source === b.source &&
      a.name === b.name &&
      a.generation === b.generation &&
      materialSnapshotEquals(a.fallback, b.fallback)
    );
  }
  if (
    a.type !== b.type ||
    a.uuid !== b.uuid ||
    a.opacity !== b.opacity ||
    a.transparent !== b.transparent ||
    a.side !== b.side ||
    a.wireframe !== b.wireframe ||
    a.metalness !== b.metalness ||
    a.roughness !== b.roughness ||
    a.emissiveIntensity !== b.emissiveIntensity ||
    a.clearcoat !== b.clearcoat ||
    a.clearcoatRoughness !== b.clearcoatRoughness ||
    a.depthWrite !== b.depthWrite ||
    a.depthTest !== b.depthTest ||
    a.blending !== b.blending
  ) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    if (a.color[i] !== b.color[i]) return false;
    if (a.emissive[i] !== b.emissive[i]) return false;
  }
  for (const slot of MATERIAL_MAP_SLOTS) {
    if (a.maps[slot] !== b.maps[slot]) return false;
  }
  return true;
}

/**
 * How many material slots a mesh with a material array actually has: one per
 * material, clamped to what the geometry's groups ask for. A group whose
 * `materialIndex` has no material would be a per-consumer guess, so the last
 * material covers the rest; a material no group can reach is dropped
 * (SPEC 14.12, FA-09). The command stream and the dump both use this, so they
 * describe the same mesh.
 */
export function materialSlotCount(object, materials) {
  const geometry = object.geometry;
  const groups = geometry === null || geometry === undefined ? null : geometry.groups;
  if (!Array.isArray(groups) || groups.length === 0) return materials.length;
  let highest = -1;
  for (let i = 0; i < groups.length; i += 1) {
    const index = groups[i] === null || groups[i] === undefined ? 0 : groups[i].materialIndex | 0;
    if (index > highest) highest = index;
  }
  if (materials.length === 0) return 0;
  return highest + 1;
}

/** The material for one slot, with the last one covering any extra groups. */
export function materialForSlot(materials, index) {
  if (materials.length === 0) return null;
  return materials[index < materials.length ? index : materials.length - 1];
}
