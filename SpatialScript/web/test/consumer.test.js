import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CAMERA_PRESETS } from '../src/consumer.js';
import {
  makeConsumer, RecordingCore, boxGeometryCommand, standardMaterialCommand,
  rigidBodyCommand, transformCommand, transformsCommand,
} from './helpers.mjs';

// --------------------------------------------------------------- scene graph

test('create, parent and name build the three.js hierarchy', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'root'],
    ['create', 2, 'mesh', 'cube'],
    ['parent', 1, 0],
    ['parent', 2, 1],
    transformCommand(2, [0.1, 0.2, 0.3]),
    ['name', 2, 'renamed'],
  ]);

  const group = consumer.objects.get(1);
  const mesh = consumer.objects.get(2);
  assert.equal(group.parent, consumer.root);
  assert.equal(mesh.parent, group);
  assert.equal(mesh.name, 'renamed');
  assert.deepEqual(mesh.position.toArray(), [0.1, 0.2, 0.3]);
  // The transform is local; parenting keeps it.
  assert.deepEqual(mesh.getWorldPosition(new THREE.Vector3()).toArray(), [0.1, 0.2, 0.3]);
});

test('objects stay detached until a parent command arrives', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['create', 1, 'mesh', 'orphan']]);
  assert.equal(consumer.objects.get(1).parent, null);
  consumer.apply([['parent', 1, 0]]);
  assert.equal(consumer.objects.get(1).parent, consumer.root);
  consumer.apply([['parent', 1, -1]]);
  assert.equal(consumer.objects.get(1).parent, null, 'parentId -1 detaches without destroying');
  assert.ok(consumer.objects.has(1));
});

test('destroy removes the object and its consumer-side state', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'cube'], ['parent', 1, 0],
    boxGeometryCommand(1), standardMaterialCommand(1), rigidBodyCommand(1),
    ['interactive', 1, { tap: true, hover: false, drag: false }],
  ]);
  assert.ok(consumer.physics.bodies.has(1));
  consumer.apply([['destroy', 1]]);
  assert.equal(consumer.objects.get(1), undefined);
  assert.equal(consumer.physics.bodies.has(1), false);
  assert.equal(consumer.interactive.get(1), undefined);
  assert.equal(consumer.root.children.length, 0);
});

test('every create kind maps to a three.js object', async () => {
  const { consumer } = await makeConsumer();
  const kinds = [
    ['group', 'Group'], ['mesh', 'Mesh'], ['text', 'Mesh'],
    ['ambientLight', 'AmbientLight'], ['directionalLight', 'DirectionalLight'],
    ['pointLight', 'PointLight'], ['spotLight', 'SpotLight'],
    ['particles', 'Group'], ['anchor', 'Group'], ['portal', 'Mesh'], ['asset', 'Group'],
  ];
  kinds.forEach(([kind], i) => consumer.apply([['create', i + 1, kind, kind]]));
  kinds.forEach(([, type], i) => assert.equal(consumer.objects.get(i + 1).type, type, `kind ${kinds[i][0]}`));
  assert.deepEqual(consumer.warnings, [], 'no kind should warn');
});

test('an unknown opcode warns once instead of throwing', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['nonsense', 1, 2], ['nonsense', 1, 3]]);
  assert.equal(consumer.warnings.length, 1);
  assert.match(consumer.warnings[0], /unknown command opcode "nonsense"/);
});

// ------------------------------------------------------------------ geometry

test('geometry builds a BufferGeometry from the typed arrays', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['create', 1, 'mesh', 'cube'], ['parent', 1, 0], boxGeometryCommand(1, 0.4, 0.2, 0.1)]);
  const geometry = consumer.objects.get(1).geometry;
  assert.equal(geometry.getAttribute('position').count, 8);
  assert.equal(geometry.getAttribute('normal').count, 8);
  assert.equal(geometry.getAttribute('uv').count, 8);
  assert.equal(geometry.index.count, 36);
  assert.ok(geometry.boundingBox, 'bounding box is computed');
  assert.equal(consumer.objects.get(1).userData.__spatialGeometry.type, 'BoxGeometry');
});

test('geometry without normals computes them', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'tri'], ['parent', 1, 0],
    ['geometry', 1, { type: 'BufferGeometry', parameters: {} },
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), null, null, null],
  ]);
  const normal = consumer.objects.get(1).geometry.getAttribute('normal');
  assert.equal(normal.count, 3);
  assert.deepEqual([normal.getX(0), normal.getY(0), normal.getZ(0)], [0, 0, 1]);
});

test('TextGeometry buffers are used verbatim', async () => {
  const { consumer } = await makeConsumer();
  const positions = new Float32Array([0, 0, 0, 0.1, 0, 0, 0.1, 0.1, 0]);
  consumer.apply([
    ['create', 1, 'mesh', 'label'], ['parent', 1, 0],
    ['geometry', 1, { type: 'TextGeometry', parameters: { text: 'hi', size: 0.1, depth: 0.01, font: 'default' } },
      positions, null, null, null],
  ]);
  assert.equal(consumer.objects.get(1).geometry.getAttribute('position').count, 3);
  assert.equal(consumer.objects.get(1).userData.__spatialGeometry.parameters.text, 'hi');
});

// ----------------------------------------------------------------- materials

test('material types map one to one and colours stay linear', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0],
    standardMaterialCommand(1, { color: [0.25, 0.5, 0.75], metalness: 0.3, roughness: 0.4, side: 2, transparent: true, opacity: 0.5 }),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0],
    standardMaterialCommand(2, { type: 'MeshBasicMaterial' }),
    ['create', 3, 'mesh', 'c'], ['parent', 3, 0],
    standardMaterialCommand(3, { type: 'MeshPhysicalMaterial', clearcoat: 0.8, clearcoatRoughness: 0.2 }),
    ['create', 4, 'mesh', 'd'], ['parent', 4, 0],
    standardMaterialCommand(4, { type: 'OcclusionMaterial' }),
  ]);
  const a = consumer.objects.get(1).material;
  assert.equal(a.type, 'MeshStandardMaterial');
  assert.equal(a.metalness, 0.3);
  assert.equal(a.roughness, 0.4);
  assert.equal(a.side, THREE.DoubleSide);
  assert.equal(a.transparent, true);
  assert.equal(a.opacity, 0.5);
  assert.ok(Math.abs(a.color.r - 0.25) < 1e-6 && Math.abs(a.color.b - 0.75) < 1e-6, 'linear colour is not re-encoded');

  assert.equal(consumer.objects.get(2).material.type, 'MeshBasicMaterial');
  assert.equal(consumer.objects.get(3).material.clearcoat, 0.8);
  assert.equal(consumer.objects.get(4).material.colorWrite, false, 'OcclusionMaterial is depth-only');
});

test('WEB-18: textures bind per colour space without clobbering each other', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0],
    ['texture', 7, { url: 'asset://checker.png', repeat: [2, 3], offset: [0.1, 0.2], wrapS: 1000, wrapT: 1001, flipY: false }],
    standardMaterialCommand(1, { maps: { map: 7, normalMap: 7, roughnessMap: null, metalnessMap: null, emissiveMap: null } }),
  ]);
  const entry = consumer.textures.get(7);
  assert.deepEqual(entry.texture.repeat.toArray(), [2, 3]);
  assert.deepEqual(entry.texture.offset.toArray(), [0.1, 0.2]);
  assert.equal(entry.texture.wrapS, THREE.RepeatWrapping);
  assert.equal(entry.texture.wrapT, THREE.ClampToEdgeWrapping);
  assert.equal(entry.texture.flipY, false);
  const material = consumer.objects.get(1).material;
  // The base map wants sRGB and the normal map wants linear, so the two bindings
  // are separate views over the same image (WEB-18).
  assert.equal(material.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(material.normalMap.colorSpace, THREE.NoColorSpace);
  assert.notEqual(material.map, material.normalMap);
  assert.ok([material.map, material.normalMap].includes(entry.texture));
});

test('asset:// and relative texture urls resolve against their roots', async () => {
  const { consumer } = await makeConsumer({ assetRoot: '/assets' });
  assert.equal(consumer.resolveUrl('asset://wood.png'), '/assets/wood.png');
  assert.equal(consumer.resolveUrl('textures/wood.png'), '/assets/textures/wood.png');
  assert.equal(consumer.resolveUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(consumer.resolveUrl('/absolute.png'), '/absolute.png');
});

// -------------------------------------------------------------------- lights

test('light commands set three.js lights and aim the target along the world direction', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'directionalLight', 'sun'], ['parent', 1, 0], transformCommand(1, [1, 2, 1]),
    ['light', 1, { type: 'directional', color: [1, 0.5, 0.25], intensity: 3, distance: 0, decay: 2, angle: 0, penumbra: 0, castShadow: true, direction: [0, -1, 0] }],
    ['create', 2, 'spotLight', 'spot'], ['parent', 2, 0], transformCommand(2, [0, 1, 0]),
    ['light', 2, { type: 'spot', color: [1, 1, 1], intensity: 5, distance: 4, decay: 2, angle: 0.5, penumbra: 0.3, castShadow: false, direction: [1, 0, 0] }],
    ['create', 3, 'pointLight', 'point'], ['parent', 3, 0],
    ['light', 3, { type: 'point', color: [1, 1, 1], intensity: 2, distance: 3, decay: 1.5, angle: 0, penumbra: 0, castShadow: false, direction: null }],
  ]);
  consumer.updateVisuals(1 / 60);

  const sun = consumer.objects.get(1);
  assert.equal(sun.intensity, 3);
  assert.equal(sun.castShadow, true);
  assert.ok(Math.abs(sun.color.g - 0.5) < 1e-6);
  // Target one metre down from the light's world position.
  assert.deepEqual(sun.target.position.toArray(), [1, 1, 1]);

  const spot = consumer.objects.get(2);
  assert.equal(spot.angle, 0.5);
  assert.equal(spot.penumbra, 0.3);
  assert.equal(spot.distance, 4);
  assert.deepEqual(spot.target.position.toArray(), [1, 1, 0]);

  const point = consumer.objects.get(3);
  assert.equal(point.decay, 1.5);
  assert.equal(point.distance, 3);
});

test('a scene with no lights warns and gets no fallback lighting', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['create', 1, 'mesh', 'cube'], ['parent', 1, 0]]);
  consumer.updateVisuals(1 / 60);
  // The macOS host adds nothing either, so neither does the consumer: a scene with
  // no lights must look the same on both backends.
  assert.equal(consumer.scene.children.filter((o) => o.isLight).length, 0);
  assert.deepEqual(consumer.warnings, ['the scene has no lights; meshes with lit materials render black']);
  assert.ok(consumer.dump().warnings.includes('the scene has no lights; meshes with lit materials render black'));

  consumer.updateVisuals(1 / 60);
  assert.equal(consumer.warnings.length, 1, 'warned once');

  consumer.apply([['create', 2, 'ambientLight', ''], ['parent', 2, 0]]);
  consumer.updateVisuals(1 / 60);
  assert.equal(consumer.warnings.length, 1, 'and not again once the script adds one');
});

// ---------------------------------------------- opacity, billboard, ordering

test('opacity multiplies down the hierarchy without touching material opacity', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'parent'], ['parent', 1, 0],
    ['create', 2, 'mesh', 'child'], ['parent', 2, 1],
    standardMaterialCommand(2, { opacity: 0.5, transparent: true }),
    ['opacity', 1, 0.5], ['opacity', 2, 0.5],
  ]);
  const material = consumer.objects.get(2).material;
  assert.equal(material.userData.__baseOpacity, 0.5, 'the material keeps its own opacity');
  assert.ok(Math.abs(material.opacity - 0.125) < 1e-6, '0.5 material * 0.5 parent * 0.5 own');
  assert.equal(material.transparent, true);
});

test('opacity below one forces transparency on an opaque material', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0],
    standardMaterialCommand(1), ['opacity', 1, 0.4],
  ]);
  const material = consumer.objects.get(1).material;
  assert.equal(material.transparent, true);
  assert.ok(Math.abs(material.opacity - 0.4) < 1e-6);
});

test('billboard copies the camera orientation into the object local frame', async () => {
  const { consumer } = await makeConsumer();
  consumer.setCameraPosition(0, 0, 1.2);
  consumer.apply([
    ['create', 1, 'group', 'holder'], ['parent', 1, 0],
    transformCommand(1, [0, 0, 0], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).toArray()),
    ['create', 2, 'mesh', 'card'], ['parent', 2, 1], ['billboard', 2, true],
  ]);
  consumer.updateVisuals(1 / 60);
  const world = consumer.objects.get(2).getWorldQuaternion(new THREE.Quaternion());
  const camera = consumer.camera.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(Math.abs(Math.abs(world.dot(camera)) - 1) < 1e-6, 'world orientation matches the camera');
});

test('renderOrder, hoverEffect and groundingShadow are handled', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0],
    ['renderOrder', 1, 3], ['hoverEffect', 1, 'highlight'],
    ['groundingShadow', 1, true], ['groundingShadow', 1, true],
    ['shadow', 1, true, true],
  ]);
  const mesh = consumer.objects.get(1);
  assert.equal(mesh.renderOrder, 3);
  assert.equal(mesh.userData.__hoverEffect, 'highlight', 'hoverEffect is accepted silently');
  assert.equal(mesh.castShadow, true);
  assert.equal(mesh.receiveShadow, true);
  const grounding = consumer.warnings.filter((w) => w.includes('groundingShadow'));
  assert.equal(grounding.length, 1, 'groundingShadow warns exactly once');
});

// ------------------------------------------------------------------- physics

test('rigidBody creates a Rapier body and collider with the requested shape', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'cube'], ['parent', 1, 0], transformCommand(1, [0, 1, 0]),
    boxGeometryCommand(1, 0.2, 0.2, 0.2), standardMaterialCommand(1),
    rigidBodyCommand(1, { mass: 2, friction: 0.9, restitution: 0.1 }),
  ]);
  const entry = consumer.physics.bodies.get(1);
  assert.ok(entry, 'a body exists');
  assert.equal(entry.body.isDynamic(), true);
  assert.ok(Math.abs(entry.collider.friction() - 0.9) < 1e-6);
  assert.ok(Math.abs(entry.collider.restitution() - 0.1) < 1e-6);
  const half = entry.collider.halfExtents();
  assert.ok(Math.abs(half.x - 0.1) < 1e-6 && Math.abs(half.y - 0.1) < 1e-6);
  const translation = entry.body.translation();
  assert.ok(Math.abs(translation.y - 1) < 1e-6, 'the body starts at the world transform');
});

test('static and kinematic bodies are created with the matching Rapier type', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'floor'], ['parent', 1, 0], boxGeometryCommand(1, 1, 0.05, 1),
    rigidBodyCommand(1, { type: 'static' }),
    ['create', 2, 'mesh', 'lift'], ['parent', 2, 0], boxGeometryCommand(2),
    rigidBodyCommand(2, { type: 'kinematic' }),
  ]);
  assert.equal(consumer.physics.bodies.get(1).body.isFixed(), true);
  assert.equal(consumer.physics.bodies.get(2).body.isKinematic(), true);
  assert.equal(consumer.physics.isDynamic(1), false);
});

test('MAINT-03: the consumer uses the shape the core resolved, with no table of its own', async () => {
  const { consumer } = await makeConsumer();
  const positions = new Float32Array([0.1, 0, 0, -0.1, 0, 0, 0, 0.1, 0, 0, -0.1, 0, 0, 0, 0.1, 0, 0, -0.1]);
  consumer.apply([
    ['create', 1, 'mesh', 'ball'], ['parent', 1, 0],
    ['geometry', 1, { type: 'SphereGeometry', parameters: { radius: 0.15 }, uuid: 'geo-ball' }, positions, null, null, null],
    // The core resolves "auto" before it sends the body (SPEC 3.7).
    rigidBodyCommand(1, { shape: 'sphere', requestedShape: 'auto' }),
    ['create', 2, 'mesh', 'pill'], ['parent', 2, 0],
    ['geometry', 2, { type: 'CapsuleGeometry', parameters: { radius: 0.05, height: 0.2 }, uuid: 'geo-pill' }, positions, null, null, null],
    rigidBodyCommand(2, { shape: 'capsule', requestedShape: 'auto' }),
  ]);
  assert.ok(Math.abs(consumer.physics.bodies.get(1).collider.radius() - 0.15) < 1e-6);
  const capsule = consumer.physics.bodies.get(2).collider;
  assert.ok(Math.abs(capsule.radius() - 0.05) < 1e-6);
  assert.ok(Math.abs(capsule.halfHeight() - 0.1) < 1e-6);
  assert.deepEqual(consumer.warnings, []);

  // An unresolved shape is a protocol break, so it warns rather than guessing.
  consumer.apply([
    ['create', 3, 'mesh', 'blob'], ['parent', 3, 0], boxGeometryCommand(3),
    rigidBodyCommand(3, { shape: 'auto' }),
  ]);
  assert.ok(consumer.physics.bodies.has(3));
  assert.equal(consumer.warnings.filter((w) => w.includes('unresolved shape')).length, 1);
});

test('a mesh shape on a dynamic body falls back to convex and warns', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'blob'], ['parent', 1, 0], boxGeometryCommand(1),
    rigidBodyCommand(1, { shape: 'mesh' }),
  ]);
  assert.ok(consumer.physics.bodies.has(1));
  assert.ok(consumer.warnings.some((w) => w.includes('static-only')));
});

test('a transform on a dynamic body teleports it and zeroes its velocity', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'cube'], ['parent', 1, 0], boxGeometryCommand(1),
    rigidBodyCommand(1),
    ['bodyVelocity', 1, 0, 5, 0, null, null, null],
  ]);
  const body = consumer.physics.bodies.get(1).body;
  assert.ok(Math.abs(body.linvel().y - 5) < 1e-6);

  consumer.apply([transformCommand(1, [0.5, 0.6, 0.7])]);
  assert.deepEqual(
    [body.translation().x, body.translation().y, body.translation().z].map((n) => +n.toFixed(6)),
    [0.5, 0.6, 0.7],
  );
  assert.deepEqual(
    [body.linvel().x, body.linvel().y, body.linvel().z, body.angvel().x],
    [0, 0, 0, 0],
    'teleporting zeroes the velocities',
  );
});

test('impulse, force and torque reach the body', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'cube'], ['parent', 1, 0], boxGeometryCommand(1), rigidBodyCommand(1),
    ['bodyImpulse', 1, 0, 1, 0, null, null, null],
    ['bodyTorque', 1, 0, 0, 0.05],
  ]);
  const body = consumer.physics.bodies.get(1).body;
  assert.ok(body.linvel().y > 0, 'an impulse produces linear velocity');
  consumer.physics.step(1 / 60);
  assert.ok(Math.abs(body.angvel().z) > 0, 'a torque produces angular velocity');
});

test('gravity is applied to the world', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['gravity', 0, 0, -5, 0]]);
  assert.equal(consumer.physics.world.gravity.y, -5);
});

test('joints of every type are created', async () => {
  const { consumer } = await makeConsumer();
  const bodies = [];
  for (let id = 1; id <= 2; id++) {
    bodies.push(
      ['create', id, 'mesh', `b${id}`], ['parent', id, 0],
      transformCommand(id, [id * 0.3, 0, 0]),
      boxGeometryCommand(id), rigidBodyCommand(id, { type: id === 1 ? 'static' : 'dynamic' }),
    );
  }
  consumer.apply(bodies);
  const types = ['fixed', 'revolute', 'spherical', 'prismatic', 'distance'];
  types.forEach((type, i) => {
    consumer.apply([['joint', 100 + i, {
      type, bodyA: 1, bodyB: 2, anchorA: [0, 0, 0], anchorB: [0, 0.1, 0], axis: [0, 1, 0],
      limits: type === 'revolute' || type === 'prismatic' || type === 'distance' ? [-1, 1] : null,
    }]]);
  });
  assert.equal(consumer.physics.joints.size, types.length);
  consumer.apply([['joint', 100, null]]);
  assert.equal(consumer.physics.joints.size, types.length - 1);
});

test('a dropped body lands on a static floor and syncs back to the core', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.apply([
    ['create', 1, 'mesh', 'floor'], ['parent', 1, 0], transformCommand(1, [0, -0.3, 0]),
    boxGeometryCommand(1, 2, 0.1, 2), rigidBodyCommand(1, { type: 'static' }),
    ['create', 2, 'mesh', 'ball'], ['parent', 2, 0], transformCommand(2, [0, 0.4, 0]),
    boxGeometryCommand(2, 0.2, 0.2, 0.2), rigidBodyCommand(2, { restitution: 0 }),
  ]);
  const start = consumer.physics.bodies.get(2).body.translation().y;
  for (let i = 0; i < 180; i++) consumer.tick(1 / 60);
  const end = consumer.physics.bodies.get(2).body.translation().y;
  assert.ok(end < start, 'the body fell');
  // Floor top is -0.25, half extent 0.1, so it rests near -0.15.
  assert.ok(Math.abs(end - -0.15) < 0.02, `came to rest on the floor (y=${end})`);

  const lastSync = core.syncs.at(-1);
  assert.equal(lastSync.length, 11, 'only the dynamic body is synced');
  assert.equal(lastSync[0], 2);
  assert.ok(Math.abs(lastSync[2] - end) < 1e-3);
  const lastBodies = core.bodySyncs.at(-1);
  assert.equal(lastBodies.length, 16, 'both bodies report velocity records');
});

test('collision events convert to core dispatches once per pair', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.apply([
    ['create', 1, 'mesh', 'floor'], ['parent', 1, 0], transformCommand(1, [0, -0.3, 0]),
    boxGeometryCommand(1, 2, 0.1, 2), rigidBodyCommand(1, { type: 'static' }),
    ['create', 2, 'mesh', 'ball'], ['parent', 2, 0], transformCommand(2, [0, 0.1, 0]),
    boxGeometryCommand(2, 0.2, 0.2, 0.2), rigidBodyCommand(2, { restitution: 0 }),
  ]);
  for (let i = 0; i < 60; i++) consumer.tick(1 / 60);

  const starts = core.dispatched.filter((d) => d.type === 'collisionstart');
  assert.ok(starts.length >= 1, 'a collisionstart was dispatched');
  // The core mirrors the event onto the other object itself.
  assert.equal(starts.length, 1, 'exactly one dispatch per collision pair');
  const event = starts[0];
  assert.ok(event.id === 1 || event.id === 2);
  assert.equal(typeof event.payload.other, 'number');
  assert.notEqual(event.payload.other, event.id);
  assert.equal(event.payload.point.length, 3);
  assert.equal(event.payload.normal.length, 3);
  assert.equal(typeof event.payload.impulse, 'number');
});

// ------------------------------------------------------------- input, dumps

test('input state is pushed to the core every tick with no hands', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.input.injectKey('KeyW', true);
  consumer.tick(1 / 60);
  const first = core.inputs[0];
  assert.deepEqual(first.keyboard.down, ['KeyW']);
  assert.deepEqual(first.keyboard.pressed, ['KeyW']);
  assert.deepEqual(first.hands, { left: null, right: null });
  assert.equal(first.mouse.position, null);

  consumer.tick(1 / 60);
  assert.deepEqual(core.inputs[1].keyboard.pressed, [], 'wasPressed lasts one frame');
  assert.deepEqual(core.inputs[1].keyboard.down, ['KeyW']);
});

test('interactive flags drive the hit-test ancestor lookup', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'holder'], ['parent', 1, 0],
    ['create', 2, 'mesh', 'child'], ['parent', 2, 1], boxGeometryCommand(2),
    ['interactive', 1, { tap: true, hover: false, drag: true }],
  ]);
  const child = consumer.objects.get(2);
  assert.equal(consumer.interactiveAncestor(child, 'tap'), consumer.objects.get(1));
  assert.equal(consumer.interactiveAncestor(child, 'hover'), null);
});

test('raycast returns flat sorted records for __spatialNative.raycast', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'near'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]), boxGeometryCommand(1, 0.4, 0.4, 0.4),
    ['create', 2, 'mesh', 'far'], ['parent', 2, 0], transformCommand(2, [0, 0, -1]), boxGeometryCommand(2, 0.4, 0.4, 0.4),
  ]);
  consumer.root.updateMatrixWorld(true);
  const hits = consumer.raycast(0, 0, 2, 0, 0, -1, Infinity);
  assert.equal(hits.length, 16, 'one record per object');
  assert.equal(hits[0], 1, 'the nearest object comes first');
  assert.ok(Math.abs(hits[7] - 1.8) < 1e-6);
  assert.deepEqual(hits.slice(4, 7), [0, 0, 1], 'the normal is in world space');
  assert.equal(hits[8], 2);
  assert.ok(hits[7] < hits[15], 'records are sorted by distance');

  const limited = consumer.raycast(0, 0, 2, 0, 0, -1, 2);
  assert.equal(limited.length, 8, 'maxDistance is honoured');
});

// --------------------------------------------------- particles, anchors, env

test('particle emitters honour the command fields and presets', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'particles', 'fx'], ['parent', 1, 0],
    ['particles', 1, {
      preset: null, shape: 'sphere', shapeSize: [0.2, 0.2, 0.2], birthRate: 120, lifetime: 2,
      lifetimeVariation: 0, speed: 0.5, speedVariation: 0, size: 0.02, sizeVariation: 0,
      color: [1, 0, 0], colorEnd: [0, 0, 1], opacity: 1, opacityEnd: 0, spreadAngle: 1,
      acceleration: [0, -2, 0], isEmitting: true, burstCount: 5, loops: true, texture: null,
    }],
  ]);
  const emitter = consumer.emitters.get(1);
  assert.equal(emitter.config.birthRate, 120);
  assert.equal(emitter.config.shape, 'sphere');
  assert.ok(Math.abs(emitter.colorStart.r - 1) < 1e-6 && Math.abs(emitter.colorStart.b) < 1e-6);
  assert.ok(emitter.colorFinish);

  emitter.update(0.5);
  assert.ok(emitter.count > 0, 'particles are emitted');
  const emitted = emitter.count;
  consumer.apply([['particlesBurst', 1]]);
  assert.equal(emitter.count, emitted + 5, 'burst adds burstCount particles');

  consumer.apply([['particles', 1, { preset: 'sparks', isEmitting: false }]]);
  assert.equal(emitter.config.isEmitting, false, 'a preset does not override isEmitting');
  // sparks sprays in every direction, as the RealityKit preset does.
  assert.equal(emitter.config.spreadAngle, Math.PI, 'preset values replace the defaults');
  assert.equal(emitter.config.birthRate, 500);
});

test('a head anchor parents its content to the camera; other anchors stay plain groups', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'anchor', 'head'], ['parent', 1, 0], ['anchor', 1, { kind: 'head' }],
    ['create', 2, 'anchor', 'table'], ['parent', 2, 0],
    ['anchor', 2, { kind: 'plane', plane: 'horizontal', minimumBounds: [0.2, 0.2] }],
  ]);
  assert.equal(consumer.objects.get(1).parent, consumer.camera);
  assert.equal(consumer.objects.get(2).parent, consumer.root);
});

test('portals take over the mesh surface and hide their world group', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'world'], ['parent', 1, 0],
    ['create', 2, 'portal', 'portal'], ['parent', 2, 0],
    boxGeometryCommand(2), standardMaterialCommand(2),
    ['world', 1, true],
    ['portal', 2, { worldId: 1, width: 0.5, height: 0.4, crossing: false }],
  ]);
  const portal = consumer.portals.get(2);
  assert.ok(portal, 'a portal was registered');
  assert.equal(consumer.objects.get(2).geometry.parameters.width, 0.5);
  assert.equal(consumer.objects.get(2).material, portal.material);
  assert.ok(consumer.worldGroups.has(1));

  // A later geometry or material command must not clobber the portal surface.
  consumer.apply([boxGeometryCommand(2), standardMaterialCommand(2)]);
  assert.equal(consumer.objects.get(2).material, portal.material);
});

test('environment sets an equirectangular scene environment and intensity', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['environment', 0, { url: 'asset://studio.png', intensity: 1.5 }]]);
  assert.ok(consumer.scene.environment);
  assert.equal(consumer.scene.environment.mapping, THREE.EquirectangularReflectionMapping);
  assert.equal(consumer.scene.environmentIntensity, 1.5);
  consumer.apply([['environment', 0, null]]);
  assert.equal(consumer.scene.environment, null);
});

test('log commands are recorded without becoming scene errors', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['log', 0, 'warn', 'careful'], ['log', 0, 'error', 'an error line']]);
  assert.deepEqual(consumer.logs.map((l) => `${l.level}: ${l.message}`),
    ['warn: careful', 'error: an error line']);
  // A script's own console.error is a log line, not a scene error.
  assert.deepEqual(consumer.dump().errors, []);
});

test('a full command batch applies in order without errors', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'g'], ['parent', 1, 0], transformCommand(1, [0, 0.1, 0]),
    ['create', 2, 'mesh', 'cube'], ['parent', 2, 1], transformCommand(2),
    boxGeometryCommand(2), standardMaterialCommand(2),
    ['shadow', 2, true, false], ['opacity', 2, 0.8], ['billboard', 2, true],
    ['manipulable', 2, true], ['renderOrder', 2, 2],
    ['interactive', 2, { tap: true, hover: false, drag: true }],
    rigidBodyCommand(2),
    ['create', 3, 'directionalLight', ''], ['parent', 3, 0], transformCommand(3, [1, 2, 1]),
    ['light', 3, { type: 'directional', color: [1, 1, 1], intensity: 3, distance: 0, decay: 2, angle: 0, penumbra: 0, castShadow: true, direction: [-0.4, -0.8, -0.4] }],
    ['gravity', 0, 0, -9.81, 0],
  ]);
  assert.deepEqual(consumer.errors, []);
  assert.deepEqual(consumer.warnings, []);
  assert.equal(consumer.objects.size, 3);
  assert.ok(consumer.manipulable.has(2));
  assert.ok(consumer.billboards.has(2));
});

// ------------------------------------------------- batched transforms (SPEC 5)

test('transforms applies every packed record and matches the single-object opcode', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0],
    ['create', 2, 'group', 'holder'], ['parent', 2, 0],
    ['create', 3, 'mesh', 'b'], ['parent', 3, 2],
  ]);
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5).toArray();
  consumer.apply([transformsCommand([
    { id: 1, position: [0.1, 0.2, 0.3], quaternion, scale: [2, 2, 2] },
    { id: 2, position: [0, 1, 0] },
    { id: 3, position: [0.5, 0, 0] },
  ])]);

  const a = consumer.objects.get(1);
  assert.deepEqual(a.position.toArray().map((n) => +n.toFixed(4)), [0.1, 0.2, 0.3]);
  assert.deepEqual(a.scale.toArray(), [2, 2, 2]);
  assert.ok(Math.abs(a.quaternion.y - quaternion[1]) < 1e-6);
  // The records are local TRS, so the child stays relative to its parent.
  assert.deepEqual(
    consumer.objects.get(3).getWorldPosition(new THREE.Vector3()).toArray().map((n) => +n.toFixed(4)),
    [0.5, 1, 0],
  );

  // The same values through the per-object opcode must land in the same place,
  // within the precision the float32 records carry.
  const { consumer: other } = await makeConsumer();
  other.apply([['create', 1, 'mesh', 'a'], ['parent', 1, 0]]);
  other.apply([transformCommand(1, [0.1, 0.2, 0.3], quaternion, [2, 2, 2])]);
  other.objects.get(1).matrix.elements.forEach((value, i) => {
    assert.ok(Math.abs(value - a.matrix.elements[i]) < 1e-6, `matrix element ${i}`);
  });
});

test('transforms skips unknown ids and a truncated trailing record', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['create', 1, 'mesh', 'a'], ['parent', 1, 0]]);
  const command = transformsCommand([
    { id: 99, position: [9, 9, 9] },
    { id: 1, position: [0.4, 0, 0] },
  ]);
  // A short tail must not throw or corrupt the records before it.
  const truncated = ['transforms', 0, command[2].subarray(0, 11 * 2 + 5)];
  consumer.apply([truncated]);
  assert.deepEqual(consumer.objects.get(1).position.toArray().map((n) => +n.toFixed(4)), [0.4, 0, 0]);
  assert.deepEqual(consumer.errors, []);

  consumer.apply([['transforms', 0, new Float32Array(0)], ['transforms', 0, null]]);
  assert.deepEqual(consumer.errors, []);
});

test('a transforms record teleports a dynamic body and zeroes its velocity', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'cube'], ['parent', 1, 0], boxGeometryCommand(1), rigidBodyCommand(1),
    ['bodyVelocity', 1, 0, 5, 0, null, null, null],
  ]);
  const body = consumer.physics.bodies.get(1).body;
  assert.ok(Math.abs(body.linvel().y - 5) < 1e-6);

  consumer.apply([transformsCommand([{ id: 1, position: [0.5, 0.6, 0.7] }])]);
  assert.deepEqual(
    [body.translation().x, body.translation().y, body.translation().z].map((n) => +n.toFixed(5)),
    [0.5, 0.6, 0.7],
  );
  assert.deepEqual([body.linvel().x, body.linvel().y, body.linvel().z], [0, 0, 0]);
});

test('the consumer does not retain the transforms buffer between frames', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['create', 1, 'mesh', 'a'], ['parent', 1, 0]]);
  // The core reuses one buffer, so overwriting it after the call must change nothing.
  const command = transformsCommand([{ id: 1, position: [0.25, 0, 0] }]);
  consumer.apply([command]);
  command[2].fill(0);
  assert.deepEqual(consumer.objects.get(1).position.toArray().map((n) => +n.toFixed(4)), [0.25, 0, 0]);
});

// ------------------------------------------- shared geometries and materials

test('meshes sharing a geometry uuid share one BufferGeometry', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'geo-shared';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], boxGeometryCommand(1, 0.2, 0.2, 0.2, shared),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], boxGeometryCommand(2, 0.2, 0.2, 0.2, shared),
    ['create', 3, 'mesh', 'c'], ['parent', 3, 0], boxGeometryCommand(3, 0.1, 0.1, 0.1, 'geo-other'),
  ]);
  assert.equal(consumer.objects.get(1).geometry, consumer.objects.get(2).geometry);
  assert.notEqual(consumer.objects.get(1).geometry, consumer.objects.get(3).geometry);
  assert.equal(consumer.geometries.size, 2);
  assert.equal(consumer.geometries.get(shared).users.size, 2);
});

test('new buffers for a known geometry uuid refill the instance every user sees', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'geo-mutating';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], boxGeometryCommand(1, 0.2, 0.2, 0.2, shared),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], boxGeometryCommand(2, 0.2, 0.2, 0.2, shared),
  ]);
  const instance = consumer.objects.get(1).geometry;
  const before = instance.boundingBox.max.x;

  consumer.apply([boxGeometryCommand(1, 0.8, 0.8, 0.8, shared)]);
  assert.equal(consumer.objects.get(1).geometry, instance, 'the instance is kept, not replaced');
  assert.equal(consumer.objects.get(2).geometry, instance);
  assert.ok(instance.boundingBox.max.x > before, 'the shared instance now holds the new buffers');
  assert.equal(consumer.geometries.size, 1);
});

test('a shared geometry is disposed only when its last user goes away', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'geo-refcount';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], boxGeometryCommand(1, 0.2, 0.2, 0.2, shared),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], boxGeometryCommand(2, 0.2, 0.2, 0.2, shared),
  ]);
  const instance = consumer.objects.get(1).geometry;
  let disposals = 0;
  instance.addEventListener('dispose', () => { disposals += 1; });

  consumer.apply([['destroy', 1]]);
  assert.equal(disposals, 0, 'one user left');
  assert.equal(consumer.geometries.get(shared).users.size, 1);

  consumer.apply([['destroy', 2]]);
  assert.equal(disposals, 1, 'the GPU side is freed with the last user');
  // The entry itself is kept: the core will not re-send buffers for a uuid and
  // revision it has already delivered, so a later mesh on the same geometry
  // arrives with null buffers and must find it here.
  assert.equal(consumer.geometries.get(shared).users.size, 0);
  assert.ok(consumer._idleGeometries.has(shared));
});

test('meshes sharing a material uuid share one material, and a change reaches every user', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'mat-shared';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], standardMaterialCommand(1, { uuid: shared, color: [1, 0, 0] }),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], standardMaterialCommand(2, { uuid: shared, color: [1, 0, 0] }),
  ]);
  const instance = consumer.objects.get(1).material;
  assert.equal(consumer.objects.get(2).material, instance);
  assert.equal(consumer.materials.size, 1);

  consumer.apply([standardMaterialCommand(1, { uuid: shared, color: [0, 0, 1], roughness: 0.25 })]);
  assert.equal(consumer.objects.get(1).material, instance, 'updated in place, not replaced');
  assert.equal(consumer.objects.get(2).material, instance);
  assert.ok(Math.abs(instance.color.b - 1) < 1e-6 && Math.abs(instance.color.r) < 1e-6);
  assert.equal(instance.roughness, 0.25);
});

test('a shared material is disposed only when its last user goes away', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'mat-refcount';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], standardMaterialCommand(1, { uuid: shared }),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], standardMaterialCommand(2, { uuid: shared }),
  ]);
  const instance = consumer.objects.get(1).material;
  let disposals = 0;
  instance.addEventListener('dispose', () => { disposals += 1; });

  consumer.apply([['destroy', 1]]);
  assert.equal(disposals, 0);
  consumer.apply([['destroy', 2]]);
  assert.equal(disposals, 1);
  assert.equal(consumer.materials.size, 0);
});

test('opacity clones a shared material for one object and leaves the others alone', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'mat-opacity';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], standardMaterialCommand(1, { uuid: shared }),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], standardMaterialCommand(2, { uuid: shared }),
    ['opacity', 1, 0.5],
  ]);
  const instance = consumer.materials.get(shared).material;
  const faded = consumer.objects.get(1).material;
  assert.notEqual(faded, instance, 'the faded object gets its own material');
  assert.ok(Math.abs(faded.opacity - 0.5) < 1e-6);
  assert.equal(faded.transparent, true);
  assert.equal(consumer.objects.get(2).material, instance, 'the other user is untouched');
  assert.equal(instance.opacity, 1);

  // A change to the shared material must reach the clone too.
  consumer.apply([standardMaterialCommand(1, { uuid: shared, color: [0, 1, 0] })]);
  const refreshed = consumer.objects.get(1).material;
  assert.ok(Math.abs(refreshed.color.g - 1) < 1e-6);
  assert.ok(Math.abs(refreshed.opacity - 0.5) < 1e-6);

  // Back to full opacity, the object returns to the shared instance.
  consumer.apply([['opacity', 1, 1]]);
  assert.equal(consumer.objects.get(1).material, instance);
  assert.equal(consumer.opacityMaterials.size, 0);
});

test('replacing a mesh geometry releases the old shared entry', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-first'),
  ]);
  assert.equal(consumer.geometryOf.get(1).uuid, 'geo-first');
  consumer.apply([boxGeometryCommand(1, 0.3, 0.3, 0.3, 'geo-second')]);
  assert.equal(consumer.geometryOf.get(1).uuid, 'geo-second');
  assert.equal(consumer.geometries.get('geo-first').users.size, 0, 'the old entry has no users');
  assert.ok(consumer._idleGeometries.has('geo-first'));
});

test('a scene of 1500 meshes on one geometry holds one BufferGeometry', async () => {
  const { consumer } = await makeConsumer({ physics: false });
  const shared = 'geo-stress';
  const batch = [];
  for (let id = 1; id <= 1500; id++) {
    batch.push(['create', id, 'mesh', `c${id}`], ['parent', id, 0],
      boxGeometryCommand(id, 0.012, 0.012, 0.012, shared),
      standardMaterialCommand(id, { uuid: `mat-${id}` }));
  }
  consumer.apply(batch);
  assert.equal(consumer.geometries.size, 1);
  assert.equal(consumer.geometries.get(shared).users.size, 1500);
  assert.equal(consumer.materials.size, 1500);
});

// ------------------------------------------------ native dump (parity gate)

test('nativeDump mirrors the Swift dump shape and reads its values off three.js', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'holder'], ['parent', 1, 0], transformCommand(1, [0, 0.1, 0]),
    ['create', 2, 'mesh', 'cube'], ['parent', 2, 1], transformCommand(2, [0.2, 0, 0]),
    boxGeometryCommand(2, 0.2, 0.2, 0.2, 'geo-native'),
    standardMaterialCommand(2, { uuid: 'mat-native', color: [0.25, 0.5, 0.75], metalness: 0.3, roughness: 0.4 }),
    ['shadow', 2, true, false], ['opacity', 2, 0.5], ['billboard', 2, true], ['manipulable', 2, true],
    ['renderOrder', 2, 4], ['hoverEffect', 2, 'highlight'],
    ['interactive', 2, { tap: true, hover: false, drag: true }],
    rigidBodyCommand(2, { type: 'static', shape: 'box' }),
    ['create', 3, 'directionalLight', 'sun'], ['parent', 3, 0], transformCommand(3, [1, 2, 1]),
    ['light', 3, { type: 'directional', color: [1, 1, 1], intensity: 3, distance: 0, decay: 2, angle: 0, penumbra: 0, castShadow: true, direction: [0, -1, 0] }],
    ['gravity', 0, 0, -5, 0],
  ]);
  consumer.updateVisuals(1 / 60);

  const dump = consumer.nativeDump();
  assert.deepEqual(Object.keys(dump), [
    'backend', 'platform', 'frame', 'elapsed', 'objects', 'objectCount', 'joints',
    'gravity', 'environment',
    // phase 2 (SPEC 14.13)
    'isActive', 'audioMixer', 'camera', 'sceneUnderstanding', 'render',
    'environmentLighting', 'debug', 'hostFunctions', 'controllers',
    'warnings', 'errors', 'logs', 'placeholder',
  ]);
  assert.equal(dump.backend, 'three');
  assert.equal(dump.objectCount, 3);
  assert.deepEqual(dump.gravity, [0, -5, 0]);
  assert.equal(dump.environment, null);
  assert.equal(dump.placeholder, false);

  const cube = dump.objects.find((o) => o.name === 'cube');
  assert.deepEqual(Object.keys(cube), [
    'id', 'name', 'type', 'parent', 'visible', 'position', 'quaternion', 'scale',
    'worldPosition', 'opacity', 'billboard', 'groundingShadow', 'hoverEffect',
    'manipulable', 'castShadow', 'receiveShadow', 'renderOrder', 'world',
    'interactive', 'components', 'geometry', 'material', 'light', 'rigidBody',
    // phase 2 (SPEC 14.13)
    'audio', 'video', 'characterController', 'forceField', 'accessibility',
    'skeleton', 'blendShapes',
  ]);
  assert.equal(cube.type, 'Mesh');
  assert.equal(cube.parent, 1, 'the core parent id, not the three.js object');
  assert.deepEqual(cube.position, [0.2, 0, 0]);
  assert.deepEqual(cube.worldPosition, [0.2, 0.1, 0]);
  assert.equal(cube.opacity, 0.5);
  assert.equal(cube.billboard, true);
  assert.equal(cube.manipulable, true);
  assert.equal(cube.renderOrder, 4);
  assert.equal(cube.hoverEffect, 'highlight');
  assert.equal(cube.castShadow, true);
  assert.deepEqual(cube.interactive, { tap: true, hover: false, drag: true });
  assert.equal(cube.geometry.type, 'BoxGeometry');
  assert.equal(cube.geometry.parameters.width, 0.2);

  // Material values come from the three.js material, with the object's own
  // OpacityComponent kept out of the material's opacity.
  assert.equal(cube.material.nativeType, 'MeshStandardMaterial');
  assert.ok(Math.abs(cube.material.color[0] - 0.25) < 1e-6);
  assert.ok(Math.abs(cube.material.color[2] - 0.75) < 1e-6);
  assert.equal(cube.material.metalness, 0.3);
  assert.equal(cube.material.opacity, 1);
  assert.equal(cube.rigidBody.type, 'static', 'read back from the physics body');
  assert.deepEqual(cube.components,
    ['ModelComponent', 'CollisionComponent', 'PhysicsBodyComponent', 'InputTargetComponent',
      'OpacityComponent', 'BillboardComponent', 'ManipulationComponent']);

  const holder = dump.objects.find((o) => o.name === 'holder');
  assert.equal(holder.parent, 0, 'root children report parent 0');
  assert.equal(holder.type, 'Group');

  const sun = dump.objects.find((o) => o.name === 'sun');
  assert.equal(sun.type, 'DirectionalLight');
  assert.equal(sun.light.type, 'directional');
  assert.equal(sun.light.intensity, 3, 'three.js units, no lumen conversion on this side');
  assert.deepEqual(sun.light.direction.map((n) => +n.toFixed(6)), [0, -1, 0]);
  assert.deepEqual(sun.components, ['DynamicLightShadowComponent', 'DirectionalLightComponent']);
});

test('the mac camera preset matches the macOS host and adds no lighting of its own', async () => {
  const { consumer } = await makeConsumer({
    camera: CAMERA_PRESETS.mac.camera,
    fov: CAMERA_PRESETS.mac.fov,
    background: CAMERA_PRESETS.mac.background,
  });
  assert.deepEqual(consumer.camera.position.toArray(), [0, 0.25, 1.4]);
  assert.equal(consumer.camera.fov, 60);
  assert.equal(consumer.scene.background.getHex(), 0x000000);
  assert.deepEqual(CAMERA_PRESETS.mac.width, 1400);
  assert.deepEqual(CAMERA_PRESETS.mac.height, 950);

  consumer.apply([['create', 1, 'mesh', 'cube'], ['parent', 1, 0]]);
  consumer.updateVisuals(1 / 60);
  assert.equal(consumer.scene.children.filter((o) => o.isLight).length, 0,
    'no lighting beyond what the script declares');
  assert.ok(consumer.warnings.some((w) => w.includes('render black')));
});

// ------------------------------------------------------------------ raycast

test('an unbounded raycast (maxDistance -1) hits the nearest stacked mesh', async () => {
  const { consumer } = await makeConsumer();
  // Three boxes stacked on the Y axis, the way physics-scenarios.js arranges them.
  consumer.apply([
    ['create', 1, 'mesh', 'stack-0'], ['parent', 1, 0], transformCommand(1, [0, -0.25, 0]), boxGeometryCommand(1, 0.08, 0.08, 0.08),
    ['create', 2, 'mesh', 'stack-1'], ['parent', 2, 0], transformCommand(2, [0, -0.17, 0]), boxGeometryCommand(2, 0.08, 0.08, 0.08),
    ['create', 3, 'mesh', 'stack-2'], ['parent', 3, 0], transformCommand(3, [0, -0.09, 0]), boxGeometryCommand(3, 0.08, 0.08, 0.08),
  ]);
  consumer.root.updateMatrixWorld(true);

  // The core sends -1 rather than Infinity for an unbounded ray (SPEC 6).
  const hits = consumer.raycast(0, 0.5, 0, 0, -1, 0, -1);
  assert.equal(hits.length, 24, 'one record per object, all three hit');
  assert.equal(hits[0], 3, 'the topmost box is nearest');
  assert.equal(hits[8], 2);
  assert.equal(hits[16], 1, 'records are sorted by distance');
  assert.ok(hits[7] < hits[15] && hits[15] < hits[23]);

  // The hit point and the world-space face normal come back with each record.
  assert.ok(Math.abs(hits[2] - -0.05) < 1e-6, 'hit the top face of stack-2');
  assert.deepEqual(hits.slice(4, 7).map((n) => +n.toFixed(6)), [0, 1, 0], 'upward face normal');

  // Infinity and a missing value mean the same thing.
  assert.equal(consumer.raycast(0, 0.5, 0, 0, -1, 0, Infinity).length, 24);
  assert.equal(consumer.raycast(0, 0.5, 0, 0, -1, 0, undefined).length, 24);
  // A real limit still clips.
  assert.equal(consumer.raycast(0, 0.5, 0, 0, -1, 0, 0.6).length, 8);
});

test('dynamic bodies get continuous collision detection so they cannot tunnel', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    // A 0.02 m thin static floor, the thickness physics-scenarios.js uses.
    ['create', 1, 'mesh', 'floor'], ['parent', 1, 0], transformCommand(1, [0, -0.3, 0]),
    boxGeometryCommand(1, 1.2, 0.02, 1.2), rigidBodyCommand(1, { type: 'static', shape: 'box', friction: 0.8 }),
    ['create', 2, 'mesh', 'dropper'], ['parent', 2, 0], transformCommand(2, [0, 0.3, 0]),
    ['geometry', 2, { type: 'SphereGeometry', parameters: { radius: 0.03 }, uuid: 'geo-ball' },
      new Float32Array([0.03, 0, 0, -0.03, 0, 0, 0, 0.03, 0, 0, -0.03, 0, 0, 0, 0.03, 0, 0, -0.03]), null, null, null],
    rigidBodyCommand(2, { mass: 0.1, restitution: 0.4, shape: 'sphere' }),
  ]);
  assert.equal(consumer.physics.bodies.get(2).body.isCcdEnabled(), true);
  assert.equal(consumer.physics.bodies.get(1).body.isCcdEnabled(), false, 'static bodies do not need it');

  for (let i = 0; i < 300; i++) consumer.tick(1 / 60);
  const y = consumer.physics.bodies.get(2).body.translation().y;
  // Floor top is -0.29, ball radius 0.03, so it rests near -0.26.
  assert.ok(Math.abs(y - -0.26) < 0.02, `the ball rests on the floor instead of tunnelling (y=${y})`);
});

// ------------------------------------------------- SPEC 3.7 raycast rules

test('WEB-23: raycast honours recursive false, visibility, and one hit per object', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    // A direct child of the mounted scene.
    ['create', 1, 'mesh', 'top'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]), boxGeometryCommand(1, 0.2, 0.2, 0.2),
    // A mesh nested one level down.
    ['create', 2, 'group', 'holder'], ['parent', 2, 0], transformCommand(2, [0, 0, -0.5]),
    ['create', 3, 'mesh', 'nested'], ['parent', 3, 2], boxGeometryCommand(3, 0.2, 0.2, 0.2),
    // An invisible direct child behind the first one.
    ['create', 4, 'mesh', 'hidden'], ['parent', 4, 0], transformCommand(4, [0, 0, -1]), boxGeometryCommand(4, 0.2, 0.2, 0.2),
    ['visible', 4, false],
  ]);
  consumer.root.updateMatrixWorld(true);

  const ids = (records) => {
    const out = [];
    for (let i = 0; i < records.length; i += 8) out.push(records[i]);
    return out;
  };
  // recursive defaults to true and finds the nested mesh.
  assert.deepEqual(ids(consumer.raycast(0, 0, 2, 0, 0, -1, -1)), [1, 3]);
  assert.deepEqual(ids(consumer.raycast(0, 0, 2, 0, 0, -1, -1, true)), [1, 3]);
  // recursive false keeps only direct children of the mounted scene.
  assert.deepEqual(ids(consumer.raycast(0, 0, 2, 0, 0, -1, -1, false)), [1]);
  // The invisible mesh is never returned, and no object appears twice.
  assert.ok(!ids(consumer.raycast(0, 0, 2, 0, 0, -1, -1)).includes(4));
  consumer.apply([['visible', 4, true]]);
  const visible = ids(consumer.raycast(0, 0, 2, 0, 0, -1, -1));
  assert.deepEqual(visible, [1, 3, 4]);
  assert.equal(new Set(visible).size, visible.length, 'at most one hit per object');
});

// ------------------------------------------------------ SPEC 3.7 rigid bodies

test('a rigidBody on an object with no geometry warns once and is ignored', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'holder'], ['parent', 1, 0],
    rigidBodyCommand(1),
  ]);
  assert.equal(consumer.physics.bodies.has(1), false, 'no body is created');
  const matching = consumer.warnings.filter((w) => w.includes('has no geometry to build a collision shape from'));
  assert.equal(matching.length, 1);
  assert.ok(matching[0].includes('"holder"'), 'the warning names the object');

  // A second command for the same object must not warn again.
  consumer.apply([rigidBodyCommand(1, { mass: 3 })]);
  assert.equal(consumer.warnings.filter((w) => w.includes('has no geometry')).length, 1);

  // A mesh whose geometry has no vertices is the same case.
  consumer.apply([
    ['create', 2, 'mesh', 'empty'], ['parent', 2, 0],
    ['geometry', 2, { type: 'BufferGeometry', parameters: {}, uuid: 'geo-empty' }, new Float32Array(0), null, null, null],
    rigidBodyCommand(2),
  ]);
  assert.equal(consumer.physics.bodies.has(2), false);
  assert.equal(consumer.warnings.filter((w) => w.includes('has no geometry')).length, 2);

  // A mesh with real geometry builds its body normally and warns about nothing.
  consumer.apply([
    ['create', 3, 'mesh', 'solid'], ['parent', 3, 0], boxGeometryCommand(3), rigidBodyCommand(3),
  ]);
  assert.equal(consumer.physics.bodies.has(3), true);
  assert.equal(consumer.warnings.filter((w) => w.includes('has no geometry')).length, 2);
});

test('a trigger is never simulated and reports both collision edges', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.apply([
    // The trigger asks to be dynamic; SPEC 3.7 says the type is ignored.
    ['create', 1, 'mesh', 'trigger'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    boxGeometryCommand(1, 0.3, 0.3, 0.3),
    rigidBodyCommand(1, { type: 'dynamic', isTrigger: true, shape: 'box' }),
    ['create', 2, 'mesh', 'ball'], ['parent', 2, 0], transformCommand(2, [0, 0.6, 0]),
    boxGeometryCommand(2, 0.06, 0.06, 0.06), rigidBodyCommand(2, { mass: 0.2, shape: 'box' }),
  ]);
  const trigger = consumer.physics.bodies.get(1);
  assert.equal(trigger.body.isKinematic(), true, 'a trigger is kinematic whatever its type says');
  assert.equal(trigger.collider.isSensor(), true);
  assert.equal(consumer.physics.isDynamic(1), false);
  const startY = trigger.body.translation().y;

  for (let i = 0; i < 180; i++) consumer.tick(1 / 60);

  assert.equal(trigger.body.translation().y, startY, 'the trigger never falls');
  const ball = consumer.physics.bodies.get(2).body.translation().y;
  assert.ok(ball < -0.5, `the ball passes straight through instead of resting on it (y=${ball})`);

  const starts = core.dispatched.filter((d) => d.type === 'collisionstart');
  const ends = core.dispatched.filter((d) => d.type === 'collisionend');
  assert.equal(starts.length, 1, 'one collisionstart for the pair');
  assert.equal(ends.length, 1, 'one collisionend for the pair');
  assert.deepEqual([starts[0].id, starts[0].payload.other].sort(), [1, 2]);
});

test('distance joint limits follow SPEC 3.7', async () => {
  const build = (consumer) => consumer.apply([
    ['create', 1, 'mesh', 'anchor'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    boxGeometryCommand(1), rigidBodyCommand(1, { type: 'static' }),
    ['create', 2, 'mesh', 'bob'], ['parent', 2, 0], transformCommand(2, [0.4, 0, 0]),
    boxGeometryCommand(2), rigidBodyCommand(2, { mass: 0.5 }),
  ]);

  // null pins the separation at the value it had when the joint was added.
  const pinned = await makeConsumer();
  build(pinned.consumer);
  pinned.consumer.apply([['joint', 10, {
    type: 'distance', bodyA: 1, bodyB: 2, anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 1, 0], limits: null,
  }]]);
  assert.equal(pinned.consumer.physics.joints.size, 1);
  assert.deepEqual(pinned.consumer.warnings, [], 'pinning needs no warning');
  for (let i = 0; i < 240; i++) pinned.consumer.tick(1 / 60);
  const a = pinned.consumer.physics.bodies.get(1).body.translation();
  const b = pinned.consumer.physics.bodies.get(2).body.translation();
  const separation = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  assert.ok(Math.abs(separation - 0.4) < 0.05, `the separation stays near 0.4 (was ${separation.toFixed(3)})`);

  // A positive minimum cannot be expressed by a Rapier rope, so it warns once.
  const limited = await makeConsumer();
  build(limited.consumer);
  limited.consumer.apply([['joint', 11, {
    type: 'distance', bodyA: 1, bodyB: 2, anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 1, 0], limits: [0.2, 0.6],
  }]]);
  const warned = limited.consumer.warnings.filter((w) => w.includes('minimum separation'));
  assert.equal(warned.length, 1);
  assert.ok(warned[0].includes('distance joint 11'), 'the warning names the joint');
  assert.ok(warned[0].includes('0.6'), 'and says the maximum is applied');

  // A zero minimum is exactly a rope, so nothing is warned about.
  const rope = await makeConsumer();
  build(rope.consumer);
  rope.consumer.apply([['joint', 12, {
    type: 'distance', bodyA: 1, bodyB: 2, anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 1, 0], limits: [0, 0.6],
  }]]);
  assert.deepEqual(rope.consumer.warnings, []);
  assert.equal(rope.consumer.physics.joints.size, 1);
});

// ------------------------------------------------------ native dump details

test('the native dump lists CollisionComponent only where a collider exists', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'plain'], ['parent', 1, 0], boxGeometryCommand(1), standardMaterialCommand(1),
    ['create', 2, 'mesh', 'body'], ['parent', 2, 0], transformCommand(2, [0.5, 0, 0]),
    boxGeometryCommand(2), standardMaterialCommand(2), rigidBodyCommand(2),
    ['create', 3, 'mesh', 'trigger'], ['parent', 3, 0], transformCommand(3, [1, 0, 0]),
    boxGeometryCommand(3), standardMaterialCommand(3), rigidBodyCommand(3, { isTrigger: true }),
  ]);
  const dump = consumer.nativeDump();
  const components = (name) => dump.objects.find((o) => o.name === name).components;
  assert.ok(!components('plain').includes('CollisionComponent'), 'a plain mesh has no collider on web');
  assert.ok(components('body').includes('CollisionComponent'));
  assert.ok(components('body').includes('PhysicsBodyComponent'));
  assert.ok(components('trigger').includes('CollisionComponent'));
  assert.ok(!components('trigger').includes('PhysicsBodyComponent'), 'a trigger carries no physics body');
  // The trigger still reports the type the script asked for.
  assert.equal(dump.objects.find((o) => o.name === 'trigger').rigidBody.type, 'dynamic');
});

test('the native dump survives a material or light with no colour', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'world'], ['parent', 1, 0],
    ['create', 2, 'portal', 'portal'], ['parent', 2, 0],
    boxGeometryCommand(2), standardMaterialCommand(2),
    ['world', 1, true], ['portal', 2, { worldId: 1, width: 0.5, height: 0.4, crossing: false }],
    ['create', 3, 'particles', 'fx'], ['parent', 3, 0],
    ['particles', 3, { preset: 'sparks', isEmitting: true }],
  ]);
  const dump = consumer.nativeDump();
  const portal = dump.objects.find((o) => o.name === 'portal');
  // The portal's render-target material has no colour, metalness or emissive.
  assert.equal(portal.material.color, null);
  assert.equal(portal.material.metalness, null);
  assert.equal(portal.material.emissive, null);
  assert.equal(portal.material.nativeType, 'ShaderMaterial');
  assert.equal(portal.light, null);
  assert.ok(portal.components.includes('PortalComponent'));
  assert.equal(JSON.parse(JSON.stringify(dump)).objects.length, dump.objects.length, 'the dump is serialisable');
});

// --------------------------------------------------- warnings and environment

test('consumer warnings are registered with the core under a consumer: key', async () => {
  const registered = [];
  const core = new RecordingCore();
  core.runtime = { warnOnce: (key, message) => registered.push([key, message]) };
  const { consumer } = await makeConsumer({ core });

  consumer.apply([['groundingShadow', 1, true], ['create', 1, 'mesh', 'm'], ['groundingShadow', 1, true]]);
  assert.equal(registered.length, 1);
  assert.equal(registered[0][0], 'consumer:groundingShadow');
  assert.match(registered[0][1], /groundingShadow is unsupported/);
  // The consumer keeps its own copy for the native dump.
  assert.equal(consumer.warnings.length, 1);
});

test('.exr environments warn once and .hdr goes to the Radiance loader', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['environment', 0, { url: 'asset://studio.exr', intensity: 1.5 }]]);
  assert.equal(consumer.scene.environment, null);
  assert.equal(consumer.scene.environmentIntensity, 1.5);
  assert.equal(consumer.warnings.filter((w) => w.includes('.exr environments are unsupported')).length, 1);

  consumer.apply([['environment', 0, { url: 'asset://studio2.exr', intensity: 1 }]]);
  assert.equal(consumer.warnings.filter((w) => w.includes('.exr environments are unsupported')).length, 1);

  // .hdr is supported: it takes the Radiance path and raises no warning.
  let requested = null;
  consumer.hdrLoader = { load: (url) => { requested = url; } };
  consumer.apply([['environment', 0, { url: 'asset://studio-env.hdr', intensity: 2 }]]);
  assert.equal(requested, '/assets/studio-env.hdr');
  assert.equal(consumer.scene.environmentIntensity, 2);
  assert.equal(consumer.warnings.filter((w) => w.includes('.hdr')).length, 0);
});

// ============================================================ bug review fixes

test('WEB-01: a failure in the post-batch step is recorded and never retried', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'cube'], ['parent', 1, 0], boxGeometryCommand(1),
  ]);
  const original = consumer.physics.setBody.bind(consumer.physics);
  let calls = 0;
  consumer.physics.setBody = () => { calls += 1; throw new Error('boom'); };

  // apply() must not throw, and the pending queue must be empty afterwards.
  assert.doesNotThrow(() => consumer.apply([rigidBodyCommand(1)]));
  assert.equal(calls, 1);
  assert.equal(consumer._pendingBodies.size, 0, 'the pending body is cleared');
  assert.equal(consumer.errors.length, 1);
  assert.match(consumer.errors[0], /rigidBody on id 1 "cube" failed: boom/);

  // The failing op is not retried on the next frame.
  consumer.tick(1 / 60);
  assert.equal(calls, 1, 'the failed op is not retried forever');
  assert.equal(consumer.frame, 1, 'the frame counter still advances');
  assert.ok(consumer.elapsed > 0);
  consumer.physics.setBody = original;
});

test('WEB-01: a throwing tick still advances the frame and records the error', async () => {
  const core = new RecordingCore();
  core.tick = () => { throw new Error('core exploded'); };
  const { consumer } = await makeConsumer({ core });
  consumer.tick(1 / 60);
  consumer.tick(1 / 60);
  assert.equal(consumer.frame, 2);
  assert.equal(consumer.errors.length, 1, 'the repeat is counted, not appended');
  assert.match(consumer.errors[0], /core exploded/);
});

test('WEB-26: repeated errors are counted and the list is capped', async () => {
  const { consumer } = await makeConsumer();
  for (let i = 0; i < 500; i++) {
    consumer.recordError('command test', null, new Error(`failure ${i}`));
  }
  assert.equal(consumer.errors.length, 200);
  assert.equal(consumer.droppedErrors, 300);
  for (let i = 0; i < 50; i++) consumer.recordError('command test', null, new Error('failure 0'));
  assert.equal(consumer.errors.length, 200, 'a repeat is never appended again');
});

test('WEB-02: an in-place geometry edit re-uploads the attributes and bounds', async () => {
  const { consumer } = await makeConsumer();
  const command = boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-live');
  consumer.apply([['create', 1, 'mesh', 'm'], ['parent', 1, 0], command]);
  const geometry = consumer.objects.get(1).geometry;
  const attribute = geometry.getAttribute('position');
  const versionBefore = attribute.version;
  assert.ok(Math.abs(geometry.boundingBox.max.x - 0.1) < 1e-6);

  // The core re-emits the same arrays after an in-place edit.
  command[3][0] = 9;
  command[3][3] = 9;
  consumer.apply([command]);

  assert.equal(consumer.objects.get(1).geometry, geometry, 'the instance is kept');
  assert.equal(geometry.getAttribute('position'), attribute, 'the attribute is refilled, not replaced');
  assert.ok(attribute.version > versionBefore, 'three re-uploads the buffer');
  assert.ok(Math.abs(geometry.boundingBox.max.x - 9) < 1e-6, 'the bounding volume is recomputed');
  assert.ok(Math.abs(geometry.boundingSphere.radius - geometry.boundingSphere.radius) < 1e-6);
});

test('WEB-02: a revision from the core skips the redundant refill', async () => {
  const { consumer } = await makeConsumer();
  const withRevision = (revision) => {
    const command = boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-rev');
    command[2].revision = revision;
    return command;
  };
  consumer.apply([['create', 1, 'mesh', 'm'], ['parent', 1, 0], withRevision(1)]);
  const attribute = consumer.objects.get(1).geometry.getAttribute('position');
  const version = attribute.version;
  consumer.apply([withRevision(1)]);
  assert.equal(attribute.version, version, 'the same revision is not rewritten');
  consumer.apply([withRevision(2)]);
  assert.ok(attribute.version > version, 'a new revision is');
});

test('WEB-03: swapping a mesh geometry rebuilds its Rapier collider', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0],
    boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-small'), rigidBodyCommand(1, { shape: 'box' }),
  ]);
  const half = () => {
    const e = consumer.physics.bodies.get(1).collider.halfExtents();
    return [+e.x.toFixed(4), +e.y.toFixed(4), +e.z.toFixed(4)];
  };
  assert.deepEqual(half(), [0.1, 0.1, 0.1]);

  consumer.apply([boxGeometryCommand(1, 2, 2, 2, 'geo-big')]);
  assert.deepEqual(half(), [1, 1, 1], 'the collider follows the new geometry');
});

test('WEB-04: respeccing a body keeps the joints attached to it', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    boxGeometryCommand(1), rigidBodyCommand(1, { type: 'static' }),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], transformCommand(2, [0.3, 0, 0]),
    boxGeometryCommand(2), rigidBodyCommand(2),
    ['joint', 10, { type: 'fixed', bodyA: 1, bodyB: 2, anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 1, 0], limits: null }],
  ]);
  assert.deepEqual([...consumer.physics.joints.keys()], [10]);

  // A type change forces a rebuild, which used to take the joint down with it.
  consumer.apply([rigidBodyCommand(1, { type: 'kinematic' })]);
  assert.deepEqual([...consumer.physics.joints.keys()], [10], 'the joint survives the respec');
  assert.equal(consumer.nativeDump().joints.length, 1);

  // Destroying a body still removes its joints.
  consumer.apply([['destroy', 2]]);
  assert.deepEqual([...consumer.physics.joints.keys()], []);
});

test('WEB-05/06: a load that lands after destroy is dropped and assetSpecs is cleared', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  let succeed = null;
  consumer.gltfLoader = { load: (url, onLoad) => { succeed = onLoad; } };
  consumer.apply([
    ['create', 1, 'asset', 'robot'], ['parent', 1, 0],
    ['asset', 1, { glb: 'robot.glb' }],
  ]);
  assert.equal(consumer.assetSpecs.size, 1);

  consumer.apply([['destroy', 1]]);
  assert.equal(consumer.assetSpecs.size, 0, 'assetSpecs is cleared on destroy');
  assert.equal(consumer.assetIdForUrl('robot.glb'), undefined);

  let disposed = 0;
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  mesh.geometry.addEventListener('dispose', () => { disposed += 1; });
  scene.add(mesh);
  succeed({ scene, animations: [] });

  assert.equal(consumer.assets.has(1), false, 'the entry is not resurrected');
  assert.deepEqual(core.dispatched.filter((d) => d.id === 1), [], 'nothing is dispatched to a dead id');
  assert.equal(disposed, 1, 'the orphaned gltf is disposed');
  assert.equal(consumer.pendingLoads, 0);
});

test('WEB-07: a load from a previous scene never resolves against the new one', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  let succeed = null;
  consumer.gltfLoader = { load: (url, onLoad) => { succeed = onLoad; } };
  consumer.apply([
    ['create', 1, 'asset', 'first'], ['parent', 1, 0], ['asset', 1, { glb: 'a.glb' }],
  ]);
  const generationBefore = consumer.generation;

  consumer.reset();
  assert.ok(consumer.generation > generationBefore, 'the generation moved on');
  assert.equal(consumer.pendingLoads, 0, 'reset zeroes the in-flight count');

  // The new scene reuses id 1, as the core restarts its counter on load().
  consumer.apply([['create', 1, 'asset', 'second'], ['parent', 1, 0]]);
  succeed({ scene: new THREE.Group(), animations: ['walk'] });
  assert.deepEqual(core.dispatched, [], 'the stale load does not touch the new object');
  assert.equal(consumer.assets.has(1), false);
});

test('WEB-08: head-anchored content is pickable, raycastable and fades', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'anchor', 'head'], ['parent', 1, 0], ['anchor', 1, { kind: 'head' }],
    ['create', 2, 'mesh', 'badge'], ['parent', 2, 1], transformCommand(2, [0, 0, -0.5]),
    boxGeometryCommand(2, 0.2, 0.2, 0.2), standardMaterialCommand(2),
    ['opacity', 2, 0.25],
  ]);
  consumer.camera.updateMatrixWorld(true);
  const badge = consumer.objects.get(2);
  assert.equal(consumer.objects.get(1).parent, consumer.camera);
  assert.ok(consumer.pickables().includes(badge), 'the anchored mesh is pickable');

  // The camera sits at (0, 0, 1.2) looking at the origin, so the badge is at z 0.7.
  const hits = consumer.raycast(0, 0, 2, 0, 0, -1, -1);
  assert.equal(hits[0], 2, 'the anchored mesh is raycastable');
  assert.ok(Math.abs(badge.material.opacity - 0.25) < 1e-6, 'opacity reaches it');
});

test('WEB-09: a portal renders a world group nested below the root', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'container'], ['parent', 1, 0],
    ['create', 2, 'group', 'world'], ['parent', 2, 1],
    ['create', 3, 'mesh', 'inner'], ['parent', 3, 2], boxGeometryCommand(3), standardMaterialCommand(3),
    ['create', 4, 'mesh', 'outside'], ['parent', 4, 0], boxGeometryCommand(4), standardMaterialCommand(4),
    ['create', 5, 'portal', 'portal'], ['parent', 5, 0],
    boxGeometryCommand(5), standardMaterialCommand(5),
    ['world', 2, true], ['portal', 5, { worldId: 2, width: 0.5, height: 0.4, crossing: false }],
  ]);
  const portal = consumer.portals.get(5);
  const restore = consumer._enterPortalPass(portal, consumer.objects.get(2));
  const visible = (id) => {
    let node = consumer.objects.get(id);
    while (node) {
      if (node.visible === false) return false;
      node = node.parent;
    }
    return true;
  };
  assert.equal(visible(3), true, 'the nested world content is drawn');
  assert.equal(visible(4), false, 'the rest of the scene is not');
  assert.equal(consumer.objects.get(5).visible, false, 'nor the portal surface');
  restore();
  assert.equal(consumer.objects.get(4).visible, true, 'visibility is restored');

  // A world group the script hid stays hidden.
  consumer.apply([['visible', 2, false]]);
  const restore2 = consumer._enterPortalPass(portal, consumer.objects.get(2));
  assert.equal(consumer.objects.get(2).visible, false, 'the script wins over the portal pass');
  restore2();
});

test('WEB-10: manipulating a dynamic body syncs once and drives Rapier', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.apply([
    ['create', 1, 'mesh', 'knob'], ['parent', 1, 0], transformCommand(1, [0, 0.5, 0]),
    boxGeometryCommand(1), standardMaterialCommand(1),
    ['manipulable', 1, true], rigidBodyCommand(1),
  ]);
  const object = consumer.objects.get(1);
  const body = consumer.physics.bodies.get(1).body;
  // Stand in for a pointer gesture.
  consumer.input.manipulation = { object };

  object.position.set(0.4, 0.5, 0);
  object.updateMatrixWorld(true);
  consumer.tick(1 / 60);

  const record = core.syncs.at(-1);
  assert.equal(record.length, 11, 'exactly one sync record for the manipulated id');
  assert.equal(record[0], 1);
  assert.ok(Math.abs(record[1] - 0.4) < 1e-3);
  assert.equal(body.isKinematic(), true, 'the body follows the pointer while manipulated');

  consumer.input.manipulation = null;
  consumer.tick(1 / 60);
  assert.equal(body.isDynamic(), true, 'and simulates again afterwards');
});

test('WEB-11: environment textures are disposed on replacement and reset', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['environment', 0, { url: 'asset://a.png', intensity: 1 }]]);
  const first = consumer.scene.environment;
  let disposed = 0;
  first.addEventListener('dispose', () => { disposed += 1; });

  consumer.apply([['environment', 0, { url: 'asset://b.png', intensity: 1 }]]);
  assert.equal(disposed, 1, 'the replaced environment is freed');
  assert.notEqual(consumer.scene.environment, first);

  const second = consumer.scene.environment;
  let secondDisposed = 0;
  second.addEventListener('dispose', () => { secondDisposed += 1; });
  consumer.reset();
  assert.equal(secondDisposed, 1, 'reset frees the last one');
  assert.equal(consumer.scene.environment, null);
});

test('WEB-12: a texture url change keeps the instance materials are bound to', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0],
    ['texture', 7, { url: 'asset://a.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    standardMaterialCommand(1, { maps: { map: 7, normalMap: null, roughnessMap: null, metalnessMap: null, emissiveMap: null } }),
  ]);
  const bound = consumer.objects.get(1).material.map;
  let disposed = 0;
  bound.addEventListener('dispose', () => { disposed += 1; });

  consumer.apply([['texture', 7, { url: 'asset://b.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }]]);
  assert.equal(disposed, 0, 'the bound instance is not disposed under the material');
  assert.equal(consumer.objects.get(1).material.map, bound, 'and is still the one in use');
  assert.equal(consumer.textures.get(7).url, '/assets/b.png', 'while the entry points at the new url');
});

test('SPEC 5: a null texture payload releases the id', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['texture', 7, { url: 'asset://a.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }]]);
  const entry = consumer.textures.get(7);
  let disposed = 0;
  entry.texture.addEventListener('dispose', () => { disposed += 1; });

  consumer.apply([['texture', 7, null]]);
  assert.equal(consumer.textures.has(7), false, 'the id is dropped');
  assert.equal(disposed, 1, 'the GPU texture is freed');
  assert.equal(entry.released, true, 'an in-flight load for it is ignored');
  assert.deepEqual(consumer.warnings, []);
});

test('SPEC 5: a released texture a material still uses is kept and warned about', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0],
    ['texture', 7, { url: 'asset://a.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    standardMaterialCommand(1, { maps: { map: 7, normalMap: null, roughnessMap: null, metalnessMap: null, emissiveMap: null } }),
  ]);
  const bound = consumer.objects.get(1).material.map;
  let disposed = 0;
  bound.addEventListener('dispose', () => { disposed += 1; });
  consumer.apply([['texture', 7, null]]);
  assert.equal(disposed, 0, 'a texture in use is not pulled out from under the material');
  assert.equal(consumer.warnings.filter((w) => w.includes('still references it')).length, 1);
});

test('WEB-13/14: physics commands without Rapier warn, and sync still runs', async () => {
  const { consumer, core } = await makeConsumer({ physics: false, core: new RecordingCore() });
  assert.equal(consumer.physics, null);
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0], boxGeometryCommand(1),
    rigidBodyCommand(1), ['gravity', 0, 0, -5, 0],
    ['bodyImpulse', 1, 0, 1, 0, null, null, null],
  ]);
  assert.equal(consumer.warnings.filter((w) => w.includes('no physics module')).length, 1);
  assert.ok(consumer.bodySpecs.has(1), 'the spec is still recorded for the dump');
  assert.equal(consumer.nativeDump().objects[0].rigidBody, null, 'with no live body to read back');

  // WEB-14: manipulation reaches the core even with no physics world.
  consumer.input.manipulation = { object: consumer.objects.get(1) };
  consumer.objects.get(1).position.set(0.2, 0, 0);
  consumer.objects.get(1).updateMatrixWorld(true);
  consumer.tick(1 / 60);
  const record = core.syncs.at(-1);
  assert.equal(record.length, 11);
  assert.ok(Math.abs(record[1] - 0.2) < 1e-6);
});

test('WEB-15: manualBridge lets load events through but not input events', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.setManualBridge(true);
  consumer.dispatch('tap', 1, {});
  consumer.dispatch('collisionstart', 1, {});
  consumer.dispatch('textureLoaded', 1, {});
  consumer.dispatch('assetError', 1, { message: 'x' });
  assert.deepEqual(core.dispatched.map((d) => d.type), ['textureLoaded', 'assetError']);
});

test('WEB-16/17: non-finite rays and transform records are refused', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]), boxGeometryCommand(1),
  ]);
  consumer.root.updateMatrixWorld(true);
  assert.deepEqual(consumer.raycast(NaN, 0, 2, 0, 0, -1, -1), []);
  assert.deepEqual(consumer.raycast(0, 0, 2, 0, Infinity, -1, -1), []);
  assert.equal(consumer.raycast(0, 0, 2, 0, 0, -1, -1).length, 8, 'a finite ray still hits');

  consumer.apply([transformsCommand([{ id: 1, position: [NaN, 0, 0] }])]);
  assert.deepEqual(consumer.objects.get(1).position.toArray(), [0, 0, 0], 'the object is untouched');
  assert.equal(consumer.errors.length, 1);
  assert.match(consumer.errors[0], /transforms record on id 1 "m" failed: the record is not finite/);

  consumer.apply([transformCommand(1, [0, Infinity, 0])]);
  assert.deepEqual(consumer.objects.get(1).position.toArray(), [0, 0, 0]);
  assert.equal(consumer.errors.length, 2);
});

test('WEB-19/21/22: reset disposes once and clears every session', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'world'], ['parent', 1, 0],
    ['create', 2, 'portal', 'portal'], ['parent', 2, 0], boxGeometryCommand(2), standardMaterialCommand(2),
    ['world', 1, true], ['portal', 2, { worldId: 1, width: 0.5, height: 0.4, crossing: false }],
    ['create', 3, 'particles', 'fx'], ['parent', 3, 0], ['particles', 3, { preset: 'sparks' }],
  ]);
  let targetDisposals = 0;
  consumer.portals.get(2).target.addEventListener('dispose', () => { targetDisposals += 1; });
  consumer.input.hovered = consumer.objects.get(2);
  consumer.input.drag = { object: consumer.objects.get(2) };
  consumer.manualBridge = true;
  consumer.pendingLoads = 3;
  consumer._pendingBodies.set(9, null);

  consumer.reset();
  assert.equal(targetDisposals, 1, 'the portal render target is disposed exactly once');
  assert.equal(consumer.input.hovered, null);
  assert.equal(consumer.input.drag, null);
  assert.equal(consumer.manualBridge, false);
  assert.equal(consumer.pendingLoads, 0);
  assert.equal(consumer._pendingBodies.size, 0);
  assert.ok(consumer.physics, 'reset keeps a usable physics world');

  // dispose() must not leave a fresh world behind.
  consumer.dispose();
  assert.equal(consumer.physics, null);
});

test('WEB-20: flags for an unknown id are ignored', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['interactive', 99, { tap: true, hover: false, drag: false }],
    ['opacity', 99, 0.5],
  ]);
  assert.equal(consumer.interactive.size, 0);
  assert.equal(consumer.opacities.size, 0);
  assert.equal(consumer.warnings.filter((w) => w.includes('unknown object id 99')).length, 1);
});

test('WEB-24: a portal whose world is destroyed stops showing the old frame', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'world'], ['parent', 1, 0],
    ['create', 2, 'portal', 'portal'], ['parent', 2, 0], boxGeometryCommand(2), standardMaterialCommand(2),
    ['world', 1, true], ['portal', 2, { worldId: 1, width: 0.5, height: 0.4, crossing: false }],
  ]);
  const portal = consumer.portals.get(2);
  portal.cleared = false;
  const cleared = [];
  consumer.renderer = {
    setRenderTarget: (t) => cleared.push(t === portal.target ? 'portal' : 'screen'),
    clear: () => cleared.push('clear'),
    render: () => {},
    getDrawingBufferSize: (v) => v.set(800, 600),
  };
  consumer.apply([['destroy', 1]]);
  consumer.render();
  assert.deepEqual(cleared.slice(0, 3), ['portal', 'clear', 'screen']);
  assert.equal(portal.cleared, true);
  cleared.length = 0;
  consumer.render();
  assert.ok(!cleared.includes('clear'), 'and only clears it once');
  consumer.renderer = null;
});

test('WEB-29: a billboarded body does not spin with the camera', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'sign'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    boxGeometryCommand(1), rigidBodyCommand(1, { type: 'static', shape: 'box' }),
    ['billboard', 1, true],
  ]);
  consumer.setCameraPosition(1, 1, 1);
  const body = consumer.physics.bodies.get(1).body;
  const before = body.rotation();
  consumer.updateVisuals(1 / 60);
  consumer.tick(1 / 60);
  const after = body.rotation();
  assert.deepEqual(
    [after.x, after.y, after.z, after.w].map((n) => +n.toFixed(6)),
    [before.x, before.y, before.z, before.w].map((n) => +n.toFixed(6)),
    'the collider keeps the pose the script gave it',
  );
  // The visual object did turn to face the camera.
  assert.ok(Math.abs(consumer.objects.get(1).quaternion.y) > 1e-3);
});

test('WEB-30: opacity multiplies into a particle emitter', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'holder'], ['parent', 1, 0],
    ['create', 2, 'particles', 'fx'], ['parent', 2, 1],
    ['particles', 2, { preset: null, birthRate: 100, lifetime: 1, opacity: 1, opacityEnd: 1, size: 0.02 }],
    ['opacity', 1, 0.5], ['opacity', 2, 0.5],
  ]);
  const emitter = consumer.emitters.get(2);
  assert.ok(Math.abs(emitter.opacityScale - 0.25) < 1e-6, '0.5 parent * 0.5 own');
  emitter.update(0.1);
  assert.ok(emitter.count > 0);
  assert.ok(Math.abs(emitter.alphas[0] - 0.25) < 1e-3, 'the particle alpha carries it');
});

test('WEB-27: destroying a mesh does not scan the resource caches', async () => {
  const { consumer } = await makeConsumer({ physics: false });
  const batch = [];
  for (let id = 1; id <= 300; id++) {
    batch.push(['create', id, 'mesh', `c${id}`], ['parent', id, 0],
      boxGeometryCommand(id, 0.02, 0.02, 0.02, 'geo-many'),
      standardMaterialCommand(id, { uuid: `mat-${id}` }));
  }
  consumer.apply(batch);
  assert.equal(consumer._sharedGeometries.size, 1);
  assert.equal(consumer._sharedMaterials.size, 300);
  consumer.apply(batch.filter((c) => c[0] === 'create').map((c) => ['destroy', c[1]]));
  assert.equal(consumer._sharedMaterials.size, 0);
  assert.equal(consumer.materials.size, 0);
  // One idle geometry entry survives so a re-send with null buffers still works.
  assert.equal(consumer.geometries.size, 1);
  assert.equal(consumer.geometries.get('geo-many').users.size, 0);
});

test('WEB-18: a shared texture keeps each material decoding correctly', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0],
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0],
    ['texture', 7, { url: 'asset://t.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    standardMaterialCommand(1, { uuid: 'mat-a', maps: { map: 7, normalMap: null, roughnessMap: null, metalnessMap: null, emissiveMap: null } }),
  ]);
  const asMap = consumer.objects.get(1).material.map;
  assert.equal(asMap.colorSpace, THREE.SRGBColorSpace);

  // A second material binds the same id in a linear slot.
  consumer.apply([standardMaterialCommand(2, { uuid: 'mat-b', maps: { map: null, normalMap: null, roughnessMap: 7, metalnessMap: null, emissiveMap: null } })]);
  assert.equal(consumer.objects.get(2).material.roughnessMap.colorSpace, THREE.NoColorSpace);
  assert.equal(consumer.objects.get(1).material.map, asMap, 'the first binding is untouched');
  assert.equal(asMap.colorSpace, THREE.SRGBColorSpace, 'and still decodes as sRGB');
  assert.equal(consumer.objects.get(1).material.map.image, consumer.objects.get(2).material.roughnessMap.image,
    'both views share one image');
});

test('WEB-25: only the left button ends a drag, and leaving the canvas closes it', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'handle'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    boxGeometryCommand(1, 0.4, 0.4, 0.4),
    ['interactive', 1, { tap: true, hover: false, drag: true }],
  ]);
  consumer.root.updateMatrixWorld(true);
  const dispatched = [];
  const input = consumer.input;
  input.deps.dispatch = (type, id) => dispatched.push(type);
  input.deps.element = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };

  input.onPointerDown({ button: 0, clientX: 400, clientY: 300, pointerId: 1 });
  assert.deepEqual(dispatched, ['dragstart']);

  // A right-button release must not end the left drag.
  input.onPointerUp({ button: 2, clientX: 400, clientY: 300 });
  assert.deepEqual(dispatched, ['dragstart'], 'the drag is still running');
  assert.ok(input.drag);

  // Leaving the canvas closes the gesture instead of leaving it live.
  input.onPointerLeave({});
  assert.deepEqual(dispatched, ['dragstart', 'dragend']);
  assert.equal(input.drag, null);
});

test('WEB-28: growing a particle emitter releases the buffers it replaces', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'particles', 'fx'], ['parent', 1, 0],
    ['particles', 1, { preset: null, birthRate: 10, lifetime: 1, size: 0.01 }],
  ]);
  const emitter = consumer.emitters.get(1);
  let disposals = 0;
  emitter.geometry.addEventListener('dispose', () => { disposals += 1; });
  const capacityBefore = emitter.capacity;

  // A much higher birth rate forces a bigger buffer.
  consumer.apply([['particles', 1, { preset: null, birthRate: 5000, lifetime: 2, size: 0.01 }]]);
  assert.ok(emitter.capacity > capacityBefore, 'the emitter grew');
  assert.equal(disposals, 1, 'the previous attribute set was released');
  assert.equal(emitter.geometry.getAttribute('position').count, emitter.capacity);
});

test('particle direction fills the spread cone for every emission shape', async () => {
  const { consumer } = await makeConsumer();
  const spread = (shape, spreadAngle) => {
    consumer.apply([
      ['create', 1, 'particles', 'fx'], ['parent', 1, 0],
      ['particles', 1, {
        preset: null, shape, shapeSize: [0.2, 0.2, 0.2], birthRate: 2000, lifetime: 5,
        speed: 1, spreadAngle, size: 0.01, acceleration: [0, 0, 0], opacity: 1, opacityEnd: 1,
      }],
    ]);
    const emitter = consumer.emitters.get(1);
    emitter.update(0.5);
    let minY = 1; let maxY = -1;
    for (let i = 0; i < emitter.count; i++) {
      const speed = Math.hypot(emitter.vx[i], emitter.vy[i], emitter.vz[i]) || 1;
      const y = emitter.vy[i] / speed;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    consumer.apply([['destroy', 1]]);
    return { minY, maxY, count: emitter.count };
  };

  // A half-angle of PI is the whole sphere, whatever the birth shape.
  for (const shape of ['point', 'sphere', 'box', 'cone', 'plane']) {
    const result = spread(shape, Math.PI);
    assert.ok(result.count > 100, `${shape} emitted`);
    assert.ok(result.minY < -0.9, `${shape} sprays downward too (min ${result.minY.toFixed(2)})`);
    assert.ok(result.maxY > 0.9, `${shape} sprays upward too`);
  }

  // A narrow cone stays inside its half-angle and still fills it.
  const narrow = spread('cone', 0.5);
  assert.ok(narrow.minY > Math.cos(0.5) - 1e-3, 'nothing escapes the cone');
  assert.ok(narrow.minY < Math.cos(0.4), 'and the cone is filled, not hollow');

  // Zero spread is a straight beam.
  const beam = spread('point', 0);
  assert.ok(beam.minY > 0.999 && beam.maxY > 0.999);
});

test('particle variations are absolute, in the units of the value they vary', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'particles', 'fx'], ['parent', 1, 0],
    ['particles', 1, {
      preset: null, shape: 'point', birthRate: 2000, lifetime: 1, lifetimeVariation: 0.5,
      speed: 1, speedVariation: 0.5, size: 0.01, sizeVariation: 0.006,
      spreadAngle: 0, acceleration: [0, 0, 0], opacity: 1, opacityEnd: 1,
    }],
  ]);
  const emitter = consumer.emitters.get(1);
  emitter.update(0.5);
  let minSize = 1; let maxSize = 0; let minLife = 99; let maxLife = 0;
  for (let i = 0; i < emitter.count; i++) {
    minSize = Math.min(minSize, emitter.baseSize[i]);
    maxSize = Math.max(maxSize, emitter.baseSize[i]);
    minLife = Math.min(minLife, emitter.life[i]);
    maxLife = Math.max(maxLife, emitter.life[i]);
  }
  // size 0.01 +/- 0.006, not 0.01 * (1 +/- 0.006).
  assert.ok(minSize < 0.006 && maxSize > 0.014, `size spans ${minSize} to ${maxSize}`);
  assert.ok(minLife < 0.6 && maxLife > 1.4, `lifetime spans ${minLife} to ${maxLife}`);
});

test('particle point size uses the real projection factor', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'particles', 'fx'], ['parent', 1, 0],
    ['particles', 1, { preset: null, birthRate: 10, lifetime: 1, size: 0.01 }],
  ]);
  const emitter = consumer.emitters.get(1);
  // A 0.01 m particle one metre away at a 60 degree vertical fov on a 950 px
  // viewport is 0.01 * 950 / (2 * tan(30)) = 8.2 px across.
  emitter.setViewportScale(950, 60);
  const scale = emitter.material.uniforms.uScale.value;
  assert.ok(Math.abs(0.01 * scale / 1 - 8.227) < 0.01, `got ${(0.01 * scale).toFixed(3)} px at one metre`);
});

// ==================================== performance and robustness review fixes

test('PERF-10: console storage is bounded per frame and in total', async () => {
  const { consumer } = await makeConsumer();
  const batch = [];
  for (let i = 0; i < 1000; i++) batch.push(['log', 0, 'log', `line ${i}`]);
  consumer.apply(batch);

  // 200 lines plus the one that says the rest were suppressed.
  assert.equal(consumer.logs.length, 201);
  assert.match(consumer.logs[200].message, /suppressed after 200/);
  assert.equal(consumer.droppedLogs, 800, "every line past the budget is counted");

  // The per-frame budget resets with the frame.
  consumer.tick(1 / 60);
  consumer.apply([['log', 0, 'log', 'next frame']]);
  assert.equal(consumer.logs.at(-1).message, 'next frame');

  // And the total is a ring: 5000 lines is the ceiling.
  for (let frame = 0; frame < 60; frame++) {
    consumer.tick(1 / 60);
    const more = [];
    for (let i = 0; i < 200; i++) more.push(['log', 0, 'log', `f${frame}:${i}`]);
    consumer.apply(more);
  }
  assert.equal(consumer.logs.length, 5000);
  assert.ok(consumer.droppedLogs > 800, 'the overflow is counted, not silent');
  assert.equal(consumer.logs.at(-1).message, 'f59:199', 'the newest lines are the ones kept');
});

test('ROBUST-05: asset and relative urls are contained to the asset root', async () => {
  const { consumer } = await makeConsumer({ assetRoot: '/assets', scriptRoot: '/examples' });
  const resolve = (url) => consumer.resolveUrl(url);

  assert.equal(resolve('asset://a.png'), '/assets/a.png');
  assert.equal(resolve('asset://sub/./b.png'), '/assets/sub/b.png');
  // SPEC 3.5: a relative path is relative to the shared asset root.
  assert.equal(resolve('textures/wood.png'), '/assets/textures/wood.png');
  // The core prefixes its own assetRoot name, which is dropped before joining.
  assert.equal(resolve('assets/textures/wood.png'), '/assets/textures/wood.png');
  assert.equal(resolve('/absolute.png'), '/absolute.png');
  assert.equal(resolve('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(resolve('file:///etc/passwd'), 'file:///etc/passwd');

  // Traversal is refused, plain, percent-encoded, double-encoded and backslashed.
  for (const url of [
    'asset://../../outside.png',
    'asset://..%2f..%2fsecret.png',
    'asset://..%252f..%252fx.png',
    'asset://..\\..\\win.png',
    '../../../etc/shadow',
    'asset://..',
  ]) {
    assert.equal(resolve(url), null, `${url} must be refused`);
  }
  assert.ok(consumer.warnings.some((w) => w.includes('resolves outside the asset root')));

  // Credentials never reach a log, a dump or the wire.
  assert.equal(resolve('https://user:secret@example.com/a.png'), 'https://example.com/a.png');

  // A refused url starts no load and dispatches no result.
  const core = new RecordingCore();
  const { consumer: guarded } = await makeConsumer({ core, assetRoot: '/assets' });
  guarded.gltfLoader = { load: () => { throw new Error('must not be called'); } };
  guarded.apply([
    ['texture', 7, { url: 'asset://../../evil.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    ['create', 1, 'asset', 'a'], ['parent', 1, 0], ['asset', 1, { glb: 'asset://../../evil.glb' }],
  ]);
  assert.equal(guarded.textures.has(7), false, 'no texture entry for a refused url');
  assert.deepEqual(core.dispatched.map((d) => d.type), ['assetError']);
  assert.match(core.dispatched[0].payload.message, /resolves outside the asset root/);
});

test('MAINT-09: an unknown payload key warns once per opcode and key', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0],
    standardMaterialCommand(1, { sheen: 0.5, iridescence: 1 }),
  ]);
  const material = consumer.warnings.filter((w) => w.includes('material payload'));
  assert.equal(material.length, 2);
  assert.ok(material.some((w) => w.includes('"sheen"')));
  assert.ok(material.some((w) => w.includes('"iridescence"')));

  // The same key on a later command does not warn again.
  consumer.apply([standardMaterialCommand(1, { uuid: 'mat-2', sheen: 0.9 })]);
  assert.equal(consumer.warnings.filter((w) => w.includes('"sheen"')).length, 1);

  // Known keys are silent, on every payload the consumer reads.
  const { consumer: quiet } = await makeConsumer();
  quiet.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0], boxGeometryCommand(1), standardMaterialCommand(1),
    rigidBodyCommand(1),
    ['create', 2, 'directionalLight', 'sun'], ['parent', 2, 0],
    ['light', 2, { type: 'directional', color: [1, 1, 1], intensity: 1, distance: 0, decay: 2, angle: 0, penumbra: 0, castShadow: false, direction: [0, -1, 0] }],
    ['create', 3, 'anchor', 'a'], ['parent', 3, 0], ['anchor', 3, { kind: 'plane', plane: 'horizontal', minimumBounds: [0.2, 0.2] }],
  ]);
  assert.deepEqual(quiet.warnings, []);
});

test('MAINT-09: unknown light types and anchor kinds warn instead of passing', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'pointLight', 'odd'], ['parent', 1, 0],
    ['light', 1, { type: 'area', color: [1, 1, 1], intensity: 1, distance: 0, decay: 2, angle: 0, penumbra: 0, castShadow: false, direction: null }],
    ['create', 2, 'anchor', 'odd'], ['parent', 2, 0], ['anchor', 2, { kind: 'table' }],
  ]);
  assert.equal(consumer.warnings.filter((w) => w.includes('unknown light type "area"')).length, 1);
  assert.equal(consumer.warnings.filter((w) => w.includes('unknown anchor kind "table"')).length, 1);
  // Both still produce something usable rather than throwing.
  assert.equal(consumer.objects.get(1).intensity, 1);
  assert.equal(consumer.objects.get(2).parent, consumer.root);
});

test('the geometry revision decides a refill, and a re-send may carry no buffers', async () => {
  const { consumer } = await makeConsumer();
  const command = (id, revision, withBuffers) => {
    const full = boxGeometryCommand(id, 0.2, 0.2, 0.2, 'geo-shared');
    full[2].revision = revision;
    if (withBuffers) return full;
    return ['geometry', id, full[2], null, null, null, null];
  };

  // The first mesh carries the data; the next two are told it is unchanged.
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], command(1, '4:0:0:0:0', true),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], command(2, '4:0:0:0:0', false),
    ['create', 3, 'mesh', 'c'], ['parent', 3, 0], command(3, '4:0:0:0:0', false),
  ]);
  const geometry = consumer.objects.get(1).geometry;
  assert.equal(consumer.objects.get(2).geometry, geometry);
  assert.equal(consumer.objects.get(3).geometry, geometry);
  assert.equal(geometry.getAttribute('position').count, 8, 'the shared data survived the null re-sends');
  assert.deepEqual(consumer.warnings, []);

  // A plain BufferGeometry always arrives with buffers, and a new revision refills.
  const attribute = geometry.getAttribute('position');
  const version = attribute.version;
  const edited = command(1, '4:1:0:0:0', true);
  edited[3][0] = 7;
  consumer.apply([edited]);
  assert.ok(attribute.version > version, 'a new revision re-uploads');
  assert.ok(Math.abs(geometry.boundingBox.max.x - 7) < 1e-6);

  // Destroying every user keeps the entry, so a later mesh still gets the data.
  consumer.apply([['destroy', 1], ['destroy', 2], ['destroy', 3]]);
  assert.equal(consumer.geometries.get('geo-shared').users.size, 0);
  consumer.apply([['create', 4, 'mesh', 'late'], ['parent', 4, 0], command(4, '4:1:0:0:0', false)]);
  assert.equal(consumer.objects.get(4).geometry.getAttribute('position').count, 8,
    'a mesh added after the last user still gets the geometry');
  assert.deepEqual(consumer.warnings, []);

  // A new revision with no buffers cannot be honoured, so it says so.
  consumer.apply([command(4, '4:2:0:0:0', false)]);
  assert.equal(consumer.warnings.filter((w) => w.includes('without buffers')).length, 1);
  assert.equal(consumer.objects.get(4).geometry.getAttribute('position').count, 8, 'the old data is kept');
});

test('the idle geometry cache is bounded', async () => {
  const { consumer } = await makeConsumer({ physics: false });
  for (let id = 1; id <= 200; id++) {
    consumer.apply([
      ['create', id, 'mesh', `m${id}`], ['parent', id, 0],
      boxGeometryCommand(id, 0.02, 0.02, 0.02, `geo-${id}`),
      ['destroy', id],
    ]);
  }
  assert.equal(consumer._idleGeometries.size, 128);
  assert.equal(consumer.geometries.size, 128);
  assert.ok(consumer._idleGeometries.has('geo-200'), 'the newest idle entries are kept');
  assert.ok(!consumer._idleGeometries.has('geo-1'), 'the oldest are evicted');
});

test('PERF-07: a finished texture load touches only the materials that use it', async () => {
  const { consumer } = await makeConsumer();
  const loaded = [];
  consumer.textureLoader = {};
  consumer.imageLoader = { load: (url, onLoad) => loaded.push(onLoad) };
  consumer.apply([
    ['create', 1, 'mesh', 'textured'], ['parent', 1, 0],
    ['create', 2, 'mesh', 'plain'], ['parent', 2, 0],
    ['texture', 7, { url: 'asset://a.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    standardMaterialCommand(1, { uuid: 'mat-textured', maps: { map: 7, normalMap: null, roughnessMap: null, metalnessMap: null, emissiveMap: null } }),
    standardMaterialCommand(2, { uuid: 'mat-plain' }),
  ]);
  const textured = consumer.materials.get('mat-textured');
  const plain = consumer.materials.get('mat-plain');
  const before = { textured: textured.material.version, plain: plain.material.version };
  const otherEntryCount = consumer.materials.size;

  loaded[0]({ width: 4, height: 4 });

  // Only the texture is refreshed; no material is rebuilt and the cache is intact.
  assert.equal(consumer.materials.size, otherEntryCount, 'the material cache is not flushed');
  assert.equal(consumer.materials.get('mat-textured'), textured, 'and the entries are the same objects');
  assert.equal(plain.material.version, before.plain, 'an unrelated material is untouched');
  assert.equal(textured.material.version, before.textured, 'nor is the referencing material rebuilt');
  assert.equal(consumer.objects.get(1).material.map.image.width, 4, 'the texture itself has the pixels');
});
