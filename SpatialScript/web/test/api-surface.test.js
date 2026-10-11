// MAINT-07: entry points the web consumer exposes that had no test. Each is
// silent-failure shaped, so a regression would only show up as a screenshot diff.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Portal } from '../src/portals.js';
import { ParticleEmitter } from '../src/particles.js';
import { InputController } from '../src/input.js';
import { makeConsumer, RecordingCore, boxGeometryCommand, transformCommand } from './helpers.mjs';

test('setAssetAnimation plays, restarts, stops and reports a missing clip', async () => {
  const { consumer } = await makeConsumer();
  let succeed = null;
  consumer.gltfLoader = { load: (url, onLoad) => { succeed = onLoad; } };
  consumer.apply([
    ['create', 1, 'asset', 'robot'], ['parent', 1, 0], ['asset', 1, { glb: 'asset://robot.glb' }],
  ]);

  const root = new THREE.Group();
  const bone = new THREE.Object3D();
  bone.name = 'bone';
  root.add(bone);
  const track = new THREE.VectorKeyframeTrack('bone.position', [0, 1], [0, 0, 0, 0, 1, 0]);
  const clips = [new THREE.AnimationClip('walk', 1, [track]), new THREE.AnimationClip('idle', 1, [track])];
  succeed({ scene: root, animations: clips });

  const entry = consumer.assets.get(1);
  assert.ok(entry, 'the asset registered its mixer');
  assert.deepEqual(entry.clips.map((c) => c.name), ['walk', 'idle']);

  consumer.apply([['assetAnimation', 1, 'walk', true, 1.5]]);
  assert.ok(entry.action, 'an action is running');
  assert.equal(entry.action.timeScale, 1.5);
  assert.equal(entry.action.loop, THREE.LoopRepeat);
  assert.equal(entry.action.isRunning(), true);

  // A one-shot replaces the looping action rather than stacking on it.
  const looping = entry.action;
  consumer.apply([['assetAnimation', 1, 'idle', false, 1]]);
  assert.notEqual(entry.action, looping);
  assert.equal(entry.action.loop, THREE.LoopOnce);
  assert.equal(entry.action.clampWhenFinished, true);
  assert.equal(looping.isRunning(), false, 'the previous action was stopped');

  // The mixer advances the bone the clip drives.
  consumer.updateVisuals(0.5);
  assert.ok(bone.position.y > 0.2, `the mixer ran (y=${bone.position.y})`);

  consumer.apply([['assetAnimation', 1, null, false, 1]]);
  assert.equal(entry.action, null, 'null stops playback');

  consumer.apply([['assetAnimation', 1, 'sprint', true, 1]]);
  assert.equal(consumer.warnings.filter((w) => w.includes('"sprint" not found')).length, 1);
});

test('loadAsset succeeds into the object and reports animations and bounds', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  let succeed = null;
  consumer.gltfLoader = { load: (url, onLoad) => { succeed = onLoad; } };
  consumer.apply([
    ['create', 1, 'asset', 'robot'], ['parent', 1, 0], ['asset', 1, { usdz: 'asset://r.usdz', glb: 'asset://robot.glb' }],
  ]);
  assert.equal(consumer.pendingLoads, 1);

  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.1), new THREE.MeshStandardMaterial());
  root.add(mesh);
  succeed({ scene: root, animations: [new THREE.AnimationClip('walk', 1, [])] });

  assert.equal(consumer.objects.get(1).children.includes(root), true, 'the gltf is under the asset object');
  assert.equal(consumer.pendingLoads, 0);
  const dispatched = core.dispatched.find((d) => d.type === 'assetLoaded');
  assert.ok(dispatched);
  assert.deepEqual(dispatched.payload.animations, ['walk']);
  // A flat six-number box, which is the shape the core reads back.
  assert.equal(dispatched.payload.boundingBox.length, 6);
  assert.deepEqual(dispatched.payload.boundingBox.map((n) => +n.toFixed(3)), [-0.2, -0.1, -0.05, 0.2, 0.1, 0.05]);
  assert.equal(consumer.assetIdForUrl('asset://r.usdz'), 1, 'either url resolves the id');
  assert.equal(consumer.assetIdForUrl('asset://robot.glb'), 1);
});

test('textureIdForUrl resolves by the script url and by the resolved one', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['texture', 7, {
    url: 'asset://grid.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true,
  }]]);
  assert.equal(consumer.textureIdForUrl('asset://grid.png'), 7);
  assert.equal(consumer.textureIdForUrl('/assets/grid.png'), 7);
  assert.equal(consumer.textureIdForUrl('asset://other.png'), undefined);
  consumer.apply([['texture', 7, null]]);
  assert.equal(consumer.textureIdForUrl('asset://grid.png'), undefined, 'a released id no longer resolves');
});

test('consumerRoots covers the camera only while it holds anchored content', async () => {
  const { consumer } = await makeConsumer();
  assert.deepEqual(consumer.consumerRoots(), [consumer.root]);
  consumer.apply([
    ['create', 1, 'anchor', 'head'], ['parent', 1, 0], ['anchor', 1, { kind: 'head' }],
  ]);
  assert.deepEqual(consumer.consumerRoots(), [consumer.root, consumer.camera]);
  consumer.apply([['destroy', 1]]);
  assert.deepEqual(consumer.consumerRoots(), [consumer.root]);
});

test('resize keeps the renderer size and the camera aspect together', async () => {
  const { consumer } = await makeConsumer();
  const sizes = [];
  consumer.renderer = { setSize: (w, h) => sizes.push([w, h]) };
  consumer.resize(1400, 950);
  assert.deepEqual(sizes, [[1400, 950]]);
  assert.ok(Math.abs(consumer.camera.aspect - 1400 / 950) < 1e-9);
  // Without a renderer it is a no-op rather than a throw.
  consumer.renderer = null;
  assert.doesNotThrow(() => consumer.resize(10, 10));
});

test('Portal.updateCamera copies the viewer camera and builds the projective matrix', () => {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  const portal = new Portal(mesh, { worldId: 1, width: 0.4, height: 0.3, crossing: false }, 64);
  const camera = new THREE.PerspectiveCamera(55, 1.6, 0.02, 90);
  camera.position.set(0.2, 0.4, 1.1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  portal.updateCamera(camera);

  // A window, not a mirror: the render camera is the viewer's camera.
  assert.deepEqual(portal.camera.position.toArray(), camera.position.toArray());
  assert.equal(portal.camera.fov, 55);
  assert.equal(portal.camera.aspect, 1.6);
  assert.deepEqual(portal.camera.quaternion.toArray(), camera.quaternion.toArray());

  // A world point projects to the same place through the texture matrix as it
  // does on screen, which is what keeps world content inside the surface.
  const world = new THREE.Vector3(0.05, 0.02, -0.4);
  // Vector4 keeps w, which the shader divides by.
  const projected = new THREE.Vector4(world.x, world.y, world.z, 1).applyMatrix4(portal.textureMatrix);
  const uv = [projected.x / projected.w, projected.y / projected.w];
  const ndc = world.clone().project(camera);
  assert.ok(Math.abs(uv[0] - ((ndc.x + 1) / 2)) < 1e-6);
  assert.ok(Math.abs(uv[1] - ((ndc.y + 1) / 2)) < 1e-6);

  portal.resizeTarget(128, 96);
  assert.equal(portal.target.width, 128);
  assert.equal(portal.target.height, 96);
  portal.dispose();
});

test('ParticleEmitter.setViewportScale follows the field of view', () => {
  const owner = new THREE.Group();
  const emitter = new ParticleEmitter(owner, 1);
  emitter.setViewportScale(950, 60);
  const wide = emitter.material.uniforms.uScale.value;
  emitter.setViewportScale(950, 30);
  const narrow = emitter.material.uniforms.uScale.value;
  // A narrower lens magnifies, so the same particle covers more pixels.
  assert.ok(narrow > wide);
  assert.ok(Math.abs(wide - 950 / (2 * Math.tan(Math.PI / 6))) < 1e-6);
  emitter.dispose();
});

test('InputController.endSessions and manipulatedObjects report the live gesture', () => {
  const dispatched = [];
  const object = new THREE.Object3D();
  object.userData.__spatialId = 3;
  const input = new InputController({
    element: null,
    camera: new THREE.PerspectiveCamera(),
    pickables: () => [],
    idOf: (o) => o.userData.__spatialId,
    interactiveAncestor: () => null,
    isManipulable: () => true,
    dispatch: (type, id) => dispatched.push([type, id]),
  });

  assert.deepEqual(input.manipulatedObjects(), []);
  input.manipulation = { object };
  assert.deepEqual(input.manipulatedObjects(), [object]);

  input.endSessions();
  assert.deepEqual(dispatched, [['manipulationend', 3]]);
  assert.equal(input.manipulation, null);
  assert.deepEqual(input.manipulatedObjects(), []);

  // A drag closes with a dragend carrying the translation so far.
  dispatched.length = 0;
  input.drag = {
    dragTarget: object,
    start: new THREE.Vector3(0, 0, 0),
    last: new THREE.Vector3(0.2, 0.1, 0),
  };
  input.endSessions();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0][0], 'dragend');
  assert.equal(input.drag, null);

  // clearSessions drops the references without dispatching anything.
  dispatched.length = 0;
  input.hovered = object;
  input.drag = { dragTarget: object, start: new THREE.Vector3(), last: new THREE.Vector3() };
  input.clearSessions();
  assert.deepEqual(dispatched, []);
  assert.equal(input.hovered, null);
  assert.equal(input.drag, null);
});

test('the parity viewport probe survives an orthographic scripted camera', async () => {
  const { consumer } = await makeConsumer();
  // The probe parity.mjs runs, in the same shape.
  const probe = () => {
    const camera = consumer.camera;
    return {
      kind: camera.isOrthographicCamera ? 'orthographic' : 'perspective',
      scripted: consumer.scriptCamera !== null,
      aspect: camera.isOrthographicCamera ? null : camera.aspect,
      fov: camera.isOrthographicCamera ? null : camera.fov,
      frustum: camera.isOrthographicCamera
        ? [camera.left, camera.right, camera.top, camera.bottom]
        : null,
    };
  };

  const builtIn = probe();
  assert.equal(builtIn.kind, 'perspective');
  assert.equal(builtIn.scripted, false);
  assert.equal(typeof builtIn.aspect, 'number');
  assert.doesNotThrow(() => builtIn.aspect.toFixed(4));

  consumer.apply([
    ['create', 9, 'group', 'cam'], ['parent', 9, 0],
    ['camera', 9, {
      kind: 'orthographic', fov: null, near: 0.01, far: 20,
      left: -0.3, right: 0.3, top: 0.3, bottom: -0.3,
    }],
  ]);
  const scripted = probe();
  assert.equal(scripted.kind, 'orthographic');
  assert.equal(scripted.scripted, true);
  // An orthographic camera has no aspect or fov, which is what used to throw.
  assert.equal(scripted.aspect, null);
  assert.equal(scripted.fov, null);
  assert.deepEqual(scripted.frustum, [-0.3, 0.3, 0.3, -0.3]);
  assert.doesNotThrow(() => scripted.frustum.map((n) => n.toFixed(2)).join('/'));

  // And it still dumps, with no perspective fields invented.
  const dumped = consumer.nativeDump().camera;
  assert.equal(dumped.kind, 'orthographic');
  assert.equal(dumped.fov, null);
  assert.equal(dumped.left, -0.3);
});
