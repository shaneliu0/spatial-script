// Scene-level phase 2 state (SPEC 14): the audio mixer, the active camera,
// scene understanding and the render options. All of it is id 0 and diffed
// once per frame against a stored payload.

import { push } from "../builtins.js";
import { cameraPayload, cameraPayloadEquals, copyCameraPayload } from "../camera.js";
import { clamp } from "../sanitize.js";

/** SPEC 14.11 constrains the debug model view to these. */
const DEBUG_MODEL_VIEWS = ["normal", "uv", "baseColor", "roughness", "metallic", "occlusion", "emissive"];
/** three.js only has materials for these two. */
const WEB_DEBUG_MODEL_VIEWS = ["normal", "uv"];

export function diffSceneState(runtime, out) {
  // ---- audio mixer -------------------------------------------------------
  const mixer = runtime.audio;
  if (mixer._revision !== runtime.audioRevision) {
    runtime.audioRevision = mixer._revision;
    push(out, ["audioMixer", 0, mixer.toJSON()]);
  }

  // ---- camera ------------------------------------------------------------
  // Nothing is emitted until a script assigns one: the consumer's built-in
  // camera is the default (SPEC 14.3). The command names the camera object's
  // own id so its pose travels through `transforms` like any other object;
  // `["camera", 0, { kind: null }]` hands the viewport back (SPEC 14.13).
  if (runtime.camera !== null || runtime.cameraSnapshot !== null) {
    const camera = runtime.camera;
    const next = cameraPayload(camera, runtime.cameraScratch);
    const id = camera === null ? 0 : runtime.idForObject(camera);
    if (id !== runtime.cameraId || !cameraPayloadEquals(runtime.cameraSnapshot, next)) {
      runtime.cameraId = id;
      runtime.cameraSnapshot = copyCameraPayload(next);
      push(out, ["camera", id, runtime.cameraSnapshot]);
    }
  }

  // ---- scene understanding ------------------------------------------------
  const understanding = runtime.sceneUnderstanding;
  const previousUnderstanding = runtime.sceneUnderstandingSnapshot;
  if (
    previousUnderstanding === null
      ? understanding.collision || understanding.occlusion || understanding.physics || understanding.shadows
      : previousUnderstanding.collision !== understanding.collision ||
        previousUnderstanding.occlusion !== understanding.occlusion ||
        previousUnderstanding.physics !== understanding.physics ||
        previousUnderstanding.shadows !== understanding.shadows
  ) {
    const payload = {
      collision: understanding.collision === true,
      occlusion: understanding.occlusion === true,
      physics: understanding.physics === true,
      shadows: understanding.shadows === true,
    };
    runtime.sceneUnderstandingSnapshot = payload;
    if (runtime.env.platform !== "visionos") {
      runtime.warnOnce(
        "scene-understanding",
        "Spatial.sceneUnderstanding has no effect outside visionOS; the state is kept and reported",
      );
    }
    push(out, ["sceneUnderstanding", 0, payload]);
  }

  // ---- render options -----------------------------------------------------
  const adaptive = runtime.render.adaptiveResolution === true;
  const exponent = clamp(runtime.environmentLighting.intensityExponent, 0, 16, 1);
  let debugModelView = runtime.debug.modelView === undefined ? null : runtime.debug.modelView;
  if (debugModelView !== null && DEBUG_MODEL_VIEWS.indexOf(debugModelView) === -1) {
    runtime.warnOnce(
      `debug-model-view:${String(debugModelView)}`,
      `Spatial.debug.modelView must be one of ${DEBUG_MODEL_VIEWS.join(", ")} or null; ` +
        `"${String(debugModelView)}" was ignored`,
    );
    debugModelView = null;
  }
  if (debugModelView !== null && runtime.env.backend === "three" && WEB_DEBUG_MODEL_VIEWS.indexOf(debugModelView) === -1) {
    runtime.warnOnce(
      "debug-model-view-web",
      `The three.js backend has no debug material for "${debugModelView}"; the object renders normally`,
    );
  }
  const previousOptions = runtime.renderOptionsSnapshot;
  if (
    previousOptions === null
      ? adaptive || exponent !== 1 || debugModelView !== null
      : previousOptions.adaptiveResolution !== adaptive ||
        previousOptions.environmentIntensityExponent !== exponent ||
        previousOptions.debugModelView !== debugModelView
  ) {
    const payload = {
      adaptiveResolution: adaptive,
      environmentIntensityExponent: exponent,
      debugModelView,
    };
    runtime.renderOptionsSnapshot = payload;
    if (adaptive && runtime.env.platform !== "visionos") {
      runtime.warnOnce(
        "adaptive-resolution",
        "Spatial.render.adaptiveResolution has no effect outside visionOS; the state is kept and reported",
      );
    }
    push(out, ["renderOptions", 0, payload]);
  }
}
