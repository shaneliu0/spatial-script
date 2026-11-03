// Constants, scratch objects and free helpers shared by the consumer modules.
//
// FA-57: `consumer/consumer.js` was one 3000-line file. The class is now split
// by responsibility across sibling modules that mix into it, and everything they
// share lives here so there is exactly one copy of each table and each scratch
// vector.

import * as THREE from 'three';

export const SIDES = { FrontSide: THREE.FrontSide, BackSide: THREE.BackSide, DoubleSide: THREE.DoubleSide };
export const BLENDING = { NormalBlending: THREE.NormalBlending, AdditiveBlending: THREE.AdditiveBlending };
export const WRAPPING = {
  RepeatWrapping: THREE.RepeatWrapping,
  ClampToEdgeWrapping: THREE.ClampToEdgeWrapping,
  MirroredRepeatWrapping: THREE.MirroredRepeatWrapping,
};

export const _v3 = new THREE.Vector3();
export const _quat = new THREE.Quaternion();
export const _parentQuat = new THREE.Quaternion();
export const _scale = new THREE.Vector3();
export const _size = new THREE.Vector2();
export const _ndc = new THREE.Vector2();
export const _plane = new THREE.Plane();
export const _origin = new THREE.Vector3(0, 0, 0);
export const _matrix = new THREE.Matrix4();

/** Bones by name and morph targets by name, for SPEC 14.5. */
export function describeRig(root) {
  const bones = new Map();
  const morphs = new Map();
  root.traverse((node) => {
    if (node.isBone && node.name && !bones.has(node.name)) bones.set(node.name, node);
    if (node.isSkinnedMesh && node.skeleton) {
      for (const bone of node.skeleton.bones) if (bone.name && !bones.has(bone.name)) bones.set(bone.name, bone);
    }
    if (node.isMesh && node.morphTargetDictionary && node.morphTargetInfluences) {
      for (const [name, index] of Object.entries(node.morphTargetDictionary)) {
        if (!morphs.has(name)) morphs.set(name, []);
        morphs.get(name).push({ mesh: node, index });
      }
    }
  });
  return { bones, morphs };
}

export let _whiteTexture = null;
export function whiteTexture() {
  if (_whiteTexture) return _whiteTexture;
  _whiteTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  _whiteTexture.needsUpdate = true;
  return _whiteTexture;
}

export const MAX_ERRORS = 200;
/** SPEC 3.5: the one shared asset root, served from the SpatialScript folder. */
export const DEFAULT_ASSET_ROOT = '/assets';
/** SPEC 14.3: how far an orthographic width may differ before it is called out. */
export const ORTHOGRAPHIC_TOLERANCE = 0.02;
/** Geometries kept after their last user, so a re-send with null buffers works. */
export const MAX_IDLE_GEOMETRIES = 128;
export const MAX_LOGS_PER_FRAME = 200;
export const MAX_LOGS = 5000;

/** The keys each payload is allowed to carry (SPEC 5). */
export const KNOWN_KEYS = {
  material: new Set(['type', 'uuid', 'color', 'opacity', 'transparent', 'side', 'wireframe',
    'metalness', 'roughness', 'emissive', 'emissiveIntensity', 'clearcoat', 'clearcoatRoughness',
    'depthWrite', 'depthTest', 'blending', 'maps']),
  // SPEC 5: `requestedShape` and `requestedType` carry what the script asked
  // for where the core normalised it (a trigger's type becomes "static").
  rigidBody: new Set(['type', 'mass', 'shape', 'requestedShape', 'requestedType', 'friction', 'restitution',
    'linearDamping', 'angularDamping', 'isTrigger', 'gravity']),
  light: new Set(['type', 'color', 'intensity', 'distance', 'decay', 'angle', 'penumbra',
    'castShadow', 'direction']),
  particles: new Set(['preset', 'shape', 'shapeSize', 'birthRate', 'lifetime', 'lifetimeVariation',
    'speed', 'speedVariation', 'size', 'sizeVariation', 'color', 'colorEnd', 'opacity', 'opacityEnd',
    'spreadAngle', 'acceleration', 'isEmitting', 'burstCount', 'loops', 'texture']),
  anchor: new Set(['kind', 'plane', 'minimumBounds', 'hand', 'location', 'image', 'matrix']),
  // ---- phase 2 (SPEC 14.13) ----------------------------------------------
  audio: new Set(['url', 'spatial', 'ambient', 'loop', 'volume', 'rate', 'group', 'refDistance',
    'rolloff', 'distanceModel', 'cone', 'reverbLevel']),
  audioMixer: new Set(['masterVolume', 'groups', 'state']),
  video: new Set(['url', 'width', 'height', 'loop', 'muted', 'autoplay', 'docking', 'volume', 'rate']),
  camera: new Set(['kind', 'fov', 'near', 'far', 'left', 'right', 'top', 'bottom', 'transform']),
  characterController: new Set(['radius', 'height', 'slopeLimit', 'stepLimit', 'gravity']),
  forceField: new Set(['kind', 'enabled', 'radius', 'mask', 'force', 'strength', 'minimumDistance',
    'falloff', 'axis', 'coefficient', 'noiseScale']),
  skeleton: new Set(['joints', 'track']),
  sceneUnderstanding: new Set(['collision', 'occlusion', 'physics', 'shadows']),
  renderOptions: new Set(['adaptiveResolution', 'environmentIntensityExponent', 'debugModelView']),
  accessibility: new Set(['label', 'value', 'hint', 'isButton']),
  portal: new Set(['worldId', 'width', 'height', 'crossing']),
  texture: new Set(['url', 'repeat', 'offset', 'wrapS', 'wrapT', 'flipY']),
  geometry: new Set(['type', 'uuid', 'revision', 'parameters', 'groups']),
  asset: new Set(['usdz', 'reality', 'glb', 'gltf']),
  joint: new Set(['type', 'bodyA', 'bodyB', 'anchorA', 'anchorB', 'axis', 'limits']),
  environment: new Set(['url', 'intensity']),
};

/** Light `type` values SPEC 3.6 defines. */
export const LIGHT_TYPES = new Set(['ambient', 'directional', 'point', 'spot']);
/** Anchor kinds SPEC 3.11 defines. */
export const ANCHOR_KINDS = new Set(['head', 'plane', 'hand', 'image', 'world']);

/** Keys of the shader graph cache, one per mesh and material slot. */
export function shaderKey(id, slot) {
  return `${id}:${slot || 0}`;
}

/** P2-B-51: a non-finite gain or rate would poison the Web Audio graph. */
export function sanitizeAudio(spec) {
  if (!spec) return spec;
  const clean = { ...spec };
  for (const key of ['volume', 'rate', 'refDistance', 'rolloff', 'reverbLevel']) {
    if (key in clean && !Number.isFinite(clean[key])) delete clean[key];
  }
  if (clean.cone && !clean.cone.every((n) => Number.isFinite(n))) clean.cone = null;
  return clean;
}

/** Removes a `user:password@` authority so credentials never reach a log. */
export function lightKindOf(light) {
  if (light.isDirectionalLight) return 'directional';
  if (light.isPointLight) return 'point';
  if (light.isSpotLight) return 'spot';
  return 'ambient';
}

export function stripCredentials(url) {
  return url.replace(/^(https?:\/\/)[^/@]*@/i, '$1');
}

/** Percent-decodes until stable, never throwing on a malformed escape. */
export function fullyDecode(value) {
  let current = value;
  for (let pass = 0; pass < 3; pass++) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}
export const EMPTY_RECORDS = new Float32Array(0);
/** SPEC 14.6: fallback material fields `setParameter` must never write. */
export const MATERIAL_IDENTITY = new Set(['uuid', 'id', 'type', 'name', 'version']);
export const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'];
/**
 * AR-29, SPEC 6: the closed list of event types a consumer may dispatch — the
 * input events of SPEC 3.8, the anchor and load results, and the phase 2 media
 * and host results of SPEC 14.13. A type outside it is a typo or a version skew,
 * and the script would see silent, undiagnosable behaviour on one backend.
 */
export const DISPATCH_TYPES = new Set([
  'tap', 'hoverenter', 'hoverexit', 'dragstart', 'drag', 'dragend',
  'manipulationstart', 'manipulation', 'manipulationend',
  'collisionstart', 'collisionend',
  'anchored', 'unanchored',
  'assetLoaded', 'assetError', 'textureLoaded', 'textureError',
  'loaded', 'error', 'ended', 'audioState', 'hostResult', 'fetchResult',
]);

/** Dispatch types that carry a load result rather than user input. */
export const LOAD_EVENTS = new Set([
  'textureLoaded', 'textureError', 'assetLoaded', 'assetError',
  // P2-B-35: media results are load results, not injected input.
  'loaded', 'error', 'ended', 'audioState',
]);
/** The subset of those a host may also inject on the consumer's behalf. */
export const MEDIA_EVENTS = new Set(['loaded', 'error', 'ended', 'audioState']);

/** Frees the geometries, materials and textures a loaded subtree owns. */
export function disposeSubtree(root) {
  if (!root) return;
  const seen = new Set();
  root.traverse((node) => {
    if (!node.isMesh) return;
    if (node.geometry && !seen.has(node.geometry)) {
      seen.add(node.geometry);
      node.geometry.dispose();
    }
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      for (const slot of MAP_SLOTS) {
        const texture = material[slot];
        if (texture && !seen.has(texture)) {
          seen.add(texture);
          texture.dispose();
        }
      }
      material.dispose();
    }
  });
  root.removeFromParent();
}

/** True when the 10 transform floats starting after `offset` are all finite. */
export function finiteRecord(values, offset) {
  for (let i = 1; i <= 10; i++) if (!Number.isFinite(values[offset + i])) return false;
  return true;
}

export const now = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

export function resolveConstant(value, table, fallback) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value in table) return table[value];
  return fallback;
}

export function toFloat32(value) {
  if (value instanceof Float32Array) return value;
  return Float32Array.from(value || []);
}

export function toUint32(value) {
  if (value instanceof Uint32Array) return value;
  if (ArrayBuffer.isView(value)) return Uint32Array.from(value);
  return Uint32Array.from(value || []);
}

