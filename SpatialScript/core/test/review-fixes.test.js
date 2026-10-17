// One test per review finding. Each of these fails against the build that was
// reviewed and passes against the fixed core.

import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain, transformIds, transformRecords } from "./helpers.mjs";

const FRAME = 1 / 60;

// ------------------------------------------------------------------ CORE-01

test("CORE-01 a hierarchy deeper than the limit is refused and the loop survives", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    let node = scene;
    let built = 0;
    for (let i = 0; i < 3000; i += 1) {
      const g = new S.Group();
      g.name = "level" + i;
      node.add(g);
      if (g.parent === node) { node = g; built += 1; }
    }
    scene.userData.built = built;
    S.mount(scene);
  `);

  // The frame loop, the dump and the teardown all keep working.
  let commands;
  assert.doesNotThrow(() => {
    commands = host.tick();
  });
  assert.ok(commands.length > 0);
  assert.doesNotThrow(() => host.tick());
  let dump;
  assert.doesNotThrow(() => {
    dump = host.dump();
  });
  // The scene root is depth 0, so 1024 groups fit under it.
  assert.equal(host.spatial.Spatial.scene.userData.built, 1024);
  assert.equal(dump.objects.length, 1024);
  assert.ok(dump.errors.some((entry) => /levels deep; the limit is 1024/.test(entry)));
  assert.doesNotThrow(() => host.spatial.dispose());
});

test("CORE-01 depth 1024 is accepted and depth 1025 is refused", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    let node = scene;
    for (let i = 0; i < 1024; i += 1) {
      const g = new S.Group();
      g.name = "n" + i;
      node.add(g);
      node = g;
    }
    scene.userData.depth = 1024;
    const tail = new S.Group();
    tail.name = "tail";
    node.add(tail);
    scene.userData.refused = tail.parent === null;
    S.mount(scene);
  `);
  assert.doesNotThrow(() => host.tick());
  const scene = host.spatial.Spatial.scene;
  assert.equal(scene.userData.refused, true);
  assert.equal(host.dump().objects.length, 1024);
  assert.doesNotThrow(() => host.tick());
});

// ------------------------------------------------------------------ CORE-02

test("CORE-02 a malformed sync record is dropped and reported, not written", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const holder = new S.Group();
    holder.name = "holder";
    scene.add(holder);
    const ball = new S.Mesh(new S.SphereGeometry(0.05, 12, 8), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.position.set(0.1, 0.2, 0.3);
    ball.rigidBody = new S.RigidBody({});
    holder.add(ball);
    S.mount(scene);
  `);
  host.tick();
  const ballId = host.idFor("ball");

  host.spatial.sync(new Float32Array([ballId, NaN, 0, 0, 0, 0, 0, 1, 1, 1, 1]));
  host.tick();
  let ball = host.dump().objects.find((entry) => entry.name === "ball");
  assert.deepEqual(plain(ball.position), [0.1, 0.2, 0.3], "the graph keeps the last valid pose");
  assert.deepEqual(plain(ball.worldPosition), [0.1, 0.2, 0.3]);
  assert.equal(host.dump().errors.filter((entry) => /sync record/.test(entry)).length, 1);

  // A zero-length quaternion is invalid too.
  host.spatial.sync(new Float32Array([ballId, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1]));
  host.tick();
  ball = host.dump().objects.find((entry) => entry.name === "ball");
  assert.deepEqual(plain(ball.position), [0.1, 0.2, 0.3]);

  // An unknown id is ignored without error spam.
  host.spatial.sync(new Float32Array([99999, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1]));
  assert.doesNotThrow(() => host.tick());

  // A good record still applies, and re-arms the report.
  host.spatial.sync(new Float32Array([ballId, 0, 0.5, 0, 0, 0, 0, 1, 1, 1, 1]));
  host.tick();
  ball = host.dump().objects.find((entry) => entry.name === "ball");
  assert.deepEqual(plain(ball.worldPosition).map((v) => Number(v.toFixed(5))), [0, 0.5, 0]);
});

test("CORE-02 a zero-scale parent does not collapse a child's local pose", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const holder = new S.Group();
    holder.name = "holder";
    holder.scale.set(0, 0, 0);
    scene.add(holder);
    const ball = new S.Mesh(new S.SphereGeometry(0.05, 12, 8), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.position.set(0.4, 0, 0);
    holder.add(ball);
    S.mount(scene);
  `);
  host.tick();
  host.spatial.sync(new Float32Array([host.idFor("ball"), 1, 2, 3, 0, 0, 0, 1, 1, 1, 1]));
  host.tick();
  const ball = host.dump().objects.find((entry) => entry.name === "ball");
  assert.deepEqual(plain(ball.position), [0.4, 0, 0], "the last local pose is kept");
  assert.ok(host.dump().errors.some((entry) => /singular world matrix/.test(entry)));
});

test("CORE-02 syncBodies rejects a non-finite velocity", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const ball = new S.Mesh(new S.SphereGeometry(0.05, 12, 8), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.rigidBody = new S.RigidBody({});
    scene.add(ball);
    S.mount(scene);
  `);
  host.tick();
  host.spatial.syncBodies(new Float32Array([host.idFor("ball"), 0, NaN, 0, 0, 0, 0, 0]));
  host.tick();
  const ball = host.dump().objects.find((entry) => entry.name === "ball");
  assert.deepEqual(plain(ball.velocity), [0, 0, 0]);
  assert.ok(host.dump().errors.some((entry) => /non-finite velocity/.test(entry)));
});

// ------------------------------------------------------------- CORE-03 / 18

test("CORE-03 every documented geometry mutation re-emits the geometry command", () => {
  const mutations = [
    'geometry.setAttribute("position", new S.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));',
    "geometry.computeVertexNormals();",
    "geometry.setIndex([0, 1, 2]);",
    'geometry.setAttribute("uv", new S.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));',
    'geometry.getAttribute("position").array[0] = 0.5; geometry.getAttribute("position").needsUpdate = true;',
    "mesh.geometry = new S.BoxGeometry(0.2, 0.2, 0.2);",
  ];
  for (const mutation of mutations) {
    const host = createHost();
    host.load(`
      const S = require("spatial");
      const scene = new S.Scene();
      const geometry = new S.BufferGeometry();
      geometry.setAttribute("position", new S.Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 3));
      const mesh = new S.Mesh(geometry, new S.MeshStandardMaterial());
      mesh.name = "mesh";
      scene.add(mesh);
      S.onFrame(() => { if (S.time.frame === 2) { ${mutation} } });
      S.mount(scene);
    `);
    assert.equal(commandsFor(host.tick(), "geometry").length, 1, `frame 1 for ${mutation}`);
    assert.equal(commandsFor(host.tick(), "geometry").length, 1, `mutation missed: ${mutation}`);
    assert.equal(commandsFor(host.tick(), "geometry").length, 0, `re-emitted for ${mutation}`);
  }
});

test("CORE-18 the geometry payload is a copy, not the live attribute array", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BufferGeometry();
    geometry.setAttribute("position", new S.Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 3));
    const mesh = new S.Mesh(geometry, new S.MeshStandardMaterial());
    mesh.name = "mesh";
    scene.add(mesh);
    this.geometry = geometry;
    S.mount(scene);
  `);
  const payload = commandsFor(host.tick(), "geometry")[0][3];
  const live = host.spatial.runtime.script.geometry.getAttribute("position").array;
  assert.notEqual(payload, live, "the payload must not alias the live array");
  assert.equal(payload[0], 0);
  live[0] = 99;
  assert.equal(payload[0], 0, "a later in-place edit must not change a delivered payload");
});

// ------------------------------------------------------------------ CORE-04

test("CORE-04 a RigidBody cannot be attached to two objects", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const body = new S.RigidBody({ mass: 3 });
    const a = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    a.name = "a";
    a.rigidBody = body;
    scene.add(a);
    const b = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    b.name = "b";
    scene.add(b);
    try {
      b.rigidBody = body;
      a.userData.shared = "allowed";
    } catch (error) {
      a.userData.shared = error.name + ":" + error.feature;
    }
    a.userData.stillMine = a.rigidBody === body;
    S.mount(scene);
  `);
  host.tick();
  const a = host.dump().objects.find((entry) => entry.name === "a");
  assert.equal(a.userData.shared, "SpatialUnsupportedError:rigidbody-shared");
  assert.equal(a.userData.stillMine, true);
});

// ------------------------------------------------------------------ CORE-05

test("CORE-05 sync applies to an object with matrixAutoUpdate off", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const ball = new S.Mesh(new S.SphereGeometry(0.05, 12, 8), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.matrixAutoUpdate = false;
    ball.rigidBody = new S.RigidBody({});
    scene.add(ball);
    S.mount(scene);
  `);
  host.tick();
  host.spatial.sync(new Float32Array([host.idFor("ball"), 0, 5, 0, 0, 0, 0, 1, 1, 1, 1]));
  host.tick();
  const ball = host.dump().objects.find((entry) => entry.name === "ball");
  assert.deepEqual(plain(ball.position).map((v) => Number(v.toFixed(5))), [0, 5, 0]);
  // And it stays there: the stale matrix must not be re-decomposed over it.
  host.tick();
  const again = host.dump().objects.find((entry) => entry.name === "ball");
  assert.deepEqual(plain(again.position).map((v) => Number(v.toFixed(5))), [0, 5, 0]);
});

// ------------------------------------------------------------------ CORE-06

test("CORE-06 attach onto a rotated, non-uniformly scaled parent is not a shear error", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const parent = new S.Group();
    parent.name = "parent";
    parent.scale.set(2, 0.5, 1);
    parent.rotation.set(0.3, 0.4, 0.5);
    scene.add(parent);
    const m = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    m.name = "m";
    m.position.set(0.2, 0, 0);
    scene.add(m);
    S.onFrame(() => { if (S.time.frame === 2) parent.attach(m); });
    S.mount(scene);
  `);
  host.tick();
  const mId = host.idFor("m");
  const parentId = host.idFor("parent");

  const commands = host.tick();
  assert.deepEqual(plain(commandsFor(commands, "parent")), [["parent", mId, parentId]]);
  assert.ok(
    transformIds(commands).includes(mId),
    "the reparented object must carry its new local transform in the same frame",
  );
  assert.deepEqual(plain(host.dump().errors), []);
});

// ------------------------------------------------------------------ CORE-07

test("CORE-07 a sheared applyMatrix4 is refused on every frame, not just the first", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    const shear = new S.Matrix4();
    shear.set(1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    S.onFrame(() => { if (S.time.frame === 2) box.applyMatrix4(shear); });
    S.mount(scene);
  `);
  host.tick();
  const boxId = host.idFor("box");

  assert.deepEqual(transformIds(host.tick()), [], "the sheared frame emits nothing");
  for (let frame = 0; frame < 4; frame += 1) {
    assert.deepEqual(
      transformIds(host.tick()),
      [],
      "the shear-stripped decomposition must never arrive on a later frame",
    );
  }
  assert.equal(host.dump().errors.filter((entry) => /contains shear/.test(entry)).length, 1);

  // Writing a clean transform recovers.
  host.spatial.Spatial.find("box").position.set(0.3, 0, 0);
  assert.deepEqual(transformIds(host.tick()), [boxId]);
});

// ------------------------------------------------------------------ CORE-08

test("CORE-08 mounting twice inside one tick destroys the first scene", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const a = new S.Scene();
    const ma = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    ma.name = "a-cube";
    a.add(ma);
    const b = new S.Scene();
    const mb = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    mb.name = "b-cube";
    b.add(mb);
    const c = new S.Scene();
    const mc = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    mc.name = "c-cube";
    c.add(mc);
    S.mount(a);
    S.onFrame(() => { if (S.time.frame === 2) { S.mount(b); S.mount(c); } });
  `);
  host.tick();
  const firstId = host.idFor("a-cube");

  const commands = host.tick();
  assert.deepEqual(
    plain(commandsFor(commands, "destroy")),
    [["destroy", firstId]],
    "the first scene's entity is destroyed, not merely detached",
  );
  assert.deepEqual(plain(commandsFor(commands, "parent")).map((c) => c[2]), [0]);
});

// ------------------------------------------------------------------ CORE-09

test("CORE-09 destroyed ids are recycled and the dump reports a load generation", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const keep = new S.Group();
    keep.name = "keep";
    scene.add(keep);
    S.onFrame(() => {
      if (S.time.frame === 2) {
        for (let i = 0; i < 4; i += 1) {
          const g = new S.Group();
          g.name = "t" + i;
          scene.add(g);
        }
      }
      if (S.time.frame === 3) {
        for (let i = 0; i < 4; i += 1) S.destroy(S.find("t" + i));
      }
      if (S.time.frame === 4) {
        for (let i = 0; i < 4; i += 1) {
          const g = new S.Group();
          g.name = "u" + i;
          scene.add(g);
        }
      }
    });
    S.mount(scene);
  `);
  host.tick();
  const created = commandsFor(host.tick(), "create").map((command) => command[1]);
  host.tick();
  const recreated = commandsFor(host.tick(), "create").map((command) => command[1]);
  assert.deepEqual(
    plain(recreated).sort((a, b) => a - b),
    plain(created).sort((a, b) => a - b),
    "released ids are reused instead of growing towards 2^24",
  );
  assert.equal(host.dump().loadGeneration, 1);
});

test("CORE-09 loadGeneration increments per load", () => {
  const host = createHost();
  const source = 'const S = require("spatial"); const s = new S.Scene(); s.add(new S.Group()); S.mount(s);';
  host.load(source);
  host.tick();
  assert.equal(host.dump().loadGeneration, 1);
  host.load(source);
  host.tick();
  assert.equal(host.dump().loadGeneration, 2);
});

// ------------------------------------------------------------- CORE-10 / 14

test("CORE-10 dispose tears down joints, the environment and the frame loop", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const a = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    a.name = "a";
    a.rigidBody = new S.RigidBody({ type: "static" });
    scene.add(a);
    const b = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    b.name = "b";
    b.rigidBody = new S.RigidBody({});
    scene.add(b);
    S.physics.add(new S.Joint({ type: "fixed", bodyA: a, bodyB: b }));
    S.environment = new S.ImageBasedLight("asset://studio.exr", 1);
    S.onFrame(() => {});
    setInterval(() => {}, 10);
    S.mount(scene);
  `);
  host.tick();

  const commands = host.spatial.dispose();
  const opcodes = plain(commands).map((command) => command[0]);
  assert.ok(opcodes.includes("joint"), "joints are released");
  assert.deepEqual(
    plain(commands.filter((command) => command[0] === "joint"))[0].slice(2),
    [null],
  );
  assert.ok(opcodes.indexOf("joint") < opcodes.indexOf("destroy"), "joints before their entities");
  assert.ok(opcodes.includes("environment"));
  assert.equal(commands.filter((command) => command[0] === "environment")[0][2], null);

  const runtime = host.spatial.runtime;
  assert.equal(runtime.physics.joints.length, 0);
  assert.equal(runtime.environment, null);
  assert.deepEqual(plain(runtime.physics.gravity.toArray()), [0, -9.81, 0]);
  assert.equal(runtime.frameCallbacks.length, 0);
  assert.equal(runtime.timers.timers.size, 0);
});

test("CORE-14 a tick after dispose emits nothing", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    S.mount(scene);
  `);
  host.tick();
  host.spatial.dispose();
  assert.deepEqual(plain(host.spatial.tick(FRAME)), []);
  assert.deepEqual(plain(host.spatial.tick(FRAME)), []);
});

// ------------------------------------------------------------------ CORE-11

test("CORE-11 a portal whose world is not in the scene warns and emits no portal", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const world = new S.Group();
    world.name = "world";
    const portal = new S.Portal({ width: 0.5, height: 0.5, world });
    portal.name = "portal";
    scene.add(portal);
    S.onFrame(() => { if (S.time.frame === 3) scene.add(world); });
    S.mount(scene);
  `);
  const first = host.tick();
  assert.deepEqual(plain(commandsFor(first, "portal")), []);
  assert.ok(host.dump().warnings.some((warning) => /world group that is not in the mounted scene/.test(warning)));

  host.tick();
  const third = host.tick();
  const worldId = host.idFor("world");
  const portals = commandsFor(third, "portal");
  assert.equal(portals.length, 1, "the portal arrives once its world is in the scene");
  assert.equal(portals[0][2].worldId, worldId);
  const worldIndex = third.findIndex((command) => command[0] === "world");
  assert.ok(worldIndex >= 0 && worldIndex < third.indexOf(portals[0]));
});

// ------------------------------------------------------------------ CORE-12

test("CORE-12 destroying a joint's body removes the joint", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const a = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    a.name = "a";
    a.rigidBody = new S.RigidBody({ type: "static" });
    scene.add(a);
    const b = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    b.name = "b";
    b.rigidBody = new S.RigidBody({});
    scene.add(b);
    S.physics.add(new S.Joint({ type: "revolute", bodyA: a, bodyB: b }));
    S.onFrame(() => { if (S.time.frame === 2) S.destroy(S.find("a")); });
    S.mount(scene);
  `);
  const first = host.tick();
  const jointId = commandsFor(first, "joint")[0][1];

  const commands = host.tick();
  assert.deepEqual(plain(commandsFor(commands, "joint")), [["joint", jointId, null]]);
  assert.deepEqual(plain(host.dump().joints), []);
  assert.equal(host.spatial.runtime.physics.joints.length, 0);
});

// ------------------------------------------------------------------ CORE-13

test("CORE-13 an imperative command never names an uncreated or just-destroyed id", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const loose = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    loose.name = "loose";
    loose.rigidBody = new S.RigidBody({});
    const fx = new S.ParticleEmitter({});
    fx.name = "fx";

    const doomed = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    doomed.name = "doomed";
    doomed.rigidBody = new S.RigidBody({});
    scene.add(doomed);

    S.onFrame(() => {
      if (S.time.frame === 1) { loose.rigidBody.applyImpulse(new S.Vector3(0, 1, 0)); fx.burst(); }
      if (S.time.frame === 2) { doomed.rigidBody.applyImpulse(new S.Vector3(0, 1, 0)); S.destroy(doomed); }
    });
    S.mount(scene);
  `);
  const first = host.tick();
  assert.deepEqual(plain(commandsFor(first, "bodyImpulse")), [], "no impulse for an object with no create");
  assert.deepEqual(plain(commandsFor(first, "particlesBurst")), []);
  assert.ok(host.dump().warnings.some((warning) => /not in the mounted scene/.test(warning)));

  const second = host.tick();
  assert.ok(commandsFor(second, "destroy").length > 0);
  assert.deepEqual(
    plain(commandsFor(second, "bodyImpulse")),
    [],
    "an impulse for an id destroyed in the same batch is dropped",
  );
});

// ------------------------------------------------------------------ CORE-15

test("CORE-15 an awaited asset does not leave the detach scan running every frame", async () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const holder = new S.Group();
    holder.name = "holder";
    scene.add(holder);
    S.mount(scene);
    S.loadAsset({ glb: "asset://robot.glb" }).then((asset) => {
      asset.name = "robot";
      holder.add(asset);
    });
  `, { backend: "three", platform: "web" });
  host.tick();
  const assetCommand = host.frames[0].find((command) => command[0] === "asset");
  host.spatial.dispatch("assetLoaded", assetCommand[1], { animations: [], boundingBox: [0, 0, 0, 0, 0, 0] });
  await Promise.resolve();
  host.tick();
  host.tick();
  const runtime = host.spatial.runtime;
  assert.ok(runtime.detachedCount >= 0, `detachedCount went negative: ${runtime.detachedCount}`);
  assert.equal(runtime.liveCount + runtime.detachedCount, runtime.trackedSnapshots.length);
});

// ------------------------------------------------------------- CORE-16 / 17

test("CORE-16 errors are capped and the dropped count is reported", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.add(new S.Group());
    // Distinct shapes, not distinct numbers: the throttle keys on the shape.
    const letters = "abcdefghijklmnopqrstuvwxyz";
    S.onFrame(() => {
      const i = S.time.frame;
      throw new Error("failure " + letters[i % 26] + letters[Math.floor(i / 26) % 26]);
    });
    S.mount(scene);
  `);
  for (let i = 0; i < 400; i += 1) host.tick();
  const dump = host.dump();
  assert.equal(dump.errors.length, 200);
  assert.ok(dump.droppedErrors > 0);
  assert.ok(host.spatial.runtime.errorTimes.size <= 800);
});

test("CORE-17 a single log message is truncated", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.add(new S.Group());
    console.log("big", "x".repeat(200000));
    S.mount(scene);
  `);
  const log = commandsFor(host.tick(), "log")[0];
  assert.ok(log[3].length < 20000, `message was ${log[3].length} characters`);
  assert.match(log[3], /… \(truncated, \d+ characters\)$/);
});

// ------------------------------------------------------------------ CORE-19

test("CORE-19 a disposed texture stops emitting and keeps its id reserved", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const texture = new S.TextureLoader().load("asset://grid.png");
    const mesh = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), new S.MeshStandardMaterial({ map: texture }));
    mesh.name = "panel";
    scene.add(mesh);
    S.onFrame(() => {
      if (S.time.frame === 2) texture.dispose();
      // A property change after dispose must not resurrect it into the stream.
      if (S.time.frame === 3) texture.repeat.set(4, 4);
    });
    S.mount(scene);
  `);
  const first = host.tick();
  const firstId = commandsFor(first, "texture")[0][1];
  host.tick();
  assert.deepEqual(plain(commandsFor(host.tick(), "texture")), [], "a disposed texture emits no more updates");
  // The material still names it, so the id stays reserved rather than being
  // handed to a different texture.
  assert.equal(host.spatial.runtime.idTextures.get(firstId) !== undefined, true);
  assert.equal(host.spatial.runtime.freeIds.includes(firstId), false);
});

// ------------------------------------------------------------------ CORE-20

test("CORE-20 changing a portal's width rebuilds its plane geometry", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const world = new S.Group();
    world.name = "world";
    scene.add(world);
    const portal = new S.Portal({ width: 0.5, height: 0.5, world });
    portal.name = "portal";
    scene.add(portal);
    S.onFrame(() => { if (S.time.frame === 2) portal.width = 1; });
    S.mount(scene);
  `);
  host.tick();
  const commands = host.tick();
  const geometry = commandsFor(commands, "geometry");
  assert.equal(geometry.length, 1, "the plane is regenerated");
  assert.equal(geometry[0][2].parameters.width, 1);
  assert.equal(commandsFor(commands, "portal")[0][2].width, 1);
});

// ------------------------------------------------------------------ CORE-21

test("CORE-21 a failed geometry construction does not leak notes to the next geometry", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    try {
      new S.TextGeometry("x", { size: -1, font: "nope" });
    } catch (error) {
      scene.userData.threw = error.name;
    }
    const clean = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    clean.name = "clean";
    scene.add(clean);
    S.mount(scene);
  `);
  host.tick();
  assert.equal(host.spatial.Spatial.scene.userData.threw, "SpatialUnsupportedError");
  assert.deepEqual(plain(host.dump().warnings), [], "the clean geometry inherits no notes");
});

// ------------------------------------------------------------- CORE-22 / C-16

test("CORE-22 mouse delta returns to zero on a frame with no setInput", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    probe.userData.deltas = [];
    scene.add(probe);
    S.onFrame(() => { probe.userData.deltas.push(S.input.mouse.delta.toArray()); });
    S.mount(scene);
  `);
  host.spatial.setInput({ mouse: { position: [1, 2], buttons: [false, false, false], delta: [7, 9] } });
  host.tick();
  host.tick();
  host.tick();
  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  assert.deepEqual(plain(probe.userData.deltas), [[7, 9], [0, 0], [0, 0]]);
});

// ------------------------------------------------------------------ CORE-23

test("CORE-23 dump never mints an id for the mounted scene", async () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const holder = new S.Group();
    holder.name = "holder";
    scene.add(holder);
    S.mount(scene);
    S.loadAsset({ glb: "asset://robot.glb" }).then((asset) => { asset.name = "robot"; });
  `, { backend: "three", platform: "web" });
  host.tick();
  await Promise.resolve();
  const before = host.spatial.runtime.nextId;
  const dump = host.dump();
  assert.equal(host.spatial.runtime.nextId, before, "dump allocates no ids");
  assert.equal(host.spatial.runtime.objectIds.has(host.spatial.Spatial.scene), false);
  for (const entry of dump.objects) assert.notEqual(entry.id, 0);
});

// ==================== completeness review =============================

test("C-05 inject.key(code, false) releases the key with no consumer input", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    probe.userData.down = [];
    scene.add(probe);
    S.onFrame(() => { probe.userData.down.push(S.input.keyboard.isDown("Space")); });
    S.mount(scene);
  `);
  const inject = host.spatial.Spatial.inject;
  inject.key("Space", true);
  host.tick();
  host.tick();
  host.tick();
  inject.key("Space", false);
  host.tick();
  host.tick();
  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  assert.deepEqual(plain(probe.userData.down), [true, true, true, false, false]);
});

test("C-10 a direct matrix write is honoured with matrixAutoUpdate left on", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    S.onFrame(() => { if (S.time.frame === 2) box.matrix.makeTranslation(1, 2, 3); });
    S.mount(scene);
  `);
  host.tick();
  const boxId = host.idFor("box");
  const records = transformRecords(host.tick());
  assert.equal(records.length, 1);
  assert.equal(records[0].id, boxId);
  assert.deepEqual(records[0].position.map((v) => Number(v.toFixed(4))), [1, 2, 3]);
  const box = host.dump().objects.find((entry) => entry.name === "box");
  assert.deepEqual(plain(box.position).map((v) => Number(v.toFixed(4))), [1, 2, 3]);
  // And it settles: no repeat command while the matrix stays put.
  assert.deepEqual(transformIds(host.tick()), []);
});

test("C-11 the raycast fallback returns one hit per visible object, sorted", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const hidden = new S.Mesh(new S.BoxGeometry(0.4, 0.4, 0.1), new S.MeshStandardMaterial());
    hidden.name = "hidden";
    hidden.position.set(0, 0, -0.5);
    hidden.visible = false;
    scene.add(hidden);
    const group = new S.Group();
    group.name = "group";
    scene.add(group);
    const child = new S.Mesh(new S.BoxGeometry(0.4, 0.4, 0.1), new S.MeshStandardMaterial());
    child.name = "child";
    child.position.set(0, 0, -1);
    group.add(child);
    const top = new S.Mesh(new S.BoxGeometry(0.4, 0.4, 0.1), new S.MeshStandardMaterial());
    top.name = "top";
    top.position.set(0, 0, -2);
    scene.add(top);
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    S.onFrame(() => {
      if (S.time.frame !== 2) return;
      const all = S.raycast(new S.Vector3(0.03, 0.02, 0), new S.Vector3(0, 0, -1));
      probe.userData.all = all.map((hit) => hit.object.name);
      probe.userData.distances = all.map((hit) => Number(hit.distance.toFixed(3)));
      const direct = S.raycast(new S.Vector3(0.03, 0.02, 0), new S.Vector3(0, 0, -1), { recursive: false });
      probe.userData.direct = direct.map((hit) => hit.object.name);
    });
    S.mount(scene);
  `);
  host.tick();
  host.tick();
  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  assert.deepEqual(plain(probe.userData.all), ["child", "top"], "one hit per object, no invisible mesh");
  assert.deepEqual(plain(probe.userData.distances), [0.95, 1.95]);
  assert.deepEqual(plain(probe.userData.direct), ["top"], "recursive false keeps direct children only");
});

test("C-13 interactive reports manipulation and collision listeners", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const a = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    a.name = "a";
    a.addEventListener("manipulationstart", () => {});
    scene.add(a);
    const b = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    b.name = "b";
    b.addEventListener("collisionstart", () => {});
    scene.add(b);
    S.mount(scene);
  `);
  const commands = host.tick();
  const interactive = plain(commandsFor(commands, "interactive"));
  assert.equal(interactive.length, 2);
  assert.deepEqual(interactive[0][2], { tap: false, hover: false, drag: false, manipulation: true, collision: false });
  assert.deepEqual(interactive[1][2], { tap: false, hover: false, drag: false, manipulation: false, collision: true });
  const dump = host.dump();
  assert.equal(dump.objects[0].interactive.manipulation, true);
  assert.equal(dump.objects[1].interactive.collision, true);
});

test("C-14 dispose marks objects destroyed and releases their ids", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    S.mount(scene);
    this.box = box;
    this.scene = scene;
  `);
  host.tick();
  const boxId = host.idFor("box");
  const box = host.spatial.runtime.script.box;
  const scene = host.spatial.runtime.script.scene;
  host.spatial.dispose();

  assert.equal(host.spatial.objectForId(boxId), null, "the id no longer resolves");
  assert.throws(
    () => scene.add(box),
    (error) => error.name === "SpatialUnsupportedError" && error.feature === "destroyed-object",
  );
});

test("C-27 default capabilities are honest per platform", () => {
  const expectations = {
    "realitykit/macos": { hands: false, anchors: false, manipulation: false, hoverEffect: false, portals: true, particles: true, shadows: true },
    "realitykit/visionos": { hands: true, anchors: true, manipulation: true, hoverEffect: true, portals: true, particles: true, shadows: true },
    "three/web": { hands: false, anchors: false, manipulation: true, hoverEffect: false, portals: true, particles: true, shadows: true },
  };
  for (const [key, expected] of Object.entries(expectations)) {
    const [backend, platform] = key.split("/");
    const host = createHost({ backend, platform });
    host.load('const S = require("spatial"); const s = new S.Scene(); s.add(new S.Group()); S.mount(s);', {
      backend,
      platform,
    });
    const capabilities = plain(host.spatial.Spatial.env.capabilities);
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(capabilities[name], value, `${key}.${name}`);
    }
  }
});

test("C-33 dump reports the object opacity of a ParticleEmitter, not the particle start opacity", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const fx = new S.ParticleEmitter({ opacity: 0.7 });
    fx.name = "fx";
    scene.add(fx);
    S.mount(scene);
  `);
  const commands = host.tick();
  assert.deepEqual(plain(commandsFor(commands, "opacity")), []);
  const fx = host.dump().objects.find((entry) => entry.name === "fx");
  assert.equal(fx.opacity, 1, "the OpacityComponent value, matching both native dumps");
  assert.equal(fx.particles.opacity, 0.7);
});

test("C-37 mount replacement releases the old scene's ids", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const a = new S.Scene();
    const old = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    old.name = "old";
    a.add(old);
    const b = new S.Scene();
    b.add(new S.Group());
    S.mount(a);
    this.old = old;
    this.b = b;
    S.onFrame(() => { if (S.time.frame === 2) S.mount(b); });
  `);
  host.tick();
  const oldId = host.idFor("old");
  host.tick();
  assert.equal(host.spatial.objectForId(oldId), null);
  const old = host.spatial.runtime.script.old;
  assert.throws(
    () => host.spatial.runtime.script.b.add(old),
    (error) => error.feature === "destroyed-object",
  );
});

test("C-38 clone does not carry the rigid body", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const original = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    original.name = "original";
    original.opacity = 0.5;
    original.billboard = true;
    original.rigidBody = new S.RigidBody({ mass: 4 });
    scene.add(original);
    const copy = original.clone();
    copy.name = "copy";
    copy.position.x = 0.3;
    scene.add(copy);
    S.mount(scene);
  `);
  host.tick();
  const dump = host.dump();
  const copy = dump.objects.find((entry) => entry.name === "copy");
  assert.equal(copy.rigidBody, null, "a clone gets no body: one RigidBody belongs to one object");
  assert.equal(copy.opacity, 0.5, "the display flags do carry across");
  assert.equal(copy.billboard, true);
  assert.equal(dump.objects.find((entry) => entry.name === "original").rigidBody.mass, 4);
});

test("C-39 velocity and sleep state are read-only", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const ball = new S.Mesh(new S.SphereGeometry(0.05, 12, 8), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.rigidBody = new S.RigidBody({});
    scene.add(ball);
    const results = {};
    ball.userData.results = results;
    for (const key of ["linearVelocity", "angularVelocity", "isSleeping"]) {
      try {
        ball.rigidBody[key] = key === "isSleeping" ? true : new S.Vector3(9, 9, 9);
        results[key] = "written";
      } catch (error) {
        results[key] = error.name;
      }
    }
    S.mount(scene);
  `);
  host.tick();
  host.spatial.syncBodies(new Float32Array([host.idFor("ball"), 0, -2, 0, 0, 0, 0, 0]));
  host.tick();
  const ball = host.dump().objects.find((entry) => entry.name === "ball");
  // Strict mode makes the assignment throw; either way the sync value wins.
  assert.deepEqual(plain(ball.velocity), [0, -2, 0]);
  assert.equal(ball.isSleeping, false);
});

test("C-41 the four untested public behaviours work", async () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    probe.userData.tag = "marker";
    scene.add(probe);
    S.mount(scene);

    // getObjectByProperty
    probe.userData.found = scene.getObjectByProperty("name", "probe") === probe;

    // TextureLoader.loadAsync
    const loader = new S.TextureLoader();
    loader.loadAsync("asset://async.png").then((texture) => {
      probe.userData.asyncLoaded = texture.url;
    });

    // AssetGroup.stopAnimation
    S.loadAsset({ glb: "asset://robot.glb" }).then((asset) => {
      asset.name = "robot";
      scene.add(asset);
      asset.playAnimation("walk");
      asset.stopAnimation();
      probe.userData.animationStopped = true;
    });
  `, { backend: "three", platform: "web" });

  const first = host.tick();
  const textureId = first.find((command) => command[0] === "texture" && command[2].url === "asset://async.png")[1];
  const assetId = first.find((command) => command[0] === "asset")[1];
  host.spatial.dispatch("textureLoaded", textureId, {});
  host.spatial.dispatch("assetLoaded", assetId, { animations: ["walk"], boundingBox: [0, 0, 0, 0, 0, 0] });
  host.tick();
  await Promise.resolve();
  await Promise.resolve();
  const commands = host.tick();

  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  assert.equal(probe.userData.found, true, "getObjectByProperty");
  assert.equal(probe.userData.asyncLoaded, "asset://async.png", "TextureLoader.loadAsync");
  assert.equal(probe.userData.animationStopped, true, "AssetGroup.stopAnimation");
  const animations = plain(commandsFor(commands, "assetAnimation"));
  assert.deepEqual(animations, [
    ["assetAnimation", assetId, "walk", true, 1],
    ["assetAnimation", assetId, null, false, 1],
  ]);
});

// ==================== round 5: protocol items =========================

test("SPEC 6 raycast forwards the resolved recursive flag to the native hook", () => {
  const calls = [];
  const host = createHost({
    native: {
      log() {},
      now: () => Date.now(),
      raycast(...args) {
        calls.push(args);
        return [];
      },
    },
  });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    S.onFrame(() => {
      if (S.time.frame !== 2) return;
      S.raycast(new S.Vector3(0, 0, 0), new S.Vector3(0, 0, -1));
      S.raycast(new S.Vector3(0, 0, 0), new S.Vector3(0, 0, -1), { recursive: false });
      S.raycast(new S.Vector3(0, 0, 0), new S.Vector3(0, 0, -1), { maxDistance: 2, recursive: true });
    });
    S.mount(scene);
  `);
  host.tick();
  host.tick();

  assert.equal(calls.length, 3);
  assert.equal(calls[0].length, 8, "the hook takes eight arguments");
  assert.equal(calls[0][7], true, "recursive defaults to true");
  assert.equal(calls[1][7], false);
  assert.equal(calls[2][6], 2);
  assert.equal(calls[2][7], true);
});

test("SPEC 5 a disposed texture is released once nothing references it", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const loader = new S.TextureLoader();
    const grid = loader.load("asset://grid.png");
    const panel = new S.Mesh(new S.PlaneGeometry(0.3, 0.3), new S.MeshStandardMaterial({ map: grid }));
    panel.name = "panel";
    scene.add(panel);
    this.grid = grid;
    this.panel = panel;
    S.onFrame(() => {
      if (S.time.frame === 2) grid.dispose();
      if (S.time.frame === 4) panel.material = new S.MeshStandardMaterial({ color: 0xffffff });
      if (S.time.frame === 6) panel.material.map = new S.TextureLoader().load("asset://next.png");
    });
    S.mount(scene);
  `);
  const first = host.tick();
  const textureId = commandsFor(first, "texture")[0][1];
  assert.equal(commandsFor(first, "texture")[0][2].url, "asset://grid.png");

  // Disposed, but a live material still names it: no release yet.
  assert.deepEqual(plain(commandsFor(host.tick(), "texture")), []);
  assert.deepEqual(plain(commandsFor(host.tick(), "texture")), []);
  assert.equal(host.spatial.runtime.idTextures.get(textureId) !== undefined, true, "the id stays reserved");

  // The last reference is dropped: the release goes out exactly once, after
  // the material command that stopped referencing it.
  const released = host.tick();
  const releaseIndex = released.findIndex((command) => command[0] === "texture" && command[2] === null);
  assert.ok(releaseIndex >= 0, "the release form is emitted");
  assert.deepEqual(plain(released[releaseIndex]), ["texture", textureId, null]);
  assert.ok(
    releaseIndex > released.findIndex((command) => command[0] === "material"),
    "the release follows the material that dropped it",
  );
  assert.deepEqual(plain(commandsFor(host.tick(), "texture")), [], "never emitted twice");

  // Only now may the id be handed to another texture.
  const reused = commandsFor(host.tick(), "texture");
  assert.equal(reused.length, 1);
  assert.equal(reused[0][1], textureId);
  assert.equal(reused[0][2].url, "asset://next.png");
});

test("an imperative command issued before the object's first flush waits for it, in order", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const ball = new S.Mesh(new S.SphereGeometry(0.1), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.rigidBody = new S.RigidBody({ type: "dynamic" });
    scene.add(ball);
    // Both are issued before any flush has minted the object's id.
    ball.rigidBody.applyImpulse(new S.Vector3(0, 1, 0));
    ball.rigidBody.applyForce(new S.Vector3(1, 0, 0));
    S.mount(scene);
  `);

  const first = host.tick();
  assert.equal(commandsFor(first, "bodyImpulse").length, 0, "nothing names an id the consumer has not seen");
  assert.equal(commandsFor(first, "create").length, 1, "the create goes out first");

  const second = host.tick();
  const impulse = commandsFor(second, "bodyImpulse");
  const force = commandsFor(second, "bodyForce");
  assert.equal(impulse.length, 1, "the impulse arrives the frame after the create");
  assert.equal(force.length, 1);
  assert.equal(impulse[0][1], first.find((command) => command[0] === "create")[1], "same id as the create");
  const opcodes = plain(second.map((command) => command[0]));
  assert.ok(
    opcodes.indexOf("bodyImpulse") < opcodes.indexOf("bodyForce"),
    `the two kept their order, got ${opcodes}`,
  );
  assert.deepEqual(
    plain(host.dump().warnings.filter((warning) => /was dropped/.test(warning))),
    [],
    "nothing was dropped",
  );
});

test("a deferred command whose object leaves the graph before its first flush is dropped", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const ball = new S.Mesh(new S.SphereGeometry(0.1), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.rigidBody = new S.RigidBody({ type: "dynamic" });
    scene.add(ball);
    ball.rigidBody.applyImpulse(new S.Vector3(0, 1, 0));
    // Removed again before the frame that would have flushed it.
    scene.remove(ball);
    S.mount(scene);
  `);
  const first = host.tick();
  assert.equal(commandsFor(first, "bodyImpulse").length, 0);
  const second = host.tick();
  assert.equal(commandsFor(second, "bodyImpulse").length, 0);
  assert.ok(host.dump().warnings.some((warning) => /not in the mounted scene/.test(warning)));
});

test("every deferrable opcode waits rather than dropping", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();

    const screen = new S.VideoScreen({ url: "clip.mp4", width: 1 });
    screen.name = "screen";
    const sound = new S.Audio();
    sound.name = "sound";
    sound.setBuffer(new S.AudioLoader().load("a.wav"));
    const fx = new S.ParticleEmitter({});
    fx.name = "fx";
    const walker = new S.Group();
    walker.name = "walker";
    walker.characterController = new S.CharacterController({});
    scene.add(screen, sound, fx, walker);

    // Every one of these is issued before the first flush.
    screen.play();
    sound.play();
    fx.burst();
    walker.characterController.move(new S.Vector3(0.1, 0, 0));
    walker.characterController.teleport(new S.Vector3(0, 0.5, 0));
    S.mount(scene);
  `);
  const first = host.tick();
  for (const opcode of ["videoControl", "audioControl", "particlesBurst", "characterMove", "characterTeleport"]) {
    assert.equal(commandsFor(first, opcode).length, 0, `${opcode} waits for the create`);
  }
  const second = host.tick();
  for (const opcode of ["videoControl", "audioControl", "particlesBurst", "characterMove", "characterTeleport"]) {
    assert.equal(commandsFor(second, opcode).length, 1, `${opcode} arrives the frame after the create`);
  }
  assert.equal(commandsFor(second, "videoControl")[0][2], "play");
  assert.equal(commandsFor(second, "audioControl")[0][2], "play");
  assert.deepEqual(
    plain(host.dump().warnings.filter((warning) => /was dropped/.test(warning))),
    [],
  );
});
