// SPEC 14.3 to 14.6 and 14.12 on the web consumer: cameras, character
// controllers and force fields, skeletons and blend shapes, shader graph
// materials and multi-material meshes.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  makeConsumer, RecordingCore, boxGeometryCommand, standardMaterialCommand, transformCommand, rigidBodyCommand,
} from './helpers.mjs';

// ------------------------------------------------------------------ 14.3
test('14.3: the camera command drives perspective and orthographic cameras', async () => {
  const { consumer } = await makeConsumer();
  const builtIn = consumer.camera;
  // The camera is a real object; its transform rides `transforms` (SPEC 14.13).
  consumer.apply([
    ['create', 9, 'group', 'cam'], ['parent', 9, 0], transformCommand(9, [0.1, 0.2, 1.5]),
    ['camera', 9, {
      kind: 'perspective', fov: 55, near: 0.02, far: 30,
      left: null, right: null, top: null, bottom: null,
    }],
  ]);
  assert.notEqual(consumer.camera, builtIn, 'the script camera takes over');
  assert.equal(consumer.cameraId, 9);
  assert.equal(consumer.scriptCamera.parent, consumer.objects.get(9), 'it rides the object');
  assert.equal(consumer.camera.isPerspectiveCamera, true);
  assert.equal(consumer.camera.fov, 55);
  assert.equal(consumer.camera.near, 0.02);
  consumer.root.updateMatrixWorld(true);
  assert.deepEqual(
    consumer.camera.getWorldPosition(new THREE.Vector3()).toArray().map((n) => +n.toFixed(4)),
    [0.1, 0.2, 1.5],
    'the object transform moves the camera',
  );
  // The aspect is the consumer's, from the viewport, never the script's.
  assert.equal(consumer.camera.aspect, consumer.viewportAspect());

  consumer.apply([['camera', 9, {
    kind: 'orthographic', fov: null, near: 0.1, far: 10, left: -2, right: 2, top: 1, bottom: -1,
  }]]);
  assert.equal(consumer.camera.isOrthographicCamera, true);
  assert.equal(consumer.camera.top, 1);
  // SPEC 14.3: the height is the script's and the width follows the viewport,
  // which is square here, so the requested -2..2 becomes -1..1.
  assert.equal(consumer.camera.left, -1);
  assert.equal(consumer.camera.right, 1);
  const dumped = consumer.nativeDump().camera;
  assert.equal(dumped.kind, 'orthographic');
  assert.equal(dumped.left, -2, 'the dump keeps what the script asked for');
  assert.equal(dumped.right, 2);

  // A null kind hands the view back to the consumer's own camera.
  consumer.apply([['camera', 0, { kind: null }]]);
  assert.equal(consumer.camera, builtIn);
  assert.equal(consumer.nativeDump().camera, null);
});

test('14.3: rayFromPoint and scenePosition read the view', async () => {
  const { consumer } = await makeConsumer();
  consumer.renderer = { getDrawingBufferSize: (v) => v.set(800, 600) };
  consumer.setCameraPosition(0, 0, 1.2);
  consumer.apply([
    ['create', 1, 'mesh', 'target'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    boxGeometryCommand(1, 0.4, 0.4, 0.4),
  ]);
  consumer.root.updateMatrixWorld(true);

  const ray = consumer.rayFromPoint(400, 300);
  assert.equal(ray.length, 6);
  assert.ok(Math.abs(ray[0]) < 1e-6 && Math.abs(ray[1]) < 1e-6, 'a centre pixel starts on the axis');
  assert.ok(Math.abs(ray[5] + 1) < 1e-6, 'and points away from the camera');

  // A hit reports the surface; a miss falls back to the plane through the origin.
  const onMesh = consumer.scenePositionAt(400, 300);
  assert.ok(Math.abs(onMesh[2] - 0.2) < 1e-6, 'the front face of the box');
  const onPlane = consumer.scenePositionAt(10, 10);
  assert.ok(Math.abs(onPlane[2]) < 1e-6, 'the plane through the origin');
  consumer.renderer = null;
});

// ------------------------------------------------------------------ 14.4
test('14.4: a character controller moves, slides, and reports through syncCharacter', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.apply([
    ['create', 1, 'mesh', 'floor'], ['parent', 1, 0], transformCommand(1, [0, -0.5, 0]),
    boxGeometryCommand(1, 4, 0.1, 4), rigidBodyCommand(1, { type: 'static' }),
    ['create', 2, 'mesh', 'player'], ['parent', 2, 0], transformCommand(2, [0, 0.2, 0]),
    boxGeometryCommand(2, 0.2, 0.4, 0.2),
    ['characterController', 2, { radius: 0.1, height: 0.4, slopeLimit: 0.785, stepLimit: 0.1, gravity: true }],
  ]);
  assert.ok(consumer.characters.controllers.has(2));
  assert.ok(consumer.nativeDump().objects.find((o) => o.name === 'player').components.includes('CharacterControllerComponent'));

  // A move is applied on the next step, not immediately.
  consumer.apply([['characterMove', 2, 0.2, 0, 0]]);
  for (let i = 0; i < 40; i++) consumer.tick(1 / 60);
  const position = consumer.physics ? consumer.characters.controllers.get(2).body.translation() : null;
  assert.ok(position.x > 0.1, `the controller moved (x=${position.x.toFixed(3)})`);
  assert.ok(position.y > -0.4, 'and did not fall through the floor');
  assert.equal(consumer.characters.describe(2).isOnGround, true);

  const records = core.characterSyncs.at(-1);
  assert.equal(records.length, 8);
  assert.equal(records[0], 2);
  assert.equal(records[4], 1, 'isOnGround is reported');

  // Teleport is unconditional.
  consumer.apply([['characterTeleport', 2, 1, 2, 3]]);
  const teleported = consumer.characters.controllers.get(2).body.translation();
  assert.deepEqual([teleported.x, teleported.y, teleported.z].map((n) => +n.toFixed(3)), [1, 2, 3]);
});

test('14.4: every force field kind pushes a dynamic body the way its name says', async () => {
  const build = async (field) => {
    const { consumer } = await makeConsumer();
    consumer.apply([
      ['create', 1, 'mesh', 'ball'], ['parent', 1, 0], transformCommand(1, [0.2, 0, 0]),
      boxGeometryCommand(1, 0.1, 0.1, 0.1),
      rigidBodyCommand(1, { mass: 1, gravity: false, shape: 'box' }),
      ['create', 2, 'group', 'field'], ['parent', 2, 0], transformCommand(2, [0, 0, 0]),
      ['forceField', 2, field],
    ]);
    for (let i = 0; i < 30; i++) consumer.tick(1 / 60);
    const velocity = consumer.physics.bodies.get(1).body.linvel();
    return { consumer, velocity };
  };

  const constant = await build({ kind: 'ConstantForceField', enabled: true, radius: 10, mask: -1, force: [0, 1, 0] });
  assert.ok(constant.velocity.y > 0.05, 'a constant field pushes along its force');

  const radial = await build({ kind: 'RadialForceField', enabled: true, radius: 10, mask: -1, strength: 1, minimumDistance: 0.05, falloff: 'none' });
  assert.ok(radial.velocity.x > 0.05, 'a radial field pushes outward');

  const vortex = await build({ kind: 'VortexForceField', enabled: true, radius: 10, mask: -1, strength: 1, axis: [0, 1, 0] });
  assert.ok(Math.abs(vortex.velocity.z) > 0.05, 'a vortex pushes around its axis');

  const turbulence = await build({ kind: 'TurbulenceForceField', enabled: true, radius: 10, mask: -1, strength: 2, noiseScale: 3 });
  const speed = Math.hypot(turbulence.velocity.x, turbulence.velocity.y, turbulence.velocity.z);
  assert.ok(speed > 0.01, `turbulence pushes somewhere (speed ${speed.toFixed(4)})`);

  // A disabled field does nothing, and an unknown kind warns once.
  const off = await build({ kind: 'ConstantForceField', enabled: false, radius: 10, mask: -1, force: [0, 5, 0] });
  assert.ok(Math.abs(off.velocity.y) < 1e-6);
  const unknown = await build({ kind: 'MagnetForceField', enabled: true, radius: 10, mask: -1, strength: 1 });
  assert.equal(unknown.consumer.warnings.filter((w) => w.includes('unknown force field')).length, 1);
});

test('14.4: a drag field slows a moving body', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'ball'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    boxGeometryCommand(1, 0.1, 0.1, 0.1), rigidBodyCommand(1, { mass: 1, gravity: false, shape: 'box' }),
    ['bodyVelocity', 1, 2, 0, 0, null, null, null],
    ['create', 2, 'group', 'field'], ['parent', 2, 0],
    ['forceField', 2, { kind: 'DragForceField', enabled: true, radius: 10, mask: -1, coefficient: 4 }],
  ]);
  for (let i = 0; i < 40; i++) consumer.tick(1 / 60);
  assert.ok(consumer.physics.bodies.get(1).body.linvel().x < 1.5, 'drag took speed away');
});

// ------------------------------------------------------------------ 14.6
test('14.6: a shader graph material renders its fallback and warns once', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'glow'], ['parent', 1, 0], boxGeometryCommand(1),
    ['material', 1, {
      type: 'ShaderGraphMaterial', uuid: 'graph-1', source: 'assets/mats.usda', name: 'Glow',
      parameters: { roughness: 0.4 }, generation: 0,
      fallback: { type: 'MeshStandardMaterial', uuid: 'fallback-1', color: [0, 0, 1], opacity: 1, transparent: false, side: 0, wireframe: false, metalness: 0, roughness: 1, emissive: [0, 0, 0], emissiveIntensity: 1, clearcoat: 0, clearcoatRoughness: 0, depthWrite: true, depthTest: true, blending: 1, maps: {} },
    }],
  ]);
  const material = consumer.objects.get(1).material;
  assert.equal(material.type, 'MeshStandardMaterial', 'three renders the fallback');
  assert.ok(Math.abs(material.color.b - 1) < 1e-6);
  assert.equal(consumer.warnings.filter((w) => w.includes('ShaderGraphMaterial is RealityKit only')).length, 1);

  // The dump names the graph, not the fallback.
  const dumped = consumer.nativeDump().objects[0].material;
  assert.equal(dumped.type, 'ShaderGraphMaterial');
  assert.equal(dumped.source, 'assets/mats.usda');
  assert.equal(dumped.name, 'Glow');

  // setParameter updates a same-named fallback property.
  consumer.apply([['shaderParameter', 1, 'roughness', 0.25, 0]]);
  assert.equal(material.roughness, 0.25);
  assert.equal(consumer.nativeDump().objects[0].material.parameters.roughness, 0.25);

  // SPEC 14.6: a parameter the fallback has no property for is the core's to
  // report — it warns when the script sets it — so the consumer writes nothing
  // and says nothing, and the dump still carries the value.
  consumer.apply([['shaderParameter', 1, 'glowWidth', 2, 0]]);
  assert.equal('glowWidth' in material, false, 'nothing was invented on the material');
  assert.deepEqual(consumer.warnings.filter((w) => w.includes('glowWidth')), []);
  assert.equal(consumer.nativeDump().objects[0].material.parameters.glowWidth, 2);
});

test('14.3: an orthographic camera keeps its height and takes its width from the viewport', async () => {
  const orthographic = (left, right) => ['camera', 9, {
    kind: 'orthographic', fov: null, near: 0.01, far: 20,
    left, right, top: 0.3, bottom: -0.3,
  }];

  // A 2:1 viewport wants a width of 1.2 for a height of 0.6.
  const { consumer } = await makeConsumer();
  consumer.renderer = { getDrawingBufferSize: (v) => v.set(800, 400) };
  consumer.apply([['create', 9, 'group', 'cam'], ['parent', 9, 0]]);

  // Matching extents: honored silently.
  consumer.apply([orthographic(-0.6, 0.6)]);
  let camera = consumer.camera;
  assert.equal(camera.isOrthographicCamera, true);
  assert.equal(camera.top - camera.bottom, 0.6, 'the height comes from the script');
  assert.ok(Math.abs((camera.right - camera.left) - 1.2) < 1e-9, 'and the width matches the viewport');
  assert.deepEqual(consumer.warnings, []);
  // Within two percent is still silent.
  consumer.apply([orthographic(-0.606, 0.606)]);
  assert.deepEqual(consumer.warnings, []);

  // Mismatched extents: exactly one warning naming both numbers, and the height
  // is still the script's while the width follows the viewport.
  consumer.apply([orthographic(-0.3, 0.3)]);
  camera = consumer.camera;
  assert.equal(camera.top - camera.bottom, 0.6, 'the height is untouched');
  assert.ok(Math.abs((camera.right - camera.left) - 1.2) < 1e-9, 'the image does not stretch');
  // SPEC 14.3 fixes the wording, and the numbers, on both backends.
  const warned = consumer.warnings.filter((w) => w.includes('OrthographicCamera asks'));
  assert.equal(warned.length, 1, 'warned once');
  assert.equal(warned[0],
    'OrthographicCamera asks for a visible width of 0.600 but the viewport shows 1.200 at that '
    + 'height; the height is kept and the width follows the viewport');

  // A second mismatch does not warn again.
  consumer.apply([orthographic(-0.1, 0.1)]);
  assert.equal(consumer.warnings.filter((w) => w.includes('OrthographicCamera asks')).length, 1);

  // The dump keeps what the script asked for, not the derived frustum.
  const dumped = consumer.nativeDump().camera;
  assert.equal(dumped.left, -0.1);
  assert.equal(dumped.right, 0.1);
  assert.equal(dumped.top, 0.3);
  assert.equal(dumped.bottom, -0.3);

  // An off-centre frustum keeps its centre.
  consumer.apply([orthographic(0.4, 1.6)]);
  camera = consumer.camera;
  assert.ok(Math.abs((camera.left + camera.right) / 2 - 1) < 1e-9, 'the centre is preserved');
  assert.ok(Math.abs((camera.right - camera.left) - 1.2) < 1e-9);
  consumer.renderer = null;
});

test('P2-C-16: syncCharacter reports position, ground contact and velocity', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.apply([
    ['create', 1, 'mesh', 'floor'], ['parent', 1, 0], transformCommand(1, [0, -0.5, 0]),
    boxGeometryCommand(1, 4, 0.1, 4), rigidBodyCommand(1, { type: 'static' }),
    ['create', 2, 'mesh', 'player'], ['parent', 2, 0], transformCommand(2, [0, 0.2, 0]),
    boxGeometryCommand(2, 0.2, 0.4, 0.2),
    ['characterController', 2, { radius: 0.1, height: 0.4, slopeLimit: 0.785, stepLimit: 0.1, gravity: true }],
    ['characterMove', 2, 0.1, 0, 0],
  ]);
  for (let i = 0; i < 40; i++) consumer.tick(1 / 60);

  const records = consumer.characters.syncRecords();
  assert.equal(records.length, 8);
  assert.equal(records[0], 2);
  assert.ok(records[1] > 0.05, 'the reported x followed the move');
  assert.equal(records[4], 1, 'and it is on the ground');
  // The same records reach the core through the phase 2 channel.
  assert.ok(core.characterSyncs.length > 0);
  assert.equal(core.characterSyncs.at(-1)[0], 2);
});

test('P2-C-16: syncSkeleton reports joints only while tracking', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  let succeed = null;
  consumer.gltfLoader = { load: (url, onLoad) => { succeed = onLoad; } };
  consumer.apply([
    ['create', 1, 'asset', 'rig'], ['parent', 1, 0], ['asset', 1, { glb: 'asset://rig.glb' }],
  ]);
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = 'head';
  bone.position.set(0, 0.2, 0);
  root.add(bone);
  succeed({ scene: root, animations: [] });

  assert.deepEqual(consumer.trackedSkeletons(), [], 'nothing is reported until asked');
  consumer.apply([['skeleton', 1, { joints: {}, track: true }]]);
  const tracked = consumer.trackedSkeletons();
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0][0], 1);
  assert.deepEqual(tracked[0][1].head.slice(0, 3), [0, 0.2, 0]);

  consumer.tick(1 / 60);
  assert.equal(core.skeletonSyncs.at(-1).id, 1);

  // An empty payload retracts the tracking (SPEC 14.13).
  consumer.apply([['skeleton', 1, { joints: {}, track: false }]]);
  assert.deepEqual(consumer.trackedSkeletons(), []);
});

// ---------------------------------------- the remaining phase 2 review findings
test('P2-B-11: a force field mask says once that it is not applied', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'wind'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    ['forceField', 1, { kind: 'ConstantForceField', enabled: true, radius: 10, mask: 4, force: [1, 0, 0] }],
    ['create', 2, 'group', 'wind2'], ['parent', 2, 0],
    ['forceField', 2, { kind: 'ConstantForceField', enabled: true, radius: 10, mask: 8, force: [0, 1, 0] }],
  ]);
  const warned = consumer.warnings.filter((w) => w.includes('force field masks are not applied'));
  assert.equal(warned.length, 1, 'exactly once, naming the limitation');

  // And the field still runs: the mask is not used to silently filter it out.
  consumer.apply([
    ['create', 3, 'mesh', 'ball'], ['parent', 3, 0], transformCommand(3, [0.2, 0, 0]),
    boxGeometryCommand(3, 0.1, 0.1, 0.1), rigidBodyCommand(3, { mass: 1, gravity: false, shape: 'box' }),
  ]);
  for (let i = 0; i < 30; i++) consumer.tick(1 / 60);
  const velocity = consumer.physics.bodies.get(3).body.linvel();
  assert.ok(velocity.x > 0.05, `the masked field still pushed the body (${velocity.x})`);
});

test('P2-B-12: reverting a multi-material mesh records no error', async () => {
  const { consumer } = await makeConsumer();
  const geometry = boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-revert');
  geometry[2].groups = [
    { start: 0, count: 18, materialIndex: 0 },
    { start: 18, count: 18, materialIndex: 1 },
  ];
  consumer.apply([
    ['create', 1, 'mesh', 'crate'], ['parent', 1, 0], geometry,
    ['material', 1, [standardMaterialCommand(1, { uuid: 'ra' })[2], standardMaterialCommand(1, { uuid: 'rb' })[2]]],
  ]);
  consumer.apply([standardMaterialCommand(1, { uuid: 'rc', color: [0, 0, 1] })]);
  assert.deepEqual(consumer.errors, [], 'no error is recorded');
  const material = consumer.objects.get(1).material;
  assert.equal(Array.isArray(material), false);
  assert.ok(Math.abs(material.color.b - 1) < 1e-6, 'and the new material is the one in use');

  // Going back to an array and out again stays clean.
  consumer.apply([['material', 1, [standardMaterialCommand(1, { uuid: 'rd' })[2], standardMaterialCommand(1, { uuid: 're' })[2]]]]);
  consumer.apply([standardMaterialCommand(1, { uuid: 'rf' })]);
  assert.deepEqual(consumer.errors, []);
});

test('P2-B-13: opacity reaches every material of a multi-material mesh', async () => {
  const { consumer } = await makeConsumer();
  const geometry = boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-op');
  geometry[2].groups = [
    { start: 0, count: 18, materialIndex: 0 },
    { start: 18, count: 18, materialIndex: 1 },
  ];
  consumer.apply([
    ['create', 1, 'mesh', 'crate'], ['parent', 1, 0], geometry,
    ['material', 1, [standardMaterialCommand(1, { uuid: 'oa' })[2], standardMaterialCommand(1, { uuid: 'ob' })[2]]],
    ['opacity', 1, 0.25],
  ]);
  for (const material of consumer.objects.get(1).material) {
    assert.ok(Math.abs(material.opacity - 0.25) < 1e-6, `slot opacity ${material.opacity}`);
    assert.equal(material.transparent, true);
  }
  consumer.apply([['opacity', 1, 1]]);
  for (const material of consumer.objects.get(1).material) {
    assert.equal(material.opacity, 1);
    assert.equal(material.transparent, false);
  }
});

test('P2-B-27: a character teleport takes world coordinates onto a moved parent', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'rig'], ['parent', 1, 0], transformCommand(1, [1, 0, 0]),
    ['create', 2, 'mesh', 'player'], ['parent', 2, 1], transformCommand(2, [0, 0, 0]),
    boxGeometryCommand(2, 0.2, 0.4, 0.2),
    ['characterController', 2, { radius: 0.1, height: 0.4, gravity: false }],
    ['characterTeleport', 2, 2, 0.5, 0],
  ]);
  const object = consumer.objects.get(2);
  // The conversion happens in the teleport itself, before any frame sync.
  assert.deepEqual(object.position.toArray().map((n) => +n.toFixed(4)), [1, 0.5, 0]);
  consumer.tick(1 / 60);
  // The command is world space; `position` is relative to the parent at x = 1.
  assert.deepEqual(object.position.toArray().map((n) => +n.toFixed(4)), [1, 0.5, 0]);
  object.parent.updateMatrixWorld(true);
  assert.deepEqual(
    object.getWorldPosition(new THREE.Vector3()).toArray().map((n) => +n.toFixed(4)),
    [2, 0.5, 0],
  );
  const body = consumer.characters.controllers.get(2).body.translation();
  assert.ok(Math.abs(body.x - 2) < 1e-4, 'and the physics body agrees');
});

test('P2-B-31: a shader graph shared by uuid keeps its identity on every mesh', async () => {
  const { consumer } = await makeConsumer();
  const graph = {
    type: 'ShaderGraphMaterial', uuid: 'graph-shared', source: 'assets/spatial-materials.usda',
    name: 'Glow', parameters: { roughness: 0.4 }, generation: 0,
    fallback: standardMaterialCommand(0, { uuid: 'graph-shared-fallback', color: [0, 0, 1] })[2],
  };
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], boxGeometryCommand(1), ['material', 1, graph],
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], boxGeometryCommand(2), ['material', 2, graph],
  ]);
  const objects = consumer.nativeDump().objects;
  for (const object of objects) {
    assert.equal(object.material.type, 'ShaderGraphMaterial', `${object.name} keeps the graph type`);
    assert.equal(object.material.name, 'Glow');
    assert.equal(object.material.source, 'assets/spatial-materials.usda');
  }
  // Each mesh takes its own parameter, even though the fallback is shared.
  consumer.apply([['shaderParameter', 2, 'roughness', 0.9, 0]]);
  assert.equal(consumer.nativeDump().objects[1].material.parameters.roughness, 0.9);
});

test('P2-B-32: a shader parameter binds a texture id and a material index', async () => {
  const { consumer } = await makeConsumer();
  const graph = (uuid, color) => ({
    type: 'ShaderGraphMaterial', uuid, source: 'assets/spatial-materials.usda', name: uuid,
    parameters: {}, generation: 0,
    fallback: standardMaterialCommand(0, { uuid: `${uuid}-f`, color })[2],
  });
  consumer.apply([
    ['texture', 7, { url: 'asset://checker.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    ['create', 1, 'mesh', 'panel'], ['parent', 1, 0], boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-sp'),
    ['material', 1, [graph('g0', [1, 0, 0]), graph('g1', [0, 1, 0])]],
  ]);
  // A map parameter names a texture id, not an object.
  consumer.apply([['shaderParameter', 1, 'map', 7, 1]]);
  const materials = consumer.objects.get(1).material;
  assert.equal(materials[0].map, null, 'slot 0 is untouched');
  assert.ok(materials[1].map && materials[1].map.isTexture, 'slot 1 took the texture');
  assert.equal(consumer.nativeDump().objects[0].material[1].parameters.map, 7,
    'and the dump records the id the script set');

  // An unknown id says so rather than binding nothing silently.
  consumer.apply([['shaderParameter', 1, 'map', 99, 0]]);
  assert.equal(consumer.warnings.filter((w) => w.includes('unknown texture id 99')).length, 1);
});

test('P2-B-34: the native dump describes every slot of a multi-material mesh', async () => {
  const { consumer } = await makeConsumer();
  const geometry = boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-dump');
  geometry[2].groups = [
    { start: 0, count: 18, materialIndex: 0 },
    { start: 18, count: 18, materialIndex: 1 },
  ];
  const solid = standardMaterialCommand(1, { uuid: 'da', color: [1, 0, 0], metalness: 0.25, roughness: 0.75, side: 2, wireframe: true })[2];
  const graph = {
    type: 'ShaderGraphMaterial', uuid: 'db', source: 'assets/spatial-materials.usda', name: 'Rim',
    parameters: { rimWidth: 0.3 }, generation: 0,
    fallback: standardMaterialCommand(1, { uuid: 'db-f', color: [0, 1, 0] })[2],
  };
  consumer.apply([
    ['create', 1, 'mesh', 'crate'], ['parent', 1, 0], geometry, ['material', 1, [solid, graph]],
  ]);
  const dumped = consumer.nativeDump().objects[0].material;
  assert.equal(dumped.length, 2);
  assert.equal(dumped[0].type, 'MeshStandardMaterial');
  assert.deepEqual(dumped[0].color.map((n) => +n.toFixed(3)), [1, 0, 0]);
  assert.equal(dumped[0].metalness, 0.25);
  assert.equal(dumped[0].roughness, 0.75);
  assert.equal(dumped[0].side, 2);
  assert.equal(dumped[0].wireframe, true);
  // The second slot keeps its graph fields, not the fallback's.
  assert.equal(dumped[1].type, 'ShaderGraphMaterial');
  assert.equal(dumped[1].name, 'Rim');
  assert.equal(dumped[1].parameters.rimWidth, 0.3);
});

test('FA-26: script joint poses come back when a native animation stops', async () => {
  const { consumer } = await makeConsumer();
  let succeed = null;
  consumer.gltfLoader = { load: (url, onLoad) => { succeed = onLoad; } };
  consumer.apply([
    ['create', 1, 'asset', 'rig'], ['parent', 1, 0], ['asset', 1, { glb: 'asset://rig.glb' }],
  ]);

  // A rig with one bone and one morph target, and a clip that drives both.
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = 'head';
  root.add(bone);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geometry.morphAttributes.position = [new THREE.BufferAttribute(new Float32Array(9), 3)];
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = 'body';
  mesh.morphTargetDictionary = { widen: 0 };
  mesh.morphTargetInfluences = [0];
  root.add(mesh);
  const clip = new THREE.AnimationClip('wave', 0.5, [
    new THREE.VectorKeyframeTrack('head.position', [0, 0.5], [0, 0, 0, 0, 1, 0]),
    new THREE.NumberKeyframeTrack('body.morphTargetInfluences[widen]', [0, 0.5], [0, 1]),
  ]);
  succeed({ scene: root, animations: [clip] });

  // The script poses the rig, then plays a clip that overrides it.
  consumer.apply([
    ['skeleton', 1, { joints: { head: [0, 0.5, 0, 0, 0, 0, 1] }, track: false }],
    ['blendShapes', 1, { widen: 0.25 }],
  ]);
  assert.equal(bone.position.y, 0.5);
  assert.equal(mesh.morphTargetInfluences[0], 0.25);

  consumer.apply([['assetAnimation', 1, 'wave', false, 1]]);
  // 0.45 s into a half-second clip: the track is most of the way to 1.
  for (let i = 0; i < 27; i++) consumer.tick(1 / 60);
  assert.ok(bone.position.y > 0.7, `the clip owns the pose while it runs (${bone.position.y})`);
  assert.ok(mesh.morphTargetInfluences[0] > 0.7, 'and the weights');

  // The clip is LoopOnce: when it finishes, the script's poses come back.
  for (let i = 0; i < 45; i++) consumer.tick(1 / 60);
  assert.ok(Math.abs(bone.position.y - 0.5) < 1e-6, `the held pose is restored (${bone.position.y})`);
  assert.ok(Math.abs(mesh.morphTargetInfluences[0] - 0.25) < 1e-6,
    `the held weight is restored (${mesh.morphTargetInfluences[0]})`);

  // And stopping a clip by hand does the same, without waiting a frame.
  consumer.apply([['assetAnimation', 1, 'wave', true, 1]]);
  for (let i = 0; i < 10; i++) consumer.tick(1 / 60);
  consumer.apply([['assetAnimation', 1, null, false, 1]]);
  assert.ok(Math.abs(bone.position.y - 0.5) < 1e-6, 'a stopped clip hands the rig straight back');
  assert.ok(Math.abs(mesh.morphTargetInfluences[0] - 0.25) < 1e-6);
});

test('FA-27: a shader parameter updates any same-named fallback property', async () => {
  const { consumer } = await makeConsumer();
  const fallback = standardMaterialCommand(1, { uuid: 'fa27-fallback', color: [0, 0, 1] })[2];
  consumer.apply([
    ['create', 1, 'mesh', 'glow'], ['parent', 1, 0], boxGeometryCommand(1),
    ['material', 1, {
      type: 'ShaderGraphMaterial', uuid: 'fa27', source: 'assets/spatial-materials.usda',
      name: 'Glow', parameters: {}, generation: 0, fallback,
    }],
  ]);
  const material = consumer.objects.get(1).material;

  // Not a member of any fixed list: it exists on the fallback, so it is set.
  consumer.apply([['shaderParameter', 1, 'envMapIntensity', 4, 0]]);
  assert.equal(material.envMapIntensity, 4, 'the rendered material took it');
  assert.equal(consumer.nativeDump().objects[0].material.parameters.envMapIntensity, 4,
    'and the dump reports what the script set');

  // Other families keep working through the same path.
  consumer.apply([['shaderParameter', 1, 'flatShading', true, 0]]);
  assert.equal(material.flatShading, true);
  consumer.apply([['shaderParameter', 1, 'emissive', [1, 0, 0], 0]]);
  assert.ok(Math.abs(material.emissive.r - 1) < 1e-6);

  // A name with no matching property writes nothing; the core is the one that
  // warns about it (SPEC 14.6), so the warning lists stay identical.
  consumer.apply([['shaderParameter', 1, 'glowWidth', 2, 0]]);
  consumer.apply([['shaderParameter', 1, 'glowWidth', 3, 0]]);
  assert.equal('glowWidth' in material, false);
  assert.deepEqual(consumer.warnings.filter((w) => w.includes('glowWidth')), []);
  // The dump still carries it, because the script did set it on the graph.
  assert.equal(consumer.nativeDump().objects[0].material.parameters.glowWidth, 3);
});

test('AR-31: a force field cannot accelerate a body past the SPEC 14.4 clamp', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'pebble'], ['parent', 1, 0], transformCommand(1, [0.04, 0, 0]),
    boxGeometryCommand(1, 0.04, 0.04, 0.04),
    rigidBodyCommand(1, { mass: 0.25, gravity: false, shape: 'box' }),
    ['create', 2, 'group', 'blast'], ['parent', 2, 0], transformCommand(2, [0, 0, 0]),
    // The COOKBOOK's own numbers: inverse-square at 4 cm is a huge force.
    ['forceField', 2, {
      kind: 'RadialForceField', enabled: true, radius: 0.3, mask: -1,
      strength: 0.6, minimumDistance: 0.04, falloff: 'inverseSquare',
    }],
  ]);
  // The contract is per step: no single step may change a body's velocity by
  // more than 1000 m/s^2 times the step, however mis-scaled the field is.
  const body = consumer.physics.bodies.get(1).body;
  let worst = 0;
  let previous = 0;
  for (let i = 0; i < 120; i++) {
    consumer.tick(1 / 60);
    const v = body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    worst = Math.max(worst, speed - previous);
    previous = speed;
  }
  // 1000 m/s^2 over a 1/60 s step is 16.7 m/s, plus the fraction of a step
  // Rapier's own integration adds. Unclamped this scene adds 25.0 m/s a step
  // and reaches 3000 m/s; clamped it adds 17.5 and reaches 2104.
  const budget = (1000 / 60) * 1.1;
  assert.ok(worst <= budget, `a step added ${worst.toFixed(2)} m/s, over the ${budget.toFixed(2)} m/s clamp`);
  const warned = consumer.warnings.filter((w) => w.includes('clamped to 1000 m/s^2'));
  assert.equal(warned.length, 1, consumer.warnings.join(' | '));
  assert.match(warned[0], /RadialForceField on "blast"/);

  // A field within the bound says nothing and is not scaled.
  const { consumer: gentle } = await makeConsumer();
  gentle.apply([
    ['create', 1, 'mesh', 'pebble'], ['parent', 1, 0], transformCommand(1, [0.2, 0, 0]),
    boxGeometryCommand(1, 0.04, 0.04, 0.04),
    rigidBodyCommand(1, { mass: 0.25, gravity: false, shape: 'box' }),
    ['create', 2, 'group', 'breeze'], ['parent', 2, 0], transformCommand(2, [0, 0, 0]),
    ['forceField', 2, { kind: 'ConstantForceField', enabled: true, radius: 5, mask: -1, force: [0.5, 0, 0] }],
  ]);
  for (let i = 0; i < 60; i++) gentle.tick(1 / 60);
  const gentleVelocity = gentle.physics.bodies.get(1).body.linvel();
  // f = 0.5 N on 0.25 kg is 2 m/s^2, so about 2 m/s after a second.
  assert.ok(Math.abs(gentleVelocity.x - 2) < 0.2, `gentle field gave ${gentleVelocity.x} m/s`);
  assert.deepEqual(gentle.warnings.filter((w) => w.includes('clamped')), []);
});

test('AR-31: the scenario gate fails a scene whose bodies run away', async () => {
  const { runawayBodies, MAX_SPEED, MAX_DISTANCE } = await import('../harness/native-check.mjs');

  // The gate itself, either side of each bound. The bounds are scene scale:
  // every scenario in the suite lives inside a couple of metres.
  assert.equal(MAX_DISTANCE, 10);
  assert.equal(MAX_SPEED, 20);
  assert.deepEqual(runawayBodies({ objects: [{ name: 'ok', worldPosition: [1, 2, 3], velocity: [5, 0, 0] }] }), []);
  const far = runawayBodies({ objects: [{ name: 'gone', worldPosition: [12, 0, 0], velocity: [0, 0, 0] }] });
  assert.equal(far.length, 1);
  assert.match(far[0], /12\.0 m from the origin/);
  const fast = runawayBodies({ objects: [{ name: 'bullet', worldPosition: [0, 0, 0], velocity: [25, 0, 0] }] });
  assert.match(fast[0], /25\.0 m\/s/);
  const broken = runawayBodies({ objects: [{ name: 'nan', worldPosition: [NaN, 0, 0], velocity: [0, 0, 0] }] });
  assert.match(broken[0], /non-finite position/);

  // The COOKBOOK's own recipe, with the numbers the docs now carry, run through
  // the real consumer: three 0.25 kg pebbles over a 0.8 m slab.
  const { consumer } = await makeConsumer();
  const commands = [
    ['create', 1, 'mesh', 'ground'], ['parent', 1, 0], transformCommand(1, [0, -0.26, 0]),
    boxGeometryCommand(1, 0.8, 0.02, 0.8),
    rigidBodyCommand(1, { type: 'static', shape: 'box', friction: 0.9 }),
    ['create', 2, 'group', 'repeller'], ['parent', 2, 0], transformCommand(2, [0, -0.1, 0]),
    ['forceField', 2, {
      kind: 'RadialForceField', enabled: true, radius: 0.3, mask: -1,
      strength: 0.011, minimumDistance: 0.15, falloff: 'inverseSquare',
    }],
    ['create', 3, 'group', 'molasses'], ['parent', 3, 0], transformCommand(3, [0, -0.1, 0]),
    ['forceField', 3, { kind: 'DragForceField', enabled: true, radius: 0.45, mask: -1, coefficient: 1.6 }],
  ];
  [[0.08, -0.02, 0.06], [-0.06, 0.04, -0.05], [0.02, 0.1, 0.12]].forEach((at, i) => {
    const id = 10 + i;
    commands.push(
      ['create', id, 'mesh', `pebble-${i}`], ['parent', id, 0], transformCommand(id, at),
      boxGeometryCommand(id, 0.06, 0.06, 0.06),
      rigidBodyCommand(id, { type: 'dynamic', mass: 0.25, shape: 'sphere', restitution: 0.4 }),
    );
  });
  consumer.apply(commands);
  for (let i = 0; i < 120; i++) consumer.tick(1 / 60);

  // Two seconds in, they have drifted a little and all but stopped, which is
  // what the recipe's prose promises.
  const native = consumer.nativeDump();
  assert.deepEqual(runawayBodies(native), []);
  const pebbles = native.objects.filter((o) => /^pebble-/.test(o.name));
  assert.equal(pebbles.length, 3);
  for (const pebble of pebbles) {
    const distance = Math.hypot(pebble.worldPosition[0], pebble.worldPosition[1] + 0.1, pebble.worldPosition[2]);
    const speed = Math.hypot(...pebble.velocity);
    assert.ok(distance < 2, `${pebble.name} is ${distance.toFixed(2)} m from the field`);
    assert.ok(speed < 2, `${pebble.name} is moving at ${speed.toFixed(2)} m/s`);
    // And they are resting on the slab, not through it.
    assert.ok(pebble.worldPosition[1] > -0.26, `${pebble.name} fell through the ground`);
  }
  // No field asked for more than the SPEC 14.4 clamp allows.
  assert.deepEqual(consumer.warnings.filter((w) => w.includes('clamped')), []);
});

test('SPEC 14.6: setParameter never writes the fallback material identity', async () => {
  const { consumer } = await makeConsumer();
  const fallback = standardMaterialCommand(1, { uuid: 'identity-fallback', color: [0, 0, 1] })[2];
  consumer.apply([
    ['create', 1, 'mesh', 'glow'], ['parent', 1, 0], boxGeometryCommand(1),
    ['create', 2, 'mesh', 'twin'], ['parent', 2, 0], boxGeometryCommand(2),
    ['material', 1, {
      type: 'ShaderGraphMaterial', uuid: 'identity-graph', source: 'assets/spatial-materials.usda',
      name: 'Glow', parameters: {}, generation: 0, fallback,
    }],
  ]);
  const material = consumer.objects.get(1).material;
  const before = {
    uuid: material.uuid, id: material.id, type: material.type,
    name: material.name, version: material.version,
  };

  for (const [key, value] of [['uuid', 'hijacked'], ['id', 999], ['type', 'MeshBasicMaterial'],
    ['name', 'renamed'], ['version', 42]]) {
    consumer.apply([['shaderParameter', 1, key, value, 0]]);
    assert.equal(material[key], before[key], `${key} was not written`);
  }
  // The core warns for every denied field when the script sets it, so the
  // consumer refuses the write in silence rather than saying it twice.
  assert.deepEqual(consumer.warnings.filter((w) => w.includes('identity')), []);

  // The dump still reports what the script set (SPEC 14.6).
  const parameters = consumer.nativeDump().objects[0].material.parameters;
  assert.equal(parameters.uuid, 'hijacked');
  assert.equal(parameters.version, 42);

  // The material is still shareable and still renders: a second mesh binding the
  // same graph uuid gets the same instance.
  consumer.apply([['material', 2, {
    type: 'ShaderGraphMaterial', uuid: 'identity-graph', source: 'assets/spatial-materials.usda',
    name: 'Glow', parameters: {}, generation: 0, fallback,
  }]]);
  assert.equal(consumer.objects.get(2).material, material, 'sharing by uuid still works');

  // A real parameter still lands.
  consumer.apply([['shaderParameter', 1, 'roughness', 0.25, 0]]);
  assert.equal(material.roughness, 0.25);
});
