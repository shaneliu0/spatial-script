// SPEC 14.1 audio and 14.2 video: the command shapes, the control channel, the
// sync channel and the events.

import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain } from "./helpers.mjs";

test("14.1 an Audio carries its payload, its controls and its mixer", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const loader = new S.AudioLoader();
    const buffer = loader.load("sounds/chime.wav");
    const sound = new S.Audio();
    sound.name = "chime";
    sound.setBuffer(buffer);
    sound.setLoop(true);
    sound.setVolume(0.5);
    sound.setPlaybackRate(1.5);
    sound.group = "music";
    scene.add(sound);
    S.audio.masterVolume = 0.8;
    S.audio.setGroupVolume("music", 0.4);
    S.onFrame(() => {
      if (S.time.frame === 2) sound.play();
      if (S.time.frame === 3) sound.pause();
      if (S.time.frame === 4) sound.currentTime = 12;
      if (S.time.frame === 5) sound.stop();
    });
    S.mount(scene);
  `,
    { assetRoot: "assets" },
  );

  const first = host.tick();
  const audio = commandsFor(first, "audio")[0];
  assert.equal(audio[2].url, "assets/sounds/chime.wav", "the url goes through containment");
  assert.equal(audio[2].loop, true);
  assert.equal(audio[2].volume, 0.5);
  assert.equal(audio[2].rate, 1.5);
  assert.equal(audio[2].group, "music");
  assert.equal(audio[2].spatial, false);
  assert.equal(audio[2].ambient, false);

  const mixer = commandsFor(first, "audioMixer")[0];
  assert.equal(mixer[1], 0, "the mixer is scene level");
  assert.equal(mixer[2].masterVolume, 0.8);
  assert.deepEqual(plain(mixer[2].groups), { music: 0.4 });

  assert.deepEqual(plain(commandsFor(host.tick(), "audioControl")[0].slice(2)), ["play", null]);
  assert.deepEqual(plain(commandsFor(host.tick(), "audioControl")[0].slice(2)), ["pause", null]);
  assert.deepEqual(plain(commandsFor(host.tick(), "audioControl")[0].slice(2)), ["seek", 12]);
  assert.deepEqual(plain(commandsFor(host.tick(), "audioControl")[0].slice(2)), ["stop", null]);
  assert.equal(commandsFor(host.tick(), "audio").length, 0, "an unchanged sound is silent on the wire");
});

test("14.1 PositionalAudio and AmbientAudio report their own shape", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const loader = new S.AudioLoader();
    const spatialSound = new S.PositionalAudio();
    spatialSound.name = "spatial";
    spatialSound.setBuffer(loader.load("a.wav"));
    spatialSound.setRefDistance(2);
    spatialSound.setRolloffFactor(0.5);
    spatialSound.setDistanceModel("linear");
    spatialSound.setDirectionalCone(30, 90, 0.2);
    spatialSound.reverbLevel = -6;
    const ambient = new S.AmbientAudio();
    ambient.name = "ambient";
    ambient.setBuffer(loader.load("b.wav"));
    scene.add(spatialSound, ambient);
    S.mount(scene);
  `);
  const audio = commandsFor(host.tick(), "audio");
  const spatialPayload = audio.find((command) => command[2].url === "a.wav")[2];
  const ambientPayload = audio.find((command) => command[2].url === "b.wav")[2];

  assert.equal(spatialPayload.spatial, true);
  assert.equal(spatialPayload.refDistance, 2);
  assert.equal(spatialPayload.rolloff, 0.5);
  assert.equal(spatialPayload.distanceModel, "linear");
  assert.deepEqual(plain(spatialPayload.cone), [30, 90, 0.2]);
  assert.equal(spatialPayload.reverbLevel, -6);
  assert.equal(ambientPayload.ambient, true);
  assert.equal(ambientPayload.spatial, false);

  const dump = host.dump();
  const entry = dump.objects.find((object) => object.name === "spatial");
  assert.equal(entry.audio.playing, false);
  assert.equal(entry.audio.group, "master");
});

test("14.1 syncAudio owns playback state and ended reaches the script", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const sound = new S.Audio();
    sound.name = "sound";
    sound.setBuffer(new S.AudioLoader().load("a.wav"));
    sound.onEnded = () => { scene.userData.ended = (scene.userData.ended || 0) + 1; };
    sound.addEventListener("ended", () => { scene.userData.event = true; });
    scene.add(sound);
    S.onFrame(() => {
      scene.userData.playing = sound.isPlaying;
      scene.userData.time = sound.currentTime;
      scene.userData.duration = sound.duration;
    });
    S.mount(scene);
  `);
  host.tick();
  const id = host.idFor("sound");
  host.spatial.syncAudio(new Float32Array([id, 1, 1.25, 4]));
  host.tick();
  let dump = host.dump();
  assert.equal(dump.scene.userData.playing, true);
  assert.equal(dump.scene.userData.time, 1.25);
  assert.equal(dump.scene.userData.duration, 4);

  host.spatial.dispatch("ended", id, {});
  host.tick();
  dump = host.dump();
  assert.equal(dump.scene.userData.ended, 1, "onEnded fired");
  assert.equal(dump.scene.userData.event, true, "the ended event fired");
  assert.equal(dump.scene.userData.playing, false);
});

test("14.1 a refused audio url never becomes a playable buffer", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const sound = new S.Audio();
    sound.name = "sound";
    sound.setBuffer(new S.AudioLoader().load("../../../../etc/passwd.wav"));
    sound.play();
    scene.add(sound);
    S.mount(scene);
  `,
    { assetRoot: "assets" },
  );
  const frame = host.tick();
  assert.equal(commandsFor(frame, "audioControl").length, 0, "nothing was started");
  assert.equal(commandsFor(frame, "audio")[0][2].url, null);
  const warnings = host.dump().warnings;
  assert.ok(warnings.some((warning) => /escapes the asset root/.test(warning)));
  assert.ok(warnings.some((warning) => /without a playable buffer/.test(warning)));
});

test("14.2 a VideoScreen is a mesh that carries video state and controls", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({ url: "clips/intro.mp4", width: 1.6, height: 0.9, loop: true });
    screen.name = "screen";
    screen.position.set(0, 1.2, -2);
    scene.add(screen);
    S.onFrame(() => {
      if (S.time.frame === 2) screen.play();
      if (S.time.frame === 3) screen.currentTime = 5;
      if (S.time.frame === 4) { screen.volume = 0.25; screen.muted = true; }
    });
    S.mount(scene);
  `,
    { assetRoot: "media" },
  );
  const first = host.tick();
  const video = commandsFor(first, "video")[0];
  assert.equal(video[2].url, "media/clips/intro.mp4");
  assert.equal(video[2].width, 1.6);
  assert.equal(video[2].height, 0.9);
  assert.equal(video[2].loop, true);
  assert.equal(commandsFor(first, "geometry")[0][2].type, "PlaneGeometry", "it is a mesh");
  assert.equal(commandsFor(first, "create")[0][2], "mesh");

  assert.deepEqual(plain(commandsFor(host.tick(), "videoControl")[0].slice(2)), ["play", null]);
  assert.deepEqual(plain(commandsFor(host.tick(), "videoControl")[0].slice(2)), ["seek", 5]);
  const changed = commandsFor(host.tick(), "video")[0];
  assert.equal(changed[2].volume, 0.25);
  assert.equal(changed[2].muted, true);
});

test("14.2 loaded sizes the screen from the video aspect and syncVideo owns playback", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({ url: "clip.mp4", width: 2 });
    screen.name = "screen";
    screen.addEventListener("loaded", () => { scene.userData.loaded = true; });
    scene.add(screen);
    S.onFrame(() => { scene.userData.height = screen.height; scene.userData.playing = screen.isPlaying; });
    S.mount(scene);
  `);
  host.tick();
  const id = host.idFor("screen");
  host.spatial.dispatch("loaded", id, { width: 1920, height: 1080, duration: 12 });
  host.spatial.syncVideo(new Float32Array([id, 1, 2, 12]));
  const frame = host.tick();

  const dump = host.dump();
  assert.equal(dump.scene.userData.loaded, true, "the loaded event reached the script");
  assert.ok(Math.abs(dump.scene.userData.height - 2 * (1080 / 1920)) < 1e-6, "the free dimension follows the aspect");
  assert.equal(dump.scene.userData.playing, true);
  assert.equal(commandsFor(frame, "geometry")[0][2].parameters.height.toFixed(4), (1.125).toFixed(4));
  const entry = dump.objects.find((object) => object.name === "screen");
  assert.equal(entry.video.duration, 12);
});

test("14.1 and 14.2 add nothing to a scene that uses neither", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), new S.MeshStandardMaterial());
    mesh.name = "box";
    scene.add(mesh);
    S.onFrame(() => { mesh.rotation.y += 0.01; });
    S.mount(scene);
  `);
  host.tick();
  const steady = host.tick();
  const opcodes = plain(steady.map((command) => command[0]));
  assert.deepEqual(opcodes, ["transforms"], `steady state should be one transforms command, got ${opcodes}`);
});

test("14.1 the consumer reports whether the audio engine is running", () => {
  const host = createHost({ backend: "three", platform: "web" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.onFrame(() => { scene.userData.state = S.audio.state; });
    S.mount(scene);
  `, { backend: "three", platform: "web" });
  host.tick();
  assert.equal(host.dump().scene.userData.state, "suspended", "web audio starts suspended");
  host.spatial.dispatch("audioState", 0, { state: "running" });
  host.tick();
  assert.equal(host.dump().audioMixer.state, "running");
});

test("14.1 resume moves the mixer to running and re-emits it", () => {
  const host = createHost({ backend: "three", platform: "web" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.onFrame(() => { if (S.time.frame === 2) S.audio.resume(); });
    S.mount(scene);
  `, { backend: "three", platform: "web" });
  host.tick();
  const mixer = commandsFor(host.tick(), "audioMixer")[0];
  assert.equal(mixer[2].state, "running");
});

test("14.1 AudioLoader.loadAsync resolves with the buffer and rejects a refused url", async () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const loader = new S.AudioLoader();
    loader.loadAsync("sounds/ok.wav").then((buffer) => { scene.userData.url = buffer.url; });
    loader.loadAsync("../../outside.wav").catch((error) => { scene.userData.error = error.message; });
    S.mount(scene);
  `,
    { assetRoot: "assets" },
  );
  await Promise.resolve();
  await Promise.resolve();
  host.tick();
  const dump = host.dump();
  assert.equal(dump.scene.userData.url, "assets/sounds/ok.wav");
  assert.match(dump.scene.userData.error, /refused/);
});

test("14.2 docking outside visionOS is kept and warned about", () => {
  const host = createHost({ backend: "realitykit", platform: "macos" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({ url: "clip.mp4", width: 1, docking: true });
    screen.name = "screen";
    scene.add(screen);
    S.mount(scene);
  `, { backend: "realitykit", platform: "macos" });
  host.tick();
  const dump = host.dump();
  assert.equal(dump.objects.find((object) => object.name === "screen").video.docking, true);
  assert.ok(dump.warnings.some((warning) => /docking is visionOS only/.test(warning)));
});

test("14.11 an unknown debug model view is refused, and the web says what it cannot draw", () => {
  const host = createHost({ backend: "three", platform: "web" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.debug.modelView = "sparkles";
    S.onFrame(() => { if (S.time.frame === 2) S.debug.modelView = "roughness"; });
    S.mount(scene);
  `, { backend: "three", platform: "web" });
  assert.equal(commandsFor(host.tick(), "renderOptions").length, 0, "an unknown value emits nothing");
  const options = commandsFor(host.tick(), "renderOptions")[0];
  assert.equal(options[2].debugModelView, "roughness");
  const warnings = host.dump().warnings;
  assert.ok(warnings.some((warning) => /"sparkles" was ignored/.test(warning)));
  assert.ok(warnings.some((warning) => /no debug material for "roughness"/.test(warning)));
});

test("14.2 a VideoScreen accepts one url per encoding and contains each of them", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({
      url: { mp4: "clips/bars.mp4", webm: "clips/bars.webm", hls: "../../../../etc/passwd.m3u8" },
      width: 1.6,
    });
    screen.name = "screen";
    scene.add(screen);
    S.mount(scene);
  `,
    { assetRoot: "media" },
  );
  const first = host.tick();
  const payload = commandsFor(first, "video")[0][2];
  assert.deepEqual(plain(payload.url), {
    mp4: "media/clips/bars.mp4",
    webm: "media/clips/bars.webm",
  });
  assert.equal(commandsFor(host.tick(), "video").length, 0, "an unchanged source list is silent");
  const dump = host.dump();
  assert.deepEqual(plain(dump.objects.find((object) => object.name === "screen").video.url), {
    mp4: "media/clips/bars.mp4",
    webm: "media/clips/bars.webm",
  });
  assert.ok(dump.warnings.some((warning) => /hls url was refused and dropped/.test(warning)));
});

test("14.2 a screen whose every source is refused reports null and dispatches error", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({ url: { mp4: "../../secret.mp4", webm: "javascript:alert(1)" } });
    screen.name = "screen";
    screen.addEventListener("error", (event) => { scene.userData.error = event.message; });
    scene.add(screen);
    S.mount(scene);
  `,
    { assetRoot: "media" },
  );
  const payload = commandsFor(host.tick(), "video")[0][2];
  assert.equal(payload.url, null);
  // The event waits for the object's first flush, so it lands on the tick
  // after the one that created it (P2-B-16).
  host.tick();
  const dump = host.dump();
  assert.match(dump.scene.userData.error, /no playable source/);
  assert.equal(dump.objects.find((object) => object.name === "screen").video.error, dump.scene.userData.error);
  assert.ok(dump.warnings.some((warning) => /mp4 and webm urls were refused/.test(warning)));
});

test("14.2 a string url still works and a non-string, non-object url is a TypeError", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({ url: "clip.mp4", width: 1 });
    screen.name = "screen";
    scene.add(screen);
    scene.userData.bad = null;
    try {
      new S.VideoScreen({ url: 42 });
    } catch (error) {
      scene.userData.bad = error.name;
    }
    S.mount(scene);
  `,
    { assetRoot: "media" },
  );
  assert.equal(commandsFor(host.tick(), "video")[0][2].url, "media/clip.mp4");
  assert.equal(host.dump().scene.userData.bad, "TypeError");
});
