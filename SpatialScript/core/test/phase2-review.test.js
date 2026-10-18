// One test per phase-2 review finding on the core. Each fails against the
// reviewed build.

import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain, transformIds } from "./helpers.mjs";

// ------------------------------------------------------------------ P2-B-02

test("P2-B-02 clearing the last phase-2 feature on an object retracts it", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();

    const button = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    button.name = "button";
    button.accessibility = { label: "Start", isButton: true };
    const walker = new S.Group();
    walker.name = "walker";
    walker.characterController = new S.CharacterController({});
    const field = new S.RadialForceField({ strength: 2 });
    field.name = "field";
    const sound = new S.Audio();
    sound.name = "sound";
    sound.setBuffer(new S.AudioLoader().load("a.wav"));
    const screen = new S.VideoScreen({ url: "clip.mp4", width: 1 });
    screen.name = "screen";
    scene.add(button, walker, field, sound, screen);

    S.onFrame(() => {
      if (S.time.frame === 2) {
        // Each object's only phase-2 feature goes away.
        button.accessibility = null;
        walker.characterController = null;
        field.isForceField = false;
        sound.isAudio = false;
        screen.isVideoScreen = false;
      }
    });
    S.mount(scene);
  `);
  const first = host.tick();
  for (const opcode of ["accessibility", "characterController", "forceField", "audio", "video"]) {
    assert.equal(commandsFor(first, opcode).length, 1, `${opcode} was described`);
  }

  const cleared = host.tick();
  for (const opcode of ["accessibility", "characterController", "forceField", "audio", "video"]) {
    const command = commandsFor(cleared, opcode)[0];
    assert.ok(command, `${opcode} was retracted`);
    assert.equal(command[2], null, `${opcode} retraction is a null payload`);
  }
  assert.equal(commandsFor(host.tick(), "accessibility").length, 0, "a retraction happens once");
});

test("P2-B-02 an asset that loses its rig retracts the skeleton and the blend shapes", async () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    let robot = null;
    S.loadAsset({ usdz: "robot.usdz" }).then((asset) => {
      robot = asset;
      asset.name = "robot";
      scene.add(asset);
      asset.skeleton.setJointRotation("head", new S.Quaternion(0, 0, 0, 1));
      asset.blendShapes.set("smile", 0.5);
    });
    S.onFrame(() => {
      if (S.time.frame === 4 && robot !== null) {
        robot.skeleton = null;
        robot.blendShapes = null;
      }
    });
    S.mount(scene);
  `);
  const id = commandsFor(host.tick(), "asset")[0][1];
  host.spatial.dispatch("assetLoaded", id, { joints: ["head"], blendShapes: ["smile"] });
  host.tick();
  await Promise.resolve();
  await Promise.resolve();
  const described = host.tick();
  assert.equal(commandsFor(described, "skeleton").length, 1);
  assert.equal(commandsFor(described, "blendShapes").length, 1);

  const cleared = host.tick();
  assert.deepEqual(plain(commandsFor(cleared, "skeleton")[0][2]), { joints: {}, track: false });
  assert.deepEqual(plain(commandsFor(cleared, "blendShapes")[0][2]), {});
});

// ------------------------------------------------------------------ P2-B-04

test("P2-B-04 playback on a destroyed Audio is dropped and never resurrects it", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const sound = new S.Audio();
    sound.name = "sound";
    sound.setBuffer(new S.AudioLoader().load("a.wav"));
    scene.add(sound);
    S.onFrame(() => {
      if (S.time.frame === 2) S.destroy(sound);
      if (S.time.frame === 3) { sound.play(); sound.currentTime = 3; sound.stop(); }
    });
    S.mount(scene);
  `);
  host.tick();
  const destroyed = host.tick();
  assert.equal(commandsFor(destroyed, "destroy").length, 1);

  const after = host.tick();
  assert.equal(commandsFor(after, "create").length, 0, "nothing is created again");
  assert.equal(commandsFor(after, "audioControl").length, 0, "no playback reaches the consumer");
  assert.equal(host.dump().objects.filter((entry) => entry.name === "sound").length, 0);
  assert.ok(host.dump().warnings.some((warning) => /was dropped: the object was destroyed/.test(warning)));
  assert.equal(host.spatial.runtime.extraRoots.size, 0, "it is not held as a root");
  assert.equal(host.spatial.runtime.audioObjects.size, 0);
});

// ------------------------------------------------------------------ P2-B-05

test("P2-B-05 the inactive backlog is bounded and collapsed per object", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const ball = new S.Mesh(new S.SphereGeometry(0.1), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.rigidBody = new S.RigidBody({ type: "dynamic" });
    scene.add(ball);
    scene.userData.taps = 0;
    ball.addEventListener("tap", () => { scene.userData.taps += 1; });
    S.mount(scene);
  `);
  host.tick();
  const id = host.idFor("ball");
  host.spatial.setActive(false);

  for (let i = 0; i < 5000; i += 1) {
    host.spatial.dispatch("tap", id, { point: [0, 0, 0] });
    host.spatial.sync(new Float32Array([id, 0, i, 0, 0, 0, 0, 1, 1, 1, 1]));
    host.spatial.syncBodies(new Float32Array([id, 0, i, 0, 0, 0, 0, 0]));
  }
  const runtime = host.spatial.runtime;
  assert.ok(runtime.eventQueue.length <= 1000, `events are capped, got ${runtime.eventQueue.length}`);
  assert.equal(runtime.pendingSync.length, 0, "sync records are collapsed, not queued");
  assert.equal(runtime.inactiveSync.get("sync").byId.size, 1, "one record per object");

  host.spatial.setActive(true);
  host.tick();
  const dump = host.dump();
  assert.ok(dump.scene.userData.taps <= 1000, `the flood is bounded, got ${dump.scene.userData.taps}`);
  const ball = dump.objects.find((entry) => entry.name === "ball");
  assert.equal(ball.position[1], 4999, "the latest sync record won");
  assert.ok(dump.warnings.some((warning) => /while the scene was inactive/.test(warning)));
});

// ------------------------------------------------------------------ P2-B-16

test("P2-B-16 a refused VideoScreen mints no id until it is in a scene", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const marker = new S.Group();
    marker.name = "marker";
    scene.add(marker);
    for (let i = 0; i < 50; i += 1) new S.VideoScreen({ url: "javascript:alert(1)" });
    S.mount(scene);
  `);
  host.tick();
  const runtime = host.spatial.runtime;
  assert.ok(runtime.nextId <= 4, `discarded screens burn no ids, nextId is ${runtime.nextId}`);
  assert.equal(runtime.idObjects.size, host.dump().objects.length, "no dead screens are retained");
});

// ------------------------------------------------------------------ P2-B-17

test("P2-B-17 a group and material count mismatch warns and covers every group", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BoxGeometry(0.2, 0.2, 0.2);
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 5);
    const mesh = new S.Mesh(geometry, [new S.MeshStandardMaterial(), new S.MeshBasicMaterial()]);
    mesh.name = "mismatched";
    scene.add(mesh);
    S.mount(scene);
  `);
  const payload = commandsFor(host.tick(), "material")[0][2];
  assert.equal(payload.length, 6, "every materialIndex resolves to a material");
  assert.equal(payload[5].type, "MeshBasicMaterial", "the last material covers the rest");
  assert.ok(
    host.dump().warnings.some((warning) => /asking for 6 materials but carries 2/.test(warning)),
    `expected a mismatch warning, got ${JSON.stringify(host.dump().warnings)}`,
  );
});

// ------------------------------------------------------------------ P2-B-18

test("P2-B-18 a shader parameter the stream cannot carry is refused, not nulled", () => {
  const host = createHost({ backend: "realitykit", platform: "macos" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const material = new S.ShaderGraphMaterial({
      source: "m.usda",
      name: "Glow",
      parameters: { good: 1, bad: { nope: 1 } },
      fallback: new S.MeshStandardMaterial({ roughness: 0.5 }),
    });
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), material);
    mesh.name = "mesh";
    scene.add(mesh);
    S.onFrame(() => {
      if (S.time.frame === 2) {
        material.setParameter("nan", NaN);
        material.setParameter("long", [1, 2, 3, 4, 5, 6, 7]);
        material.setParameter("tint", "hijacked");
        material.setParameter("good", 2);
      }
    });
    S.mount(scene);
  `, { backend: "realitykit", platform: "macos" });

  const payload = commandsFor(host.tick(), "material")[0][2];
  assert.equal(payload.parameters.good, 1);
  assert.equal(payload.parameters.bad, undefined, "an unsupported constructor value is dropped");

  const parameters = commandsFor(host.tick(), "shaderParameter");
  const names = plain(parameters.map((command) => command[2]));
  assert.deepEqual(
    names,
    ["tint", "good"],
    `only values the stream can carry are sent, got ${names}`,
  );
  assert.equal(parameters[names.indexOf("good")][3], 2);

  const dump = host.dump();
  const material = dump.objects.find((entry) => entry.name === "mesh").material;
  assert.equal(material.parameters.nan, undefined, "a NaN never enters the parameters");
  assert.equal(material.parameters.long, undefined, "an over-long array is refused, not truncated");
  assert.ok(dump.warnings.some((warning) => /cannot carry/.test(warning)));
});

// ------------------------------------------------------------------ P2-B-19

test("P2-B-19 captureState reports what JSON could not carry, naming the keys", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const state = { keep: 1, lookup: new Map([["a", 1]]), fn() {}, deep: {} };
    let node = state.deep;
    for (let i = 0; i < 12; i += 1) { node.next = {}; node = node.next; }
    state.self = state;
    this.state = state;
    S.mount(scene);
  `);
  host.tick();
  const captured = plain(host.spatial.captureState());
  assert.equal(captured.keep, 1);
  const warnings = host.dump().warnings;
  const report = warnings.find((warning) => /did not survive JSON unchanged/.test(warning));
  assert.ok(report, `expected a report, got ${JSON.stringify(warnings)}`);
  assert.match(report, /state\.lookup/);
  assert.match(report, /state\.fn/);
  assert.match(report, /state\.self/);
  assert.match(report, /nesting deeper than/);
});

test("P2-B-19 a state past the size cap is refused rather than carried across", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    this.state = { big: "x".repeat(2 * 1024 * 1024) };
    S.mount(scene);
  `);
  host.tick();
  assert.equal(host.spatial.captureState(), null);
  assert.ok(host.dump().warnings.some((warning) => /no state was preserved/.test(warning)));
});

// ------------------------------------------------------------------ P2-B-20

test("P2-B-20 the aspect given to the PerspectiveCamera constructor warns", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const camera = new S.PerspectiveCamera(60, 16 / 9, 0.1, 100);
    camera.name = "eye";
    scene.userData.aspect = camera.aspect;
    S.camera = camera;
    S.mount(scene);
  `);
  host.tick();
  const dump = host.dump();
  assert.ok(Math.abs(dump.scene.userData.aspect - 16 / 9) < 1e-6, "three keeps the value it was given");
  assert.ok(dump.warnings.some((warning) => /aspect is managed by the consumer/.test(warning)));
});

// ------------------------------------------------------------------ P2-B-45

test("P2-B-45 dump().camera is the live value, not the last flushed one", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const camera = new S.PerspectiveCamera(45, 1, 0.1, 10);
    camera.name = "eye";
    scene.add(camera);
    scene.userData.beforeTick = S.dump({ objects: false }).camera;
    S.camera = camera;
    scene.userData.afterAssign = S.dump({ objects: false }).camera.fov;
    S.onFrame(() => {
      if (S.time.frame === 2) {
        S.camera = null;
        scene.userData.afterClear = S.dump({ objects: false }).camera;
      }
    });
    S.mount(scene);
  `);
  host.tick();
  host.tick();
  const dump = host.dump();
  assert.equal(dump.scene.userData.beforeTick, null, "no camera is null, not a stale payload");
  assert.equal(dump.scene.userData.afterAssign, 45, "the assignment is visible before any tick");
  assert.equal(dump.scene.userData.afterClear, null, "clearing reads as null, not kind: null");
  assert.equal(dump.camera, null);
});

// ------------------------------------------------------------------ P2-B-46

test("P2-B-46 resizing a VideoScreen releases the plane it replaces", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({ url: "clip.mp4", width: 2 });
    screen.name = "screen";
    scene.add(screen);
    scene.userData.disposed = false;
    screen.geometry.addEventListener("dispose", () => { scene.userData.disposed = true; });
    S.mount(scene);
  `);
  host.tick();
  host.spatial.dispatch("loaded", host.idFor("screen"), { width: 1920, height: 1080, duration: 4 });
  host.tick();
  assert.equal(host.dump().scene.userData.disposed, true, "the old plane was disposed");
});

// ------------------------------------------------------------------ P2-B-47

test("P2-B-47 controllers.current is the one that moved most recently", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.onFrame(() => {
      const current = S.input.controllers.current;
      scene.userData.current = current === null ? null : current.id;
    });
    S.mount(scene);
  `);
  host.spatial.setInput({ controllers: [{ id: "pad-a" }, { id: "pad-b" }] });
  host.tick();
  assert.equal(host.dump().scene.userData.current, null, "connecting is not using");

  host.spatial.setInput({ controllers: [{ id: "pad-a" }, { id: "pad-b", buttons: { a: 1 } }] });
  host.tick();
  assert.equal(host.dump().scene.userData.current, "pad-b");

  host.spatial.setInput({
    controllers: [{ id: "pad-a", leftThumbstick: [0.5, 0] }, { id: "pad-b", buttons: { a: 1 } }],
  });
  host.tick();
  assert.equal(host.dump().scene.userData.current, "pad-a", "the newest movement wins");
});

// ------------------------------------------------------------------ P2-C-08

test("P2-C-08 a shader graph inside a material array emits shaderParameter with its index", () => {
  const host = createHost({ backend: "realitykit", platform: "macos" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BoxGeometry(0.2, 0.2, 0.2);
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
    const glow = new S.ShaderGraphMaterial({
      source: "m.usda",
      name: "Glow",
      parameters: { intensity: 1 },
      fallback: new S.MeshStandardMaterial(),
    });
    const mesh = new S.Mesh(geometry, [new S.MeshStandardMaterial(), glow]);
    mesh.name = "mesh";
    scene.add(mesh);
    S.onFrame(() => { if (S.time.frame === 2) glow.setParameter("intensity", 4); });
    S.mount(scene);
  `, { backend: "realitykit", platform: "macos" });
  host.tick();
  const command = commandsFor(host.tick(), "shaderParameter")[0];
  assert.ok(command, "a parameter edit inside an array still reaches the consumer");
  assert.equal(command[2], "intensity");
  assert.equal(command[3], 4);
  assert.equal(command[4], 1, "the material index says which part it belongs to");
});

test("P2-C-08 a single shader graph material carries index 0", () => {
  const host = createHost({ backend: "realitykit", platform: "macos" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const glow = new S.ShaderGraphMaterial({
      source: "m.usda",
      name: "Glow",
      parameters: { intensity: 1 },
      fallback: new S.MeshStandardMaterial(),
    });
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), glow);
    mesh.name = "mesh";
    scene.add(mesh);
    S.onFrame(() => { if (S.time.frame === 2) glow.setParameter("intensity", 3); });
    S.mount(scene);
  `, { backend: "realitykit", platform: "macos" });
  host.tick();
  assert.equal(commandsFor(host.tick(), "shaderParameter")[0][4], 0);
});

// ------------------------------------------------------------------ P2-C-09

test("P2-C-09 audio.dispose() releases the sound and the object", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const sound = new S.Audio();
    sound.name = "sound";
    sound.setBuffer(new S.AudioLoader().load("a.wav"));
    sound.play();
    S.onFrame(() => { if (S.time.frame === 2) sound.dispose(); });
    S.mount(scene);
  `);
  const first = host.tick();
  assert.equal(commandsFor(first, "audio").length, 1);
  const runtime = host.spatial.runtime;
  assert.equal(runtime.extraRoots.size, 1, "a played sound is adopted as a root");

  const disposed = host.tick();
  const opcodes = plain(disposed.map((command) => command[0]));
  assert.ok(opcodes.indexOf("audio") !== -1, `the sound is released, got ${opcodes}`);
  assert.equal(commandsFor(disposed, "audio")[0][2], null);
  assert.ok(
    opcodes.indexOf("audio") < opcodes.indexOf("destroy"),
    "the release precedes the destroy",
  );
  assert.equal(runtime.extraRoots.size, 0, "the root is gone");
  assert.equal(runtime.audioObjects.size, 0);
  assert.equal(host.dump().objects.filter((entry) => entry.name === "sound").length, 0);
});

test("P2-C-09 Spatial.destroy on a sound releases it the same way", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const sound = new S.PositionalAudio();
    sound.name = "sound";
    sound.setBuffer(new S.AudioLoader().load("a.wav"));
    scene.add(sound);
    S.onFrame(() => { if (S.time.frame === 2) S.destroy(sound); });
    S.mount(scene);
  `);
  host.tick();
  const destroyed = host.tick();
  assert.equal(commandsFor(destroyed, "audio")[0][2], null);
  assert.equal(commandsFor(destroyed, "destroy").length, 1);
});

// ------------------------------------------------------------------ P2-C-11

test("P2-C-11 a VideoScreen with no url at all dispatches error", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({ width: 1 });
    screen.name = "screen";
    screen.addEventListener("error", (event) => { scene.userData.error = event.message; });
    scene.add(screen);
    S.mount(scene);
  `);
  assert.equal(commandsFor(host.tick(), "video")[0][2].url, null);
  host.tick();
  const dump = host.dump();
  assert.match(dump.scene.userData.error, /no url was given/);
  assert.match(dump.objects.find((entry) => entry.name === "screen").video.error, /no url was given/);
});

// ------------------------------------------------------------------ P2-C-12

test("P2-C-12 a dispatched controller connection carries the controller", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.userData.seen = [];
    scene.addEventListener("controllerconnected", (event) => {
      scene.userData.seen.push(["connected", event.controller.id, event.controller.name]);
      scene.userData.connectedCount = S.input.controllers.connected;
    });
    scene.addEventListener("controllerdisconnected", (event) => {
      scene.userData.seen.push(["disconnected", event.controller.id]);
      scene.userData.afterCount = S.input.controllers.connected;
    });
    S.mount(scene);
  `);
  host.tick();
  host.spatial.dispatch("controllerconnected", 0, { id: "pad-9", name: "Reported" });
  host.tick();
  host.spatial.dispatch("controllerdisconnected", 0, { id: "pad-9" });
  host.tick();
  const dump = host.dump();
  assert.deepEqual(plain(dump.scene.userData.seen), [
    ["connected", "pad-9", "Reported"],
    ["disconnected", "pad-9"],
  ]);
  assert.equal(dump.scene.userData.connectedCount, 1);
  assert.equal(dump.scene.userData.afterCount, 0);
});

// ------------------------------------------------------------------ P2-C-13

test("P2-C-13 blob urls are allowed and reach the consumer unchanged", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({ url: "blob:https://example.com/9f5c-4a", width: 1 });
    screen.name = "screen";
    scene.add(screen);
    const texture = new S.TextureLoader().load("blob:https://example.com/tex");
    const mesh = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), new S.MeshStandardMaterial({ map: texture }));
    mesh.name = "mesh";
    scene.add(mesh);
    S.mount(scene);
  `,
    { assetRoot: "assets" },
  );
  const frame = host.tick();
  assert.equal(commandsFor(frame, "video")[0][2].url, "blob:https://example.com/9f5c-4a");
  assert.equal(commandsFor(frame, "texture")[0][2].url, "blob:https://example.com/tex");
  assert.deepEqual(
    plain(host.dump().warnings.filter((warning) => /refused|dropped/.test(warning))),
    [],
  );
});

// ------------------------------------------------ adopted roots (SPEC 14.13)

test("an adopted extra root is parented to the native root, not left detached", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const marker = new S.Group();
    marker.name = "marker";
    scene.add(marker);

    // Three ways to become an extra root: an unparented camera, a played
    // Audio that is not in the graph, and a pending asset.
    const camera = new S.PerspectiveCamera(60, 1, 0.1, 100);
    camera.name = "camera";
    S.camera = camera;

    const sound = new S.Audio();
    sound.name = "sound";
    sound.setBuffer(new S.AudioLoader().load("a.wav"));
    sound.play();

    S.loadAsset({ usdz: "robot.usdz" }).then(() => {});
    S.mount(scene);
  `);
  const first = host.tick();
  const creates = commandsFor(first, "create");
  const parents = commandsFor(first, "parent");
  assert.equal(creates.length, 4, "the marker and the three adopted roots");

  for (const create of creates) {
    const id = create[1];
    const parent = parents.find((command) => command[1] === id);
    assert.ok(parent, `every created object is parented, ${create[3]} was not`);
    assert.equal(parent[2], 0, `${create[3]} hangs off the native root`);
    const opcodes = plain(first.map((command) => `${command[0]}:${command[1]}`));
    assert.ok(
      opcodes.indexOf(`create:${id}`) < opcodes.indexOf(`parent:${id}`),
      "the create precedes the parent",
    );
  }
  for (const entry of host.dump().objects) {
    assert.notEqual(entry.parent, -1, `${entry.name} is not reported as detached`);
  }
});

test("an adopted root that joins the scene is re-parented, and detaches when released", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const holder = new S.Group();
    holder.name = "holder";
    scene.add(holder);

    const sound = new S.Audio();
    sound.name = "sound";
    sound.setBuffer(new S.AudioLoader().load("a.wav"));
    sound.play();

    const camera = new S.PerspectiveCamera(60, 1, 0.1, 100);
    camera.name = "camera";
    S.camera = camera;

    S.onFrame(() => {
      if (S.time.frame === 2) holder.add(sound);
      if (S.time.frame === 3) S.camera = null;
    });
    S.mount(scene);
  `);
  const first = host.tick();
  // An adopted root is not in the mounted scene, so its id comes from the
  // create command rather than from a lookup by name.
  const idOf = (name) => commandsFor(first, "create").find((command) => command[3] === name)[1];
  const soundId = idOf("sound");
  const cameraId = idOf("camera");
  assert.equal(commandsFor(first, "parent").find((command) => command[1] === soundId)[2], 0);

  const adopted = commandsFor(host.tick(), "parent").find((command) => command[1] === soundId);
  assert.equal(adopted[2], host.idFor("holder"), "joining the scene re-parents it properly");

  const released = commandsFor(host.tick(), "parent").find((command) => command[1] === cameraId);
  assert.equal(released[2], -1, "a released root is detached");
});
