import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain, transformIds, transformRecords } from "./helpers.mjs";

// ------------------------------------------------------------------ events

test("input events bubble to ancestors with the original target", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const group = new S.Group();
    group.name = "group";
    scene.add(group);
    const child = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    child.name = "child";
    group.add(child);
    const seen = [];
    child.userData.seen = seen;
    child.addEventListener("tap", (event) => seen.push(["child", event.target.name, event.currentTarget.name]));
    group.addEventListener("tap", (event) => seen.push(["group", event.target.name, event.currentTarget.name]));
    scene.addEventListener("tap", (event) => seen.push(["scene", event.target.name, event.currentTarget.name]));
    S.mount(scene);
  `);
  host.tick();
  host.spatial.Spatial.inject.tap("child");
  host.tick();
  const child = host.dump().objects.find((entry) => entry.name === "child");
  assert.deepEqual(plain(child.userData.seen), [
    ["child", "child", "child"],
    ["group", "child", "group"],
    ["scene", "child", ""],
  ]);
});

test("stopPropagation halts bubbling after the current object", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const group = new S.Group();
    group.name = "group";
    scene.add(group);
    const child = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    child.name = "child";
    group.add(child);
    const seen = [];
    child.userData.seen = seen;
    child.addEventListener("tap", (event) => { seen.push("child-a"); event.stopPropagation(); });
    child.addEventListener("tap", () => seen.push("child-b"));
    group.addEventListener("tap", () => seen.push("group"));
    scene.addEventListener("tap", () => seen.push("scene"));
    S.mount(scene);
  `);
  host.tick();
  host.spatial.Spatial.inject.tap("child");
  host.tick();
  const child = host.dump().objects.find((entry) => entry.name === "child");
  // stopPropagation stops the walk, but the remaining listeners on the object
  // that called it still run, matching DOM semantics.
  assert.deepEqual(plain(child.userData.seen), ["child-a", "child-b"]);
});

test("interactive is emitted when the first listener is added and the last removed", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    function onTap() {}
    function onHover() {}
    S.onFrame(() => {
      if (S.time.frame === 2) box.addEventListener("tap", onTap);
      if (S.time.frame === 3) box.addEventListener("hoverenter", onHover);
      if (S.time.frame === 4) box.removeEventListener("tap", onTap);
      if (S.time.frame === 5) box.removeEventListener("hoverenter", onHover);
    });
    S.mount(scene);
  `);
  assert.deepEqual(plain(commandsFor(host.tick(), "interactive")), []);
  const boxId = host.idFor("box");
  assert.deepEqual(plain(commandsFor(host.tick(), "interactive")), [
    ["interactive", boxId, { tap: true, hover: false, drag: false, manipulation: false, collision: false }],
  ]);
  assert.deepEqual(plain(commandsFor(host.tick(), "interactive")), [
    ["interactive", boxId, { tap: true, hover: true, drag: false, manipulation: false, collision: false }],
  ]);
  assert.deepEqual(plain(commandsFor(host.tick(), "interactive")), [
    ["interactive", boxId, { tap: false, hover: true, drag: false, manipulation: false, collision: false }],
  ]);
  assert.deepEqual(plain(commandsFor(host.tick(), "interactive")), [
    ["interactive", boxId, { tap: false, hover: false, drag: false, manipulation: false, collision: false }],
  ]);
});

test("a collision dispatch reaches both objects in the pair", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const seen = [];
    for (const name of ["a", "b"]) {
      const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
      mesh.name = name;
      mesh.rigidBody = new S.RigidBody({});
      mesh.userData.seen = seen;
      mesh.addEventListener("collisionstart", (event) => {
        seen.push(name + ":" + event.target.name + ":" + (event.other ? event.other.name : "none"));
      });
      scene.add(mesh);
    }
    S.mount(scene);
  `);
  host.tick();
  const aId = host.idFor("a");
  const bId = host.idFor("b");
  host.spatial.dispatch("collisionstart", aId, {
    other: bId,
    point: [0, 0, 0],
    normal: [0, 1, 0],
    impulse: 1,
  });
  host.tick();
  const a = host.dump().objects.find((entry) => entry.name === "a");
  assert.deepEqual(plain(a.userData.seen), ["a:a:b", "b:b:a"]);
});

// ------------------------------------------------------------------ timers

test("timers fire on frame ticks and can be cancelled", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    probe.userData.order = [];
    scene.add(probe);
    setTimeout(() => probe.userData.order.push("timeout-50"), 50);
    setTimeout(() => probe.userData.order.push("timeout-0"), 0);
    const doomed = setInterval(() => probe.userData.order.push("never"), 10);
    clearInterval(doomed);
    let count = 0;
    const repeating = setInterval(() => {
      count += 1;
      probe.userData.order.push("interval-" + count);
      if (count === 2) clearInterval(repeating);
    }, 30);
    requestAnimationFrame(() => probe.userData.order.push("raf"));
    S.mount(scene);
  `);
  for (let i = 0; i < 10; i += 1) host.tick();
  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  assert.deepEqual(plain(probe.userData.order), [
    "timeout-0",
    "raf",
    "interval-1",
    "timeout-50",
    "interval-2",
  ]);
});

// ------------------------------------------------------------------- mount

test("a single unmounted Scene is auto-mounted with a warning", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
  `);
  host.tick();
  const dump = host.dump();
  assert.equal(dump.objects.length, 1);
  assert.ok(dump.warnings.some((warning) => warning.includes("auto-mounting")));
});

test("zero or several unmounted Scenes are a load error", () => {
  const none = createHost();
  assert.throws(
    () => none.load('const S = require("spatial"); const g = new S.Group();'),
    (error) => error.name === "SpatialLoadError" && /constructed no Scene/.test(error.message),
  );

  const many = createHost();
  assert.throws(
    () => many.load('const S = require("spatial"); new S.Scene(); new S.Scene();'),
    (error) => error.name === "SpatialLoadError" && /constructed 2 Scenes/.test(error.message),
  );
});

test("mount rejects anything that is not a Scene", () => {
  const host = createHost();
  assert.throws(
    () => host.load('const S = require("spatial"); const scene = new S.Scene(); S.mount(new S.Group());'),
    (error) => error.name === "SpatialLoadError" && /expects a Scene/.test(error.message),
  );
});

// ------------------------------------------------------------------- shear

test("a sheared matrix is reported without throwing and skips only its own transform", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();

    const skewed = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    skewed.name = "skewed";
    scene.add(skewed);

    const healthy = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    healthy.name = "healthy";
    scene.add(healthy);

    // matrixAutoUpdate off keeps the sheared matrix in place every frame.
    skewed.matrixAutoUpdate = false;
    skewed.matrix.set(
      1, 0.5, 0, 0.3,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );

    S.onFrame(() => { healthy.position.x += 0.01; });
    S.mount(scene);
  `);

  // tick returns normally: an exception here would tear down the Swift scene.
  let first;
  assert.doesNotThrow(() => {
    first = host.tick();
  });
  const skewedId = host.idFor("skewed");
  const healthyId = host.idFor("healthy");

  // Everything else about the sheared object still flushes.
  assert.ok(first.some((command) => command[0] === "create" && command[1] === skewedId));
  assert.ok(first.some((command) => command[0] === "geometry" && command[1] === skewedId));
  assert.deepEqual(
    transformIds(first),
    [healthyId],
    "the sheared object emits no transform; its sibling still does",
  );

  const dump = host.dump();
  const shearErrors = dump.errors.filter((entry) => /"skewed"/.test(entry));
  assert.equal(shearErrors.length, 1);
  assert.match(shearErrors[0], /^SpatialUnsupportedError: Matrix on "skewed" contains shear/);
  assert.ok(
    host.logs.some((entry) => entry.startsWith("error: SpatialUnsupportedError: Matrix on \"skewed\"")),
    "the rejection reaches __spatialNative.log at level error",
  );

  // Reported once per object while the matrix stays invalid, and the rest of
  // the scene keeps flushing every frame.
  for (let i = 0; i < 4; i += 1) {
    const commands = host.tick();
    assert.deepEqual(transformIds(commands), [healthyId]);
  }
  assert.equal(host.dump().errors.filter((entry) => /"skewed"/.test(entry)).length, 1);
});

test("a sheared object flushes again once its matrix becomes valid", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "skewed";
    box.matrixAutoUpdate = false;
    box.matrix.set(
      1, 0.5, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    scene.add(box);
    S.onFrame(() => {
      if (S.time.frame === 2) box.matrix.makeTranslation(0.2, 0, 0);
      if (S.time.frame === 3) {
        box.matrix.set(
          1, 0, 0.4, 0.2,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0, 0, 0, 1,
        );
      }
    });
    S.mount(scene);
  `);
  const first = host.tick();
  assert.deepEqual(transformIds(first), []);
  assert.equal(host.dump().errors.length, 1);

  const boxId = host.idFor("skewed");
  const records = transformRecords(host.tick());
  assert.equal(records.length, 1);
  assert.equal(records[0].id, boxId);
  assert.ok(Math.abs(records[0].position[0] - 0.2) < 1e-6);

  // A fresh shear after a valid frame is reported again.
  assert.deepEqual(transformIds(host.tick()), []);
  assert.equal(host.dump().errors.length, 2);
});

// ----------------------------------------------------------------- destroy

test("Spatial.destroy tears a subtree down descendants first and frees the ids", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const branch = new S.Group();
    branch.name = "branch";
    scene.add(branch);
    const leafA = new S.Mesh(new S.BoxGeometry(0.08, 0.08, 0.08), new S.MeshStandardMaterial());
    leafA.name = "leafA";
    branch.add(leafA);
    const leafB = new S.Mesh(new S.BoxGeometry(0.06, 0.06, 0.06), new S.MeshStandardMaterial());
    leafB.name = "leafB";
    leafA.add(leafB);
    this.branch = branch;
    S.onFrame(() => {
      if (S.time.frame === 2) S.destroy(branch);
    });
    S.mount(scene);
  `);
  host.tick();
  const branchId = host.idFor("branch");
  const leafAId = host.idFor("leafA");
  const leafBId = host.idFor("leafB");

  const commands = host.tick();
  assert.deepEqual(plain(commandsFor(commands, "destroy")), [
    ["destroy", leafBId],
    ["destroy", leafAId],
    ["destroy", branchId],
  ]);
  // No stray parent/transform commands for objects that no longer exist.
  assert.deepEqual(plain(commandsFor(commands, "parent")), []);

  for (const id of [branchId, leafAId, leafBId]) {
    assert.equal(host.spatial.objectForId(id), null, `id ${id} should be released`);
  }
  assert.equal(host.dump().objects.length, 0);
  assert.deepEqual(plain(host.dump().errors), []);
});

test("adding a destroyed object back throws SpatialUnsupportedError", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    const doomed = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    doomed.name = "doomed";
    scene.add(doomed);
    S.onFrame(() => {
      if (S.time.frame !== 2) return;
      S.destroy(doomed);
      try {
        scene.add(doomed);
      } catch (error) {
        probe.userData.addError = error.name + ":" + error.feature;
      }
      try {
        probe.attach(doomed);
      } catch (error) {
        probe.userData.attachError = error.name + ":" + error.feature;
      }
      try {
        S.destroy(scene);
      } catch (error) {
        probe.userData.sceneError = error.name + ":" + error.feature;
      }
      try {
        S.destroy("nope");
      } catch (error) {
        probe.userData.typeError = error.name;
      }
    });
    S.mount(scene);
  `);
  host.tick();
  host.tick();
  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  assert.equal(probe.userData.addError, "SpatialUnsupportedError:destroyed-object");
  assert.equal(probe.userData.attachError, "SpatialUnsupportedError:destroyed-object");
  assert.equal(probe.userData.sceneError, "SpatialUnsupportedError:destroy-scene");
  assert.equal(probe.userData.typeError, "TypeError");
});

test("destroying an object that was never flushed emits no destroy command", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const keep = new S.Group();
    keep.name = "keep";
    scene.add(keep);
    const transient = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    transient.name = "transient";
    scene.add(transient);
    S.destroy(transient);
    S.mount(scene);
  `);
  const commands = host.tick();
  assert.deepEqual(plain(commandsFor(commands, "destroy")), []);
  assert.equal(host.dump().objects.length, 1);
});

test("rotation and non-uniform scale are not mistaken for shear", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "ok";
    scene.add(box);
    const matrix = new S.Matrix4()
      .makeRotationY(0.7)
      .multiply(new S.Matrix4().makeScale(1, 2, 3));
    box.applyMatrix4(matrix);
    S.mount(scene);
  `);
  assert.doesNotThrow(() => host.spatial.tick(1 / 60));
  const box = host.dump().objects.find((entry) => entry.name === "ok");
  assert.deepEqual(plain(box.scale).map((v) => Number(v.toFixed(4))), [1, 2, 3]);
});

// ------------------------------------------------------------------ errors

test("a load error carries a line and column", () => {
  const host = createHost();
  const source = ["// line 1", "const S = require(\"spatial\");", "const scene = new S.Scene();", "throw new Error(\"line four\");", "S.mount(scene);"].join("\n");
  try {
    host.load(source);
    assert.fail("expected the load to throw");
  } catch (error) {
    assert.equal(error.name, "SpatialLoadError");
    assert.match(error.message, /line four/);
    assert.equal(error.line, 4, `expected line 4, got ${error.line}`);
    assert.equal(typeof error.column, "number");
  }
});

test("a syntax error reports a load error without inventing a location", () => {
  const host = createHost();
  try {
    host.load("const S = require('spatial'); this is not javascript;");
    assert.fail("expected the load to throw");
  } catch (error) {
    assert.equal(error.name, "SpatialLoadError");
    assert.match(error.message, /SyntaxError/);
    assert.ok(error.line === null || typeof error.line === "number");
  }
});

test("errors inside onFrame are reported once per second and do not stop the scene", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    S.onFrame(() => { box.position.x += 0.01; });
    S.onFrame(() => { throw new Error("recurring failure"); });
    S.mount(scene);
  `);
  for (let i = 0; i < 5; i += 1) host.tick();
  const dump = host.dump();
  assert.equal(dump.errors.filter((entry) => entry.includes("recurring failure")).length, 1);
  assert.ok(Math.abs(dump.objects[0].position[0] - 0.05) < 1e-6);
});

// ----------------------------------------------------------------- raycast

test("raycast prefers the native hook when the consumer installs one", () => {
  let called = null;
  const host = createHost({
    native: {
      log() {},
      now: () => Date.now(),
      raycast(ox, oy, oz, dx, dy, dz, maxDistance) {
        called = [ox, oy, oz, dx, dy, dz, maxDistance];
        // The wall is the first object the flush walk reaches, so it holds id 1.
        return [1, 0, 0, -0.5, 0, 0, 1, 0.5];
      },
    },
  });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const wall = new S.Mesh(new S.BoxGeometry(0.5, 0.5, 0.02), new S.MeshStandardMaterial());
    wall.name = "wall";
    wall.position.set(0, 0, -0.5);
    scene.add(wall);
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    S.onFrame(() => {
      if (S.time.frame !== 2) return;
      const hits = S.raycast(new S.Vector3(0, 0, 0), new S.Vector3(0, 0, -1));
      probe.userData.count = hits.length;
      probe.userData.name = hits.length > 0 ? hits[0].object.name : null;
      probe.userData.normal = hits.length > 0 ? hits[0].normal.toArray() : null;
    });
    S.mount(scene);
  `);
  host.tick();
  host.tick();
  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  assert.equal(probe.userData.count, 1);
  assert.equal(probe.userData.name, "wall");
  assert.deepEqual(plain(probe.userData.normal), [0, 0, 1]);
  // Infinity is passed as -1 so the value survives the JavaScriptCore bridge.
  assert.equal(called[6], -1);
});

// ------------------------------------------------------- error message shape

const CORE_FRAME = /spatial-core\.js|#toLoadError|@\w+@|\bat Runtime\b|Object\.load/;

test("a load error carries the engine message only, with the stack kept separately", () => {
  const host = createHost();
  try {
    host.load(
      ["// one", 'const S = require("spatial");', "const scene = new S.Scene();", "const broken = ;"].join("\n"),
    );
    assert.fail("expected the load to throw");
  } catch (error) {
    assert.equal(error.name, "SpatialLoadError");
    assert.equal(error.message, "SyntaxError: Unexpected token ';'");
    assert.equal(error.message.includes("\n"), false, "no newline in the message");
    assert.doesNotMatch(error.message, CORE_FRAME, "no core frames in the message");
    // The stack is preserved separately and never points into the bundle.
    assert.equal(typeof error.stack, "string");
    assert.doesNotMatch(error.stack.split("\n")[0], /spatial-core\.js/);
  }
});

test("a runtime load error carries the engine message plus the script location", () => {
  const host = createHost();
  try {
    host.load(
      [
        'const S = require("spatial");',
        "const scene = new S.Scene();",
        "S.mount(scene);",
        "scene.notAFunction();",
      ].join("\n"),
    );
    assert.fail("expected the load to throw");
  } catch (error) {
    assert.equal(error.name, "SpatialLoadError");
    assert.match(error.message, /^TypeError: /);
    assert.doesNotMatch(error.message, CORE_FRAME);
    assert.equal(error.line, 4);
  }
});

test("errors on the error channel are one clean line with a script location", () => {
  const host = createHost();
  host.load(
    [
      'const S = require("spatial");',
      "const scene = new S.Scene();",
      "const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());",
      'box.name = "box";',
      "scene.add(box);",
      "S.onFrame(() => {",
      "  box.notAFunction();",
      "});",
      "S.mount(scene);",
    ].join("\n"),
  );
  const commands = host.tick();
  const dump = host.dump();

  assert.equal(dump.errors.length, 1);
  const message = dump.errors[0];
  assert.match(message, /^TypeError: /);
  assert.equal(message.includes("\n"), false, "no newline in a dump().errors entry");
  assert.doesNotMatch(message, CORE_FRAME, `core frames leaked into ${message}`);
  assert.match(message, /\(line 7(, column \d+)?\)$/, `expected a script location in ${message}`);

  // The same text goes out on the log channel and to __spatialNative.log.
  const logged = commands.find((command) => command[0] === "log" && command[2] === "error");
  assert.equal(logged[3], message);
  assert.ok(host.logs.some((entry) => entry === `error: ${message}`));
});

test("core-raised errors name the object and carry no location or frames", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    box.matrixAutoUpdate = false;
    box.matrix.set(
      1, 0.5, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    scene.add(box);
    S.mount(scene);
  `);
  host.tick();
  const message = host.dump().errors[0];
  assert.equal(message, 'SpatialUnsupportedError: Matrix on "box" contains shear, which cannot be represented as a transform');
  assert.doesNotMatch(message, CORE_FRAME);
  assert.doesNotMatch(message, /line \d+/);
});

test("a message that already contains frames is trimmed to its first line", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.add(new S.Group());
    S.onFrame(() => {
      throw new Error("boom\\n    at somewhere@spatial-core.js:1:1");
    });
    S.mount(scene);
  `);
  host.tick();
  const message = host.dump().errors[0];
  assert.equal(message.includes("\n"), false);
  assert.match(message, /^Error: boom/);
  assert.doesNotMatch(message, /spatial-core\.js/);
});

// ------------------------------------------------------- body command stream

test("body impulses, forces, torques and velocities reach the command stream", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const crate = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    crate.name = "crate";
    crate.rigidBody = new S.RigidBody({});
    scene.add(crate);
    S.onFrame(() => {
      if (S.time.frame !== 2) return;
      crate.rigidBody.applyImpulse(new S.Vector3(0, 1.5, 0));
      crate.rigidBody.applyImpulse(new S.Vector3(1, 0, 0), new S.Vector3(0.05, 0, 0));
      crate.rigidBody.applyForce(new S.Vector3(0, 0, 2));
      crate.rigidBody.applyTorque(new S.Vector3(0, 0.5, 0));
      crate.rigidBody.setLinearVelocity(new S.Vector3(0.2, 0, 0));
      crate.rigidBody.setAngularVelocity(new S.Vector3(0, 1, 0));
    });
    S.mount(scene);
  `);
  host.tick();
  const crateId = host.idFor("crate");
  const commands = host.tick();

  assert.deepEqual(plain(commandsFor(commands, "bodyImpulse")), [
    ["bodyImpulse", crateId, 0, 1.5, 0, null, null, null],
    ["bodyImpulse", crateId, 1, 0, 0, 0.05, 0, 0],
  ]);
  assert.deepEqual(plain(commandsFor(commands, "bodyForce")), [["bodyForce", crateId, 0, 0, 2]]);
  assert.deepEqual(plain(commandsFor(commands, "bodyTorque")), [["bodyTorque", crateId, 0, 0.5, 0]]);
  assert.deepEqual(plain(commandsFor(commands, "bodyVelocity")), [
    ["bodyVelocity", crateId, 0.2, 0, 0, null, null, null],
    ["bodyVelocity", crateId, null, null, null, 0, 1, 0],
  ]);
});

// -------------------------------------------------------------- dump scene

test("dump reports the mounted scene's name and userData", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.name = "demo";
    scene.userData.author = "verification";
    scene.add(new S.Group());
    S.mount(scene);
  `);
  host.tick();
  const dump = host.dump();
  assert.equal(dump.scene.name, "demo");
  assert.deepEqual(plain(dump.scene.userData), { author: "verification" });
  // Objects are unchanged: the scene itself is not one of them.
  assert.equal(dump.objects.length, 1);
});

test("geometry and material commands carry a stable resource uuid", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BoxGeometry(0.1, 0.1, 0.1);
    const material = new S.MeshStandardMaterial({ color: 0x3366ff });
    for (let i = 0; i < 3; i += 1) {
      const mesh = new S.Mesh(geometry, material);
      mesh.name = "mesh" + i;
      mesh.position.x = i * 0.15;
      scene.add(mesh);
    }
    S.onFrame(() => { if (S.time.frame === 2) material.roughness = 0.25; });
    S.mount(scene);
  `);
  const first = host.tick();
  const geometryUuids = new Set(commandsFor(first, "geometry").map((command) => command[2].uuid));
  const materialUuids = new Set(commandsFor(first, "material").map((command) => command[2].uuid));
  assert.equal(geometryUuids.size, 1, "one geometry instance means one uuid");
  assert.equal(materialUuids.size, 1, "one material instance means one uuid");
  assert.equal(typeof [...geometryUuids][0], "string");

  // A shared material changing re-emits for every user, with the same uuid.
  const second = commandsFor(host.tick(), "material");
  assert.equal(second.length, 3);
  assert.equal(new Set(second.map((command) => command[2].uuid)).size, 1);
  assert.equal([...materialUuids][0], second[0][2].uuid);
});
