// SPEC section 14 on the web consumer. Behaviours that need a real browser
// (Web Audio, video decoding, GLTF skinning) run in headless Chromium against
// the real core; the rest run against hand-built command arrays.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeConsumer, RecordingCore, boxGeometryCommand, standardMaterialCommand, transformCommand, rigidBodyCommand } from './helpers.mjs';

const audioCommand = (id, overrides = {}) => ['audio', id, {
  url: 'asset://spatial-tone.wav', spatial: false, ambient: false, loop: false, volume: 1, rate: 1,
  group: 'master', refDistance: 1, rolloff: 1, distanceModel: 'inverse', cone: null, reverbLevel: 0,
  ...overrides,
}];

// ------------------------------------------------------------------ 14.1

test('14.1: audio state is tracked and described even with no Web Audio', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'chime'], ['parent', 1, 0],
    audioCommand(1, { loop: true, volume: 0.5, group: 'effects' }),
    ['audioMixer', 0, { masterVolume: 0.8, groups: { effects: 0.4 }, state: 'running' }],
  ]);
  const described = consumer.audio.describe(1);
  assert.equal(described.url, 'asset://spatial-tone.wav');
  assert.equal(described.loop, true);
  assert.equal(described.volume, 0.5);
  assert.equal(described.group, 'effects');
  assert.equal(described.spatial, false);
  assert.deepEqual(consumer.audio.mixerState().groups, { effects: 0.4 });
  assert.equal(consumer.audio.mixerState().masterVolume, 0.8);
  // Without Web Audio the engine says so once rather than pretending.
  assert.equal(consumer.warnings.filter((w) => w.includes('no Web Audio')).length, 1);
  assert.equal(consumer.nativeDump().objects[0].components.includes('ChannelAudioComponent'), true);
});

test('14.1: a positional source keeps its cone and rolloff, an ambient one is flagged', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'engine'], ['parent', 1, 0],
    audioCommand(1, { spatial: true, refDistance: 0.3, rolloff: 1.4, distanceModel: 'exponential', cone: [60, 140, 0.25], reverbLevel: -6 }),
    ['create', 2, 'group', 'room'], ['parent', 2, 0],
    audioCommand(2, { ambient: true, volume: 0.6 }),
  ]);
  const engine = consumer.audio.describe(1);
  assert.equal(engine.spatial, true);
  assert.deepEqual(engine.cone, [60, 140, 0.25]);
  assert.equal(engine.distanceModel, 'exponential');
  assert.equal(engine.reverbLevel, -6);
  assert.equal(consumer.audio.describe(2).ambient, true);
  const components = (name) => consumer.nativeDump().objects.find((o) => o.name === name).components;
  assert.ok(components('engine').includes('SpatialAudioComponent'));
  assert.ok(components('room').includes('AmbientAudioComponent'));
});

// ------------------------------------------------------------------ 14.2

test('14.2: a video screen keeps its state and reports it in the dump', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'screen'], ['parent', 1, 0], boxGeometryCommand(1), standardMaterialCommand(1),
    ['video', 1, { url: 'asset://spatial-bars.webm', width: 0.4, height: 0.225, loop: true, muted: true, autoplay: false, docking: true, volume: 0.5, rate: 1.5 }],
  ]);
  const described = consumer.video.describe(1);
  assert.equal(described.url, 'asset://spatial-bars.webm');
  assert.equal(described.loop, true);
  assert.equal(described.muted, true);
  assert.equal(described.rate, 1.5);
  assert.ok(consumer.nativeDump().objects[0].components.includes('VideoPlayerComponent'));

  consumer.apply([['video', 1, null]]);
  assert.equal(consumer.video.describe(1), null);
});

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

  // A parameter with no matching property says so once.
  consumer.apply([['shaderParameter', 1, 'glowWidth', 2, 0]]);
  assert.equal(consumer.warnings.filter((w) => w.includes('"glowWidth"')).length, 1);
});

// ------------------------------------------------------------------ 14.7

test('14.7: scene understanding is kept and warned about once', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['sceneUnderstanding', 0, { collision: true, occlusion: false, physics: false, shadows: true }]]);
  assert.deepEqual(consumer.nativeDump().sceneUnderstanding,
    { collision: true, occlusion: false, physics: false, shadows: true });
  assert.equal(consumer.warnings.filter((w) => w.includes('scene understanding is visionOS only')).length, 1);
  consumer.apply([['sceneUnderstanding', 0, { collision: true, occlusion: true, physics: true, shadows: true }]]);
  assert.equal(consumer.warnings.filter((w) => w.includes('scene understanding')).length, 1, 'warned once');
});

// ------------------------------------------------------------------ 14.9

test('14.9: mouse edges, click counts, scroll and connected flags reach the core', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  const input = consumer.input;
  input.deps.element = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };

  input.onPointerDown({ button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  input.onWheel({ deltaX: 3, deltaY: -7 });
  consumer.tick(1 / 60);
  let state = core.inputs.at(-1);
  assert.deepEqual(state.mouse.pressed, [true, false, false]);
  assert.deepEqual(state.mouse.buttons, [true, false, false]);
  assert.deepEqual(state.mouse.pressCount, [1, 0, 0]);
  assert.deepEqual(state.mouse.scroll, [3, -7]);
  assert.equal(state.mouse.connected, true);
  assert.equal(state.keyboard.connected, false, 'no key has arrived yet');

  // The edge lasts one frame; scroll is per frame.
  consumer.tick(1 / 60);
  state = core.inputs.at(-1);
  assert.deepEqual(state.mouse.pressed, [false, false, false]);
  assert.deepEqual(state.mouse.scroll, [0, 0]);

  input.onPointerUp({ button: 0, clientX: 100, clientY: 100 });
  consumer.tick(1 / 60);
  assert.deepEqual(core.inputs.at(-1).mouse.released, [true, false, false]);

  // A second click within 400 ms counts as two.
  input.onPointerDown({ button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  consumer.tick(1 / 60);
  assert.equal(core.inputs.at(-1).mouse.pressCount[0], 2);

  input.onKeyDown({ code: 'KeyA' });
  consumer.tick(1 / 60);
  assert.equal(core.inputs.at(-1).keyboard.connected, true);
});

// ------------------------------------------------------------------ 14.10

test('14.10: the host channel carries events, calls and fetches both ways', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  const seen = [];
  consumer.host.on('score', (payload) => seen.push(payload));

  consumer.apply([['hostEvent', 0, 'score', { value: 7 }]]);
  assert.deepEqual(seen, [{ value: 7 }]);
  assert.deepEqual(consumer.host.drain(), [{ name: 'score', payload: { value: 7 } }]);

  // A registered function answers with hostResult.
  consumer.host.register('MyApp', 'save', async (args) => ({ ok: true, slot: args.slot }));
  consumer.apply([['hostCall', 11, 'MyApp.save', { slot: 2 }]]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const answer = core.dispatched.find((d) => d.type === 'hostResult');
  assert.deepEqual(answer.payload, { value: { ok: true, slot: 2 } });
  assert.equal(answer.id, 11);
  assert.deepEqual(consumer.host.names(), ['MyApp.save']);
  // P2-B-29: the correlation id is pruned once its answer has gone out.
  assert.equal(consumer.pendingCallId('MyApp.save'), undefined);
  assert.equal(consumer.pendingCalls.size, 0);

  // An unknown function is an error, not a hang.
  consumer.apply([['hostCall', 12, 'Nope.missing', null]]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const missing = core.dispatched.filter((d) => d.type === 'hostResult').at(-1);
  assert.match(missing.payload.error, /no host function named/);

  // A handler that throws is reported, not swallowed.
  consumer.host.register('MyApp', 'fail', () => { throw new Error('the disk was full'); });
  consumer.apply([['hostCall', 13, 'MyApp.fail', null]]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(core.dispatched.filter((d) => d.type === 'hostResult').at(-1).payload.error, 'the disk was full');
});

test('14.10: a fetch outside the asset root is refused before the network', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore(), assetRoot: '/assets' });
  consumer.apply([['fetch', 5, { url: 'asset://../../secrets.txt', kind: 'text' }]]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const answer = core.dispatched.find((d) => d.type === 'fetchResult');
  assert.equal(answer.id, 5);
  assert.match(answer.payload.error, /resolves outside the asset root/);
});

test('14.10: setActive pauses and resumes the scene', async () => {
  const seen = [];
  const core = new RecordingCore();
  core.setActive = (active) => seen.push(active);
  const { consumer } = await makeConsumer({ core });
  assert.equal(consumer.isActive, true);
  consumer.setActive(false);
  assert.equal(consumer.isActive, false);
  consumer.setActive(false);
  consumer.setActive(true);
  assert.deepEqual(seen, [false, true], 'only real changes are forwarded');
});

// ------------------------------------------------------------------ 14.11

test('14.11: accessibility is mirrored onto an offscreen element', async () => {
  const elements = [];
  const fakeDocument = {
    body: { appendChild: () => {} },
    createElement: (tag) => {
      const element = {
        tag, dataset: {}, style: {}, attributes: {}, textContent: '',
        setAttribute: (k, v) => { element.attributes[k] = v; },
        removeAttribute: (k) => { delete element.attributes[k]; },
        appendChild: () => {}, remove: () => {}, replaceWith: (other) => elements.push(other),
      };
      elements.push(element);
      return element;
    },
  };
  const { consumer } = await makeConsumer({ document: fakeDocument });
  consumer.apply([
    ['create', 1, 'mesh', 'button'], ['parent', 1, 0],
    ['accessibility', 1, { label: 'Play', value: 'stopped', hint: 'tap to start', isButton: true }],
  ]);
  const element = elements.find((e) => e.tag === 'button');
  assert.ok(element, 'a button element was created');
  assert.equal(element.attributes['aria-label'], 'Play');
  assert.equal(element.attributes['aria-valuetext'], 'stopped');
  assert.equal(element.attributes['aria-description'], 'tap to start');
  assert.deepEqual(consumer.nativeDump().objects[0].accessibility,
    { label: 'Play', value: 'stopped', hint: 'tap to start', isButton: true });
  assert.ok(consumer.nativeDump().objects[0].components.includes('AccessibilityComponent'));

  consumer.apply([['accessibility', 1, null]]);
  assert.equal(consumer.nativeDump().objects[0].accessibility, null);
});

test('14.11: render options scale the environment and substitute a debug material', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['environment', 0, { url: 'asset://sky.png', intensity: 4 }]]);
  assert.equal(consumer.scene.environmentIntensity, 4);

  consumer.apply([['renderOptions', 0, { adaptiveResolution: false, environmentIntensityExponent: 0.5, debugModelView: 'normal' }]]);
  assert.equal(consumer.scene.environmentIntensity, 2, 'the exponent scales the ambient environment');
  assert.equal(consumer.scene.overrideMaterial.type, 'MeshNormalMaterial');

  consumer.apply([['renderOptions', 0, { adaptiveResolution: false, environmentIntensityExponent: 0.5, debugModelView: 'uv' }]]);
  assert.ok(consumer.scene.overrideMaterial, 'uv has a substitute too');

  // A mode with no three.js equivalent says so and renders normally.
  consumer.apply([['renderOptions', 0, { adaptiveResolution: true, environmentIntensityExponent: 1, debugModelView: 'roughness' }]]);
  assert.equal(consumer.scene.overrideMaterial, null);
  assert.equal(consumer.warnings.filter((w) => w.includes('"roughness" has no three.js substitute')).length, 1);
  assert.equal(consumer.warnings.filter((w) => w.includes('adaptive resolution is visionOS only')).length, 1);
  assert.deepEqual(consumer.nativeDump().render, { adaptiveResolution: true });
  assert.deepEqual(consumer.nativeDump().debug, { modelView: 'roughness' });
});

// ------------------------------------------------------------------ 14.12

test('14.12: an array material payload and geometry groups make a multi-material mesh', async () => {
  const { consumer } = await makeConsumer();
  const geometry = boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-multi');
  geometry[2].groups = [
    { start: 0, count: 18, materialIndex: 0 },
    { start: 18, count: 18, materialIndex: 1 },
  ];
  const one = standardMaterialCommand(1, { uuid: 'mat-a', color: [1, 0, 0] })[2];
  const two = standardMaterialCommand(1, { uuid: 'mat-b', color: [0, 1, 0] })[2];
  consumer.apply([
    ['create', 1, 'mesh', 'crate'], ['parent', 1, 0], geometry,
    ['material', 1, [one, two]],
  ]);
  const mesh = consumer.objects.get(1);
  assert.ok(Array.isArray(mesh.material));
  assert.equal(mesh.material.length, 2);
  assert.ok(Math.abs(mesh.material[0].color.r - 1) < 1e-6);
  assert.ok(Math.abs(mesh.material[1].color.g - 1) < 1e-6);
  assert.equal(mesh.geometry.groups.length, 2);
  assert.equal(mesh.geometry.groups[1].materialIndex, 1);

  const dumped = consumer.nativeDump().objects[0].material;
  assert.ok(Array.isArray(dumped));
  assert.equal(dumped.length, 2);

  // Going back to one material releases the array.
  consumer.apply([standardMaterialCommand(1, { uuid: 'mat-single' })]);
  assert.equal(Array.isArray(consumer.objects.get(1).material), false);
  assert.equal(consumer.multiMaterials.size, 0);
});

// ------------------------------------------------------------------ 14.14

test('14.14: the native dump carries every phase 2 field', async () => {
  const { consumer } = await makeConsumer();
  const dump = consumer.nativeDump();
  for (const key of ['isActive', 'audioMixer', 'camera', 'sceneUnderstanding', 'render',
    'environmentLighting', 'debug', 'hostFunctions', 'controllers']) {
    assert.ok(key in dump, `the dump carries ${key}`);
  }
  consumer.apply([['create', 1, 'mesh', 'm'], ['parent', 1, 0]]);
  const object = consumer.nativeDump().objects[0];
  for (const key of ['audio', 'video', 'characterController', 'forceField', 'accessibility',
    'skeleton', 'blendShapes']) {
    assert.ok(key in object, `each object carries ${key}`);
  }
});

test('14.2: a video url object picks webm, then mp4, and errors when neither decodes', async () => {
  const make = async (canPlay) => {
    const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
    const element = {
      loop: false, muted: false, volume: 1, playbackRate: 1, currentTime: 0, paused: true,
      ended: false, readyState: 0, videoWidth: 0, videoHeight: 0, src: null,
      canPlayType: canPlay,
      addEventListener: () => {}, removeAttribute: () => {}, load: () => {}, pause: () => {},
      play: () => Promise.resolve(),
    };
    // Stand in for the DOM so the choice can be driven from the test.
    consumer.video.screens.set(1, { spec: {}, mesh: null, element, texture: null, url: null });
    return { consumer, core, element };
  };

  // Both decodable: webm wins.
  const both = await make(() => 'probably');
  both.consumer.apply([['create', 1, 'mesh', 'screen'], ['parent', 1, 0]]);
  both.consumer.video.set(1, null, { url: { webm: 'asset://spatial-bars.webm', mp4: 'asset://spatial-bars.mp4' }, width: 0.4 });
  assert.equal(both.element.src, '/assets/spatial-bars.webm');

  // No webm support: mp4 is taken instead.
  const mp4Only = await make((type) => (type === 'video/mp4' ? 'probably' : ''));
  mp4Only.consumer.apply([['create', 1, 'mesh', 'screen'], ['parent', 1, 0]]);
  mp4Only.consumer.video.set(1, null, { url: { webm: 'asset://spatial-bars.webm', mp4: 'asset://spatial-bars.mp4' }, width: 0.4 });
  assert.equal(mp4Only.element.src, '/assets/spatial-bars.mp4');

  // hls is the last resort.
  const hlsOnly = await make((type) => (type.includes('mpegurl') ? 'maybe' : ''));
  hlsOnly.consumer.apply([['create', 1, 'mesh', 'screen'], ['parent', 1, 0]]);
  hlsOnly.consumer.video.set(1, null, { url: { mp4: 'asset://spatial-bars.mp4', hls: 'https://example.com/x.m3u8' }, width: 0.4 });
  assert.equal(hlsOnly.element.src, 'https://example.com/x.m3u8');

  // Nothing decodable: the screen says so once instead of loading nothing.
  const none = await make(() => '');
  none.consumer.apply([['create', 1, 'mesh', 'screen'], ['parent', 1, 0]]);
  none.consumer.video.set(1, null, { url: { webm: 'a.webm', mp4: 'a.mp4' }, width: 0.4 });
  assert.equal(none.element.src, null);
  const failure = none.core.dispatched.find((d) => d.type === 'error');
  assert.ok(failure, 'an error event was dispatched');
  assert.match(failure.payload.message, /cannot decode webm or mp4/);
  assert.equal(none.consumer.warnings.filter((w) => w.includes('no usable video source')).length, 1);

  // An object with no usable key at all is the same story.
  const empty = await make(() => 'probably');
  empty.consumer.apply([['create', 1, 'mesh', 'screen'], ['parent', 1, 0]]);
  empty.consumer.video.set(1, null, { url: {}, width: 0.4 });
  assert.match(empty.core.dispatched.find((d) => d.type === 'error').payload.message, /no mp4, webm or hls source/);

  // A plain string still works.
  const plain = await make(() => 'probably');
  plain.consumer.apply([['create', 1, 'mesh', 'screen'], ['parent', 1, 0]]);
  plain.consumer.video.set(1, null, { url: 'asset://spatial-bars.mp4', width: 0.4 });
  assert.equal(plain.element.src, '/assets/spatial-bars.mp4');
  assert.equal(plain.consumer.video.describe(1).url, 'asset://spatial-bars.mp4');
});

test('SPEC 3.5: every url form resolves against the one shared asset root', async () => {
  const { consumer } = await makeConsumer();
  assert.equal(consumer.resolveUrl('asset://spatial-tone.wav'), '/assets/spatial-tone.wav');
  // The core prefixes relative paths with its own assetRoot name; both forms land
  // in the same place.
  assert.equal(consumer.resolveUrl('assets/sounds/chime.wav'), '/assets/sounds/chime.wav');
  assert.equal(consumer.resolveUrl('sounds/chime.wav'), '/assets/sounds/chime.wav');
  assert.equal(consumer.resolveUrl('assets/../../etc/passwd'), null);
  assert.equal(consumer.resolveUrl('asset://../outside.png'), null);
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
  const warned = consumer.warnings.filter((w) => w.includes('orthographic camera asks for a width'));
  assert.equal(warned.length, 1, 'warned once');
  assert.ok(warned[0].includes('0.6'), 'naming the requested width');
  assert.ok(warned[0].includes('1.2'), 'and the one the viewport makes');

  // A second mismatch does not warn again.
  consumer.apply([orthographic(-0.1, 0.1)]);
  assert.equal(consumer.warnings.filter((w) => w.includes('orthographic camera asks')).length, 1);

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

// ------------------------------------- P2-C-16: the consumer's feedback paths

/** `navigator` is a getter on globalThis, so stub it as a property. */
function stubNavigator(value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  };
}

test('P2-C-16: syncAudio reports playing, currentTime and duration', async () => {
  const { consumer } = await makeConsumer();
  // A sound with no decoded buffer has nothing to report.
  consumer.apply([['create', 1, 'group', 'chime'], ['parent', 1, 0], audioCommand(1)]);
  assert.equal(consumer.audio.syncRecords().length, 0);

  // Stand in for a decoded buffer and a running clock.
  const entry = consumer.audio.sources.get(1);
  entry.sound = {
    buffer: { duration: 4 }, isPlaying: true, loop: false, playbackRate: 1,
    offset: 0.5, _progress: 1.25, _startedAt: 10, context: { currentTime: 10.75 },
  };
  const records = consumer.audio.syncRecords();
  assert.equal(records.length, 4);
  assert.equal(records[0], 1);
  assert.equal(records[1], 1, 'playing');
  // P2-B-09: _progress + offset + the time since the restart.
  assert.ok(Math.abs(records[2] - 2.5) < 1e-6, `currentTime ${records[2]}`);
  assert.equal(records[3], 4, 'duration');

  // Paused, the reported time is where it stopped, not the seek offset.
  entry.sound.isPlaying = false;
  assert.ok(Math.abs(consumer.audio.syncRecords()[2] - 1.75) < 1e-6);
  assert.equal(consumer.audio.describe(1).currentTime, 1.75);

  // P2-B-10: stop returns to the start, and a seek after a pause does not add
  // the paused progress to the seek point.
  entry.sound.stop = function stop() { this.isPlaying = false; this._progress = 0; return this; };
  entry.sound.play = function play() { this.isPlaying = true; this._startedAt = this.context.currentTime; return this; };
  entry.sound.pause = function pause() { this.isPlaying = false; return this; };
  entry.sound.setPlaybackRate = function setPlaybackRate(rate) { this.playbackRate = rate; return this; };
  consumer.apply([['audioControl', 1, 'stop', null]]);
  assert.equal(entry.sound.offset, 0);
  assert.equal(entry.sound._progress, 0);
  assert.equal(consumer.audio.describe(1).currentTime, 0, 'stop reports the start again');

  entry.sound._progress = 1.25;
  consumer.apply([['audioControl', 1, 'seek', 3]]);
  assert.equal(entry.sound.offset, 3);
  assert.equal(entry.sound._progress, 0);
  assert.equal(consumer.audio.describe(1).currentTime, 3, 'a seek after a pause lands on the seek point');
});

test('P2-C-16: syncVideo reports only screens whose metadata arrived', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['create', 1, 'mesh', 'screen'], ['parent', 1, 0]]);
  consumer.video.screens.set(1, {
    spec: { url: 'asset://spatial-bars.webm' }, mesh: null, texture: null, url: null,
    element: { readyState: 0, paused: true, ended: false, currentTime: 0, duration: NaN },
  });
  assert.equal(consumer.video.syncRecords().length, 0, 'nothing to report yet');

  const element = consumer.video.screens.get(1).element;
  element.readyState = 4;
  element.paused = false;
  element.currentTime = 1.5;
  element.duration = 12;
  const records = consumer.video.syncRecords();
  assert.deepEqual(Array.from(records), [1, 1, 1.5, 12]);
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

test('P2-C-16: readControllers maps a pad and rumble reaches the actuator', async () => {
  const { consumer } = await makeConsumer();
  const effects = [];
  const pad = {
    index: 0, id: 'Demo Pad', connected: true,
    axes: [0.5, -0.25, -1, 0.75],
    buttons: Array.from({ length: 16 }, (_, i) => ({ value: i === 0 ? 1 : 0 })),
    vibrationActuator: { playEffect: (kind, options) => { effects.push([kind, options]); return Promise.resolve(); } },
  };
  const restore = stubNavigator({ getGamepads: () => [pad] });
  try {
    const [state] = consumer.input.readControllers();
    assert.equal(state.id, 'Demo Pad#0');
    // The y axis is inverted into the core's convention.
    assert.deepEqual(state.leftThumbstick, [0.5, 0.25]);
    assert.deepEqual(state.rightThumbstick, [-1, -0.75]);
    assert.equal(state.buttons.a, 1);
    assert.equal(state.buttons.b, 0);

    assert.equal(consumer.input.rumble('Demo Pad#0', 0.7, 0.4), true);
    assert.equal(effects.length, 1);
    assert.equal(effects[0][0], 'dual-rumble');
    assert.equal(effects[0][1].duration, 400);
    assert.ok(Math.abs(effects[0][1].strongMagnitude - 0.7) < 1e-6);

    // The command form the core sends goes through the same path.
    consumer.apply([['controllerRumble', 0, 'Demo Pad#0', 0.3, 0.1]]);
    assert.equal(effects.length, 2);
  } finally {
    restore();
  }
});

test('P2-B-14: a disconnected pad is reported so the script hears about it', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  const pad = {
    index: 0, id: 'Pad', connected: true, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ value: 0 })),
  };
  let pads = [];
  const restore = stubNavigator({ getGamepads: () => pads });
  try {
    // Before any pad has been seen the key is omitted, so injected state stands.
    consumer.tick(1 / 60);
    assert.equal('controllers' in core.inputs.at(-1), false);

    pads = [pad];
    consumer.tick(1 / 60);
    assert.equal(core.inputs.at(-1).controllers.length, 1);

    // Once one has been seen, an empty list is news the core must hear.
    pads = [];
    consumer.tick(1 / 60);
    assert.deepEqual(core.inputs.at(-1).controllers, []);
  } finally {
    restore();
  }
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

test('P2-B-28: pendingLoads never goes negative across a reset', async () => {
  const { consumer } = await makeConsumer();
  let succeed = null;
  consumer.gltfLoader = { load: (url, onLoad) => { succeed = onLoad; } };
  consumer.apply([['create', 1, 'asset', 'rig'], ['parent', 1, 0], ['asset', 1, { glb: 'asset://rig.glb' }]]);
  assert.equal(consumer.pendingLoads, 1);

  // A reload clears the scene while the load is still in flight.
  consumer.reset();
  assert.equal(consumer.pendingLoads, 0);
  succeed({ scene: new THREE.Group(), animations: [] });
  assert.equal(consumer.pendingLoads, 0, 'the late callback does not push it below zero');

  // And a fresh load still counts, so the harness keeps waiting correctly.
  consumer.apply([['create', 2, 'asset', 'rig'], ['parent', 2, 0], ['asset', 2, { glb: 'asset://rig.glb' }]]);
  assert.equal(consumer.pendingLoads, 1);
});

test('P2-B-29: host calls are keyed by correlation id and pruned when answered', async () => {
  const { consumer } = await makeConsumer();
  // A handler that never settles, so both calls are still outstanding.
  const answers = [];
  consumer.host.register('Preferences', 'read', () => new Promise((resolve) => answers.push(resolve)));
  consumer.apply([
    ['hostCall', 11, 'Preferences.read', { key: 'a' }],
    ['hostCall', 12, 'Preferences.read', { key: 'b' }],
  ]);
  assert.equal(consumer.pendingCalls.size, 2, 'two calls to the same function keep two ids');
  assert.equal(consumer.pendingCalls.get(11), 'Preferences.read');
  assert.equal(consumer.pendingCalls.get(12), 'Preferences.read');

  consumer.dispatch('hostResult', 11, { value: 1 });
  assert.equal(consumer.pendingCalls.has(11), false, 'the answered one is pruned');
  assert.equal(consumer.pendingCalls.has(12), true, 'the other one still waits');
  consumer.dispatch('hostResult', 12, { value: 2 });
  assert.equal(consumer.pendingCalls.size, 0);

  consumer.apply([['fetch', 21, { url: 'asset://layout.json' }]]);
  assert.equal(consumer.pendingFetches.get(21), 'asset://layout.json');
  consumer.dispatch('fetchResult', 21, { ok: true });
  assert.equal(consumer.pendingFetches.size, 0);
});

test('P2-B-30: an unknown key in a phase 2 payload is reported', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'chime'], ['parent', 1, 0],
    audioCommand(1, { loudness: 3 }),
    ['create', 2, 'mesh', 'screen'], ['parent', 2, 0],
    ['video', 2, { url: 'asset://spatial-bars.webm', width: 0.4, stereo: 'side-by-side' }],
    ['create', 3, 'group', 'walker'], ['parent', 3, 0],
    ['characterController', 3, { radius: 0.2, height: 1, jumpHeight: 2 }],
  ]);
  const named = (key) => consumer.warnings.filter((w) => w.includes(`"${key}"`));
  assert.equal(named('loudness').length, 1, 'the audio payload is checked');
  assert.equal(named('stereo').length, 1, 'the video payload is checked');
  assert.equal(named('jumpHeight').length, 1, 'the character payload is checked');
  // A known key stays quiet.
  consumer.apply([audioCommand(1, { volume: 0.5 })]);
  assert.equal(consumer.warnings.filter((w) => w.includes('"volume"')).length, 0);
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

test('P2-B-33: a video screen never disposes a geometry it does not own', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'screen'], ['parent', 1, 0], boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-shared-video'),
    ['create', 2, 'mesh', 'other'], ['parent', 2, 0], boxGeometryCommand(2, 0.2, 0.2, 0.2, 'geo-shared-video'),
  ]);
  const shared = consumer.objects.get(1).geometry;
  assert.equal(consumer.objects.get(2).geometry, shared, 'the uuid shares one geometry');
  let disposals = 0;
  shared.dispose = () => { disposals += 1; };

  consumer.video.screens.set(1, {
    spec: { url: 'asset://spatial-bars.webm', width: 0.4, height: 0.225 },
    mesh: consumer.objects.get(1), texture: null, url: null, element: { videoWidth: 0, videoHeight: 0 },
    ownsGeometry: false,
  });
  consumer.video._applySize(consumer.video.screens.get(1));
  assert.equal(disposals, 0, 'the shared geometry survives');
  assert.equal(consumer.objects.get(2).geometry, shared, 'the other mesh still has it');
  assert.notEqual(consumer.objects.get(1).geometry, shared, 'the screen took its own plane');

  // The plane it made is its own, so a resize frees that one.
  const own = consumer.objects.get(1).geometry;
  let ownDisposals = 0;
  own.dispose = () => { ownDisposals += 1; };
  consumer.video.screens.get(1).spec = { url: 'asset://spatial-bars.webm', width: 0.8, height: 0.45 };
  consumer.video._applySize(consumer.video.screens.get(1));
  assert.equal(ownDisposals, 1);
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

test('P2-B-35: media events reach the core even under the manual bridge', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  consumer.setManualBridge(true);
  consumer.dispatch('tap', 1, {});
  for (const type of ['loaded', 'error', 'ended', 'audioState']) {
    consumer.dispatch(type, 1, { note: type });
  }
  assert.equal(core.dispatched.length, 0, 'input still waits for the harness to inject it');
  // The media results go out on the next frame, once no host has answered first.
  consumer.tick(1 / 60);
  assert.deepEqual(core.dispatched.map((d) => d.type), ['loaded', 'error', 'ended', 'audioState']);
});

test('P2-B-35: a media result a host injected is not repeated, in either order', async () => {
  // The host answers first, the way a conformance step does after a frame.
  const first = await makeConsumer({ core: new RecordingCore() });
  first.consumer.setManualBridge(true);
  first.consumer.noteHostDispatch('error', 1);
  first.consumer.dispatch('error', 1, { message: 'video failed to load' });
  first.consumer.tick(1 / 60);
  assert.deepEqual(first.core.dispatched.map((d) => [d.type, d.id]), [],
    'the consumer does not echo the host answer');

  // The element's own error arrives first and the host answers afterwards; the
  // element's answer is still waiting a frame, so it is dropped rather than sent.
  const second = await makeConsumer({ core: new RecordingCore() });
  second.consumer.setManualBridge(true);
  second.consumer.dispatch('error', 1, { message: 'video failed to load' });
  assert.deepEqual(second.core.dispatched, [], 'nothing goes out within the frame');
  second.consumer.noteHostDispatch('error', 1);
  second.consumer.tick(1 / 60);
  second.consumer.tick(1 / 60);
  assert.deepEqual(second.core.dispatched.map((d) => [d.type, d.id]), [],
    'the late element answer is dropped');

  // With no host answer the element's result still reaches the script, one frame later.
  const third = await makeConsumer({ core: new RecordingCore() });
  third.consumer.setManualBridge(true);
  third.consumer.dispatch('error', 2, { message: 'video failed to load' });
  third.consumer.dispatch('ended', 3, {});
  third.consumer.dispatch('loaded', 2, { width: 160, height: 90 });
  third.consumer.tick(1 / 60);
  assert.deepEqual(third.core.dispatched.map((d) => [d.type, d.id]),
    [['error', 2], ['ended', 3], ['loaded', 2]]);
  // And only once: the frame after does not send it again.
  third.consumer.tick(1 / 60);
  assert.equal(third.core.dispatched.length, 3);

  // A result left over from the previous script never reaches the new one.
  const fourth = await makeConsumer({ core: new RecordingCore() });
  fourth.consumer.setManualBridge(true);
  fourth.consumer.dispatch('error', 1, { message: 'video failed to load' });
  fourth.consumer.reset();
  fourth.consumer.setManualBridge(true);
  fourth.consumer.tick(1 / 60);
  assert.deepEqual(fourth.core.dispatched, [], 'a stale load generation is dropped');
});

test('P2-B-48: the current-controller flag is omitted until a pad is used', async () => {
  const { consumer } = await makeConsumer();
  const pad = {
    index: 0, id: 'Pad', connected: true, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ value: 0 })),
  };
  const restore = stubNavigator({ getGamepads: () => [pad] });
  try {
    const [before] = consumer.input.readControllers();
    assert.equal(before.current, undefined, 'nothing claims to be current yet');
    assert.equal('current' in JSON.parse(JSON.stringify(before)), false, 'and it does not cross the bridge');
    consumer.input.currentController = 0;
    const [after] = consumer.input.readControllers();
    assert.equal(after.current, true);
    consumer.input.currentController = 1;
    assert.equal(consumer.input.readControllers()[0].current, false);
  } finally {
    restore();
  }
});

test('P2-B-49: the host outbox is bounded when nothing drains it', async () => {
  const { consumer } = await makeConsumer();
  for (let i = 0; i < 1500; i++) consumer.apply([['hostEvent', 0, 'ping', { i }]]);
  assert.equal(consumer.host.outbox.length, 1000, 'the ring holds a bounded number');
  const drained = consumer.host.drain();
  assert.equal(drained.length, 1000);
  // The newest events are the ones kept.
  assert.equal(drained.at(-1).payload.i, 1499);
  assert.equal(consumer.host.drain().length, 0);
});

test('P2-B-51: non-finite phase 2 payloads are refused, not passed to the engine', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'chime'], ['parent', 1, 0],
    audioCommand(1, { volume: NaN, rate: Infinity, refDistance: NaN, rolloff: NaN }),
    ['create', 2, 'mesh', 'walker'], ['parent', 2, 0], boxGeometryCommand(2),
    ['characterController', 2, { radius: NaN, height: NaN, slopeLimit: NaN, stepLimit: NaN }],
    ['characterMove', 2, NaN, 0, 0],
    ['characterTeleport', 2, 0, NaN, 0],
    ['create', 3, 'group', 'field'], ['parent', 3, 0],
    ['forceField', 3, { kind: 'radial', strength: NaN, radius: NaN, falloff: 'linear' }],
  ]);
  const described = consumer.audio.describe(1);
  assert.equal(Number.isFinite(described.volume), true, `volume ${described.volume}`);
  assert.equal(Number.isFinite(described.rate), true);
  const controller = consumer.characters.controllers.get(2);
  assert.ok(controller, 'the controller was still created with usable defaults');
  // The capsule Rapier was handed is a real one, not a NaN that panics the wasm.
  assert.equal(controller.collider.shape.radius, 0.2);
  assert.equal(controller.collider.shape.halfHeight, 0.3);
  assert.equal(consumer.warnings.filter((w) => w.includes('non-finite displacement')).length, 1);
  assert.equal(consumer.warnings.filter((w) => w.includes('non-finite position')).length, 1);
  // Nothing blew up: a step runs and the body stays at a real position.
  for (let i = 0; i < 5; i++) consumer.tick(1 / 60);
  const translation = controller.body.translation();
  assert.ok([translation.x, translation.y, translation.z].every(Number.isFinite));
  assert.deepEqual(consumer.errors, []);
});

test('P2-B-52: a re-pointed audio source ignores the load it no longer wants', async () => {
  const { consumer } = await makeConsumer();
  const engine = consumer.audio;
  const loads = [];
  engine.loader = { load: (url, onLoad, onProgress, onError) => { loads.push({ url, onLoad, onError }); } };
  const entry = {
    url: 'asset://a.wav', pendingPlay: false,
    sound: { buffer: null, setBuffer(buffer) { this.buffer = buffer; } },
  };
  engine.sources.set(1, entry);
  engine.load(1, entry, 'asset://a.wav');
  // The script re-points the same source before the first file arrives.
  entry.url = 'asset://b.wav';
  engine.load(1, entry, 'asset://b.wav');
  assert.equal(loads.length, 2, 'both loads were started');

  const wanted = { duration: 2 };
  loads[1].onLoad(wanted);
  loads[0].onLoad({ duration: 9 });
  assert.equal(entry.sound.buffer, wanted, 'the stale buffer was dropped');
  // A stale failure is silent too, rather than blaming the file in use.
  loads[0].onError(new Error('404'));
  assert.equal(consumer.warnings.filter((w) => w.includes('audio failed to load')).length, 0);
  // And the load bookkeeping balances out.
  assert.equal(consumer.pendingLoads, 0);
});
