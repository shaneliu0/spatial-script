// Scene and Mesh subclasses that enforce the SPEC 3.2 constraints:
// Scene.background / environment / fog are out of scope and throw, and a Mesh
// carries exactly one material.

import { push } from "./builtins.js";
import { ThreeScene, ThreeMesh, BufferGeometry, MeshStandardMaterial } from "./three-exports.js";
import { DIRTY, DIRTY_GEOMETRY, DIRTY_MATERIAL } from "./object-extensions.js";
import { SpatialUnsupportedError } from "./errors.js";

// Marks a geometry or material the core supplied because the script passed
// undefined or null. The diff turns the mark into a warning naming the object.
export const SUBSTITUTED = Symbol("spatial.substituted");

// Every Scene constructed during load, used by the auto-mount rule in SPEC 2.
export const constructedScenes = [];

export function resetConstructedScenes() {
  constructedScenes.length = 0;
}

function outOfScope(name) {
  return new SpatialUnsupportedError(
    `Scene.${name} is not in scope (SPEC section 4)`,
    `Scene.${name}`,
    null,
  );
}

function defineOutOfScopeSceneProperty(name) {
  const backing = Symbol(`spatial.scene.${name}`);
  Object.defineProperty(Scene.prototype, name, {
    configurable: true,
    get() {
      return this[backing] === undefined ? null : this[backing];
    },
    set(value) {
      // three's Scene constructor initialises these to null; only a real
      // assignment is rejected.
      if (value !== null && value !== undefined) throw outOfScope(name);
      this[backing] = null;
    },
  });
}

export class Scene extends ThreeScene {
  constructor() {
    super();
    push(constructedScenes, this);
  }
}

defineOutOfScopeSceneProperty("background");
defineOutOfScopeSceneProperty("environment");
defineOutOfScopeSceneProperty("fog");

const MATERIAL = Symbol("spatial.material");
const GEOMETRY = Symbol("spatial.geometry");

function substituteGeometry(geometry) {
  if (geometry !== undefined && geometry !== null) return geometry;
  const replacement = new BufferGeometry();
  replacement[SUBSTITUTED] = "geometry";
  return replacement;
}

function substituteMaterial(material) {
  if (material !== undefined && material !== null) return material;
  // three.js substitutes MeshBasicMaterial for an undefined material; the core
  // uses MeshStandardMaterial instead so the mesh responds to scene lighting.
  const replacement = new MeshStandardMaterial();
  replacement[SUBSTITUTED] = "material";
  return replacement;
}

export class Mesh extends ThreeMesh {
  constructor(geometry, material) {
    super(substituteGeometry(geometry), substituteMaterial(material));
  }
}

Object.defineProperty(Mesh.prototype, "geometry", {
  configurable: true,
  enumerable: true,
  get() {
    return this[GEOMETRY] === undefined ? null : this[GEOMETRY];
  },
  set(geometry) {
    this[GEOMETRY] = geometry === undefined ? null : geometry;
    this[DIRTY] = (this[DIRTY] | 0) | DIRTY_GEOMETRY;
  },
});

Object.defineProperty(Mesh.prototype, "material", {
  configurable: true,
  get() {
    return this[MATERIAL] === undefined ? null : this[MATERIAL];
  },
  set(material) {
    if (Array.isArray(material)) {
      throw new SpatialUnsupportedError(
        "Multiple materials per mesh are not in scope (SPEC section 4)",
        "Mesh.material[]",
        this,
      );
    }
    this[MATERIAL] = material === undefined ? null : material;
    this[DIRTY] = (this[DIRTY] | 0) | DIRTY_MATERIAL;
  },
});
