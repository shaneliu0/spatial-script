// The phase 2 behaviours that only a real browser can show: Web Audio decoding a
// file and playing it, a video element decoding a clip, and GLTF skinning with a
// morph target. Chromium runs with the fake audio device flags the harness sets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../harness/server.mjs';
import { launchBrowser, openScene, runSteps } from '../harness/browser.mjs';

test('14.1/14.2/14.5: audio, video and a rigged asset run in the browser', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, {
    origin: server.url, scriptPath: 'consumers/web/test/scripts/media.js', width: 400, height: 300,
  });
  // Enough frames for the media to load, start and advance.
  await runSteps(page, [{ frames: 10 }]);
  await page.waitForTimeout(400);
  await runSteps(page, [{ frames: 60 }]);
  await page.waitForTimeout(400);
  await runSteps(page, [{ frames: 30 }]);

  const result = await page.evaluate(() => {
    const consumer = window.spatialConsumer;
    const dump = window.spatialDump();
    const native = window.spatialNativeDump();
    const byName = (name) => native.objects.find((o) => o.name === name);
    const audioEntry = [...consumer.audio.sources.values()][0];
    const videoEntry = [...consumer.video.screens.values()][0];
    const assetEntry = [...consumer.assets.values()][0];
    return {
      contextState: consumer.audio.context ? consumer.audio.context.state : null,
      audio: byName('chime') ? byName('chime').audio : null,
      audioBuffered: !!(audioEntry && audioEntry.sound && audioEntry.sound.buffer),
      audioDuration: audioEntry && audioEntry.sound && audioEntry.sound.buffer
        ? audioEntry.sound.buffer.duration : 0,
      video: byName('screen') ? byName('screen').video : null,
      videoReady: videoEntry && videoEntry.element ? videoEntry.element.readyState : 0,
      videoSize: videoEntry && videoEntry.element
        ? [videoEntry.element.videoWidth, videoEntry.element.videoHeight] : null,
      planeSize: videoEntry && videoEntry.mesh && videoEntry.mesh.geometry.parameters
        ? [videoEntry.mesh.geometry.parameters.width, +videoEntry.mesh.geometry.parameters.height.toFixed(4)]
        : null,
      joints: dump.scene.userData.joints,
      blendShapes: dump.scene.userData.blendShapes,
      assetError: dump.scene.userData.assetError || null,
      morphInfluence: (() => {
        if (!assetEntry || !assetEntry.morphs) return null;
        const targets = assetEntry.morphs.get('widen');
        return targets ? targets[0].mesh.morphTargetInfluences[targets[0].index] : null;
      })(),
      headQuaternion: assetEntry && assetEntry.bones && assetEntry.bones.get('head')
        ? assetEntry.bones.get('head').quaternion.toArray().map((n) => +n.toFixed(4)) : null,
      components: byName('rig') ? byName('rig').components : [],
      warnings: consumer.warnings,
    };
  });

  // 14.1: Web Audio really started and decoded the file.
  assert.equal(result.contextState, 'running', 'the audio context resumed');
  assert.equal(result.audioBuffered, true, 'the wav decoded');
  // The shared spatial-tone.wav is a one-second tone.
  assert.ok(result.audioDuration > 0.4 && result.audioDuration < 2,
    `a decoded tone of a plausible length (${result.audioDuration})`);
  assert.equal(result.audio.playing, true, 'and it is playing');
  assert.ok(result.audio.currentTime > 0, 'with the clock advancing');

  // 14.2: the clip decoded and the plane took its aspect.
  assert.ok(result.videoReady >= 1, `video metadata arrived (readyState ${result.videoReady})`);
  assert.deepEqual(result.videoSize, [160, 90]);
  assert.deepEqual(result.planeSize, [0.4, 0.225], 'the plane follows the clip aspect');
  assert.equal(result.video.playing, true);
  assert.ok(result.video.duration > 1);

  // 14.5: the rig loaded with its joints and blend shapes.
  assert.equal(result.assetError, null);
  assert.deepEqual(result.joints, ['root', 'head']);
  assert.deepEqual(result.blendShapes, ['widen']);
  assert.equal(result.morphInfluence, 0.75, 'a blend shape weight reached morphTargetInfluences');
  assert.ok(Math.abs(result.headQuaternion[1] - 0.3827) < 1e-3, 'a joint rotation reached the bone');
  assert.ok(result.components.includes('SkeletalPosesComponent'));
  assert.ok(result.components.includes('BlendShapeWeightsComponent'));
});

test('P2-B-03/15/36/50: the mix graph, the listener and the harness gesture', async (t) => {
  const server = await startServer();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const { page } = await openScene(browser, {
    origin: server.url, scriptPath: 'consumers/web/test/scripts/audio-routing.js', width: 320, height: 240,
    // P2-B-50: count the resume the harness itself is supposed to make. The
    // page assigns the function during boot, so the counter wraps the setter.
    initScript: () => {
      let assigned = null;
      window.__resumeCalls = 0;
      Object.defineProperty(window, 'spatialResumeAudio', {
        configurable: true,
        get() {
          if (!assigned) return undefined;
          return (...args) => { window.__resumeCalls += 1; return assigned(...args); };
        },
        set(value) { assigned = value; },
      });
    },
  });
  await runSteps(page, [{ frames: 10 }]);
  await page.waitForTimeout(400);
  await runSteps(page, [{ frames: 30 }]);

  const result = await page.evaluate(() => {
    const consumer = window.spatialConsumer;
    const engine = consumer.audio;
    const entry = [...engine.sources.values()][0];
    const { sound } = entry;

    // P2-B-03: the node that leaves the sound is its gain, not the panner, so a
    // re-route keeps setVolume in the path and does not sever panner -> gain.
    const calls = { gain: 0, panner: 0, pannerDisconnect: 0, targets: [] };
    const gainConnect = sound.gain.connect.bind(sound.gain);
    sound.gain.connect = (node) => { calls.gain += 1; calls.targets.push(node); return gainConnect(node); };
    const pannerConnect = sound.panner.connect.bind(sound.panner);
    sound.panner.connect = (node) => { calls.panner += 1; return pannerConnect(node); };
    const pannerDisconnect = sound.panner.disconnect.bind(sound.panner);
    sound.panner.disconnect = (...args) => { calls.pannerDisconnect += 1; return pannerDisconnect(...args); };

    const before = { send: !!entry.send, level: entry.reverbLevel };
    engine.route(entry, 'sfx', 0.4);
    const after = {
      targetIsGroup: calls.targets.includes(engine.groupNode('sfx')),
      gainConnects: calls.gain,
      pannerConnects: calls.panner,
      pannerDisconnects: calls.pannerDisconnect,
      // P2-B-36: the send went with the disconnect, so the same level rebuilds it.
      send: !!entry.send,
    };
    return {
      resumeCalls: window.__resumeCalls,
      contextState: engine.context.state,
      mixerState: consumer.nativeDump().audioMixer,
      playing: sound.isPlaying,
      buffered: !!sound.buffer,
      listenerParentIsCamera: engine.listener.parent === consumer.camera,
      musicGain: engine.groupNode('music').gain.value,
      sfxGain: engine.groupNode('sfx').gain.value,
      before,
      after,
    };
  });

  // P2-B-50: the script never calls resume; the harness does, through the page.
  assert.ok(result.resumeCalls >= 1, `the harness resumed audio after load (${result.resumeCalls})`);
  assert.equal(result.contextState, 'running', 'and the context is running');
  assert.equal(result.buffered, true);
  assert.equal(result.playing, true, 'and the sound really started');
  assert.equal(result.mixerState.groups.music, 0.5);
  assert.ok(Math.abs(result.musicGain - 0.5) < 1e-6, 'the group bus carries the group volume');
  assert.ok(Math.abs(result.sfxGain - 0.25) < 1e-6);
  assert.equal(result.before.send, true, 'the reverb send was built for the first group');

  // P2-B-03: the gain is what moves between buses; the panner is left alone.
  assert.equal(result.after.targetIsGroup, true, 'the sound gain connects to the new group');
  assert.equal(result.after.gainConnects >= 1, true);
  assert.equal(result.after.pannerConnects, 0, 'the panner is not re-plugged');
  assert.equal(result.after.pannerDisconnects, 0, 'and never unplugged from its gain');
  // P2-B-36: the send survives a group change at an unchanged level.
  assert.equal(result.after.send, true, 'the reverb send was rebuilt on the new group');

  // P2-B-15: a reload rebuilds the scene, and the listener re-parents onto the
  // camera the moment the reloaded script asks for audio again.
  const detached = await page.evaluate(async () => {
    await window.spatialReload();
    return window.spatialConsumer.audio.listener.parent === window.spatialConsumer.camera;
  });
  assert.equal(detached, false, 'the reload really did clear the camera');
  await runSteps(page, [{ frames: 10 }]);
  await page.waitForTimeout(400);
  await runSteps(page, [{ frames: 20 }]);

  const afterReload = await page.evaluate(() => {
    const consumer = window.spatialConsumer;
    const entry = [...consumer.audio.sources.values()][0];
    return {
      parentIsCamera: consumer.audio.listener.parent === consumer.camera,
      listeners: consumer.camera.children.filter((c) => c.type === 'AudioListener').length,
      hasSource: !!entry,
      state: consumer.audio.context.state,
    };
  });
  assert.equal(afterReload.parentIsCamera, true, 'the listener re-parents onto the live camera');
  assert.equal(afterReload.listeners, 1, 'and only one listener is attached');
  assert.equal(afterReload.hasSource, true, 'the reloaded script has its sound again');
  assert.equal(afterReload.state, 'running');
});
