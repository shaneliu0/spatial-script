// The scene graph the consumer draws (SPEC 3.2, 3.6, 3.9, 3.10, 3.11).
// Creating, parenting and destroying objects; transforms in both forms; lights,
// opacity and billboards; particles, anchors, portals and the environment.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CAMERA_PRESETS } from '../src/consumer/consumer.js';
import {
  makeConsumer, RecordingCore, boxGeometryCommand, standardMaterialCommand, rigidBodyCommand, transformCommand, transformsCommand,
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
  // AR-36: the core already warns that groundingShadow does nothing on this
  // backend, so the consumer accepts the command in silence and the dump reports
  // the flag as unset.
  assert.deepEqual(consumer.warnings.filter((w) => w.includes('groundingShadow')), []);
  assert.equal(consumer.nativeDump().objects[0].groundingShadow, false);
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

test('the consumer does not retain the transforms buffer between frames', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['create', 1, 'mesh', 'a'], ['parent', 1, 0]]);
  // The core reuses one buffer, so overwriting it after the call must change nothing.
  const command = transformsCommand([{ id: 1, position: [0.25, 0, 0] }]);
  consumer.apply([command]);
  command[2].fill(0);
  assert.deepEqual(consumer.objects.get(1).position.toArray().map((n) => +n.toFixed(4)), [0.25, 0, 0]);
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

test('AR-22: visibility reaches the object, the dump and the pick list', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'holder'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    ['create', 2, 'mesh', 'shown'], ['parent', 2, 1], transformCommand(2, [0, 0, 0]),
    boxGeometryCommand(2, 0.2, 0.2, 0.2), standardMaterialCommand(2),
    ['create', 3, 'mesh', 'hidden'], ['parent', 3, 1], transformCommand(3, [0.5, 0, 0]),
    boxGeometryCommand(3, 0.2, 0.2, 0.2), standardMaterialCommand(3),
    ['visible', 3, false],
  ]);
  consumer.root.updateMatrixWorld(true);
  assert.equal(consumer.objects.get(2).visible, true);
  assert.equal(consumer.objects.get(3).visible, false, 'the command reached the object');

  // It reaches the dump the parity gate reads...
  const byName = Object.fromEntries(consumer.nativeDump().objects.map((o) => [o.name, o]));
  assert.equal(byName.shown.visible, true);
  assert.equal(byName.hidden.visible, false);

  // ...and a hidden mesh is neither picked nor raycast (SPEC 3.7).
  assert.equal(consumer.pickables().includes(consumer.objects.get(3)), false);
  const hits = consumer.raycast(0.5, 0, 2, 0, 0, -1, -1);
  assert.deepEqual(Array.from(hits), [], 'a hidden mesh is not a hit');

  // Hiding a parent hides the subtree in the renderer.
  consumer.apply([['visible', 1, false], ['visible', 3, true]]);
  consumer.root.updateMatrixWorld(true);
  assert.equal(consumer.pickables().length, 0, 'nothing under a hidden group is pickable');
  consumer.apply([['visible', 1, true]]);
  consumer.root.updateMatrixWorld(true);
  assert.equal(consumer.pickables().length, 2, 'and it all comes back');
});

test('SPEC 3.2: a billboard faces the camera without changing its reported rotation', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'label'], ['parent', 1, 0],
    // An authored rotation the script chose, and a billboard flag over it.
    ['transform', 1, 0, 0.2, 0, 0, 0.3826834, 0, 0.9238795, 1, 1, 1],
    boxGeometryCommand(1), standardMaterialCommand(1),
    ['billboard', 1, true],
  ]);
  const object = consumer.objects.get(1);
  const authored = object.quaternion.clone();

  // The camera looks down at the scene, so facing it is a real rotation.
  consumer.updateVisuals(1 / 60);
  assert.ok(object.quaternion.angleTo(authored) > 0.01, 'the render really faces the camera');

  // But both dumps report what the script set (SPEC 3.2, SPEC 8).
  const record = consumer.nativeDump().objects[0];
  assert.deepEqual(record.quaternion.map((n) => +n.toFixed(6)),
    authored.toArray().map((n) => +n.toFixed(6)));
  assert.equal(record.billboard, true);
  assert.ok(record.components.includes('BillboardComponent'), record.components.join(','));

  // A new authored rotation replaces the reported one, facing or not.
  consumer.apply([['transform', 1, 0, 0.2, 0, 0, 0, 0, 1, 1, 1, 1]]);
  consumer.updateVisuals(1 / 60);
  assert.deepEqual(consumer.nativeDump().objects[0].quaternion, [0, 0, 0, 1]);

  // Turning the billboard off hands the object back to its authored rotation.
  consumer.apply([['billboard', 1, false], ['transform', 1, 0, 0.2, 0, 0, 0.3826834, 0, 0.9238795, 1, 1, 1]]);
  consumer.updateVisuals(1 / 60);
  assert.deepEqual(consumer.nativeDump().objects[0].quaternion.map((n) => +n.toFixed(6)),
    authored.toArray().map((n) => +n.toFixed(6)));
  assert.deepEqual(consumer.objects.get(1).quaternion.toArray().map((n) => +n.toFixed(6)),
    authored.toArray().map((n) => +n.toFixed(6)), 'and the object stops facing');
});
