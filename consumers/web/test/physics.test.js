// Physics and picking (SPEC 3.7).
// Rapier bodies, colliders and joints; collision events; raycasts and the rules
// about what a ray may hit.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  makeConsumer, RecordingCore, boxGeometryCommand, standardMaterialCommand, rigidBodyCommand, transformCommand, transformsCommand,
} from './helpers.mjs';

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

  // The badge rides the camera, so the ray that finds it is the camera's own.
  const target = badge.getWorldPosition(new THREE.Vector3());
  const eye = consumer.camera.getWorldPosition(new THREE.Vector3());
  const dir = target.clone().sub(eye).normalize();
  const hits = consumer.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, -1);
  assert.equal(hits[0], 2, 'the anchored mesh is raycastable');
  assert.ok(Math.abs(badge.material.opacity - 0.25) < 1e-6, 'opacity reaches it');
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

test('FA-11: a loaded asset and a collider-only group yield at most one hit each', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    // An object whose visual is a subtree of meshes the command stream never named.
    ['create', 1, 'asset', 'rig'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    ['create', 2, 'mesh', 'plate'], ['parent', 2, 0], transformCommand(2, [0, 0, 0.5]),
    boxGeometryCommand(2, 0.4, 0.4, 0.4), rigidBodyCommand(2, { type: 'static', shape: 'box' }),
  ]);
  const asset = consumer.objects.get(1);
  for (const z of [0, -0.2, -0.4]) {
    const child = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial());
    child.position.z = z;
    asset.add(child);
  }
  const nested = new THREE.Group();
  const deep = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial());
  deep.position.z = 0.1;
  nested.add(deep);
  asset.add(nested);
  consumer.root.updateMatrixWorld(true);

  const hits = consumer.raycast(0, 0, 2, 0, 0, -1, -1);
  const ids = [];
  for (let i = 0; i < hits.length; i += 8) ids.push(hits[i]);
  assert.deepEqual(ids, [2, 1], 'one record per object, nearest first');
  // The asset's one record is its nearest surface anywhere in the subtree,
  // which here is the mesh nested one level deeper, not the first child hit.
  const assetDistance = hits[15];
  assert.ok(Math.abs(assetDistance - 1.7) < 1e-6, `asset hit at ${assetDistance}`);

  // SPEC 3.7 picks visible meshes: a group that has a collider only because it
  // carries a rigidBody is not a hit, however close it is.
  consumer.apply([
    ['create', 3, 'group', 'bare'], ['parent', 3, 0], transformCommand(3, [0, 0, 1]),
    rigidBodyCommand(3, { type: 'static', shape: 'box' }),
  ]);
  consumer.root.updateMatrixWorld(true);
  const again = consumer.raycast(0, 0, 2, 0, 0, -1, -1);
  const againIds = [];
  for (let i = 0; i < again.length; i += 8) againIds.push(again[i]);
  assert.deepEqual(againIds, [2, 1], 'the mesh-less group adds nothing');
});
