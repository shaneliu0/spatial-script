// Test helpers: a headless consumer plus a recording stand-in for the core.
// Tests drive the consumer with hand-built command arrays that follow SPEC section 5.

import RAPIER from '@dimforge/rapier3d-compat';
import { SpatialConsumer } from '../src/consumer.js';

let rapierReady = null;

export async function initRapier() {
  if (!rapierReady) rapierReady = RAPIER.init().then(() => RAPIER);
  return rapierReady;
}

/** Captures everything the consumer pushes back into the core (SPEC section 6). */
export class RecordingCore {
  constructor(commandBatches = []) {
    this.commandBatches = commandBatches;
    this.dispatched = [];
    this.syncs = [];
    this.bodySyncs = [];
    this.inputs = [];
    this.audioSyncs = [];
    this.videoSyncs = [];
    this.characterSyncs = [];
    this.skeletonSyncs = [];
    this.activeStates = [];
  }

  syncAudio(records) { this.audioSyncs.push(Array.from(records)); }

  syncVideo(records) { this.videoSyncs.push(Array.from(records)); }

  syncCharacter(records) { this.characterSyncs.push(Array.from(records)); }

  syncSkeleton(id, joints) { this.skeletonSyncs.push({ id, joints }); }

  setActive(active) { this.activeStates.push(active); }

  tick() {
    return this.commandBatches.shift() || [];
  }

  sync(records) {
    this.syncs.push(Array.from(records));
  }

  syncBodies(records) {
    this.bodySyncs.push(Array.from(records));
  }

  dispatch(type, id, payload) {
    this.dispatched.push({ type, id, payload });
  }

  setInput(state) {
    this.inputs.push(state);
  }

  dump() {
    return { objects: [], warnings: [], errors: [] };
  }
}

export async function makeConsumer(options = {}) {
  const rapier = options.physics === false ? null : await initRapier();
  const consumer = new SpatialConsumer({ rapier, ...options });
  await consumer.init();
  const core = options.core || new RecordingCore();
  consumer.setCore(core);
  return { consumer, core };
}

let uuidCounter = 0;
/** Every real `geometry`/`material` command carries a uuid, so the helpers do too. */
function nextUuid(prefix) {
  uuidCounter += 1;
  return `${prefix}-${uuidCounter}`;
}

/** Vertex data for a unit box, enough for buffer and collider assertions. */
export function boxGeometryCommand(id, width = 0.2, height = 0.2, depth = 0.2, uuid = null) {
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;
  const corners = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const positions = new Float32Array(corners.flat());
  const normals = new Float32Array(corners.map(([x, y, z]) => {
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
  }).flat());
  const uvs = new Float32Array(corners.length * 2);
  // Outward-facing winding, so front-side raycasts behave like a real BoxGeometry.
  const indices = new Uint32Array([
    4, 5, 6, 4, 6, 7,   // +Z
    1, 0, 3, 1, 3, 2,   // -Z
    1, 2, 6, 1, 6, 5,   // +X
    0, 4, 7, 0, 7, 3,   // -X
    2, 3, 7, 2, 7, 6,   // +Y
    0, 1, 5, 0, 5, 4,   // -Y
  ]);
  return ['geometry', id,
    {
      type: 'BoxGeometry',
      parameters: { width, height, depth, widthSegments: 1, heightSegments: 1, depthSegments: 1 },
      uuid: uuid || nextUuid('geometry'),
    },
    positions, normals, uvs, indices];
}

export function standardMaterialCommand(id, overrides = {}) {
  return ['material', id, {
    type: 'MeshStandardMaterial',
    uuid: overrides.uuid || nextUuid('material'),
    color: [1, 1, 1],
    opacity: 1,
    transparent: false,
    side: 0,
    wireframe: false,
    metalness: 0,
    roughness: 1,
    emissive: [0, 0, 0],
    emissiveIntensity: 1,
    clearcoat: 0,
    clearcoatRoughness: 0,
    depthWrite: true,
    depthTest: true,
    blending: 1,
    maps: { map: null, normalMap: null, roughnessMap: null, metalnessMap: null, emissiveMap: null },
    ...overrides,
  }];
}

export function rigidBodyCommand(id, overrides = {}) {
  return ['rigidBody', id, {
    type: 'dynamic',
    mass: 1,
    shape: 'box',
    requestedShape: 'auto',
    friction: 0.5,
    restitution: 0.2,
    linearDamping: 0,
    angularDamping: 0,
    isTrigger: false,
    gravity: true,
    ...overrides,
  }];
}

export function transformCommand(id, position = [0, 0, 0], quaternion = [0, 0, 0, 1], scale = [1, 1, 1]) {
  return ['transform', id, ...position, ...quaternion, ...scale];
}

/** Packs `[{id, position, quaternion, scale}]` into one batched `transforms` command. */
export function transformsCommand(records) {
  const buffer = new Float32Array(records.length * 11);
  records.forEach((record, i) => {
    const o = i * 11;
    const p = record.position || [0, 0, 0];
    const q = record.quaternion || [0, 0, 0, 1];
    const s = record.scale || [1, 1, 1];
    buffer[o] = record.id;
    buffer[o + 1] = p[0]; buffer[o + 2] = p[1]; buffer[o + 3] = p[2];
    buffer[o + 4] = q[0]; buffer[o + 5] = q[1]; buffer[o + 6] = q[2]; buffer[o + 7] = q[3];
    buffer[o + 8] = s[0]; buffer[o + 9] = s[1]; buffer[o + 10] = s[2];
  });
  return ['transforms', 0, buffer];
}
