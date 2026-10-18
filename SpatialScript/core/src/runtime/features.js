// Phase 2 per-object state (SPEC 14): audio, video, character controllers,
// force fields, accessibility, skeletons, blend shapes and shader parameters.
//
// All of it hangs off one bitmask on the snapshot. An object that has none of
// these features costs a single integer compare in the per-object diff, which
// is what keeps the steady-state tick where phase 1 left it.

import { push } from "../util/builtins.js";
import { audioJSONEquals } from "../media/audio.js";
import { videoJSONEquals } from "../media/video.js";
import { shallowJSONEquals } from "./payloads.js";
import { shaderParameterValue } from "../materials/shader-graph.js";

export const FEATURE_AUDIO = 1;
export const FEATURE_VIDEO = 2;
export const FEATURE_CHARACTER = 4;
export const FEATURE_FORCE_FIELD = 8;
export const FEATURE_ACCESSIBILITY = 16;
export const FEATURE_SKELETON = 32;
export const FEATURE_BLEND_SHAPES = 64;
export const FEATURE_SHADER = 128;

/** The feature bits an object carries right now. */
export function featuresFor(object) {
  let features = 0;
  if (object.isAudio === true) features |= FEATURE_AUDIO;
  if (object.isVideoScreen === true) features |= FEATURE_VIDEO;
  if (object.characterController !== null && object.characterController !== undefined) {
    features |= FEATURE_CHARACTER;
  }
  if (object.isForceField === true) features |= FEATURE_FORCE_FIELD;
  if (object.accessibility !== null && object.accessibility !== undefined) {
    features |= FEATURE_ACCESSIBILITY;
  }
  // A shader graph may be the mesh's only material or one of several
  // (SPEC 14.12), so both shapes raise the bit (P2-C-08).
  const material = object.material;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i += 1) {
      const entry = material[i];
      if (entry !== null && entry !== undefined && entry.isShaderGraphMaterial === true) {
        features |= FEATURE_SHADER;
        break;
      }
    }
  } else if (material !== null && material !== undefined && material.isShaderGraphMaterial === true) {
    features |= FEATURE_SHADER;
  }
  if (object.isAsset === true) {
    if (object.skeleton !== null && object.skeleton !== undefined) features |= FEATURE_SKELETON;
    if (object.blendShapes !== null && object.blendShapes !== undefined) features |= FEATURE_BLEND_SHAPES;
  }
  return features;
}

/**
 * Emits whatever phase-2 state changed for one object, including the removal
 * of a feature the object no longer has: a retraction has to survive the mask
 * going to zero, which is why the gate is `features | emitted` (P2-B-02).
 */
export function diffFeatures(runtime, object, snapshot, id, out) {
  const features = snapshot.features;
  const emitted = snapshot.emittedFeatures;
  diffFeaturesInner(runtime, object, snapshot, id, out, features, emitted);
  // The gate the diff reads next frame: what the object has, plus what is
  // still on the wire and would need retracting.
  snapshot.featureGate = snapshot.features | snapshot.emittedFeatures;
}

function diffFeaturesInner(runtime, object, snapshot, id, out, features, emitted) {

  // ---- audio ---------------------------------------------------------------
  if ((features & FEATURE_AUDIO) !== 0) {
    const next = object.toJSON();
    if (!audioJSONEquals(snapshot.audio, next)) {
      snapshot.audio = next;
      snapshot.emittedFeatures |= FEATURE_AUDIO;
      push(out.object, ["audio", id, next]);
    }
  } else if ((emitted & FEATURE_AUDIO) !== 0) {
    snapshot.audio = null;
    snapshot.emittedFeatures &= ~FEATURE_AUDIO;
    push(out.object, ["audio", id, null]);
  }

  // ---- video ---------------------------------------------------------------
  if ((features & FEATURE_VIDEO) !== 0) {
    const next = object.toJSON();
    if (!videoJSONEquals(snapshot.video, next)) {
      snapshot.video = next;
      snapshot.emittedFeatures |= FEATURE_VIDEO;
      push(out.object, ["video", id, next]);
    }
    // A screen with nothing to play owes an `error`, and the object only has
    // an id the consumer has seen once it has been created (P2-B-16, P2-C-11).
    if (object._pendingError !== null && object._pendingError !== undefined) {
      const message = object._pendingError;
      object._pendingError = null;
      runtime.dispatch("error", id, { message });
    }
  } else if ((emitted & FEATURE_VIDEO) !== 0) {
    snapshot.video = null;
    snapshot.emittedFeatures &= ~FEATURE_VIDEO;
    push(out.object, ["video", id, null]);
  }

  // ---- character controller ------------------------------------------------
  if ((features & FEATURE_CHARACTER) !== 0) {
    const controller = object.characterController;
    const next = controller === null || controller === undefined ? null : controller.toJSON();
    if (!shallowJSONEquals(snapshot.character, next)) {
      snapshot.character = next;
      snapshot.emittedFeatures |= FEATURE_CHARACTER;
      push(out.object, ["characterController", id, next]);
    }
  } else if ((emitted & FEATURE_CHARACTER) !== 0) {
    snapshot.character = null;
    snapshot.emittedFeatures &= ~FEATURE_CHARACTER;
    push(out.object, ["characterController", id, null]);
  }

  // ---- force field ---------------------------------------------------------
  if ((features & FEATURE_FORCE_FIELD) !== 0) {
    const next = object.toJSON();
    if (!shallowJSONEquals(snapshot.forceField, next)) {
      snapshot.forceField = next;
      snapshot.emittedFeatures |= FEATURE_FORCE_FIELD;
      push(out.object, ["forceField", id, next]);
    }
  } else if ((emitted & FEATURE_FORCE_FIELD) !== 0) {
    snapshot.forceField = null;
    snapshot.emittedFeatures &= ~FEATURE_FORCE_FIELD;
    push(out.object, ["forceField", id, null]);
  }

  // ---- accessibility -------------------------------------------------------
  if ((features & FEATURE_ACCESSIBILITY) !== 0) {
    const next = accessibilityJSON(object.accessibility);
    if (!shallowJSONEquals(snapshot.accessibility, next)) {
      snapshot.accessibility = next;
      snapshot.emittedFeatures |= FEATURE_ACCESSIBILITY;
      push(out.object, ["accessibility", id, next]);
    }
  } else if ((emitted & FEATURE_ACCESSIBILITY) !== 0) {
    snapshot.accessibility = null;
    snapshot.emittedFeatures &= ~FEATURE_ACCESSIBILITY;
    push(out.object, ["accessibility", id, null]);
  }

  // ---- shader parameters ---------------------------------------------------
  if ((features & FEATURE_SHADER) !== 0) {
    diffShaderParameters(runtime, object, snapshot, id, out);
    snapshot.emittedFeatures |= FEATURE_SHADER;
  } else if ((emitted & FEATURE_SHADER) !== 0) {
    // Nothing to retract on the wire: the material command that replaced it
    // already told the consumer. The generations start again from scratch.
    snapshot.shaderGeneration = -1;
    snapshot.shaderGenerations = null;
    snapshot.emittedFeatures &= ~FEATURE_SHADER;
  }

  // ---- skeleton and blend shapes ------------------------------------------
  if ((features & FEATURE_SKELETON) !== 0) {
    const skeleton = object.skeleton;
    if (skeleton !== null && skeleton.generation !== snapshot.skeletonGeneration) {
      snapshot.skeletonGeneration = skeleton.generation;
      snapshot.emittedFeatures |= FEATURE_SKELETON;
      push(out.object, ["skeleton", id, skeleton.toJSON()]);
    }
  } else if ((emitted & FEATURE_SKELETON) !== 0) {
    // The rig is gone: the empty pose is the retraction the payload can carry.
    snapshot.skeletonGeneration = -1;
    snapshot.emittedFeatures &= ~FEATURE_SKELETON;
    push(out.object, ["skeleton", id, { joints: {}, track: false }]);
  }

  if ((features & FEATURE_BLEND_SHAPES) !== 0) {
    const shapes = object.blendShapes;
    if (shapes !== null && shapes.generation !== snapshot.blendGeneration) {
      snapshot.blendGeneration = shapes.generation;
      snapshot.emittedFeatures |= FEATURE_BLEND_SHAPES;
      push(out.object, ["blendShapes", id, shapes.toJSON()]);
    }
  } else if ((emitted & FEATURE_BLEND_SHAPES) !== 0) {
    snapshot.blendGeneration = -1;
    snapshot.emittedFeatures &= ~FEATURE_BLEND_SHAPES;
    push(out.object, ["blendShapes", id, {}]);
  }
}

/**
 * Per-parameter commands for a shader graph material, whether the mesh carries
 * one material or one per geometry group. The command carries the material
 * index so a consumer can find the right part (P2-C-08).
 */
function diffShaderParameters(runtime, object, snapshot, id, out) {
  const material = object.material;
  if (Array.isArray(material)) {
    let generations = snapshot.shaderGenerations;
    if (generations === null || generations === undefined) {
      generations = [];
      snapshot.shaderGenerations = generations;
    }
    for (let index = 0; index < material.length; index += 1) {
      const entry = material[index];
      if (entry === null || entry === undefined || entry.isShaderGraphMaterial !== true) continue;
      const seen = generations[index] === undefined ? -1 : generations[index];
      if (seen === -1) {
        generations[index] = entry.generation;
        continue;
      }
      if (entry.generation === seen) continue;
      const names = entry.changedSince(seen);
      generations[index] = entry.generation;
      emitParameters(runtime, entry, names, id, index, out);
    }
    return;
  }

  if (material === null || material === undefined || material.isShaderGraphMaterial !== true) return;
  // The `material` command already carried the parameters the first time, so
  // only later edits become per-parameter commands (SPEC 14.6).
  if (snapshot.shaderGeneration === -1) {
    snapshot.shaderGeneration = material.generation;
    return;
  }
  if (material.generation === snapshot.shaderGeneration) return;
  const names = material.changedSince(snapshot.shaderGeneration);
  snapshot.shaderGeneration = material.generation;
  emitParameters(runtime, material, names, id, 0, out);
}

function emitParameters(runtime, material, names, id, index, out) {
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    const value = shaderParameterValue(material.parameters[name], runtime.boundTextureIdFor);
    if (value === undefined) continue;
    push(out.object, ["shaderParameter", id, name, value, index]);
  }
}

/** The accessibility payload of 14.11, with only the documented fields. */
export function accessibilityJSON(value) {
  if (value === null || typeof value !== "object") return null;
  return {
    label: typeof value.label === "string" ? value.label : "",
    value: typeof value.value === "string" ? value.value : "",
    hint: typeof value.hint === "string" ? value.hint : "",
    isButton: value.isButton === true,
  };
}
