// Shader graph materials (SPEC 14.6). RealityKit loads a pre-authored graph
// from a USD file; the web renders the required fallback and warns once.

import { Material } from "./three-exports.js";
import { host } from "./host.js";
import { MATERIAL_DIRTY } from "./materials.js";
import { finite, clamp } from "./sanitize.js";
import { MAX_PARAMETER_KEYS, MAX_PARAMETER_STRING } from "./limits.js";
import { objectKeys, push, cut } from "./builtins.js";

/**
 * A parameter value the command stream can carry: a number, a boolean, a short
 * string, a two-to-four element vector or color, or a texture id. Anything
 * else — a NaN, an object, a longer array — returns `undefined` so the caller
 * can refuse it out loud rather than sending `null`, which is indistinguishable
 * from "cleared" (P2-B-18).
 */
export function shaderParameterValue(value, textureIdFor) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > MAX_PARAMETER_STRING ? cut(value, MAX_PARAMETER_STRING) : value;
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") return undefined;
  if (value.isTexture === true) return textureIdFor === null ? undefined : textureIdFor(value);
  if (value.isColor === true) return [clamp(value.r, 0, 1, 0), clamp(value.g, 0, 1, 0), clamp(value.b, 0, 1, 0)];
  if (typeof value.w === "number") return floats([value.x, value.y, value.z, value.w]);
  if (typeof value.z === "number") return floats([value.x, value.y, value.z]);
  if (typeof value.y === "number") return floats([value.x, value.y]);
  // An array is a vector, and a vector is two to four numbers: a longer one is
  // refused rather than cut down to something the script never asked for.
  if (Array.isArray(value)) {
    if (value.length < 2 || value.length > 4) return undefined;
    return floats(value);
  }
  return undefined;
}

/** Every element finite, or nothing. */
function floats(values) {
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) return undefined;
    push(out, values[i]);
  }
  return out;
}

/** What a parameter may be, for the diagnostic. */
const ACCEPTED_VALUES =
  "a finite number, a boolean, a string, a Color, a Vector2/3/4, an array of two to four finite numbers, or a Texture";

/**
 * Properties of the fallback material a shader parameter may write. Anything
 * else — `uuid`, `type`, `version` — would corrupt the material (P2-B-18).
 */
const FALLBACK_PROPERTIES = [
  "color",
  "emissive",
  "emissiveIntensity",
  "opacity",
  "transparent",
  "roughness",
  "metalness",
  "clearcoat",
  "clearcoatRoughness",
  "wireframe",
  "side",
  "depthWrite",
  "depthTest",
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "emissiveMap",
];

export class ShaderGraphMaterial extends Material {
  constructor(options = {}) {
    super();
    if (options === null || typeof options !== "object") {
      throw new TypeError("ShaderGraphMaterial expects an options object");
    }
    if (!options.fallback || options.fallback.isMaterial !== true) {
      throw new TypeError(
        "ShaderGraphMaterial needs a `fallback` material: it is what every consumer without shader graphs renders",
      );
    }
    this.type = "ShaderGraphMaterial";
    this.isShaderGraphMaterial = true;

    const runtime = host();
    const source = typeof options.source === "string" ? options.source : null;
    this.source = source === null || runtime === null ? source : runtime.resolveUrl(source);
    if (source !== null && this.source === null && runtime !== null) {
      runtime.warnOnce(
        `shader-source:${this.uuid}`,
        `ShaderGraphMaterial was given a source url that was refused; the fallback is used`,
      );
    }
    // `name` is taken by three's Material; the graph's own name lives here and
    // is what the payload carries.
    this.graphName = typeof options.name === "string" ? options.name : "";
    this.fallback = options.fallback;
    this.parameters = {};
    this.generation = 0;
    this._changed = new Map();

    if (options.parameters !== null && typeof options.parameters === "object") {
      const keys = objectKeys(options.parameters);
      const refused = [];
      for (let i = 0; i < keys.length && i < MAX_PARAMETER_KEYS; i += 1) {
        const value = options.parameters[keys[i]];
        if (shaderParameterValue(value, () => 0) === undefined) {
          push(refused, keys[i]);
          continue;
        }
        this.parameters[keys[i]] = value;
      }
      if (refused.length > 0 && runtime !== null) {
        runtime.warnOnce(
          `shader-parameters-refused:${this.uuid}`,
          `ShaderGraphMaterial parameters ${refused.join(", ")} carry values the command stream ` +
            `cannot carry and were dropped. Accepted: ${ACCEPTED_VALUES}`,
        );
      }
    }

    if (runtime !== null && runtime.env.capabilities.shaderGraph !== true) {
      runtime.warnOnce(
        "shader-graph",
        "ShaderGraphMaterial has no shader graph on this consumer; the fallback material is rendered",
      );
    }
  }

  /**
   * Updates one parameter. On a consumer without shader graphs the same-named
   * property of the fallback is updated instead, so the scene still reacts.
   */
  setParameter(name, value) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("ShaderGraphMaterial.setParameter expects a parameter name");
    }
    if (objectKeys(this.parameters).length >= MAX_PARAMETER_KEYS && this.parameters[name] === undefined) {
      const runtime = host();
      if (runtime) {
        runtime.warnOnce(
          `shader-parameters:${this.uuid}`,
          `More than ${MAX_PARAMETER_KEYS} shader parameters; "${name}" was dropped`,
        );
      }
      return this;
    }
    // A value the command stream cannot carry is refused out loud: sending
    // `null` would read as "cleared" and the script would never know
    // (P2-B-18).
    if (shaderParameterValue(value, () => 0) === undefined) {
      const runtime = host();
      if (runtime) {
        runtime.warnOnce(
          `shader-value:${this.uuid}:${name}`,
          `ShaderGraphMaterial.setParameter("${name}") was given a value the command stream cannot ` +
            `carry; it was ignored. Accepted: ${ACCEPTED_VALUES}`,
        );
      }
      return this;
    }

    this.parameters[name] = value;
    this.generation += 1;
    this._changed.set(name, this.generation);
    this[MATERIAL_DIRTY] = true;

    const fallback = this.fallback;
    if (fallback !== null && FALLBACK_PROPERTIES.indexOf(name) !== -1 && fallback[name] !== undefined) {
      const target = fallback[name];
      if (target !== null && typeof target === "object" && typeof target.copy === "function" && typeof value === "object") {
        target.copy(value);
      } else {
        fallback[name] = value;
      }
      fallback[MATERIAL_DIRTY] = true;
    }
    return this;
  }

  getParameter(name) {
    return this.parameters[name];
  }

  /** Parameters changed after `generation`, for the per-mesh command. */
  changedSince(generation) {
    const names = [];
    for (const [name, at] of this._changed) {
      if (at > generation) push(names, name);
    }
    return names;
  }
}

/** The `material` payload for a shader graph (SPEC 14.6). */
export function shaderGraphSnapshot(material, textureIdFor, materialSnapshot) {
  const parameters = {};
  const keys = objectKeys(material.parameters);
  for (let i = 0; i < keys.length && i < MAX_PARAMETER_KEYS; i += 1) {
    const value = shaderParameterValue(material.parameters[keys[i]], textureIdFor);
    // `setParameter` refuses what the stream cannot carry, so a constructor
    // parameter is the only way to get here; it is dropped the same way.
    if (value !== undefined) parameters[keys[i]] = value;
  }
  return {
    type: "ShaderGraphMaterial",
    uuid: material.uuid,
    source: material.source,
    name: material.graphName,
    parameters,
    // Lets a consumer tell one parameter edit from the next without diffing.
    generation: material.generation,
    fallback: materialSnapshot(material.fallback, textureIdFor, null),
  };
}
