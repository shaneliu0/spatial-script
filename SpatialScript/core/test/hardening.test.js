// One test per performance-and-robustness review finding, plus the public
// surface the review found untested. Each fails against the reviewed build.

import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain } from "./helpers.mjs";

// ------------------------------------------------------------------ ROBUST-02

test("ROBUST-02 a requestAnimationFrame storm cannot wedge the frame loop", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    function spawn() { for (let i = 0; i < 200; i += 1) requestAnimationFrame(spawn); }
    spawn();
    S.onFrame(() => { probe.userData.frame = S.time.frame; });
    S.mount(scene);
  `);
  // Five frames of an exponentially self-spawning callback still return.
  for (let i = 0; i < 5; i += 1) {
    const started = Date.now();
    host.tick();
    assert.ok(Date.now() - started < 4000, "a frame must not run away");
  }
  const dump = host.dump();
  assert.equal(
    dump.objects.find((entry) => entry.name === "probe").userData.frame,
    5,
    "the loop kept running",
  );
  assert.ok(
    dump.warnings.some((warning) => /live animation-frame callbacks|callbacks came due in one/.test(warning)),
    `expected a cap warning, got ${JSON.stringify(dump.warnings)}`,
  );
  assert.ok(host.spatial.runtime.timers.frameCallbacks.size <= 10000);
});

test("ROBUST-02 timer registrations and per-object listeners are capped", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    for (let i = 0; i < 10100; i += 1) setTimeout(() => {}, 100000);
    let calls = 0;
    for (let i = 0; i < 1100; i += 1) box.addEventListener("tap", () => { calls += 1; });
    box.userData.listeners = box._listeners.tap.length;
    S.mount(scene);
  `);
  host.tick();
  const dump = host.dump();
  assert.equal(host.spatial.runtime.timers.timers.size, 10000);
  assert.equal(dump.objects.find((entry) => entry.name === "box").userData.listeners, 1000);
  assert.ok(dump.warnings.some((warning) => /live timers/.test(warning)));
  assert.ok(dump.warnings.some((warning) => /"tap" listeners/.test(warning)));
});

// ------------------------------------------------------------- ROBUST-03 / 04

test("ROBUST-03 a frozen object costs one object, not the frame loop", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const healthy = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    healthy.name = "healthy";
    scene.add(healthy);
    const frozen = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    frozen.name = "frozen";
    scene.add(frozen);
    Object.freeze(frozen);
    S.onFrame(() => { healthy.position.x += 0.01; });
    S.mount(scene);
  `);
  let commands;
  assert.doesNotThrow(() => {
    commands = host.tick();
  });
  assert.ok(commands.some((command) => command[0] === "create" && command[3] === "healthy"));
  for (let i = 0; i < 4; i += 1) {
    assert.doesNotThrow(() => host.tick(), `frame ${i + 2} must still run`);
  }
  const dump = host.dump();
  assert.equal(dump.frame, 5);
  assert.equal(dump.errors.filter((entry) => /"frozen" could not be processed/.test(entry)).length, 1);
  assert.ok(Math.abs(dump.objects.find((entry) => entry.name === "healthy").position[0] - 0.05) < 1e-6);
});

test("ROBUST-04 a patched Array.prototype.push cannot stop the loop", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    S.onFrame(() => { box.position.x += 0.01; });
    S.mount(scene);
    Array.prototype.push = function () { throw new Error("push hijacked"); };
  `);
  let commands;
  assert.doesNotThrow(() => {
    commands = host.tick();
  });
  assert.ok(commands.length > 0, "the batch is still built with captured builtins");
  assert.doesNotThrow(() => host.tick());
  assert.doesNotThrow(() => host.dump());
  assert.equal(host.dump().frame, 2);
});

test("ROBUST-04 a patched updateMatrix costs one object, not the loop", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const parent = new S.Group();
    parent.name = "parent";
    scene.add(parent);
    const child = new S.Group();
    child.name = "child";
    parent.add(child);
    const healthy = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    healthy.name = "healthy";
    scene.add(healthy);
    S.onFrame(() => { parent.position.x += 0.01; healthy.position.y += 0.01; });
    S.mount(scene);
    S.Object3D.prototype.updateMatrix = function () { throw new Error("patched"); };
  `);
  assert.doesNotThrow(() => host.tick());
  assert.doesNotThrow(() => host.tick());
  const dump = host.dump();
  assert.equal(dump.frame, 2);
  assert.ok(dump.errors.some((entry) => /could not be processed/.test(entry)));
  // The object that does not need a local compose keeps updating.
  assert.ok(Math.abs(dump.objects.find((entry) => entry.name === "healthy").position[1] - 0.02) < 1e-6);
});

// ------------------------------------------------------------------ ROBUST-05

test("ROBUST-05 texture urls are contained, credentialled and unlisted ones refused", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const loader = new S.TextureLoader();
    const urls = [
      "https://user:secret@example.com/a.png",
      "file:///etc/passwd",
      "../../../../../../etc/shadow",
      "asset://../../outside.png",
      "/Users/someone/.ssh/id_rsa",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "textures/wood.png",
    ];
    const marker = new S.Group();
    marker.name = "marker";
    scene.add(marker);
    for (const url of urls) loader.load(url);
    S.mount(scene);
  `,
    { assetRoot: "assets" },
  );
  const emitted = commandsFor(host.tick(), "texture").map((command) => command[2].url);
  const warnings = host.dump().warnings;

  assert.ok(!emitted.some((url) => typeof url === "string" && url.includes("secret")), "credentials never reach the wire");
  assert.ok(emitted.includes("https://example.com/a.png"), "the host and path survive");
  assert.ok(!emitted.some((url) => typeof url === "string" && url.includes("etc/shadow")), "no traversal escape");
  assert.ok(!emitted.some((url) => typeof url === "string" && url.startsWith("javascript:")), "no unlisted scheme");
  assert.ok(emitted.includes("data:image/png;base64,AAAA"), "data urls pass through");
  assert.ok(emitted.includes("assets/textures/wood.png"), "a relative url joins the asset root");
  assert.ok(emitted.includes("assets/Users/someone/.ssh/id_rsa"), "a leading slash is neutered, not escaping");

  assert.ok(warnings.some((warning) => /Credentials were stripped/.test(warning)));
  assert.ok(warnings.some((warning) => /scheme "javascript:" is not allowed/.test(warning)));
  assert.ok(warnings.some((warning) => /escapes/.test(warning)));
});

test("ROBUST-05 asset urls go through the same containment as texture urls", async () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    // A pending asset is already a root of the graph, so the command is
    // emitted without waiting for the consumer to answer.
    S.loadAsset({
      usdz: "models/robot.usdz",
      reality: "https://user:secret@example.com/robot.reality",
    }).catch(() => {});
    S.loadAsset({ usdz: "../../../../etc/passwd.usdz" }).catch((error) => {
      probe.userData.refused = error.message;
    });
    S.loadAsset({ usdz: "javascript:alert(1)" }).catch((error) => {
      probe.userData.scheme = error.message;
    });
    S.mount(scene);
  `,
    { assetRoot: "assets" },
  );
  await Promise.resolve();
  const asset = commandsFor(host.tick(), "asset")[0];

  assert.equal(asset[2].usdz, "assets/models/robot.usdz", "a relative asset url joins the asset root");
  assert.equal(asset[2].reality, "https://example.com/robot.reality", "credentials never reach the wire");

  const dump = host.dump();
  const probe = dump.objects.find((entry) => entry.name === "probe");
  assert.match(probe.userData.refused, /refused usdz/, "a traversal escape rejects the load");
  assert.match(probe.userData.scheme, /refused usdz/, "an unlisted scheme rejects the load");
  assert.ok(dump.warnings.some((warning) => /Credentials were stripped/.test(warning)));
  assert.ok(dump.warnings.some((warning) => /escapes the asset root/.test(warning)));
  assert.ok(dump.warnings.some((warning) => /scheme "javascript:" is not allowed/.test(warning)));
});

test("ROBUST-05 the environment url is contained, and a refused one leaves no environment", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    S.environment = new S.ImageBasedLight("studio/room.exr", 2);
    S.onFrame(() => {
      if (S.time.frame === 2) S.environment = new S.ImageBasedLight("../../../../secret.exr", 1);
    });
    S.mount(scene);
  `,
    { assetRoot: "assets" },
  );
  const first = commandsFor(host.tick(), "environment")[0];
  assert.equal(first[2].url, "assets/studio/room.exr", "a relative environment url joins the asset root");
  assert.equal(host.dump().environment.url, "assets/studio/room.exr", "the dump reports what was sent");

  const cleared = commandsFor(host.tick(), "environment")[0];
  assert.equal(cleared[2], null, "a refused url leaves the scene with no environment");
  const dump = host.dump();
  assert.equal(dump.environment, null);
  assert.ok(dump.warnings.some((warning) => /escapes the asset root/.test(warning)));
  assert.ok(dump.warnings.some((warning) => /environment was dropped/.test(warning)));
});

// ------------------------------------------------------------------ ROBUST-06

test("ROBUST-06 geometry parameters that the wire cannot carry are dropped", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BoxGeometry(0.1, 0.1, 0.1);
    const cyclic = { name: "deep" };
    cyclic.self = cyclic;
    geometry.parameters.evil = cyclic;
    geometry.parameters.fn = function () {};
    geometry.parameters.big = new Array(200000).fill("k");
    geometry.parameters.longString = "x".repeat(5000);
    geometry.parameters.smallArray = [1, 2, 3];
    geometry.parameters.flag = true;
    const mesh = new S.Mesh(geometry, new S.MeshStandardMaterial());
    mesh.name = "mesh";
    scene.add(mesh);
    S.mount(scene);
  `);
  const commands = host.tick();
  const parameters = commandsFor(commands, "geometry")[0][2].parameters;

  assert.equal(parameters.evil, undefined);
  assert.equal(parameters.fn, undefined);
  assert.equal(parameters.big, undefined);
  assert.equal(parameters.longString.length, 256);
  assert.deepEqual(plain(parameters.smallArray), [1, 2, 3]);
  assert.equal(parameters.flag, true);
  assert.equal(parameters.width, 0.1);
  // The whole batch is serialisable, which a cyclic value would prevent.
  assert.doesNotThrow(() => JSON.stringify(commands.filter((command) => command[0] !== "transforms")));
  assert.ok(host.dump().warnings.some((warning) => /are not a value the command stream can carry/.test(warning)));
});

// ------------------------------------------------------------------ ROBUST-07

test("ROBUST-07 an oversized name is truncated once, with a warning", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    mesh.name = "x".repeat(2000000);
    scene.add(mesh);
    S.mount(scene);
  `);
  const create = commandsFor(host.tick(), "create")[0];
  assert.equal(create[3].length, 256);
  assert.ok(host.dump().warnings.some((warning) => /was truncated to 256/.test(warning)));
});

// ------------------------------------------------------------- ROBUST-08 / 09

test("ROBUST-08 a throwing toString logs a placeholder instead of throwing", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    const hostile = {
      toJSON() { throw new Error("toJSON boom"); },
      toString() { throw new Error("toString boom"); },
    };
    S.onFrame(() => { console.log("tick", hostile); probe.userData.logged = true; });
    S.mount(scene);
  `);
  const commands = host.tick();
  const dump = host.dump();
  assert.equal(host.spatial.Spatial.scene.children[0].userData.logged, true, "console.log returned normally");
  assert.deepEqual(plain(dump.errors), [], "no error is recorded for a hostile argument");
  const log = commandsFor(commands, "log")[0];
  assert.match(log[3], /tick \[unstringifiable object\]/);
});

test("ROBUST-09 an error that varies per frame is throttled on its shape", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.add(new S.Group());
    S.onFrame(() => { throw new Error("frame boom " + S.time.frame + " at " + Math.random()); });
    S.mount(scene);
  `);
  for (let i = 0; i < 60; i += 1) host.tick();
  const dump = host.dump();
  assert.equal(dump.errors.length, 1, `the varying message must collapse, got ${dump.errors.length}`);
  assert.ok(host.spatial.runtime.errorTimes.size <= 4);
});

// ------------------------------------------------------------------ ROBUST-10

test("ROBUST-10 a throwing Proxy trap during add is recorded", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    mesh.name = "proxied";
    const hostile = new Proxy(mesh, {
      get(target, key) {
        if (key === "children") throw new Error("trap boom");
        return Reflect.get(target, key);
      },
    });
    try { scene.add(hostile); } catch (error) { probe.userData.threw = error.message; }
    S.mount(scene);
  `);
  host.tick();
  const dump = host.dump();
  assert.equal(dump.objects.find((entry) => entry.name === "probe").userData.threw, "trap boom");
  assert.ok(
    dump.errors.some((entry) => /could not inspect "proxied"/.test(entry)),
    `expected a diagnostic, got ${JSON.stringify(dump.errors)}`,
  );
});
