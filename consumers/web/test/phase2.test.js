// SPEC 14.7 and 14.9 to 14.14 on the web consumer: scene understanding, input,
// the host channel, accessibility and render options, and the native dump.
// Behaviours that need a real browser run in media.test.js and shadows.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  makeConsumer, RecordingCore, boxGeometryCommand, standardMaterialCommand, transformCommand, rigidBodyCommand, stubNavigator,
} from './helpers.mjs';

/** The `audio` payload the core sends, in full (SPEC 14.13). */
const audioCommand = (id, overrides = {}) => ['audio', id, {
  url: 'asset://spatial-tone.wav', spatial: false, ambient: false, loop: false, volume: 1, rate: 1,
  group: 'master', refDistance: 1, rolloff: 1, distanceModel: 'inverse', cone: null, reverbLevel: 0,
  ...overrides,
}];

// ------------------------------------------------------------------ 14.7
test('14.7: scene understanding is kept and warned about once', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['sceneUnderstanding', 0, { collision: true, occlusion: false, physics: false, shadows: true }]]);
  assert.deepEqual(consumer.nativeDump().sceneUnderstanding,
    { collision: true, occlusion: false, physics: false, shadows: true });
  // AR-36: "no effect outside visionOS" is the core's warning, so the consumer
  // does not repeat it.
  assert.deepEqual(consumer.warnings.filter((w) => w.includes('scene understanding is visionOS only')), []);
  // NR-06, SPEC 14.7: the script is also told what it will not get back — this
  // part only the consumer knows, so it says it once.
  const raycastWarning = consumer.warnings.filter((w) => w.includes('raycasts will not see the real world'));
  assert.equal(raycastWarning.length, 1, consumer.warnings.join(' | '));
  assert.match(raycastWarning[0], /no hit carries sceneUnderstanding/);

  consumer.apply([['sceneUnderstanding', 0, { collision: true, occlusion: true, physics: true, shadows: true }]]);
  assert.equal(consumer.warnings.filter((w) => w.includes('raycasts will not see the real world')).length, 1, 'warned once');

  // And a raycast really does report nothing for the real world: every record
  // names an object the script created.
  consumer.apply([
    ['create', 1, 'mesh', 'cube'], ['parent', 1, 0], transformCommand(1, [0, 0, 0]),
    boxGeometryCommand(1, 0.4, 0.4, 0.4),
  ]);
  consumer.root.updateMatrixWorld(true);
  const hits = consumer.raycast(0, 0, 2, 0, 0, -1, -1);
  const ids = [];
  for (let i = 0; i < hits.length; i += 8) ids.push(hits[i]);
  assert.deepEqual(ids, [1], 'no id 0 real-world record is produced');

  // Turning every flag off stops the warnings from coming back.
  consumer.apply([['sceneUnderstanding', 0, { collision: false, occlusion: false, physics: false, shadows: false }]]);
  assert.equal(consumer.warnings.filter((w) => w.includes('raycasts will not see the real world')).length, 1);
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

test('FA-34: every conditional dump key appears exactly when its feature does', async () => {
  // The Swift consumer's presence rules, from ScriptingNativeDump.swift
  // (`describe`) and ScriptingNativeDump+Phase2.swift (`phase2Dump`): a key is
  // in the record when the consumer holds that feature for the id, and absent
  // when it does not. Each row is [key, the commands that turn it on].
  const { consumer } = await makeConsumer();
  consumer.gltfLoader = { load: () => {} };
  consumer.textureLoader = null;

  consumer.apply([
    ['create', 1, 'mesh', 'plain'], ['parent', 1, 0], boxGeometryCommand(1),
    standardMaterialCommand(1, { uuid: 'fa34-plain' }),
  ]);
  const plain = () => consumer.nativeDump().objects.find((o) => o.name === 'plain');
  const off = ['velocity', 'isSleeping', 'asset', 'loaded', 'animations', 'anchor',
    'isAnchored', 'portal', 'particles', 'audio', 'video', 'characterController',
    'forceField', 'skeleton', 'blendShapes', 'accessibility', 'isOnGround'];
  for (const key of off) assert.equal(key in plain(), false, `a plain mesh carries no ${key}`);
  assert.ok(plain().material, 'but it does have a material');

  // Each feature switches its own key on, and only its own.
  consumer.apply([rigidBodyCommand(1, { type: 'dynamic', mass: 1, shape: 'box' })]);
  consumer.tick(1 / 60);
  assert.ok('velocity' in plain() && 'isSleeping' in plain(), 'a dynamic body reports motion');

  consumer.apply([audioCommand(1)]);
  assert.ok('audio' in plain());
  consumer.apply([['audio', 1, null]]);
  assert.equal('audio' in plain(), false, 'and the key goes when the feature does');

  consumer.apply([['accessibility', 1, { label: 'a', value: null, hint: null, isButton: false }]]);
  assert.ok('accessibility' in plain());
  consumer.apply([['accessibility', 1, null]]);
  assert.equal('accessibility' in plain(), false);

  consumer.apply([['characterController', 1, { radius: 0.2, height: 1, gravity: false }]]);
  assert.ok('characterController' in plain());
  consumer.apply([['characterController', 1, null]]);
  assert.equal('characterController' in plain(), false);

  consumer.apply([['forceField', 1, { kind: 'ConstantForceField', enabled: true, radius: 1, mask: -1, force: [0, 1, 0] }]]);
  assert.ok('forceField' in plain());
  consumer.apply([['forceField', 1, null]]);
  assert.equal('forceField' in plain(), false);

  consumer.apply([['blendShapes', 1, { widen: 0.5 }]]);
  assert.ok('blendShapes' in plain());
  consumer.apply([['blendShapes', 1, {}]]);
  assert.equal('blendShapes' in plain(), false, 'an empty payload retracts it (SPEC 14.13)');

  // A shader graph reports the graph block next to the material.
  consumer.apply([['material', 1, {
    type: 'ShaderGraphMaterial', uuid: 'fa34-graph', source: 'assets/spatial-materials.usda',
    name: 'Glow', parameters: { rim: 0.5 }, generation: 0,
    fallback: standardMaterialCommand(1, { uuid: 'fa34-graph-fallback' })[2],
  }]]);
  // SPEC 8 and 14.6: the graph is the material, with its fallback nested — not
  // a key of its own — and the fact that the fallback renders is a component.
  assert.deepEqual(Object.keys(plain().material).sort(),
    ['fallback', 'generation', 'name', 'parameters', 'source', 'type']);
  assert.equal(plain().material.name, 'Glow');
  assert.equal(plain().material.type, 'ShaderGraphMaterial');
  assert.ok(plain().components.includes('ShaderGraphFallback'), 'a browser renders the fallback');
  assert.equal('shaderGraph' in plain(), false);

  // The debug view names itself on every mesh it covers, in `components`.
  consumer.apply([['renderOptions', 0, { adaptiveResolution: false, environmentIntensityExponent: 1, debugModelView: 'normal' }]]);
  assert.ok(plain().components.includes('debugModelView:normal'));
  consumer.apply([['renderOptions', 0, { adaptiveResolution: false, environmentIntensityExponent: 1, debugModelView: null }]]);
  assert.equal(plain().components.some((c) => c.startsWith('debugModelView')), false);

  // The kind-specific keys, on the kinds that carry them.
  consumer.apply([
    ['create', 2, 'anchor', 'anchor'], ['parent', 2, 0], ['anchor', 2, { kind: 'head' }],
    ['create', 3, 'particles', 'fx'], ['parent', 3, 0], ['particles', 3, { preset: 'sparks', isEmitting: true }],
    ['create', 4, 'asset', 'rig'], ['parent', 4, 0], ['asset', 4, { glb: 'asset://rig.glb' }],
  ]);
  const byName = Object.fromEntries(consumer.nativeDump().objects.map((o) => [o.name, o]));
  assert.ok('anchor' in byName.anchor && 'isAnchored' in byName.anchor);
  assert.ok('particles' in byName.fx);
  for (const key of ['asset', 'loaded', 'animations']) assert.ok(key in byName.rig, `the asset carries ${key}`);
  assert.equal('anchor' in byName.fx, false, 'and no kind borrows another kind\'s keys');
});

test('FA-34: the native dump carries the SPEC 8 fields the Swift dump carries', async () => {
  const { consumer } = await makeConsumer();
  // The asset is described, not fetched: node has no loader for it.
  consumer.gltfLoader = { load: () => {} };
  consumer.apply([
    ['create', 1, 'mesh', 'ball'], ['parent', 1, 0], transformCommand(1, [0, 1, 0]),
    boxGeometryCommand(1, 0.2, 0.2, 0.2), rigidBodyCommand(1, { type: 'dynamic', mass: 1, shape: 'box' }),
    ['create', 2, 'mesh', 'floor'], ['parent', 2, 0], transformCommand(2, [0, -0.5, 0]),
    boxGeometryCommand(2, 2, 0.1, 2), rigidBodyCommand(2, { type: 'static', shape: 'box' }),
    ['create', 3, 'particles', 'sparks'], ['parent', 3, 0],
    ['particles', 3, { preset: 'sparks', isEmitting: true }],
    ['create', 4, 'asset', 'rig'], ['parent', 4, 0], ['asset', 4, { glb: 'asset://rig.glb' }],
  ]);
  for (let i = 0; i < 10; i++) consumer.tick(1 / 60);
  const dump = consumer.nativeDump();

  // Top level.
  assert.deepEqual(Object.keys(dump.scene), ['name', 'childCount']);
  assert.equal(dump.scene.childCount, consumer.root.children.length);
  // SPEC 8: the core counts loads from 1; the consumer counts resets.
  assert.equal(dump.loadGeneration, consumer.generation + 1);
  assert.equal(dump.droppedErrors, 0);

  const byName = Object.fromEntries(dump.objects.map((o) => [o.name, o]));
  // A dynamic body reports the motion the consumer measured; a static one does not.
  assert.ok(Array.isArray(byName.ball.velocity), 'the dynamic body reports velocity');
  assert.ok(byName.ball.velocity[1] < 0, 'and it is falling');
  assert.equal(typeof byName.ball.isSleeping, 'boolean');
  // SPEC 8: any object with a rigid body reports its motion, static ones too.
  assert.ok('velocity' in byName.floor, 'a static body reports a resting velocity');
  assert.deepEqual(byName.floor.velocity, [0, 0, 0]);

  // SPEC 8: a particle emitter reports the whole state, in the core's key set.
  assert.deepEqual(Object.keys(byName.sparks.particles).sort(),
    ['acceleration', 'birthRate', 'burstCount', 'color', 'colorEnd', 'isEmitting', 'lifetime',
      'lifetimeVariation', 'loops', 'opacity', 'opacityEnd', 'preset', 'shape', 'shapeSize',
      'size', 'sizeVariation', 'speed', 'speedVariation', 'spreadAngle', 'texture']);
  assert.equal(byName.sparks.particles.isEmitting, true);
  assert.equal(typeof byName.sparks.particles.lifetime, 'number');
  assert.equal(byName.sparks.particles.preset, 'sparks');

  // An asset reports the sources it was asked for, in the core's shape.
  assert.deepEqual(byName.rig.asset, { glb: 'asset://rig.glb', gltf: null, usdz: null, reality: null });
  assert.equal(byName.rig.loaded, false, 'nothing has arrived yet');
  assert.deepEqual(byName.rig.animations, []);

  // The environment reports its url and intensity, not just that it is on.
  assert.equal(dump.environment, null);
  consumer.apply([['environment', 0, { url: 'asset://studio-env.png', intensity: 2 }]]);
  consumer.scene.environment = new THREE.Texture();
  const lit = consumer.nativeDump().environment;
  // SPEC 8: the core's environment block is `{ url, intensity }`.
  assert.deepEqual(Object.keys(lit).sort(), ['intensity', 'url']);
  assert.equal(lit.url, 'asset://studio-env.png');
  assert.ok(Math.abs(lit.intensity - 2) < 1e-6, `intensity ${lit.intensity}`);

  // Dropping errors is counted, not hidden.
  for (let i = 0; i < 250; i++) consumer.recordError('probe', 1, new Error(`boom ${i}`));
  assert.ok(consumer.nativeDump().droppedErrors > 0, 'the dropped errors are reported');
});
