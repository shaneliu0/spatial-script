// SPEC 14.1 and 14.2 on the web consumer: Web Audio sources, the mixer, and
// video screens. The parts that need a real browser live in media.test.js; these
// run against hand-built command arrays.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeConsumer, RecordingCore, boxGeometryCommand, standardMaterialCommand,
} from './helpers.mjs';

/** The `audio` payload the core sends, in full (SPEC 14.13). */
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

  // FA-34: a retracted feature drops its key, the way the Swift dump does.
  consumer.apply([['accessibility', 1, null]]);
  assert.equal('accessibility' in consumer.nativeDump().objects[0], false);
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
  // AR-36: the core warns that adaptiveResolution has no effect outside
  // visionOS; the consumer keeps the state and adds nothing.
  assert.deepEqual(consumer.warnings.filter((w) => w.includes('adaptive resolution')), []);
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

  const dumpedObject = consumer.nativeDump().objects[0];
  const dumped = dumpedObject.material;
  assert.ok(Array.isArray(dumped));
  assert.equal(dumped.length, 2);
  // SPEC 8: how the mesh is split is a native fact, so it rides `components`
  // rather than adding keys the core dump does not have.
  assert.ok(dumpedObject.components.includes('geometryGroups:2'));
  assert.ok(dumpedObject.components.includes('materialSlots:2'));
  assert.deepEqual(Object.keys(dumpedObject.geometry).sort(), ['parameters', 'type']);

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
  // FA-34: a per-object phase 2 key is there when the feature is, and not when
  // it is not — the presence rule the Swift dump uses.
  consumer.apply([['create', 1, 'mesh', 'm'], ['parent', 1, 0]]);
  const bare = consumer.nativeDump().objects[0];
  for (const key of ['audio', 'video', 'characterController', 'forceField', 'accessibility',
    'skeleton', 'blendShapes', 'shaderGraph', 'debugModelView']) {
    assert.equal(key in bare, false, `a bare mesh carries no ${key}`);
  }
  consumer.apply([
    audioCommand(1),
    ['accessibility', 1, { label: 'thing', value: null, hint: null, isButton: false }],
  ]);
  const featured = consumer.nativeDump().objects[0];
  assert.ok(featured.audio, 'the sound is reported');
  assert.ok(featured.accessibility, 'and the label');
  assert.equal('video' in featured, false, 'but nothing it does not have');
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
  // SPEC 3.5: a load failure reaches the script through the event; the consumer
  // adds no warning of its own, so the warning list is the same on every backend.
  assert.deepEqual(none.consumer.warnings.filter((w) => w.includes('video source')), []);
  assert.equal(none.core.dispatched.filter((d) => d.type === 'error').length, 1, 'and only once');

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

// ------------------------------------- P2-C-16: the consumer's feedback paths
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

test('AR-32: a video reports the play intent at once, and the element corrects it', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  const listeners = {};
  const element = {
    loop: false, muted: false, volume: 1, playbackRate: 1, currentTime: 0, duration: 12,
    paused: true, ended: false, readyState: 4, videoWidth: 160, videoHeight: 90, src: null,
    canPlayType: () => 'probably',
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeAttribute: () => {}, load: () => {}, setAttribute: () => {},
    // A real element starts asynchronously: `paused` only clears when it does.
    play() { return Promise.resolve(); },
    pause() { this.paused = true; if (listeners.pause) listeners.pause(); },
  };
  consumer.video.createElement = () => element;
  consumer.apply([['create', 1, 'mesh', 'screen'], ['parent', 1, 0]]);
  consumer.video.screens.set(1, {
    spec: { url: 'asset://spatial-bars.webm', width: 0.4 }, mesh: null, element,
    texture: null, url: 'asset://spatial-bars.webm',
  });
  consumer.video.set(1, null, { url: 'asset://spatial-bars.webm', width: 0.4 });

  assert.equal(consumer.video.describe(1).playing, false, 'nothing is playing yet');

  // The frame the script calls play(), the consumer already reports playing, so
  // the sync it sends cannot flip the script's own isPlaying back off.
  consumer.apply([['videoControl', 1, 'play', null]]);
  assert.equal(element.paused, true, 'the element has not started yet');
  assert.equal(consumer.video.describe(1).playing, true, 'but the intent is reported at once');
  const records = Array.from(consumer.video.syncRecords());
  assert.deepEqual(records.slice(0, 2), [1, 1], 'and syncVideo says the same');

  // Once the element really starts, its own state agrees.
  element.paused = false;
  assert.equal(consumer.video.describe(1).playing, true);

  // The element has the last word: ending stops it, whatever the intent was.
  element.ended = true;
  assert.equal(consumer.video.describe(1).playing, false, 'an ended clip is not playing');
  element.ended = false;

  // A pause from the script is immediate too.
  consumer.apply([['videoControl', 1, 'pause', null]]);
  assert.equal(consumer.video.describe(1).playing, false);

  // A browser that refuses playback clears the intent rather than lying.
  const refusing = { ...element, paused: true, ended: false, play: () => Promise.reject(new Error('gesture required')) };
  consumer.video.screens.get(1).element = refusing;
  consumer.apply([['videoControl', 1, 'play', null]]);
  assert.equal(consumer.video.describe(1).playing, true, 'the intent stands until the refusal lands');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(consumer.video.describe(1).playing, false, 'and then it is corrected');
  assert.ok(consumer.warnings.some((w) => w.includes('refused to start video playback')));
  assert.equal(core.dispatched.length, 0, 'no event was invented for any of this');
});
