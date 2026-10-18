// One test per performance finding from the performance-and-robustness review,
// plus the public surface that review found untested. Each fails against the
// reviewed build.

import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain, transformIds } from "./helpers.mjs";

// -------------------------------------------------------------------- PERF-03

test("PERF-03 an unchanged light is not re-derived", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    let node = scene;
    for (let i = 0; i < 20; i += 1) { const g = new S.Group(); node.add(g); node = g; }
    const sun = new S.DirectionalLight(0xffffff, 2);
    sun.name = "sun";
    sun.position.set(1, 2, 1);
    node.add(sun);
    S.onFrame(() => { if (S.time.frame === 3) sun.intensity = 5; });
    S.mount(scene);
  `);
  assert.equal(commandsFor(host.tick(), "light").length, 1, "the first frame carries the light");
  assert.equal(commandsFor(host.tick(), "light").length, 0, "an untouched light emits nothing");
  const changed = commandsFor(host.tick(), "light");
  assert.equal(changed.length, 1, "a written property re-derives it");
  assert.equal(changed[0][2].intensity, 5);
  assert.equal(commandsFor(host.tick(), "light").length, 0);
});

test("PERF-03 a light colour change is still detected", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const lamp = new S.PointLight(0xffffff, 1);
    lamp.name = "lamp";
    scene.add(lamp);
    S.onFrame(() => { if (S.time.frame === 2) lamp.color.set(0xff0000); });
    S.mount(scene);
  `);
  host.tick();
  const changed = commandsFor(host.tick(), "light");
  assert.equal(changed.length, 1);
  assert.deepEqual(plain(changed[0][2].color), [1, 0, 0]);
});

// -------------------------------------------------------------------- PERF-04

test("PERF-04 matrixAutoUpdate false is the static hint and still reports a matrix write", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const scenery = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    scenery.name = "scenery";
    scenery.position.set(0.5, 0, 0);
    scenery.updateMatrix();
    scenery.matrixAutoUpdate = false;
    scene.add(scenery);
    S.onFrame(() => {
      // Ignored while the matrix is authoritative, exactly as in three.js.
      if (S.time.frame === 2) scenery.position.set(9, 9, 9);
      if (S.time.frame === 4) scenery.matrix.makeTranslation(1, 2, 3);
    });
    S.mount(scene);
  `);
  host.tick();
  const sceneryId = host.idFor("scenery");
  assert.deepEqual(transformIds(host.tick()), [], "a TRS write does not move a matrix-driven object");
  assert.deepEqual(transformIds(host.tick()), []);
  assert.deepEqual(transformIds(host.tick()), [sceneryId], "a matrix write does");
  const dump = host.dump();
  assert.deepEqual(
    plain(dump.objects[0].position).map((v) => Number(v.toFixed(4))),
    [1, 2, 3],
  );
});

// -------------------------------------------------------------------- PERF-06

test("PERF-06 a known geometry uuid and revision is re-sent without buffers", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.BoxGeometry(0.1, 0.1, 0.1);
    const sphere = new S.SphereGeometry(0.05, 8, 6);
    const mesh = new S.Mesh(box, new S.MeshStandardMaterial());
    mesh.name = "mesh";
    // Keepers hold both geometries alive, so the delivered record survives the
    // swaps; a geometry whose last user leaves is re-sent with its buffers.
    const keepBox = new S.Mesh(box, new S.MeshStandardMaterial());
    keepBox.name = "keepBox";
    const keepSphere = new S.Mesh(sphere, new S.MeshStandardMaterial());
    keepSphere.name = "keepSphere";
    scene.add(mesh, keepBox, keepSphere);
    S.onFrame(() => {
      const f = S.time.frame;
      if (f === 2) mesh.geometry = sphere;
      if (f === 3) mesh.geometry = box;
      if (f === 4) mesh.geometry = sphere;
    });
    S.mount(scene);
  `);
  const created = commandsFor(host.tick(), "geometry");
  const first = created[0];
  assert.ok(first[3] !== null && first[3].length > 0, "the first sight carries the vertices");
  const sphereFirst = created.find((command) => command[2].uuid !== first[2].uuid);
  assert.ok(sphereFirst[3] !== null, "a geometry the consumer has not seen carries its vertices");

  const second = commandsFor(host.tick(), "geometry")[0];
  assert.equal(second[3], null, "the keeper already delivered this geometry");

  const backToBox = commandsFor(host.tick(), "geometry")[0];
  assert.equal(backToBox[3], null, "a known uuid and revision needs no buffers");
  assert.equal(backToBox[2].uuid, first[2].uuid);
  assert.equal(backToBox[2].revision, first[2].revision);
  assert.notEqual(backToBox[2].parameters, null, "the descriptor still describes the mesh");

  const backToSphere = commandsFor(host.tick(), "geometry")[0];
  assert.equal(backToSphere[3], null);
});

test("PERF-06 an edited BufferGeometry still carries its vertices", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BufferGeometry();
    geometry.setAttribute("position", new S.Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 3));
    const mesh = new S.Mesh(geometry, new S.MeshStandardMaterial());
    mesh.name = "mesh";
    scene.add(mesh);
    S.onFrame(() => {
      if (S.time.frame === 2) {
        geometry.getAttribute("position").array[0] = 0.5;
        geometry.getAttribute("position").needsUpdate = true;
      }
    });
    S.mount(scene);
  `);
  assert.ok(commandsFor(host.tick(), "geometry")[0][3].length > 0);
  const edited = commandsFor(host.tick(), "geometry")[0];
  assert.ok(edited[3] !== null && edited[3][0] === 0.5, "an edit is a new revision, so the data is sent");
});

test("PERF-06 meshes sharing one BufferGeometry upload it once", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BufferGeometry();
    const positions = new Float32Array(300);
    for (let i = 0; i < 100; i += 1) positions[i * 3] = i * 0.001;
    geometry.setAttribute("position", new S.Float32BufferAttribute(positions, 3));
    const material = new S.MeshStandardMaterial();
    for (let i = 0; i < 20; i += 1) {
      const mesh = new S.Mesh(geometry, material);
      mesh.name = "m" + i;
      scene.add(mesh);
    }
    S.onFrame(() => {
      if (S.time.frame === 2) {
        // A new revision has to carry its buffers again.
        geometry.getAttribute("position").array[0] = 0.5;
        geometry.getAttribute("position").needsUpdate = true;
      }
    });
    S.mount(scene);
  `);
  const first = commandsFor(host.tick(), "geometry");
  assert.equal(first.length, 20, "every mesh is still described");
  assert.equal(first.filter((command) => command[3] !== null).length, 1, "the vertices cross once");
  assert.equal(first[0][3].length, 300, "and the first one carries them");
  const uuids = new Set(first.map((command) => command[2].uuid));
  assert.equal(uuids.size, 1, "they all name the same geometry");

  const edited = commandsFor(host.tick(), "geometry");
  assert.equal(edited.length, 20, "a new revision reaches every mesh");
  assert.equal(edited.filter((command) => command[3] !== null).length, 1, "and crosses once again");
  assert.equal(edited.find((command) => command[3] !== null)[3][0], 0.5);
});

test("PERF-06 the last user of a geometry being destroyed restores its buffers", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.BoxGeometry(0.1, 0.1, 0.1);
    const material = new S.MeshStandardMaterial();
    const first = new S.Mesh(box, material);
    first.name = "first";
    const second = new S.Mesh(box, material);
    second.name = "second";
    scene.add(first, second);
    S.onFrame(() => {
      if (S.time.frame === 2) {
        S.destroy(first);
        S.destroy(second);
      }
      if (S.time.frame === 3) {
        const third = new S.Mesh(box, material);
        third.name = "third";
        scene.add(third);
      }
    });
    S.mount(scene);
  `);
  const created = commandsFor(host.tick(), "geometry");
  assert.equal(created.length, 2, "both meshes are described");
  assert.ok(created[0][3] !== null && created[0][3].length > 0, "the first sight carries the vertices");
  assert.equal(created[1][3], null, "the second mesh on the same geometry needs no buffers");

  host.tick(); // both meshes destroyed
  const revived = commandsFor(host.tick(), "geometry");
  assert.equal(revived.length, 1);
  assert.ok(
    revived[0][3] !== null && revived[0][3].length > 0,
    "a geometry whose last user was destroyed carries its buffers again",
  );
  assert.equal(revived[0][2].uuid, created[0][2].uuid, "it is still the same geometry");
});

test("PERF-06 a geometry that keeps a live user still re-sends without buffers", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.BoxGeometry(0.1, 0.1, 0.1);
    const material = new S.MeshStandardMaterial();
    const first = new S.Mesh(box, material);
    first.name = "first";
    const second = new S.Mesh(box, material);
    second.name = "second";
    scene.add(first, second);
    S.onFrame(() => {
      if (S.time.frame === 2) S.destroy(first);
      if (S.time.frame === 3) {
        const third = new S.Mesh(box, material);
        third.name = "third";
        scene.add(third);
      }
    });
    S.mount(scene);
  `);
  const created = commandsFor(host.tick(), "geometry");
  assert.equal(created.length, 2);
  host.tick(); // one of the two meshes destroyed, one survivor
  const added = commandsFor(host.tick(), "geometry");
  assert.equal(added.length, 1);
  assert.equal(added[0][3], null, "a survivor keeps the delivery alive, so no buffers are re-sent");
  assert.equal(added[0][2].uuid, created[0][2].uuid);
});

test("PERF-06 replacing the mounted scene restores the buffers of its geometries", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const box = new S.BoxGeometry(0.1, 0.1, 0.1);
    const material = new S.MeshStandardMaterial();
    const first = new S.Scene();
    const mesh = new S.Mesh(box, material);
    mesh.name = "mesh";
    first.add(mesh);
    S.onFrame(() => {
      if (S.time.frame === 2) {
        const next = new S.Scene();
        const replacement = new S.Mesh(box, material);
        replacement.name = "replacement";
        next.add(replacement);
        S.mount(next);
      }
    });
    S.mount(first);
  `);
  const created = commandsFor(host.tick(), "geometry");
  assert.ok(created[0][3] !== null && created[0][3].length > 0);
  const replaced = commandsFor(host.tick(), "geometry");
  assert.equal(replaced.length, 1);
  assert.ok(
    replaced[0][3] !== null && replaced[0][3].length > 0,
    "the replaced scene took its geometry deliveries with it",
  );
});

// -------------------------------------------------------------------- PERF-09

test("PERF-09 only the timers that are due are touched", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    probe.userData.fired = 0;
    scene.add(probe);
    // Far-future timers must cost nothing per frame.
    for (let i = 0; i < 5000; i += 1) setTimeout(() => {}, 600000);
    setTimeout(() => { probe.userData.fired += 1; }, 30);
    setInterval(() => { probe.userData.fired += 10; }, 20);
    S.mount(scene);
  `);
  for (let i = 0; i < 10; i += 1) host.tick();
  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  // The one-shot plus five interval firings over ten frames at 1/60 s.
  assert.equal(probe.userData.fired % 10, 1, "the one-shot fired exactly once");
  assert.ok(probe.userData.fired >= 41 && probe.userData.fired <= 91, `unexpected count ${probe.userData.fired}`);
  assert.equal(host.spatial.runtime.timers.timers.size, 5001);
});

// -------------------------------------------------------------------- PERF-10

test("PERF-10 console output is capped per frame with a summary", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.add(new S.Group());
    S.onFrame(() => { for (let i = 0; i < 1000; i += 1) console.log("line", i); });
    S.mount(scene);
  `);
  const commands = host.tick();
  const logs = commandsFor(commands, "log");
  assert.ok(logs.length <= 201, `expected at most 201 log commands, got ${logs.length}`);
  assert.ok(logs.some((command) => /more log lines were suppressed this frame/.test(command[3])));
  // The next frame starts a fresh budget.
  assert.ok(commandsFor(host.tick(), "log").length <= 201);
});

// -------------------------------------------------------------------- PERF-11

test("PERF-11 replacing a large scene is one frame, not several", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const geo = new S.BoxGeometry(0.02, 0.02, 0.02);
    const mat = new S.MeshStandardMaterial();
    function build(tag) {
      const scene = new S.Scene();
      for (let i = 0; i < 300; i += 1) {
        const m = new S.Mesh(geo, mat);
        m.name = tag + i;
        scene.add(m);
      }
      return scene;
    }
    const a = build("a");
    this.b = build("b");
    S.mount(a);
    S.onFrame(() => { if (S.time.frame === 2) S.mount(this.b); });
  `);
  host.tick();
  const swap = host.tick();
  assert.equal(commandsFor(swap, "destroy").length, 300, "every old entity is destroyed in the swap frame");
  assert.equal(commandsFor(swap, "create").length, 300, "and every new one created");
  assert.deepEqual(plain(commandsFor(host.tick(), "destroy")), [], "nothing spills into the next frame");
  assert.deepEqual(plain(commandsFor(host.tick(), "create")), []);
});

// -------------------------------------------------------------------- PERF-02

test("PERF-02 dump options narrow the work a polling host pays for", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geo = new S.BoxGeometry(0.02, 0.02, 0.02);
    const mat = new S.MeshStandardMaterial();
    for (let i = 0; i < 200; i += 1) {
      const m = new S.Mesh(geo, mat);
      m.name = "m" + i;
      m.position.set(i * 0.001234567, 0, 0);
      m.userData.big = "x".repeat(200);
      scene.add(m);
    }
    S.mount(scene);
  `);
  host.tick();

  const full = host.spatial.dump();
  assert.equal(full.objects.length, 200);
  assert.ok(full.objects[0].userData.big.length === 200);
  assert.notEqual(full.objects[0].material, null);

  // SPEC 3.13 licenses exactly two omissions: geometry parameters and
  // userData. Everything else the full entry carries stays (FA-41).
  const compact = host.spatial.dump({ compact: true });
  assert.equal(compact.objects.length, 200);
  assert.equal(compact.objects[0].userData, undefined, "no userData");
  assert.ok(!("parameters" in compact.objects[0].geometry), "no geometry parameters key");
  assert.equal(compact.objects[0].geometry.type, "BoxGeometry", "the geometry type stays");
  assert.notEqual(compact.objects[0].material, undefined, "the material payload stays");
  assert.equal(compact.objects[0].material.type, "MeshStandardMaterial");
  assert.equal(compact.objects[0].light, null, "the light slot stays");
  assert.equal(compact.objects[0].rigidBody, null);
  assert.equal(compact.objects[0].opacity, 1);
  assert.equal(compact.objects[0].billboard, false);
  assert.equal(compact.objects[0].world, false);
  assert.notEqual(compact.objects[0].interactive, undefined);
  assert.equal(compact.objects[1].position[0], 0.0012, "positions are rounded to four decimals");
  assert.ok(
    JSON.stringify(compact).length < JSON.stringify(full).length,
    "compact is still smaller on the wire",
  );

  const summary = host.spatial.dump({ objects: false });
  assert.equal(summary.objects.length, 0);
  assert.equal(summary.frame, 1);
  assert.deepEqual(plain(summary.gravity), [0, -9.81, 0]);

  const named = host.spatial.dump({ names: ["m3", "m7"] });
  assert.deepEqual(plain(named.objects.map((entry) => entry.name)), ["m3", "m7"]);

  const fields = host.spatial.dump({ fields: ["position"] });
  assert.deepEqual(plain(Object.keys(fields.objects[0])).sort(), ["id", "name", "position"]);
});

// -------------------------------------------------------------------- MAINT-06

test("MAINT-06 the load capabilities option overrides the platform defaults", () => {
  const host = createHost();
  host.load('const S = require("spatial"); const s = new S.Scene(); s.add(new S.Group()); S.mount(s);', {
    backend: "realitykit",
    platform: "macos",
    capabilities: { manipulation: true, hands: true },
  });
  const capabilities = host.spatial.Spatial.env.capabilities;
  assert.equal(capabilities.manipulation, true, "the host's answer wins");
  assert.equal(capabilities.hands, true);
  assert.equal(capabilities.anchors, false, "unmentioned keys keep the platform default");
  assert.equal(capabilities.portals, true);
});

test("MAINT-06 hand tracking reaches the script", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    S.onFrame(() => {
      const left = S.input.hands.left;
      probe.userData.tracked = left !== null && left.isTracked;
      probe.userData.pinching = left !== null && left.isPinching;
      const tip = left === null ? null : left.joint("indexFingerTip");
      probe.userData.tip = tip === null ? null : tip.position.toArray();
      probe.userData.unknown = left === null ? "no hand" : left.joint("elbow");
      probe.userData.right = S.input.hands.right;
    });
    S.mount(scene);
  `);
  host.spatial.setInput({
    hands: {
      left: {
        isTracked: true,
        isPinching: true,
        joints: { indexFingerTip: [0.1, 0.2, 0.3, 0, 0, 0, 1], notAJoint: [9, 9, 9, 0, 0, 0, 1] },
      },
      right: null,
    },
  });
  host.tick();
  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  assert.equal(probe.userData.tracked, true);
  assert.equal(probe.userData.pinching, true);
  assert.deepEqual(plain(probe.userData.tip), [0.1, 0.2, 0.3]);
  assert.equal(probe.userData.unknown, null, "an unknown joint name reports null");
  assert.equal(probe.userData.right, null);
});

test("MAINT-06 assetError and unanchored reach their listeners", async () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const anchor = new S.Anchor("head");
    anchor.name = "anchor";
    anchor.userData.events = [];
    anchor.addEventListener("anchored", () => anchor.userData.events.push("anchored"));
    anchor.addEventListener("unanchored", () => anchor.userData.events.push("unanchored"));
    scene.add(anchor);
    S.mount(scene);
    S.loadAsset({ glb: "asset://robot.glb" }).catch((error) => {
      anchor.userData.assetError = error.message;
    });
  `,
    { backend: "three", platform: "web" },
  );
  const first = host.tick();
  const assetId = first.find((command) => command[0] === "asset")[1];
  const anchorId = host.idFor("anchor");

  host.spatial.dispatch("anchored", anchorId, {});
  host.tick();
  host.spatial.dispatch("unanchored", anchorId, {});
  host.spatial.dispatch("assetError", assetId, { message: "robot.glb is missing" });
  host.tick();
  await Promise.resolve();
  host.tick();

  const anchor = host.dump().objects.find((entry) => entry.name === "anchor");
  assert.deepEqual(plain(anchor.userData.events), ["anchored", "unanchored"]);
  assert.equal(anchor.isAnchored, false, "unanchored clears the flag");
  assert.equal(anchor.userData.assetError, "robot.glb is missing");
});

test("MAINT-06 TextureLoader.setPath and the gravity setter work", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const loader = new S.TextureLoader().setPath("skins/");
    const mesh = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), new S.MeshStandardMaterial({ map: loader.load("hero.png") }));
    mesh.name = "mesh";
    scene.add(mesh);
    S.physics.gravity = new S.Vector3(0, -1.62, 0);
    S.mount(scene);
  `,
    { assetRoot: "assets" },
  );
  const commands = host.tick();
  assert.equal(commandsFor(commands, "texture")[0][2].url, "assets/skins/hero.png");
  assert.deepEqual(plain(commandsFor(commands, "gravity")[0]), ["gravity", 0, 0, -1.62, 0]);
});

test("MAINT-08 hoverEffect only accepts the documented values", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    mesh.name = "mesh";
    scene.add(mesh);
    const results = {};
    mesh.userData.results = results;
    for (const value of ["highlight", "lift", "spotlight", null, "sparkle", 7]) {
      try {
        mesh.hoverEffect = value;
        results[String(value)] = "ok";
      } catch (error) {
        results[String(value)] = error.name;
      }
    }
    S.mount(scene);
  `);
  host.tick();
  const results = host.dump().objects[0].userData.results;
  assert.equal(results.highlight, "ok");
  assert.equal(results.lift, "ok");
  assert.equal(results.spotlight, "ok");
  assert.equal(results.null, "ok");
  assert.equal(results.sparkle, "TypeError");
  assert.equal(results["7"], "TypeError");
});

// ------------------------------------------------------------- SPEC 3.13 caps

test("Spatial.limits names every enforced cap and cannot be edited", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    probe.userData.limits = { ...S.limits };
    try {
      S.limits.MAX_DEPTH = 1;
      probe.userData.frozen = S.limits.MAX_DEPTH === 1024;
    } catch (error) {
      probe.userData.frozen = true;
    }
    scene.add(probe);
    S.mount(scene);
  `);
  host.tick();
  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  const expected = [
    "MAX_CALLBACKS_PER_TICK",
    "MAX_DEPTH",
    "MAX_ERROR_MESSAGES_PER_SECOND",
    "MAX_ID",
    "MAX_LISTENERS_PER_EVENT",
    "MAX_LIVE_FRAME_CALLBACKS",
    "MAX_LIVE_TIMERS",
    "MAX_LOGS_PER_FRAME",
    "MAX_LOG_MESSAGE",
    "MAX_NAME_LENGTH",
    "MAX_RECORDED_ERRORS",
    "MAX_RECORDED_WARNINGS",
  ];
  assert.deepEqual(Object.keys(probe.userData.limits).sort(), expected);
  assert.equal(probe.userData.limits.MAX_ID, 1 << 24);
  assert.equal(probe.userData.limits.MAX_RECORDED_ERRORS, 200);
  assert.equal(probe.userData.limits.MAX_RECORDED_WARNINGS, 500);
  assert.equal(
    probe.userData.limits.MAX_ERROR_MESSAGES_PER_SECOND,
    20,
    "the error rate limit SPEC 3.13 states is readable, not hidden",
  );
  assert.ok(probe.userData.frozen, "the object stays frozen");
});

