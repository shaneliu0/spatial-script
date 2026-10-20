// One test per adversarial-results finding on the core. Each fails against the
// reviewed build; the ones that pin a value fail against a mutated constant.

import test from "node:test";
import assert from "node:assert/strict";
import { MAX_DEFERRED_FRAMES, MAX_INACTIVE_EVENTS, MAX_INACTIVE_SYNC_OBJECTS } from "../src/util/limits.js";
import { createHost, commandsFor, plain } from "./helpers.mjs";

// -------------------------------------------------------------------- AR-05

test("AR-05 colour components are clamped to 0..1 on materials, lights and particles", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();

    const material = new S.MeshStandardMaterial();
    material.color.r = 5;
    material.color.g = -3;
    material.color.b = NaN;
    material.emissive.r = 9;
    material.emissive.g = -1;
    material.emissive.b = NaN;
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), material);
    mesh.name = "mesh";
    scene.add(mesh);

    const lamp = new S.PointLight(0xffffff, 1);
    lamp.name = "lamp";
    lamp.color.r = 5;
    lamp.color.g = -3;
    lamp.color.b = NaN;
    scene.add(lamp);

    const fx = new S.ParticleEmitter({});
    fx.name = "fx";
    fx.color.r = 5;
    fx.color.g = -3;
    fx.color.b = NaN;
    scene.add(fx);

    S.mount(scene);
  `);
  const frame = host.tick();
  const material = commandsFor(frame, "material")[0][2];
  const light = commandsFor(frame, "light")[0][2];
  const particles = commandsFor(frame, "particles")[0][2];

  // A NaN channel falls back to the "fully on" default, out of range clamps.
  assert.deepEqual(plain(material.color), [1, 0, 1], "material colour is clamped");
  assert.deepEqual(plain(material.emissive), [1, 0, 0], "emissive falls back to 0 on NaN");
  assert.deepEqual(plain(light.color), [1, 0, 1], "light colour is clamped");
  assert.deepEqual(plain(particles.color), [1, 0, 1], "particle colour is clamped");

  const dump = host.dump();
  assert.deepEqual(plain(dump.objects.find((e) => e.name === "mesh").material.color), [1, 0, 1]);
  assert.deepEqual(plain(dump.objects.find((e) => e.name === "lamp").light.color), [1, 0, 1]);
});

// -------------------------------------------------------------------- AR-06

test("AR-45 the caps outside Spatial.limits are pinned by value and by behaviour", () => {
  // The three caps SPEC names but does not publish on `Spatial.limits`.
  assert.equal(MAX_DEFERRED_FRAMES, 2, "a deferred command waits two frames (SPEC 14.13)");
  assert.equal(MAX_INACTIVE_EVENTS, 1000, "SPEC 14.10 names 1000 queued events");
  assert.equal(MAX_INACTIVE_SYNC_OBJECTS, 10000);

  // And the queue really stops at the documented number: 1001 taps arrive while the
  // scene is inactive, exactly 1000 are delivered on activation, and one line says so.
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const m = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    m.name = "target";
    scene.userData.taps = 0;
    m.addEventListener("tap", () => { scene.userData.taps += 1; });
    scene.add(m);
    S.mount(scene);
  `);
  host.tick();
  host.spatial.setActive(false);
  const id = host.idFor("target");
  for (let i = 0; i < 1001; i += 1) host.spatial.dispatch("tap", id, {});
  host.spatial.setActive(true);
  host.tick();
  host.tick();
  const dump = host.dump();
  assert.equal(dump.scene.userData.taps, 1000, "exactly the documented number of events is delivered");
  assert.ok(dump.warnings.some((w) => /More than 1000 events arrived while the scene was inactive/.test(w)), JSON.stringify(dump.warnings));
});

test("AR-06 every published cap in Spatial.limits is pinned by value", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    probe.userData.limits = { ...S.limits };
    scene.add(probe);
    S.mount(scene);
  `);
  host.tick();
  const limits = plain(host.dump().objects.find((entry) => entry.name === "probe").userData.limits);
  // The whole published table, by value: a cap that changes without this line
  // changing is a contract change nobody reviewed.
  assert.deepEqual(limits, {
    MAX_NAME_LENGTH: 256,
    MAX_LOG_MESSAGE: 16384,
    MAX_LOGS_PER_FRAME: 200,
    MAX_LIVE_TIMERS: 10000,
    MAX_LIVE_FRAME_CALLBACKS: 10000,
    MAX_CALLBACKS_PER_TICK: 10000,
    MAX_LISTENERS_PER_EVENT: 1000,
    MAX_DEPTH: 1024,
    MAX_ID: 16777216,
    MAX_RECORDED_ERRORS: 200,
    MAX_RECORDED_WARNINGS: 500,
    MAX_ERROR_MESSAGES_PER_SECOND: 20,
  });
});

test("AR-06 a log message is truncated at exactly MAX_LOG_MESSAGE", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.add(new S.Group());
    console.log("x".repeat(40000));
    S.mount(scene);
  `);
  const log = commandsFor(host.tick(), "log")[0];
  const suffix = "… (truncated, 40000 characters)";
  assert.equal(log[3].length, 16384 + suffix.length, "cut at the cap, plus the suffix that says so");
  assert.ok(log[3].endsWith(suffix));
  assert.equal(log[3].slice(0, 16384), "x".repeat(16384));
});

test("AR-06 the live animation-frame registration cap is enforced and reported", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    // One past the cap: the last registration is refused, not queued.
    let accepted = 0;
    for (let i = 0; i < S.limits.MAX_LIVE_FRAME_CALLBACKS + 1; i += 1) {
      const id = requestAnimationFrame(() => {});
      if (id !== undefined) accepted += 1;
    }
    probe.userData.accepted = accepted;
    S.mount(scene);
  `);
  host.tick();
  const dump = host.dump();
  assert.equal(
    host.spatial.runtime.timers.frameCallbacks.size <= 10000,
    true,
    "never more than the cap is held",
  );
  assert.ok(
    dump.warnings.some((warning) => /live animation-frame callbacks; the registration was dropped/.test(warning)),
    `expected the cap warning, got ${JSON.stringify(dump.warnings)}`,
  );
});

// -------------------------------------------------------------------- AR-27

test("AR-27 host payloads and captured state stop at MAX_JSON_DEPTH", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    // A chain exactly at the cap survives; one link deeper does not.
    const atCap = { d1: { d2: { d3: { d4: { d5: { d6: { d7: "kept" } } } } } } };
    const pastCap = { d1: { d2: { d3: { d4: { d5: { d6: { d7: { d8: "gone" } } } } } } } };
    this.state = { atCap, pastCap };
    S.host.send("probe", { atCap, pastCap });
    S.mount(scene);
  `);
  const sent = commandsFor(host.tick(), "hostEvent")[0][3];
  const reach = (value, depth) => {
    let node = value;
    for (let i = 1; i <= depth; i += 1) node = node === null || node === undefined ? node : node[`d${i}`];
    return node;
  };
  assert.equal(reach(plain(sent.atCap), 7), "kept", "seven levels of nesting travel whole");
  assert.equal(reach(plain(sent.pastCap), 7), null, "the eighth becomes null");

  const state = plain(host.spatial.captureState());
  assert.equal(reach(state.atCap, 7), "kept");
  assert.equal(reach(state.pastCap, 7), null);
  assert.ok(
    host.dump().warnings.some((warning) => /nesting deeper than 8/.test(warning)),
    "and the truncation is named, not silent",
  );
});

// -------------------------------------------------------------------- AR-19

test("AR-19 a trigger body is normalised to a static, massless body on the wire", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const zone = new S.Mesh(new S.BoxGeometry(0.3, 0.3, 0.3), new S.MeshStandardMaterial());
    zone.name = "zone";
    zone.rigidBody = new S.RigidBody({ type: "dynamic", mass: 4, isTrigger: true, shape: "box" });
    scene.add(zone);
    const solid = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    solid.name = "solid";
    solid.rigidBody = new S.RigidBody({ type: "dynamic", mass: 4 });
    scene.add(solid);
    S.mount(scene);
  `);
  const bodies = commandsFor(host.tick(), "rigidBody");
  const zone = bodies.find((command) => command[1] === host.idFor("zone"))[2];
  const solid = bodies.find((command) => command[1] === host.idFor("solid"))[2];

  assert.equal(zone.type, "static", "a trigger is never simulated, so its type is not");
  assert.equal(zone.mass, 0, "and it has no mass");
  assert.equal(zone.requestedType, "dynamic", "the authored value stays visible");
  assert.equal(zone.isTrigger, true);
  assert.equal(solid.type, "dynamic", "an ordinary body is untouched");
  assert.equal(solid.mass, 4);
  assert.equal(solid.requestedType, "dynamic");

  const dumped = host.dump().objects.find((entry) => entry.name === "zone").rigidBody;
  assert.equal(dumped.type, "static");
  assert.equal(dumped.requestedType, "dynamic");
});

// -------------------------------------------------------------------- AR-15

test("AR-15 a preset resolves in the core, so the payload, the dump and the script agree", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    // The author's fields lose to the preset, except isEmitting (SPEC 3.10).
    const rain = new S.ParticleEmitter({ preset: "rain", birthRate: 7, size: 0.9, isEmitting: false });
    rain.name = "rain";
    scene.add(rain);
    scene.userData.birthRate = rain.birthRate;
    scene.userData.size = rain.size;
    scene.userData.shape = rain.shape;
    scene.userData.isEmitting = rain.isEmitting;
    S.mount(scene);
  `);
  const payload = commandsFor(host.tick(), "particles")[0][2];
  assert.equal(payload.birthRate, 700, "the preset's rate is what renders and what is sent");
  assert.equal(payload.size, 0.004);
  assert.equal(payload.shape, "box");
  assert.equal(payload.isEmitting, false, "isEmitting stays the author's");
  assert.equal(payload.preset, "rain");

  const dump = host.dump();
  const entry = dump.objects.find((object) => object.name === "rain");
  assert.equal(entry.particles.birthRate, 700, "the dump reports what is rendered");
  assert.equal(dump.scene.userData.birthRate, 700, "and so does the script's own property");
  assert.equal(dump.scene.userData.size, 0.004);
  assert.equal(dump.scene.userData.shape, "box");
  assert.equal(dump.scene.userData.isEmitting, false);
});

// -------------------------------------------------------------------- AR-33

test("AR-33 the impact preset does not loop", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const impact = new S.ParticleEmitter({ preset: "impact", loops: true });
    impact.name = "impact";
    scene.add(impact);
    const sparks = new S.ParticleEmitter({ preset: "sparks" });
    sparks.name = "sparks";
    scene.add(sparks);
    scene.userData.loops = impact.loops;
    S.mount(scene);
  `);
  const emitters = commandsFor(host.tick(), "particles");
  const impact = emitters.find((command) => command[2].preset === "impact")[2];
  const sparks = emitters.find((command) => command[2].preset === "sparks")[2];
  assert.equal(impact.loops, false, "one shot, as the reference says");
  assert.equal(sparks.loops, true, "a looping preset still loops");
  assert.equal(host.dump().scene.userData.loops, false, "the script reads it back too");
});

// -------------------------------------------------------------------- AR-20

test("AR-20 a portal whose world leaves the scene stops naming it", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const world = new S.Group();
    world.name = "world";
    scene.add(world);
    const portal = new S.Portal({ width: 0.4, height: 0.4, world });
    portal.name = "portal";
    scene.add(portal);
    S.onFrame(() => { if (S.time.frame === 2) scene.remove(world); });
    S.mount(scene);
  `);
  const first = commandsFor(host.tick(), "portal")[0];
  const worldId = host.idFor("world");
  assert.equal(first[2].worldId, worldId, "while the world is in the scene it is named");

  const departed = commandsFor(host.tick(), "portal")[0];
  assert.ok(departed, "the portal is re-emitted when its world leaves");
  assert.equal(departed[2].worldId, null, "and it names no world any more");
  assert.equal(departed[2].width, 0.4, "the rest of the payload stands");
  assert.ok(host.dump().warnings.some((warning) => /world group that is not in the mounted scene/.test(warning)));
});

// ------------------------------------------------------------- AR-21, AR-26

test("AR-21 compact omits its two keys and objects:false is the documented shape", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), new S.MeshStandardMaterial());
    mesh.name = "box";
    mesh.userData.note = "kept out of compact";
    scene.add(mesh);
    S.mount(scene);
  `);
  host.tick();

  const compact = host.spatial.dump({ compact: true });
  const entry = compact.objects.find((object) => object.name === "box");
  assert.ok(!("userData" in entry), "userData is omitted, not nulled");
  assert.ok(!("parameters" in entry.geometry), "geometry parameters are omitted, not nulled");
  assert.equal(entry.geometry.type, "BoxGeometry");
  assert.ok(JSON.stringify(compact).indexOf('"parameters"') === -1, "and nothing else reintroduces them");

  // objects: false is the top-level fields with an empty object list.
  const summary = host.spatial.dump({ objects: false });
  assert.ok("objects" in summary, "the key is present");
  assert.deepEqual(plain(summary.objects), [], "and empty");
  const full = host.spatial.dump();
  for (const key of Object.keys(full)) {
    if (key === "objects") continue;
    assert.ok(key in summary, `the summary keeps the top-level key ${key}`);
  }
});

test("AR-26 compact and objects:false are the same shape a transport must forward", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    for (let i = 0; i < 3; i += 1) {
      const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
      mesh.name = "m" + i;
      mesh.userData.big = "x".repeat(50);
      scene.add(mesh);
    }
    S.mount(scene);
  `);
  host.tick();

  // The contract a host's /dump route must reproduce: compact keeps every
  // object and every key except the two, objects:false keeps none of them.
  const full = host.spatial.dump();
  const compact = host.spatial.dump({ compact: true });
  const summary = host.spatial.dump({ objects: false });

  assert.equal(compact.objects.length, full.objects.length, "compact keeps every object");
  assert.equal(summary.objects.length, 0, "objects:false keeps none");
  const fullKeys = Object.keys(full.objects[0]).filter((key) => key !== "userData");
  for (const key of fullKeys) {
    assert.ok(key in compact.objects[0], `compact keeps ${key}`);
  }
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length, "and it is smaller");
  assert.equal(summary.frame, full.frame, "the summary is the same scene");
});

// -------------------------------------------------------------------- AR-29

test("AR-29 an event type outside the protocol's list is dropped with a warning", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    box.userData.bogus = 0;
    box.userData.taps = 0;
    box.addEventListener("bogusEvent", () => { box.userData.bogus += 1; });
    box.addEventListener("tap", () => { box.userData.taps += 1; });
    scene.add(box);
    S.mount(scene);
  `);
  host.tick();
  const id = host.idFor("box");
  host.spatial.dispatch("bogusEvent", id, {});
  host.spatial.dispatch("tap", id, { point: [0, 0, 0] });
  host.tick();

  const dump = host.dump();
  const box = dump.objects.find((entry) => entry.name === "box");
  assert.equal(box.userData.bogus, 0, "an unlisted type never reaches a listener");
  assert.equal(box.userData.taps, 1, "a listed one still does");
  assert.ok(
    dump.warnings.some((warning) => /dispatch\("bogusEvent"\) is not one of the event types/.test(warning)),
    `expected a warning naming the type, got ${JSON.stringify(dump.warnings)}`,
  );
});

// -------------------------------------------------------------------- AR-32

test("AR-32 isPlaying is intent-immediate on both Audio and VideoScreen", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const sound = new S.Audio();
    sound.name = "sound";
    sound.setBuffer(new S.AudioLoader().load("a.wav"));
    const screen = new S.VideoScreen({ url: "clip.mp4", width: 1 });
    screen.name = "screen";
    scene.add(sound, screen);

    scene.userData.before = [sound.isPlaying, screen.isPlaying];
    sound.play();
    screen.play();
    scene.userData.afterPlay = [sound.isPlaying, screen.isPlaying];
    sound.pause();
    screen.pause();
    scene.userData.afterPause = [sound.isPlaying, screen.isPlaying];
    sound.play();
    screen.play();
    sound.stop();
    scene.userData.afterStop = sound.isPlaying;

    // A sound with nothing to play is the engine refusing, not intent.
    const silent = new S.Audio();
    silent.name = "silent";
    scene.add(silent);
    silent.play();
    scene.userData.silent = silent.isPlaying;
    // The common construction — a loader result not yet arrived — follows the
    // same rule, and the docs say so (AR-47).
    const pending = new S.Audio();
    pending.setBuffer(new S.AudioLoader().load("late.wav"));
    pending.name = "pending";
    scene.add(pending);
    scene.userData.pendingBuffer = pending.buffer !== null;
    pending.play();
    scene.userData.pending = pending.isPlaying;
    S.mount(scene);
  `);
  host.tick();
  const data = host.dump().scene.userData;
  assert.deepEqual(plain(data.before), [false, false]);
  assert.deepEqual(plain(data.afterPlay), [true, true], "both report the intent on the call frame");
  assert.deepEqual(plain(data.afterPause), [false, false]);
  assert.equal(data.afterStop, false);
  assert.equal(data.silent, false, "a sound with no buffer never claims to play");
  assert.equal(data.pending, data.pendingBuffer, "isPlaying follows the buffer's presence, nothing else");

  // And the consumer stays authoritative afterwards.
  host.spatial.syncAudio(new Float32Array([host.idFor("sound"), 0, 0, 4]));
  host.tick();
  assert.equal(host.dump().objects.find((entry) => entry.name === "sound").audio.playing, false);
});

// -------------------------------------------------------------------- AR-34

test("AR-34 a refused texture url reads as null on the script's Texture", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const refused = new S.TextureLoader().load("ftp://example.com/a.png");
    const ok = new S.TextureLoader().load("textures/grid.png");
    const mesh = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), new S.MeshStandardMaterial({ map: refused }));
    mesh.name = "panel";
    scene.add(mesh);
    S.onFrame(() => {
      scene.userData.refusedUrl = refused.url;
      scene.userData.requested = refused.requestedUrl;
      scene.userData.okUrl = ok.url;
      scene.userData.check = refused.url === null;
    });
    S.mount(scene);
  `,
    { assetRoot: "assets" },
  );
  host.tick();
  const frame = host.tick();
  const dump = host.dump();
  assert.equal(dump.scene.userData.refusedUrl, null, "the property the docs invite a check on is null");
  assert.equal(dump.scene.userData.check, true);
  assert.equal(dump.scene.userData.requested, "ftp://example.com/a.png", "what was asked for is kept");
  // A url that survives containment is left exactly as the script wrote it —
  // resolving against the asset root is the wire's business, not the script's.
  assert.equal(dump.scene.userData.okUrl, "textures/grid.png", "an accepted url is untouched");
  const texture = commandsFor(frame, "texture").concat(commandsFor(host.frames[0], "texture"));
  assert.ok(texture.some((command) => command[2] && command[2].url === null), "the wire says null too");
});

// -------------------------------------------------------------------- AR-36

test("AR-36 one unsupported fact produces exactly one core warning", () => {
  const host = createHost({ backend: "three", platform: "web" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({ url: "clip.mp4", width: 1, docking: true });
    screen.name = "screen";
    scene.add(screen);
    const shadowed = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), new S.MeshStandardMaterial());
    shadowed.name = "shadowed";
    shadowed.groundingShadow = true;
    scene.add(shadowed);
    S.mount(scene);
  `, { backend: "three", platform: "web" });
  for (let i = 0; i < 3; i += 1) host.tick();
  const warnings = host.dump().warnings;
  assert.equal(warnings.filter((warning) => /docking/.test(warning)).length, 1, "one docking warning");
  assert.equal(
    warnings.filter((warning) => /groundingShadow/.test(warning)).length,
    1,
    "one groundingShadow warning",
  );
});
