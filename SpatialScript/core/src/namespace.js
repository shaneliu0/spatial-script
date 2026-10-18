// The `require("spatial")` namespace (SPEC section 3). Nothing outside this
// object is reachable from a script.

import {
  Vector2,
  Vector3,
  Vector4,
  Quaternion,
  Euler,
  Matrix3,
  Matrix4,
  Color,
  Box3,
  Sphere,
  Plane,
  Ray,
  MathUtils,
  Spherical,
  Object3D,
  Group,
  BufferGeometry,
  BufferAttribute,
  Float32BufferAttribute,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  AmbientLight,
  DirectionalLight,
  PointLight,
  SpotLight,
  AnimationClip,
  AnimationMixer,
  AnimationAction,
  KeyframeTrack,
  VectorKeyframeTrack,
  QuaternionKeyframeTrack,
  NumberKeyframeTrack,
  ColorKeyframeTrack,
  AnimationUtils,
  FrontSide,
  BackSide,
  DoubleSide,
  NormalBlending,
  AdditiveBlending,
  RepeatWrapping,
  ClampToEdgeWrapping,
  MirroredRepeatWrapping,
  LoopOnce,
  LoopRepeat,
  LoopPingPong,
  PerspectiveCamera,
  OrthographicCamera,
} from "./util/three-exports.js";
import { Scene, Mesh } from "./scene/scene-classes.js";
import {
  BoxGeometry,
  SphereGeometry,
  PlaneGeometry,
  CylinderGeometry,
  ConeGeometry,
  TorusGeometry,
  CapsuleGeometry,
  CircleGeometry,
  RingGeometry,
} from "./scene/geometry.js";
import { TextGeometry } from "./scene/text-geometry.js";
import { OcclusionMaterial } from "./materials/materials.js";
import { Texture, TextureLoader } from "./materials/texture.js";
import { RigidBody, Joint } from "./physics/physics.js";
import { ParticleEmitter } from "./scene/particles.js";
import { Anchor } from "./scene/anchor.js";
import { Portal } from "./scene/portal.js";
import { ImageBasedLight } from "./scene/asset.js";
import { AudioLoader, AudioBuffer, Audio, PositionalAudio, AmbientAudio } from "./media/audio.js";
import { VideoScreen } from "./media/video.js";
import { CharacterController } from "./physics/character.js";
import {
  ConstantForceField,
  RadialForceField,
  VortexForceField,
  DragForceField,
  TurbulenceForceField,
} from "./physics/force-fields.js";
import { ShaderGraphMaterial } from "./materials/shader-graph.js";
import { SpatialUnsupportedError } from "./util/errors.js";
import { createInject } from "./input/inject.js";
import {
  MAX_NAME_LENGTH,
  MAX_LOG_MESSAGE,
  MAX_LOGS_PER_FRAME,
  MAX_LIVE_TIMERS,
  MAX_LIVE_FRAME_CALLBACKS,
  MAX_CALLBACKS_PER_TICK,
  MAX_LISTENERS_PER_EVENT,
  MAX_DEPTH,
  MAX_ID,
  MAX_RECORDED_ERRORS,
  MAX_RECORDED_WARNINGS,
  MAX_ERROR_MESSAGES_PER_SECOND,
} from "./util/limits.js";

// The bounds a script can read, so a generator can stay inside them.
const LIMITS = Object.freeze({
  MAX_NAME_LENGTH,
  MAX_LOG_MESSAGE,
  MAX_LOGS_PER_FRAME,
  MAX_LIVE_TIMERS,
  MAX_LIVE_FRAME_CALLBACKS,
  MAX_CALLBACKS_PER_TICK,
  MAX_LISTENERS_PER_EVENT,
  MAX_DEPTH,
  MAX_ID,
  MAX_RECORDED_ERRORS,
  MAX_RECORDED_WARNINGS,
  MAX_ERROR_MESSAGES_PER_SECOND,
});

export function createNamespace(runtime) {
  const namespace = {
    // 3.1 math
    Vector2,
    Vector3,
    Vector4,
    Quaternion,
    Euler,
    Matrix3,
    Matrix4,
    Color,
    Box3,
    Sphere,
    Plane,
    Ray,
    MathUtils,
    Spherical,

    // 3.2 scene graph
    Object3D,
    Group,
    Scene,
    Mesh,

    // 3.3 geometry
    BufferGeometry,
    BufferAttribute,
    Float32BufferAttribute,
    BoxGeometry,
    SphereGeometry,
    PlaneGeometry,
    CylinderGeometry,
    ConeGeometry,
    TorusGeometry,
    CapsuleGeometry,
    CircleGeometry,
    RingGeometry,
    TextGeometry,

    // 3.4 materials
    MeshBasicMaterial,
    MeshStandardMaterial,
    MeshPhysicalMaterial,
    OcclusionMaterial,

    // 3.5 textures
    Texture,
    TextureLoader,

    // 3.6 lights
    AmbientLight,
    DirectionalLight,
    PointLight,
    SpotLight,
    ImageBasedLight,

    // 3.7 physics
    RigidBody,
    Joint,

    // 3.9 animation
    AnimationClip,
    AnimationMixer,
    AnimationAction,
    KeyframeTrack,
    VectorKeyframeTrack,
    QuaternionKeyframeTrack,
    NumberKeyframeTrack,
    ColorKeyframeTrack,
    AnimationUtils,

    // 3.10 / 3.11
    ParticleEmitter,
    Anchor,
    Portal,

    // 14.1 audio
    AudioLoader,
    AudioBuffer,
    Audio,
    PositionalAudio,
    AmbientAudio,

    // 14.2 video
    VideoScreen,

    // 14.3 cameras
    PerspectiveCamera,
    OrthographicCamera,

    // 14.4 character controller and force effects
    CharacterController,
    ConstantForceField,
    RadialForceField,
    VortexForceField,
    DragForceField,
    TurbulenceForceField,

    // 14.6 shader graph materials
    ShaderGraphMaterial,

    // constants
    FrontSide,
    BackSide,
    DoubleSide,
    NormalBlending,
    AdditiveBlending,
    RepeatWrapping,
    ClampToEdgeWrapping,
    MirroredRepeatWrapping,
    LoopOnce,
    LoopRepeat,
    LoopPingPong,

    // 3.13 runtime
    SpatialUnsupportedError,
    limits: LIMITS,
    version: runtime.version,

    mount(scene) {
      return runtime.mount(scene);
    },
    onFrame(callback) {
      return runtime.onFrame(callback);
    },
    offFrame(callback) {
      runtime.offFrame(callback);
    },
    // Same lookup as scene.getObjectByName, normalised to null on a miss so
    // the return is consistent with the unmounted case.
    find(name) {
      if (!runtime.scene) return null;
      const found = runtime.scene.getObjectByName(name);
      return found === undefined ? null : found;
    },
    destroy(object) {
      return runtime.destroy(object);
    },
    raycast(origin, direction, options) {
      return runtime.raycast(origin, direction, options);
    },
    loadAsset(urls) {
      return runtime.loadAsset(urls);
    },
    dump(options) {
      return runtime.dump(options);
    },
    dispose() {
      return runtime.dispose();
    },

    // 14.3 pointer queries
    rayFromPoint(x, y) {
      return runtime.rayFromPoint(x, y);
    },

    // 14.11 consumer-performed requests
    fetchText(url) {
      return runtime.fetchText(url);
    },
    fetchJSON(url) {
      return runtime.fetchJSON(url);
    },

    inject: createInject(runtime),
  };

  const readOnly = (name, get) => Object.defineProperty(namespace, name, { enumerable: true, get });
  readOnly("scene", () => runtime.scene);
  readOnly("time", () => runtime.time);
  readOnly("env", () => runtime.env);
  readOnly("physics", () => runtime.physics);
  readOnly("input", () => runtime.input);
  readOnly("audio", () => runtime.audio);
  readOnly("host", () => runtime.hostChannel);
  readOnly("isActive", () => runtime.active);
  readOnly("render", () => runtime.render);
  readOnly("environmentLighting", () => runtime.environmentLighting);
  readOnly("debug", () => runtime.debug);

  Object.defineProperty(namespace, "camera", {
    enumerable: true,
    get() {
      return runtime.camera;
    },
    set(value) {
      runtime.setCamera(value);
    },
  });

  Object.defineProperty(namespace, "sceneUnderstanding", {
    enumerable: true,
    get() {
      return runtime.sceneUnderstanding;
    },
    set(value) {
      if (value === null || value === undefined) {
        runtime.sceneUnderstanding = { collision: false, occlusion: false, physics: false, shadows: false };
        return;
      }
      if (typeof value !== "object") {
        throw new TypeError("Spatial.sceneUnderstanding expects an object or null");
      }
      runtime.sceneUnderstanding = {
        collision: value.collision === true,
        occlusion: value.occlusion === true,
        physics: value.physics === true,
        shadows: value.shadows === true,
      };
    },
  });

  Object.defineProperty(namespace, "environment", {
    enumerable: true,
    get() {
      return runtime.environment;
    },
    set(value) {
      if (value !== null && value !== undefined && !(value instanceof ImageBasedLight)) {
        throw new TypeError("Spatial.environment expects an ImageBasedLight or null");
      }
      runtime.environment = value === undefined ? null : value;
    },
  });

  return namespace;
}
