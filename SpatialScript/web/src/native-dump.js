// The three.js side of the parity gate.
//
// Rebuilds the SPEC section 8 dump from the objects the consumer actually renders,
// in the same shape and with the same value conventions as the Swift consumer's
// `nativeDump()` (ScriptingNativeDump.swift), so the two can be diffed field by
// field. Every value is read off the three.js object, never off the core.

import * as THREE from 'three';
import { walkUp } from './scene-walk.js';

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
    objectCount: objects.length,
    joints: describeJoints(consumer),
    gravity: [gravity.x, gravity.y, gravity.z],
    environment: consumer.scene.environment ? { active: true } : null,
    warnings: consumer.warnings.slice(),
    errors: consumer.errors.slice(),
    logs: consumer.logs.map((line) => `${line.level}: ${line.message}`),
    placeholder: false,
  };
}

/** Only objects hanging off the rendered root count, matching the Swift filter. */
function isAttached(consumer, object) {
  return walkUp(object, (node) => node === consumer.root || node === consumer.camera) !== null;
}

function describe(consumer, id, object) {
  object.matrixWorld.decompose(_world, _quaternion, _scale);
  _position.copy(object.position);
  const rotation = object.quaternion;
  const scale = object.scale;

  const record = {
    id,
    name: object.name || '',
    type: KIND_TYPES[object.userData.__spatialKind] || object.type,
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
    interactive: consumer.interactive.get(id) || { tap: false, hover: false, drag: false },
    components: componentNames(consumer, id, object),
    geometry: geometryDump(object),
    material: materialDump(consumer, id, object),
    light: lightDump(consumer, id, object),
    rigidBody: bodyDump(consumer, id),
  };

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
    record.particles = consumer.emitters.has(id);
  }
  return record;
}

function parentIdentifier(consumer, object) {
  const parent = object.parent;
  if (!parent) return null;
  // Head-anchored content rides the camera on web; in RealityKit it sits on the root.
  if (parent === consumer.root || parent === consumer.camera) return 0;
  const id = parent.userData ? parent.userData.__spatialId : undefined;
  return id === undefined ? null : id;
}

function geometryDump(object) {
  const info = object.userData.__spatialGeometry;
  if (!info || !info.type) return null;
  const parameters = info.parameters && Object.keys(info.parameters).length ? info.parameters : null;
  return { type: info.type, parameters };
}

function materialDump(consumer, id, object) {
  const entry = consumer.materialOf.get(id);
  const spec = entry ? JSON.parse(entry.key) : null;
  const material = object.isMesh && object.material && !Array.isArray(object.material) ? object.material : null;
  if (!spec && !material) return null;

  // Every field is optional: a portal's render-target material and a particle
  // material have no colour, metalness or emissive at all, and report null.
  const dump = {
    type: spec ? spec.type : (material ? material.type : null),
    color: spec ? spec.color ?? null : null,
    opacity: spec ? spec.opacity ?? null : null,
    transparent: spec ? spec.transparent ?? null : null,
    side: spec ? spec.side ?? null : null,
    wireframe: spec ? spec.wireframe ?? null : null,
    metalness: spec ? spec.metalness ?? null : null,
    roughness: spec ? spec.roughness ?? null : null,
    emissive: spec ? spec.emissive ?? null : null,
    emissiveIntensity: spec ? spec.emissiveIntensity ?? null : null,
    clearcoat: spec ? spec.clearcoat ?? null : null,
    clearcoatRoughness: spec ? spec.clearcoatRoughness ?? null : null,
    depthWrite: spec ? spec.depthWrite ?? null : null,
    depthTest: spec ? spec.depthTest ?? null : null,
    blending: spec ? spec.blending ?? null : null,
    maps: spec ? spec.maps ?? {} : {},
    nativeType: null,
  };

  if (!material) return dump;
  // Read the values back off the material three.js is actually rendering with.
  dump.nativeType = material.colorWrite === false ? 'OcclusionMaterial' : material.type;
  dump.color = colorTriple(material.color);
  dump.side = material.side ?? null;
  dump.wireframe = material.wireframe === true;
  dump.depthWrite = material.depthWrite === true;
  dump.depthTest = material.depthTest === true;
  dump.blending = material.blending ?? null;
  dump.transparent = material.transparent === true;
  // Object3D.opacity is a separate component, so report the material's own value.
  dump.opacity = material.userData.__baseOpacity ?? material.opacity ?? null;
  if (material.isMeshStandardMaterial) {
    dump.metalness = material.metalness ?? null;
    dump.roughness = material.roughness ?? null;
    dump.emissive = colorTriple(material.emissive);
    dump.emissiveIntensity = material.emissiveIntensity ?? null;
  }
  if (material.isMeshPhysicalMaterial) {
    dump.clearcoat = material.clearcoat ?? null;
    dump.clearcoatRoughness = material.clearcoatRoughness ?? null;
  }
  return dump;
}

/** Linear [r, g, b], or null where the material has no such colour at all. */
function colorTriple(color) {
  if (!color || typeof color.r !== 'number') return null;
  return [color.r, color.g, color.b];
}

function lightDump(consumer, id, object) {
  if (!object.isLight) return null;
  const dump = {
    type: lightType(object),
    color: colorTriple(object.color),
    // three.js is already in the physical units SPEC 3.6 describes, so no
    // lumen or lux conversion happens on this side.
    intensity: object.intensity ?? null,
    distance: object.distance ?? null,
    decay: object.decay ?? null,
    angle: object.angle ?? null,
    penumbra: object.penumbra ?? null,
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
  if (object.isDirectionalLight) names.push('DirectionalLightComponent');
  if (object.isPointLight) names.push('PointLightComponent');
  if (object.isSpotLight) names.push('SpotLightComponent');
  return names;
}
