import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain, transformIds } from "./helpers.mjs";

// ------------------------------------------------------------- async bodies

test("a body with top-level await keeps running across ticks", async () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const before = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    before.name = "before";
    scene.add(before);
    S.mount(scene);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const after = new S.Mesh(new S.BoxGeometry(0.05, 0.05, 0.05), new S.MeshStandardMaterial());
    after.name = "after";
    scene.add(after);
    scene.userData.resumed = true;
  `);

  // load() returned after the synchronous prefix.
  assert.deepEqual(
    plain(host.dump().objects.map((entry) => entry.name)),
    ["before"],
  );

  // The awaited timer is driven by frame ticks.
  for (let i = 0; i < 4; i += 1) host.tick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  host.tick();

  const dump = host.dump();
  assert.deepEqual(plain(dump.objects.map((entry) => entry.name)).sort(), ["after", "before"]);
  assert.deepEqual(plain(dump.errors), []);
  assert.equal(host.spatial.Spatial.scene.userData.resumed, true);
});

test("a throw before the first await is reported as a load error with a location", async () => {
  const host = createHost();
  host.load(
    [
      'const S = require("spatial");',
      "const scene = new S.Scene();",
      "S.mount(scene);",
      'throw new Error("early failure");',
      "await null;",
    ].join("\n"),
  );
  await host.spatial.whenLoaded();
  host.tick();

  const errors = host.dump().errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0], /early failure/);
  assert.match(errors[0], /SpatialLoadError/);
  assert.match(errors[0], /line 4/);
});

test("a throw after an await is a runtime error and the scene keeps running", async () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    S.onFrame((dt) => { box.position.x += 0.01; });
    S.mount(scene);
    await Promise.resolve();
    throw new Error("late failure");
  `);
  await host.spatial.whenLoaded();

  for (let i = 0; i < 3; i += 1) host.tick();
  const dump = host.dump();
  assert.equal(dump.errors.length, 1);
  assert.match(dump.errors[0], /late failure/);
  // Not a load error: the scene was mounted and keeps updating.
  assert.doesNotMatch(dump.errors[0], /SpatialLoadError/);
  assert.ok(Math.abs(dump.objects[0].position[0] - 0.03) < 1e-6);
});

test("a body without top-level await still reports load errors synchronously", () => {
  const host = createHost();
  assert.throws(
    () => host.load('const S = require("spatial"); new S.Scene(); new S.Scene();'),
    (error) => error.name === "SpatialLoadError" && /constructed 2 Scenes/.test(error.message),
  );
});

// --------------------------------------------------- non-finite transforms

test("a non-finite transform is skipped, reported once, and recovers", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const good = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    good.name = "good";
    scene.add(good);
    const bad = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    bad.name = "bad";
    scene.add(bad);
    S.onFrame(() => {
      good.position.x += 0.01;
      const f = S.time.frame;
      if (f === 2) bad.position.x = NaN;
      if (f === 3) bad.position.set(Infinity, 0, 0);
      if (f === 4) { bad.position.set(0.2, 0, 0); bad.quaternion.set(0, 0, 0, 0); }
      if (f === 5) { bad.quaternion.set(0, 0, 0, 1); }
    });
    S.mount(scene);
  `);
  host.tick();
  const goodId = host.idFor("good");
  const badId = host.idFor("bad");

  for (let frame = 2; frame <= 4; frame += 1) {
    const commands = host.tick();
    assert.deepEqual(
      transformIds(commands),
      [goodId],
      `frame ${frame} must not emit a transform for the bad object`,
    );
    for (const command of commands) {
      for (const value of command.slice(2)) assertFinite(value, command[0]);
    }
  }

  // One error while it stays invalid.
  const errors = host.dump().errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Transform on "bad" is not finite/);

  // Valid again: the transform flows.
  const recovered = transformIds(host.tick()).sort((a, b) => a - b);
  assert.deepEqual(recovered, [goodId, badId].sort((a, b) => a - b));
});

test("non-finite scalars never reach material, light, body or gravity payloads", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();

    const mesh = new S.Mesh(new S.SphereGeometry(0.1, 12, 8), new S.MeshPhysicalMaterial());
    mesh.name = "mesh";
    mesh.material.opacity = NaN;
    mesh.material.roughness = Infinity;
    mesh.material.metalness = -3;
    mesh.material.clearcoat = NaN;
    mesh.material.emissiveIntensity = -1;
    mesh.rigidBody = new S.RigidBody({});
    mesh.rigidBody.mass = NaN;
    mesh.rigidBody.friction = -2;
    scene.add(mesh);

    const lamp = new S.SpotLight(0xffffff, NaN, -4, 99, 5, -1);
    lamp.name = "lamp";
    scene.add(lamp);

    const fx = new S.ParticleEmitter({ birthRate: NaN, lifetime: -1, size: -0.5, opacity: 9 });
    fx.name = "fx";
    scene.add(fx);

    S.physics.gravity.set(NaN, Infinity, 0);
    S.mount(scene);
  `);

  const commands = host.tick();
  for (const command of commands) {
    for (const value of command.slice(2)) {
      assertFinite(value, command[0]);
    }
  }

  const material = commands.find((command) => command[0] === "material")[2];
  assert.equal(material.opacity, 1);
  assert.equal(material.roughness, 1);
  assert.equal(material.metalness, 0);
  assert.equal(material.clearcoat, 0);
  assert.equal(material.emissiveIntensity, 0);

  const light = commands.find((command) => command[0] === "light")[2];
  assert.equal(light.intensity, 1);
  assert.equal(light.distance, 0);
  assert.equal(light.angle, Math.PI / 2);
  assert.equal(light.penumbra, 1);
  assert.equal(light.decay, 0);

  const body = commands.find((command) => command[0] === "rigidBody")[2];
  assert.equal(body.mass, 1);
  assert.equal(body.friction, 0);

  const particles = commands.find((command) => command[0] === "particles")[2];
  assert.equal(particles.birthRate, 100);
  assert.equal(particles.lifetime, 0);
  assert.equal(particles.size, 0);
  assert.equal(particles.opacity, 1);

  const gravity = commands.find((command) => command[0] === "gravity");
  assert.deepEqual(plain(gravity), ["gravity", 0, 0, -9.81, 0]);
});

function assertFinite(value, opcode) {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${opcode} carried ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) assertFinite(element, opcode);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assert.ok(Number.isFinite(value[i]), `${opcode} carried ${value[i]} at index ${i}`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) assertFinite(value[key], opcode);
  }
}

// -------------------------------------------------- parameter normalization

test("a mesh without geometry or material gets substituted defaults and a warning", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const bare = new S.Mesh();
    bare.name = "bare";
    scene.add(bare);
    const noMaterial = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), null);
    noMaterial.name = "noMaterial";
    scene.add(noMaterial);
    S.mount(scene);
  `);
  const commands = host.tick();
  const dump = host.dump();

  const bare = dump.objects.find((entry) => entry.name === "bare");
  assert.equal(bare.geometry.type, "BufferGeometry");
  assert.equal(bare.material.type, "MeshStandardMaterial");

  const noMaterial = dump.objects.find((entry) => entry.name === "noMaterial");
  assert.equal(noMaterial.material.type, "MeshStandardMaterial");

  assert.ok(dump.warnings.some((warning) => /"bare" was created without a geometry/.test(warning)));
  assert.ok(
    dump.warnings.some((warning) => /"bare" was created without a material/.test(warning)),
    "the substituted material warning names the object",
  );
  assert.ok(
    dump.warnings.some((warning) => /MeshBasicMaterial, which is unlit/.test(warning)),
    "the warning explains the difference from three.js",
  );
  assert.equal(commands.filter((command) => command[0] === "material").length, 2);
});

test("cloning a valid mesh does not warn about substituted defaults", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const original = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    original.name = "original";
    scene.add(original);
    const copy = original.clone();
    copy.name = "copy";
    scene.add(copy);
    S.mount(scene);
  `);
  host.tick();
  assert.deepEqual(plain(host.dump().warnings), []);
});

test("geometry arguments are normalized and reported", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(-1, 0, undefined), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    const ball = new S.Mesh(new S.SphereGeometry(-0.2, 0, -5), new S.MeshStandardMaterial());
    ball.name = "ball";
    scene.add(ball);
    S.mount(scene);
  `);
  host.tick();
  const dump = host.dump();

  const box = dump.objects.find((entry) => entry.name === "box").geometry.parameters;
  assert.equal(box.width, 1);
  assert.equal(box.height, 0.001);
  assert.equal(box.depth, 1);

  const ball = dump.objects.find((entry) => entry.name === "ball").geometry.parameters;
  assert.equal(ball.radius, 0.2);
  assert.equal(ball.widthSegments, 3);
  assert.equal(ball.heightSegments, 2);

  assert.ok(dump.warnings.some((warning) => /BoxGeometry arguments were normalized/.test(warning)));
  assert.ok(dump.warnings.some((warning) => /SphereGeometry arguments were normalized/.test(warning)));
});

test("light and material ranges are clamped with a warning", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const lamp = new S.PointLight(0xffffff, -5, -1, -1);
    lamp.name = "lamp";
    scene.add(lamp);
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial({ opacity: 4 }));
    mesh.name = "mesh";
    scene.add(mesh);
    S.mount(scene);
  `);
  const commands = host.tick();
  const light = commands.find((command) => command[0] === "light")[2];
  assert.equal(light.intensity, 0);
  assert.equal(light.distance, 0);
  assert.equal(light.decay, 0);
  const material = commands.find((command) => command[0] === "material")[2];
  assert.equal(material.opacity, 1);

  const warnings = host.dump().warnings;
  assert.ok(warnings.some((warning) => /PointLight properties were clamped/.test(warning)));
  assert.ok(warnings.some((warning) => /MeshStandardMaterial properties were clamped/.test(warning)));
});

test("an unparseable color keeps three.js behavior: a warning and no change", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial({ color: "not-a-color" }));
    mesh.name = "mesh";
    scene.add(mesh);
    S.mount(scene);
  `);
  const commands = host.tick();
  const material = commands.find((command) => command[0] === "material")[2];
  assert.deepEqual(plain(material.color), [1, 1, 1]);
  assert.ok(host.dump().warnings.some((warning) => /Unknown color/.test(warning)));
});

test("add, remove and attach validate their arguments", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    const results = probe.userData.results = {};
    const attempt = (name, fn) => {
      try { fn(); results[name] = "ok"; } catch (error) { results[name] = error.name + ": " + error.message; }
    };
    attempt("plainObject", () => scene.add({ name: "plain" }));
    attempt("string", () => scene.add("nope"));
    attempt("number", () => scene.remove(7));
    attempt("attachArray", () => scene.attach([1, 2]));
    attempt("null", () => scene.add(null));
    attempt("undefined", () => scene.add(undefined));
    S.mount(scene);
  `);
  host.tick();
  const results = host.dump().objects.find((entry) => entry.name === "probe").userData.results;
  assert.match(results.plainObject, /^TypeError: Object3D\.add expects an Object3D, received a plain Object$/);
  assert.match(results.string, /received the string "nope"/);
  assert.match(results.number, /Object3D\.remove expects an Object3D, received the number 7/);
  assert.match(results.attachArray, /Object3D\.attach expects an Object3D, received an array of length 2/);
  assert.equal(results.null, "ok");
  assert.equal(results.undefined, "ok");
  assert.ok(host.dump().warnings.some((warning) => /Object3D\.add was called with null/.test(warning)));
});

test("a re-parent that would make a cycle is refused and reported", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const a = new S.Group(); a.name = "a"; scene.add(a);
    const b = new S.Group(); b.name = "b"; a.add(b);
    const c = new S.Group(); c.name = "c"; b.add(c);
    c.add(a);
    a.add(scene);
    a.add(a);
    scene.userData.aParent = a.parent === scene ? "scene" : String(a.parent && a.parent.name);
    scene.userData.sceneParent = scene.parent === null ? "none" : "cycled";
    S.mount(scene);
  `);
  // Would recurse forever in three's updateMatrixWorld if the cycle were allowed.
  assert.doesNotThrow(() => host.tick());
  const dump = host.dump();
  assert.equal(host.spatial.Spatial.scene.userData.aParent, "scene");
  assert.equal(host.spatial.Spatial.scene.userData.sceneParent, "none");
  assert.equal(dump.objects.length, 3);
  assert.equal(dump.errors.filter((entry) => /cyclic/.test(entry)).length, 3);
});

// ------------------------------------------------------------- traversal

test("traversal survives removing and destroying from inside the callback", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    for (let i = 0; i < 8; i += 1) {
      const mesh = new S.Mesh(new S.BoxGeometry(0.02, 0.02, 0.02), new S.MeshStandardMaterial());
      mesh.name = "item-" + i;
      scene.add(mesh);
    }
    const seen = [];
    scene.userData.seen = seen;
    scene.traverse((object) => {
      if (object === scene) return;
      seen.push(object.name);
      if (object.name === "item-2" || object.name === "item-3") {
        object.removeFromParent();
        S.destroy(object);
      }
    });
    scene.userData.remaining = scene.children.map((child) => child.name);

    const visible = [];
    scene.userData.visible = visible;
    scene.traverseVisible((object) => { if (object !== scene) visible.push(object.name); });

    const ancestors = [];
    scene.userData.ancestors = ancestors;
    scene.children[0].traverseAncestors((object) => ancestors.push(object.type));
    S.mount(scene);
  `);
  assert.doesNotThrow(() => host.tick());
  const scene = host.spatial.Spatial.scene;

  // Every sibling was visited even though two were removed mid-walk.
  assert.deepEqual(plain(scene.userData.seen), [
    "item-0",
    "item-1",
    "item-2",
    "item-3",
    "item-4",
    "item-5",
    "item-6",
    "item-7",
  ]);
  assert.deepEqual(plain(scene.userData.remaining), [
    "item-0",
    "item-1",
    "item-4",
    "item-5",
    "item-6",
    "item-7",
  ]);
  assert.equal(scene.userData.visible.length, 6);
  assert.deepEqual(plain(scene.userData.ancestors), ["Scene"]);
  assert.deepEqual(plain(host.dump().errors), []);
});
