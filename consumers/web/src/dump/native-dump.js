// The three.js side of the parity gate.
//
// Rebuilds the SPEC section 8 dump from the objects the consumer actually renders,
// in the same shape and with the same value conventions as the Swift consumer's
// `nativeDump()` (ScriptingNativeDump.swift), so the two can be diffed field by
// field. Every value is read off the three.js object, never off the core.

import * as THREE from 'three';
import { walkUp } from './scene-walk.js';

/** The texture slots a material payload can bind (SPEC 3.4). */
const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'];

const KIND_TYPES = {
  mesh: 'Mesh',
  text: 'Mesh',
  portal: 'Portal',
  group: 'Group',
  ambientLight: 'AmbientLight',
  directionalLight: 'DirectionalLight',
  pointLight: 'PointLight',
  spotLight: 'SpotLight',
  particles: 'ParticleEmitter',
  anchor: 'Anchor',
  asset: 'Asset',
};

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _world = new THREE.Vector3();
const _to = new THREE.Vector3();

export function nativeDump(consumer, { platform = 'web' } = {}) {
  consumer.root.updateMatrixWorld(true);
  consumer.camera.updateMatrixWorld(true);

  const objects = [];
  for (const id of [...consumer.objects.keys()].sort((a, b) => a - b)) {
    const object = consumer.objects.get(id);
    if (!isAttached(consumer, object)) continue;
    objects.push(describe(consumer, id, object));
  }

  const gravity = consumer.physics ? consumer.physics.world.gravity : { x: 0, y: -9.81, z: 0 };

  return {
    backend: 'three',
    platform,
    frame: consumer.frame,
    elapsed: consumer.elapsed,
    objects,
    joints: describeJoints(consumer),
    gravity: [gravity.x, gravity.y, gravity.z],
    // SPEC 8: the scene block is the core's, plus `childCount`. The scene's name
    // never crosses the command stream — it names a script object, not anything
    // the renderer holds — so it is read off the runtime when one is attached.
    scene: { name: sceneName(consumer), childCount: consumer.root.children.length },
    // The core counts from 1 on its first load; the consumer counts resets, and
    // it is not reset for the first script.
    loadGeneration: consumer.generation + 1,
    droppedErrors: consumer.droppedErrors || 0,
    environment: environmentDump(consumer),
    // ---- phase 2 (SPEC 14.13) ---------------------------------------------
    isActive: consumer.isActive !== false,
    audioMixer: consumer.audio ? consumer.audio.mixerState() : null,
    camera: cameraDump(consumer),
    sceneUnderstanding: consumer.sceneUnderstanding
      ? { ...consumer.sceneUnderstanding }
      : { collision: false, occlusion: false, physics: false, shadows: false },
    render: { adaptiveResolution: consumer.renderOptions.adaptiveResolution === true },
    environmentLighting: { intensityExponent: consumer.renderOptions.environmentIntensityExponent ?? 1 },
    debug: { modelView: consumer.renderOptions.debugModelView ?? null },
    hostFunctions: consumer.host ? consumer.host.names() : [],
    controllers: consumer.input ? consumer.input.readControllers() : [],
    warnings: consumer.warnings.slice(),
    errors: consumer.errors.slice(),
  };
}

/**
 * FA-34, SPEC 8: the image based light the scene is really lit by, with the url
 * and intensity that produced it, matching `ScriptingNativeDump.environmentDump`.
 */
function environmentDump(consumer) {
  if (!consumer.scene.environment) return null;
  return {
    url: consumer.environmentSource || null,
    intensity: consumer._environmentBaseIntensity ?? 1,
  };
}

/**
 * SPEC 8: `scene.name` is the script's scene name. Nothing on the wire carries
 * it — the core names only objects with ids — so it comes from the mounted
 * scene when the core exposes its runtime, and is the core's default otherwise.
 */
function sceneName(consumer) {
  const runtime = consumer.core && consumer.core.runtime;
  const scene = runtime && runtime.scene;
  return (scene && typeof scene.name === 'string') ? scene.name : '';
}

/**
 * SPEC 8: `type` is the script class the core dumps, which the create kind does
 * not always name on its own — an `Audio` arrives as a plain group and becomes
 * a `PositionalAudio` through its payload, and a force field names its own kind.
 * The three.js class is reported separately as `nativeType`.
 */
function typeOf(consumer, id, object) {
  const kind = object.userData.__spatialKind;
  const field = consumer.forceFields ? consumer.forceFields.describe(id) : null;
  if (field && field.kind) return field.kind;
  const audio = consumer.audio ? consumer.audio.describe(id) : null;
  if (audio) {
    if (audio.ambient === true) return 'AmbientAudio';
    return audio.spatial === true ? 'PositionalAudio' : 'Audio';
  }
  if (consumer.video && consumer.video.screens.has(id)) return 'VideoScreen';
  if (consumer.cameraId === id && consumer.cameraSpec) {
    return consumer.cameraSpec.kind === 'orthographic' ? 'OrthographicCamera' : 'PerspectiveCamera';
  }
  return KIND_TYPES[kind] || object.type;
}

/** SPEC 8: no listener of any kind, the shape the core's `interactive` uses. */

const NO_INTERACTION = { tap: false, hover: false, drag: false, manipulation: false, collision: false };

/**
 * SPEC 8 and 3.10: the emitter state the consumer is running, in the core's key
 * set. A preset has already been resolved into these fields by the time the
 * emitter renders, so this is what the particles are actually doing.
 */
function emitterState(emitter, consumer) {
  const config = emitter.config;
  const colour = (value) => {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return [value[0], value[1], value[2]];
    const c = new THREE.Color(value);
    return [c.r, c.g, c.b];
  };
  return {
    preset: config.preset ?? null,
    shape: config.shape,
    shapeSize: Array.isArray(config.shapeSize) ? [...config.shapeSize] : config.shapeSize,
    birthRate: config.birthRate,
    lifetime: config.lifetime,
    lifetimeVariation: config.lifetimeVariation,
    speed: config.speed,
    speedVariation: config.speedVariation,
    size: config.size,
    sizeVariation: config.sizeVariation,
    color: colour(config.color),
    colorEnd: colour(config.colorEnd),
    opacity: config.opacity,
    opacityEnd: config.opacityEnd,
    spreadAngle: config.spreadAngle,
    acceleration: Array.isArray(config.acceleration) ? [...config.acceleration] : config.acceleration,
    isEmitting: config.isEmitting !== false,
    burstCount: config.burstCount,
    loops: config.loops !== false,
    // The core reports the texture id it sent, not the loaded texture.
    texture: config.texture ?? null,
  };
}

/** Only objects hanging off the rendered root count, matching the Swift filter. */

function isAttached(consumer, object) {
  return walkUp(object, (node) => node === consumer.root
    || node === consumer.camera
    // Head-anchored content rides the built-in camera even when a script has
    // taken the view over with one of its own (SPEC 3.11, 14.3).
    || node === consumer.builtInCamera) !== null;
}

function describe(consumer, id, object) {
  object.matrixWorld.decompose(_world, _quaternion, _scale);
  _position.copy(object.position);
  // SPEC 3.2 and 8: a billboard's facing is applied for the render only, so the
  // dump reports the rotation the script authored, as RealityKit's does.
  const authored = consumer.authoredRotations.get(id);
  const rotation = authored
    ? { x: authored[0], y: authored[1], z: authored[2], w: authored[3] }
    : object.quaternion;
  const scale = object.scale;

  const record = {
    id,
    name: object.name || '',
    type: typeOf(consumer, id, object),
    parent: parentIdentifier(consumer, object),
    visible: object.visible !== false,
    position: [_position.x, _position.y, _position.z],
    quaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
    scale: [scale.x, scale.y, scale.z],
    worldPosition: [_world.x, _world.y, _world.z],
    opacity: consumer.opacities.get(id) ?? 1,
    billboard: consumer.billboards.has(id),
    groundingShadow: false,
    hoverEffect: object.userData.__hoverEffect ?? null,
    manipulable: consumer.manipulable.has(id),
    castShadow: object.castShadow === true,
    receiveShadow: object.receiveShadow === true,
    renderOrder: object.renderOrder || 0,
    world: consumer.worldGroups.has(id),
    // SPEC 8: the flags the core sent for this object, key for key.
    interactive: { ...NO_INTERACTION, ...(consumer.interactive.get(id) || {}) },
    // The two additions the rule allows: the native class, and the native
    // component and helper names. Every backend-specific fact lives here.
    nativeType: object.type,
    components: componentNames(consumer, id, object),
    geometry: geometryDump(object),
    material: materialDump(consumer, id, object),
    light: lightDump(consumer, id, object),
    rigidBody: bodyDump(consumer, id),
  };

  // ---- phase 2 (SPEC 14.13) ------------------------------------------------
  // FA-34: present exactly when the consumer holds that feature for this id,
  // which is the rule `ScriptingNativeDump+Phase2.phase2Dump` follows.
  for (const [key, value] of Object.entries(phase2Dump(consumer, id, object))) record[key] = value;

  // FA-34, SPEC 8: the motion the consumer measured, present only on a body
  // that can move, the way the Swift dump reports it.
  // SPEC 8: present on any object with a rigid body, whatever its type.
  if (record.rigidBody && consumer.physics) {
    const entry = consumer.physics.bodies.get(id);
    if (entry) {
      const velocity = entry.body.linvel();
      record.velocity = [velocity.x, velocity.y, velocity.z];
      record.isSleeping = entry.body.isSleeping() === true;
    }
  }
  if (object.userData.__spatialKind === 'asset') {
    // SPEC 8: the sources the script asked for, in the core's shape, and what
    // the asset turned out to carry once it loaded.
    const spec = consumer.assetSpecs.get(id) || {};
    const entry = consumer.assets.get(id);
    record.asset = {
      glb: spec.glb ?? null,
      gltf: spec.gltf ?? null,
      usdz: spec.usdz ?? null,
      reality: spec.reality ?? null,
    };
    record.loaded = !!entry;
    record.animations = entry ? entry.clips.map((clip) => clip.name) : [];
  }
  if (object.userData.__spatialKind === 'anchor') {
    record.anchor = object.userData.__spatialAnchor || null;
    // The web consumer never anchors to the world (SPEC 3.11).
    record.isAnchored = false;
  }
  if (object.userData.__spatialKind === 'portal') {
    const portal = consumer.portals.get(id);
    if (portal) record.portal = portal.spec;
  }
  if (object.userData.__spatialKind === 'particles') {
    // SPEC 8: the whole emitter state, in the core's key order, reporting the
    // values the consumer applied (a preset is resolved by then, SPEC 3.10).
    const emitter = consumer.emitters.get(id);
    record.particles = emitter ? emitterState(emitter, consumer) : null;
  }
  return record;
}

/**
 * FA-34: the per-object phase 2 block, with the same keys and the same presence
 * rules as `ScriptingNativeDump+Phase2.phase2Dump(_:)` in the Swift consumer.
 */
function phase2Dump(consumer, id, object) {
  const out = {};
  const audio = consumer.audio ? consumer.audio.describe(id) : null;
  if (audio) out.audio = audio;
  const video = consumer.video ? consumer.video.describe(id) : null;
  if (video) out.video = video;
  const character = consumer.characters ? consumer.characters.describe(id) : null;
  if (character) {
    // SPEC 8: the controller reports the spec the script set; `isOnGround` and
    // `velocity` are object-level, the way the core dumps them.
    const { isOnGround, ...spec } = character;
    out.characterController = spec;
    out.isOnGround = isOnGround === true;
    const entry = consumer.characters.controllers.get(id);
    if (entry) out.velocity = [entry.velocity.x, entry.velocity.y, entry.velocity.z];
  }
  const field = consumer.forceFields ? consumer.forceFields.describe(id) : null;
  if (field) out.forceField = field;
  // The Swift dump reports the pair together, gated on the record holding a rig:
  // `skeleton` is null when there are no joints, and the weights ride with it.
  const asset = consumer.assets.get(id);
  const holdsRig = consumer.skeletons.has(id) || consumer.blendShapes.has(id)
    || !!(asset && asset.bones && asset.bones.size)
    || object.userData.__spatialKind === 'asset';
  if (holdsRig) {
    out.skeleton = skeletonDump(consumer, id);
    const weights = consumer.blendShapes.get(id);
    out.blendShapes = weights ? { ...weights } : (asset && asset.morphs && asset.morphs.size ? {} : null);
  }
  const accessibility = consumer.accessibility ? consumer.accessibility.describe(id) : null;
  if (accessibility) out.accessibility = accessibility;

  return out;
}

/** The active camera, or null while the consumer's own is in use (SPEC 14.3). */
function cameraDump(consumer) {
  const camera = consumer.scriptCamera;
  if (!camera) return null;
  camera.updateMatrixWorld(true);
  // SPEC 8: the camera block is the core's key set. Where the camera is comes
  // from the object it rides, which is dumped like any other object.
  const dump = {
    kind: camera.isOrthographicCamera ? 'orthographic' : 'perspective',
    near: camera.near,
    far: camera.far,
  };
  if (camera.isOrthographicCamera) {
    // SPEC 14.3: the dump keeps the script's left and right, even where the
    // rendered width was derived from the viewport aspect instead.
    const spec = consumer.cameraSpec;
    Object.assign(dump, {
      fov: null,
      left: spec && spec.left !== undefined && spec.left !== null ? spec.left : camera.left,
      right: spec && spec.right !== undefined && spec.right !== null ? spec.right : camera.right,
      top: camera.top,
      bottom: camera.bottom,
    });
  } else {
    Object.assign(dump, { fov: camera.fov, left: null, right: null, top: null, bottom: null });
  }
  return dump;
}

/** The joints the consumer actually holds, read off the loaded rig. */
function skeletonDump(consumer, id) {
  const asset = consumer.assets.get(id);
  if (!asset || !asset.bones || asset.bones.size === 0) return null;
  const state = consumer.skeletons.get(id);
  // SPEC 8: the same joint names the core dumps — the ones the script named —
  // with the pose the renderer is actually holding for each. Every bone in the
  // rig still reaches the core through `syncSkeleton` when tracking is on.
  const wanted = state && state.joints ? Object.keys(state.joints) : [];
  const joints = {};
  for (const name of wanted) {
    const bone = asset.bones.get(name);
    if (!bone) continue;
    joints[name] = [
      bone.position.x, bone.position.y, bone.position.z,
      bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w,
    ];
  }
  return { joints, track: !!(state && state.track) };
}

function parentIdentifier(consumer, object) {
  const parent = object.parent;
  if (!parent) return null;
  // Head-anchored content rides the camera on web; in RealityKit it sits on the root.
  if (parent === consumer.root || parent === consumer.camera) return 0;
  const id = parent.userData ? parent.userData.__spatialId : undefined;
  return id === undefined ? null : id;
}

/**
 * SPEC 8: the geometry block is `{ type, parameters }` — the core's key set
 * minus its uuid. How the mesh is split is a native fact and rides `components`.
 */
function geometryDump(object) {
  const info = object.userData.__spatialGeometry;
  if (!info || !info.type) return null;
  const parameters = info.parameters && Object.keys(info.parameters).length ? info.parameters : null;
  return { type: info.type, parameters };
}

/**
 * SPEC 8: a material block has the core's key set — no uuid, no extra keys. A
 * shader graph reports the graph with its fallback nested, exactly as the core
 * does (SPEC 14.6); the native class name rides `components`.
 */
function materialDump(consumer, id, object) {
  if (Array.isArray(object.material)) {
    // SPEC 14.12: one block per slot, in slot order.
    return object.material.map((one, slot) => materialSlot(consumer, id, one, slot));
  }
  const material = object.isMesh && object.material ? object.material : null;
  if (!material && !consumer.materialOf.has(id)) return null;
  return materialSlot(consumer, id, material, 0);
}

function materialSlot(consumer, id, material, slot) {
  const graph = consumer.shaderGraphs.get(`${id}:${slot}`);
  const fallback = standardMaterialDump(consumer, material);
  if (!graph) return fallback;
  return {
    type: 'ShaderGraphMaterial',
    source: graph.source,
    name: graph.name,
    parameters: { ...graph.parameters },
    generation: graph.generation ?? 0,
    // The material three renders is the fallback the script supplied.
    fallback,
  };
}

/** The values three.js is really rendering with, under the core's key names. */
function standardMaterialDump(consumer, material) {
  if (!material) return null;
  const standard = material.isMeshStandardMaterial === true;
  const physical = material.isMeshPhysicalMaterial === true;
  return {
    type: material.userData.__spatialType || material.type,
    color: colorTriple(material.color),
    // Object3D.opacity is a separate component, so report the material's own.
    opacity: material.userData.__baseOpacity ?? material.opacity ?? 1,
    transparent: (material.userData.__baseTransparent ?? material.transparent) === true,
    side: material.side ?? 0,
    wireframe: material.wireframe === true,
    metalness: standard ? material.metalness : 0,
    roughness: standard ? material.roughness : 1,
    emissive: standard ? colorTriple(material.emissive) : [0, 0, 0],
    emissiveIntensity: standard ? material.emissiveIntensity : 1,
    clearcoat: physical ? material.clearcoat : 0,
    clearcoatRoughness: physical ? material.clearcoatRoughness : 0,
    depthWrite: material.depthWrite === true,
    depthTest: material.depthTest === true,
    blending: material.blending ?? 1,
    maps: mapsOf(consumer, material),
  };
}

/** A three.js Color as the `[r, g, b]` triple every dump uses. */
function colorTriple(color) {
  return color ? [color.r, color.g, color.b] : null;
}

/** The texture id bound to each map slot, or null — the core's `maps` shape. */

function mapsOf(consumer, material) {
  const maps = {};
  for (const slot of MAP_SLOTS) {
    const texture = material[slot] || null;
    maps[slot] = texture ? textureIdOf(consumer, texture) : null;
  }
  return maps;
}

function textureIdOf(consumer, texture) {
  for (const [id, entry] of consumer.textures) {
    if (entry.texture === texture) return id;
    for (const view of entry.views.values()) if (view === texture) return id;
  }
  return null;
}

function lightDump(consumer, id, object) {
  if (!object.isLight) return null;
  const dump = {
    type: lightType(object),
    color: colorTriple(object.color),
    // three.js is already in the physical units SPEC 3.6 describes, so no
    // lumen or lux conversion happens on this side.
    intensity: object.intensity ?? 1,
    // SPEC 8: numbers on every light type, with the core's defaults where three
    // has no such property (an AmbientLight has no distance or decay).
    distance: object.distance ?? 0,
    decay: object.decay ?? 2,
    angle: object.angle ?? 0,
    penumbra: object.penumbra ?? 0,
    castShadow: object.castShadow === true,
    direction: null,
  };
  if (object.target && object.target.matrixWorld) {
    object.target.updateMatrixWorld(true);
    _world.setFromMatrixPosition(object.matrixWorld);
    _to.setFromMatrixPosition(object.target.matrixWorld).sub(_world);
    if (_to.lengthSq() > 0) {
      _to.normalize();
      dump.direction = [_to.x, _to.y, _to.z];
    }
  }
  return dump;
}

function lightType(light) {
  if (light.isDirectionalLight) return 'directional';
  if (light.isPointLight) return 'point';
  if (light.isSpotLight) return 'spot';
  if (light.isAmbientLight) return 'ambient';
  return 'unknown';
}

function bodyDump(consumer, id) {
  if (!consumer.physics) return null;
  const entry = consumer.physics.bodies.get(id);
  const spec = consumer.bodySpecs.get(id);
  if (!entry || !spec) return null;
  const dump = { ...spec };
  const body = entry.body;
  // A trigger carries no physics body on either backend, so its reported type
  // stays the one the script asked for (SPEC 3.7 says the type is ignored).
  dump.type = spec.isTrigger === true
    ? (spec.type || 'dynamic')
    : (body.isFixed() ? 'static' : (body.isKinematic() ? 'kinematic' : 'dynamic'));
  dump.shape = spec.shape;
  return dump;
}

function describeJoints(consumer) {
  if (!consumer.physics) return [];
  const out = [];
  for (const jointId of [...consumer.physics.joints.keys()].sort((a, b) => a - b)) {
    const spec = consumer.physics.joints.get(jointId).spec;
    out.push({
      id: jointId,
      type: spec.type,
      bodyA: spec.bodyA,
      bodyB: spec.bodyB,
      anchorA: spec.anchorA || [0, 0, 0],
      anchorB: spec.anchorB || [0, 0, 0],
      axis: spec.axis || [0, 1, 0],
      limits: spec.limits || null,
    });
  }
  return out;
}

/**
 * RealityKit component names for what the three.js side actually holds, so the
 * two component lists can be compared directly. Names with no three.js
 * equivalent (GroundingShadowComponent, HoverEffectComponent) are never emitted.
 */
function componentNames(consumer, id, object) {
  const names = [];
  const isMesh = object.isMesh === true;
  if (isMesh && object.geometry && object.material) names.push('ModelComponent');
  const body = consumer.physics ? consumer.physics.bodies.get(id) : null;
  // SPEC 3.7: web colliders exist only for a rigidBody or a trigger, and
  // RealityKit builds its collision shapes lazily, so this lists a
  // CollisionComponent only where a collider actually exists. Hit testing and
  // raycasting still cover every visible mesh through the three.js Raycaster.
  if (body && body.collider) names.push('CollisionComponent');
  if (body) {
    // A trigger is collision-only: RealityKit strips its physics components too.
    if (body.spec.isTrigger !== true) {
      names.push('PhysicsBodyComponent');
      if (consumer.physics.isDynamic(id)) names.push('PhysicsMotionComponent');
    }
  }
  const interactive = consumer.interactive.get(id);
  if (interactive && (interactive.tap || interactive.hover || interactive.drag)) {
    names.push('InputTargetComponent');
  }
  if ((consumer.opacities.get(id) ?? 1) !== 1) names.push('OpacityComponent');
  if (consumer.billboards.has(id)) names.push('BillboardComponent');
  if (object.isLight && object.castShadow) names.push('DynamicLightShadowComponent');
  if (consumer.emitters.has(id)) names.push('ParticleEmitterComponent');
  if (consumer.portals.has(id)) names.push('PortalComponent');
  if (consumer.worldGroups.has(id)) names.push('WorldComponent');
  if (object.userData.__spatialKind === 'anchor') names.push('AnchoringComponent');
  if (isMesh && consumer.scene.environment) names.push('ImageBasedLightReceiverComponent');
  if (consumer.manipulable.has(id)) names.push('ManipulationComponent');
  // ---- phase 2 components ------------------------------------------------
  const audio = consumer.audio ? consumer.audio.sources.get(id) : null;
  if (audio) names.push(audio.ambient ? 'AmbientAudioComponent' : (audio.spatial ? 'SpatialAudioComponent' : 'ChannelAudioComponent'));
  if (consumer.video && consumer.video.screens.has(id)) names.push('VideoPlayerComponent');
  if (consumer.characters && consumer.characters.controllers.has(id)) names.push('CharacterControllerComponent');
  if (consumer.forceFields && consumer.forceFields.fields.has(id)) names.push('ForceEffectComponent');
  if (consumer.accessibility && consumer.accessibility.entries.has(id)) names.push('AccessibilityComponent');
  const asset = consumer.assets.get(id);
  if (asset && asset.bones && asset.bones.size) names.push('SkeletalPosesComponent');
  if (asset && asset.morphs && asset.morphs.size) names.push('BlendShapeWeightsComponent');
  if (object.isDirectionalLight) names.push('DirectionalLightComponent');
  if (object.isPointLight) names.push('PointLightComponent');
  if (object.isSpotLight) names.push('SpotLightComponent');

  // SPEC 8: native facts that are not core dump keys live here as names, never
  // as extra keys elsewhere in the dump.
  const info = object.userData.__spatialGeometry;
  if (info && info.groups && info.groups.length) names.push(`geometryGroups:${info.groups.length}`);
  const slots = Array.isArray(object.material) ? object.material.length : (object.material ? 1 : 0);
  if (slots > 1) names.push(`materialSlots:${slots}`);
  const first = Array.isArray(object.material) ? object.material[0] : object.material;
  if (first) names.push(`nativeMaterial:${first.colorWrite === false ? 'OcclusionMaterial' : first.type}`);
  // Which texture slots the renderer really bound, by name.
  for (const slot of MAP_SLOTS) {
    if (first && first[slot]) names.push(`boundMap:${slot}`);
  }
  const mode = consumer.renderOptions.debugModelViewApplied ?? null;
  if (mode && isMesh) names.push(`debugModelView:${mode}`);
  const graph = consumer.shaderGraphs.get(`${id}:0`);
  // SPEC 14.6: a browser renders the fallback, so the graph itself never loads.
  if (graph) names.push('ShaderGraphFallback');
  return names;
}
