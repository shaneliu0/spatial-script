// The consumer's own runtime (SPEC 5, 6, 8, 12).
// Object kinds and unknown opcodes, input and the two dumps, error and log
// bounds, url containment, hot swap and teardown.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CAMERA_PRESETS } from '../src/consumer/consumer.js';
import {
  makeConsumer, RecordingCore, boxGeometryCommand, standardMaterialCommand, rigidBodyCommand, transformCommand,
} from './helpers.mjs';

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

test('gravity is applied to the world', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['gravity', 0, 0, -5, 0]]);
  assert.equal(consumer.physics.world.gravity.y, -5);
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

// ------------------------------------------------ native dump (parity gate)
/**
 * SPEC 8's native dump shape rule. The key sets below are the core dump's, which
 * both consumers mirror; they were cross-checked against
 * `Packages/SpatialScriptRuntime/Sources/RealityKitScripting/Dump/ScriptingNativeDump.swift`
 * (`nativeDump` top level, `describe` per object) and
 * `Dump/ScriptingNativeDump+Phase2.swift` (`phase2SceneDump`, `phase2Dump`).
 * The web dump must carry the same keys under the same conditions, or a field
 * can go missing on one backend and no gate notices.
 */
const SWIFT_TOP_LEVEL_KEYS = [
  'backend', 'platform', 'frame', 'elapsed', 'objects', 'joints',
  'gravity', 'scene', 'loadGeneration', 'droppedErrors', 'environment',
  'warnings', 'errors',
  // phase 2 (SPEC 14.13), which the core dump carries too
  'isActive', 'camera', 'sceneUnderstanding', 'render', 'environmentLighting',
  'debug', 'controllers', 'audioMixer', 'hostFunctions',
];
/** The keys `describe(_:)` always sets, whatever the object turns out to be. */
const SWIFT_OBJECT_KEYS = [
  'id', 'name', 'type', 'parent', 'visible', 'position', 'quaternion', 'scale',
  'worldPosition', 'opacity', 'billboard', 'groundingShadow', 'hoverEffect',
  'manipulable', 'castShadow', 'receiveShadow', 'renderOrder', 'world',
  'interactive', 'geometry', 'material', 'light', 'rigidBody',
  // the two SPEC 8 additions
  'nativeType', 'components',
];
/** Keys `describe(_:)` and `phase2Dump(_:)` add only when the feature is there. */
const SWIFT_CONDITIONAL_OBJECT_KEYS = [
  'velocity', 'isSleeping', 'isOnGround', 'asset', 'loaded', 'animations',
  'anchor', 'isAnchored', 'portal', 'particles',
  'audio', 'video', 'characterController', 'forceField', 'skeleton', 'blendShapes',
  'accessibility',
];
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
  assert.deepEqual(Object.keys(dump).sort(), SWIFT_TOP_LEVEL_KEYS.slice().sort(),
    'the top-level key set is the core dump\'s (SPEC 8)');
  assert.equal(dump.backend, 'three');
  assert.equal(dump.objects.length, 3);
  assert.deepEqual(dump.gravity, [0, -5, 0]);
  assert.equal(dump.environment, null);
  // SPEC 8: the core counts loads from 1, so the first scene is generation 1.
  assert.equal(dump.loadGeneration, 1);
  assert.equal(dump.render.adaptiveResolution, false);
  assert.deepEqual(Object.keys(dump.scene).sort(), ['childCount', 'name']);

  const cube = dump.objects.find((o) => o.name === 'cube');
  for (const key of SWIFT_OBJECT_KEYS) assert.ok(key in cube, `every object carries ${key}`);
  const extra = Object.keys(cube).filter((k) => !SWIFT_OBJECT_KEYS.includes(k));
  for (const key of extra) {
    assert.ok(SWIFT_CONDITIONAL_OBJECT_KEYS.includes(key),
      `${key} is a key the Swift dump also emits`);
  }
  // This mesh has a rigid body, so it reports the motion the core reports too.
  assert.deepEqual(extra, ['velocity', 'isSleeping']);
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
  // SPEC 8: the five flags the core dumps, whatever the command carried.
  assert.deepEqual(cube.interactive,
    { tap: true, hover: false, drag: true, manipulation: false, collision: false });
  assert.equal(cube.geometry.type, 'BoxGeometry');
  assert.equal(cube.geometry.parameters.width, 0.2);

  // Material values come from the three.js material, with the object's own
  // OpacityComponent kept out of the material's opacity.
  assert.equal(cube.material.type, 'MeshStandardMaterial');
  // The native class is a component name, not a material key (SPEC 8).
  assert.ok(cube.components.includes('nativeMaterial:MeshStandardMaterial'));
  assert.ok(Math.abs(cube.material.color[0] - 0.25) < 1e-6);
  assert.ok(Math.abs(cube.material.color[2] - 0.75) < 1e-6);
  assert.equal(cube.material.metalness, 0.3);
  assert.equal(cube.material.opacity, 1);
  assert.equal(cube.rigidBody.type, 'static', 'read back from the physics body');
  assert.deepEqual(cube.components,
    ['ModelComponent', 'CollisionComponent', 'PhysicsBodyComponent', 'InputTargetComponent',
      'OpacityComponent', 'BillboardComponent', 'ManipulationComponent',
      'nativeMaterial:MeshStandardMaterial']);

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

// --------------------------------------------------- warnings and environment
test('consumer warnings are registered with the core under a consumer: key', async () => {
  const registered = [];
  const core = new RecordingCore();
  core.runtime = { warnOnce: (key, message) => registered.push([key, message]) };
  const { consumer } = await makeConsumer({ core });

  consumer.apply([['create', 1, 'mesh', 'm'], ['nonsense', 1, {}], ['nonsense', 1, {}]]);
  assert.equal(registered.length, 1, 'once per key, however often the command repeats');
  assert.equal(registered[0][0], 'consumer:opcode:nonsense');
  assert.match(registered[0][1], /unknown command opcode "nonsense"/);
  // The consumer keeps its own copy for the native dump.
  assert.equal(consumer.warnings.length, 1);

  // AR-36: a fact the core already warns about is not warned about again here.
  consumer.apply([['groundingShadow', 1, true], ['video', 1, { url: 'asset://spatial-bars.webm', width: 0.4, docking: true }]]);
  assert.deepEqual(registered.map((r) => r[0]), ['consumer:opcode:nonsense'],
    'groundingShadow and video docking are the core\'s to report');
});

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

test('WEB-15: manualBridge lets load events through but not input events', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.setManualBridge(true);
  consumer.dispatch('tap', 1, {});
  consumer.dispatch('collisionstart', 1, {});
  consumer.dispatch('textureLoaded', 1, {});
  consumer.dispatch('assetError', 1, { message: 'x' });
  assert.deepEqual(core.dispatched.map((d) => d.type), ['textureLoaded', 'assetError']);
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

test('FA-19: the default camera is the Mac RealityView camera', async () => {
  const { consumer } = await makeConsumer();
  // SPEC 14.3: (0, 0.25, 1.4) looking at the origin, 60 degree vertical fov.
  assert.deepEqual(consumer.camera.position.toArray(), [0, 0.25, 1.4]);
  assert.equal(consumer.camera.fov, 60);
  assert.equal(consumer.camera, consumer.builtInCamera);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(consumer.camera.quaternion);
  const toOrigin = consumer.camera.position.clone().negate().normalize();
  assert.ok(forward.distanceTo(toOrigin) < 1e-6, 'it looks at the origin');
  // The world matrix is composed, so picking works before the first render.
  const eye = consumer.camera.getWorldPosition(new THREE.Vector3());
  assert.deepEqual(eye.toArray().map((n) => +n.toFixed(6)), [0, 0.25, 1.4]);

  // The mac preset asks for the same camera, so `?preset=mac` only changes the
  // viewport size and background.
  assert.deepEqual(CAMERA_PRESETS.mac.camera, [0, 0.25, 1.4]);
  assert.equal(CAMERA_PRESETS.mac.fov, 60);

  // An explicit camera still wins.
  const { consumer: custom } = await makeConsumer({ camera: [1, 2, 3], fov: 30 });
  assert.deepEqual(custom.camera.position.toArray(), [1, 2, 3]);
  assert.equal(custom.camera.fov, 30);
});

// AR-30: the warning catalogue is only true if every warning the consumer emits
// reaches `dump().warnings`. These two tests hold that: one enumerates the call
// sites in the source, the other drives one warning out of every module and
// checks it arrives through the core's own channel.

/** A core that keeps the warnings its runtime was given, the way the real one does. */
function coreWithWarningChannel() {
  const seen = [];
  const core = new RecordingCore();
  core.runtime = {
    warnOnce(key, message) {
      if (seen.some((w) => w.key === key)) return;
      seen.push({ key, message });
    },
  };
  core.dump = () => ({ objects: [], warnings: seen.map((w) => w.message), errors: [] });
  core.seenWarnings = seen;
  return core;
}

test('AR-30: every warning site in the consumer goes through the routed warnOnce', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');
  const srcDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../src');

  const files = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  await walk(srcDir);
  assert.ok(files.length >= 10, `found ${files.length} consumer source files`);

  const sites = [];
  const strays = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const isPage = file.endsWith('page.js');
    text.split('\n').forEach((line, index) => {
      const where = `${path.relative(srcDir, file)}:${index + 1}`;
      // Every warning must funnel through a warnOnce that reaches the core: the
      // consumer's own method, or a module's injected `deps.warnOnce`.
      if (/\bwarnOnce\(/.test(line)) {
        const routed = /this\.warnOnce\(|deps\.warnOnce\(|warnOnce\(key, message\)|warnOnce: |runtime\.warnOnce\(|warnOnce\(k, m\)|warnOnce\(m, m\)/.test(line);
        if (!routed) strays.push(`${where}: ${line.trim()}`);
        if (/this\.warnOnce\(|deps\.warnOnce\(/.test(line)) sites.push(where);
      }
      // A bare console.warn would never reach the dump. The page's dev UI is
      // not the consumer and reports its own failures that way.
      if (!isPage && /(?<!\.)\bconsole\.(warn|error)\(/.test(line) && !line.trim().startsWith('*')) {
        strays.push(`${where}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(strays, [], 'every warning site routes through warnOnce');
  assert.ok(sites.length >= 30, `${sites.length} routed warning sites found`);
});

test('AR-30: a warning from every consumer module lands in dump().warnings', async () => {
  const core = coreWithWarningChannel();
  const { consumer } = await makeConsumer({ core });

  // One warning out of each module that owns any, driven by the command stream.
  consumer.apply([
    // consumer/features.js — an unknown light type, an unknown anchor kind,
    // a visionOS-only flag and an unsupported portal option.
    ['create', 1, 'pointLight', 'lamp'], ['parent', 1, 0],
    ['light', 1, { type: 'laser', color: [1, 1, 1], intensity: 1, distance: 0, decay: 2, angle: 0, penumbra: 0, castShadow: false, direction: null }],
    ['create', 2, 'anchor', 'anchor'], ['parent', 2, 0], ['anchor', 2, { kind: 'orbit' }],
    ['sceneUnderstanding', 0, { collision: true, occlusion: false, physics: false, shadows: false }],
    ['create', 3, 'portal', 'window'], ['parent', 3, 0],
    ['portal', 3, { width: 0.5, height: 0.5, worldId: null, crossing: true }],
    // consumer/resources.js — an unknown payload key.
    ['create', 4, 'mesh', 'crate'], ['parent', 4, 0],
    standardMaterialCommand(4, { sparkle: true }),
    // media/audio.js — a browser with no Web Audio still tracks the sound.
    ['audio', 4, { url: 'asset://spatial-tone.wav', spatial: false, ambient: false, loop: false, volume: 1, rate: 1, group: 'master', refDistance: 1, rolloff: 1, distanceModel: 'inverse', cone: null, reverbLevel: 0 }],
    // physics/character.js — a force field mask is not applied here.
    ['create', 5, 'group', 'wind'], ['parent', 5, 0],
    ['forceField', 5, { kind: 'ConstantForceField', enabled: true, radius: 1, mask: 4, force: [1, 0, 0] }],
    // consumer/consumer.js — an unknown opcode.
    ['nonsense', 0, {}],
  ]);
  // consumer/host.js — a fetch outside the asset root.
  consumer.apply([['fetch', 9, { url: 'asset://../../secrets.txt', kind: 'text' }]]);
  // consumer/assets.js — an .exr environment.
  consumer.apply([['environment', 0, { url: 'asset://studio.exr', intensity: 1 }]]);

  const wanted = [
    'unknown light type "laser"',
    'unknown anchor kind "orbit"',
    'raycasts will not see the real world',
    'Portal crossing is unsupported',
    '"sparkle"',
    'this browser has no Web Audio',
    'force field masks are not applied',
    'unknown command opcode "nonsense"',
    '.exr environments are unsupported',
  ];
  const dumped = consumer.dump().warnings;
  for (const text of wanted) {
    assert.ok(dumped.some((w) => w.includes(text)), `dump().warnings carries "${text}" (got ${JSON.stringify(dumped)})`);
    // And it got there through the core, not only through the consumer's copy.
    assert.ok(core.seenWarnings.some((w) => w.message.includes(text)),
      `the core's warning channel carries "${text}"`);
  }
  // The core sees every consumer warning under a namespaced key (C-12).
  assert.ok(core.seenWarnings.every((w) => w.key.startsWith('consumer:')),
    JSON.stringify(core.seenWarnings.map((w) => w.key)));
  // And each one only once, however many times the command repeats.
  const before = core.seenWarnings.length;
  consumer.apply([['nonsense', 0, {}], ['nonsense', 0, {}]]);
  assert.equal(core.seenWarnings.length, before, 'warn once per key per scene');
});

test('AR-29: the consumer never dispatches an event type outside SPEC 6', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.apply([['create', 1, 'mesh', 'm'], ['parent', 1, 0]]);

  // Every type the consumer really sends is on the list.
  for (const type of ['tap', 'hoverenter', 'dragstart', 'collisionstart', 'assetLoaded',
    'textureError', 'loaded', 'ended', 'audioState', 'hostResult', 'fetchResult']) {
    consumer.dispatch(type, 1, {});
  }
  assert.equal(core.dispatched.length, 11, 'the listed types go through');

  // A typo or a version skew is named, once, and not delivered.
  consumer.dispatch('bogusEvent', 1, {});
  consumer.dispatch('bogusEvent', 1, {});
  assert.equal(core.dispatched.length, 11, 'the unlisted type was not dispatched');
  const warned = consumer.warnings.filter((w) => w.includes('bogusEvent'));
  assert.equal(warned.length, 1, warned.join(' | '));
  assert.match(warned[0], /is not a SPEC 6 event type/);
  assert.ok(consumer.dump().warnings.some((w) => w.includes('bogusEvent')));
});

test('SPEC 12: a consumer warning prints exactly one console line per key', async () => {
  // A core that behaves like the real one: `warnOnce` records the warning and
  // answers with the `log` command the consumer prints on the way back in.
  const registered = [];
  const core = new RecordingCore();
  const queue = [];
  core.runtime = {
    warnOnce(key, message) {
      if (registered.some((r) => r[0] === key)) return;
      registered.push([key, message]);
      queue.push(['log', 0, 'warn', message]);
    },
  };
  core.tick = () => queue.splice(0, queue.length);

  const printed = [];
  const { consumer } = await makeConsumer({ core, console: { warn: (m) => printed.push(m), log: () => {}, error: () => {} } });

  consumer.apply([['create', 1, 'mesh', 'm'], ['parent', 1, 0], ['nonsense', 1, {}]]);
  // The warning is registered with the core and printed by nobody yet.
  assert.equal(registered.length, 1);
  assert.deepEqual(printed, [], 'the consumer does not print it itself');

  // The core's log command comes back on the next tick: one line, once.
  const lines = (list) => list.filter((m) => String(m).includes('nonsense'));
  consumer.tick(1 / 60);
  assert.deepEqual(lines(printed), ['unknown command opcode "nonsense"']);
  assert.deepEqual(lines(consumer.logs.map((l) => l.message)), ['unknown command opcode "nonsense"']);

  // Repeating the command says nothing more, anywhere.
  consumer.apply([['nonsense', 1, {}], ['nonsense', 1, {}]]);
  consumer.tick(1 / 60);
  assert.equal(lines(printed).length, 1, printed.join(' | '));
  assert.equal(lines(consumer.logs.map((l) => l.message)).length, 1);
  assert.equal(consumer.warnings.filter((w) => w.includes('nonsense')).length, 1);

  // A core that cannot take the warning leaves the line to the consumer, so a
  // headless run still sees it exactly once.
  const bareLines = [];
  const bare = await makeConsumer({ core: new RecordingCore(), console: { warn: (m) => bareLines.push(m), log: () => {}, error: () => {} } });
  bare.consumer.apply([['create', 1, 'mesh', 'm'], ['parent', 1, 0], ['nonsense', 1, {}], ['nonsense', 1, {}]]);
  assert.deepEqual(bareLines, ['unknown command opcode "nonsense"'], 'printed once by the consumer itself');
  assert.equal(bare.consumer.logs.length, 1);
});
