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
} from "./three-exports.js";
import { Scene, Mesh } from "./scene-classes.js";
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
} from "./geometry.js";
import { TextGeometry } from "./text-geometry.js";
import { OcclusionMaterial } from "./materials.js";
import { Texture, TextureLoader } from "./texture.js";
import { RigidBody, Joint } from "./physics.js";
import { ParticleEmitter } from "./particles.js";
import { Anchor } from "./anchor.js";
import { Portal } from "./portal.js";
import { ImageBasedLight } from "./asset.js";
import { SpatialUnsupportedError } from "./errors.js";
import { createInject } from "./inject.js";
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
} from "./limits.js";

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

    inject: createInject(runtime),
  };

  const readOnly = (name, get) => Object.defineProperty(namespace, name, { enumerable: true, get });
  readOnly("scene", () => runtime.scene);
  readOnly("time", () => runtime.time);
  readOnly("env", () => runtime.env);
  readOnly("physics", () => runtime.physics);
  readOnly("input", () => runtime.input);

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
