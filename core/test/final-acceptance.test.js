// One test per final-acceptance review finding on the core. Each fails against
// the reviewed build.

import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain } from "./helpers.mjs";

// -------------------------------------------------------------------- FA-09

test("FA-09 more materials than the groups ask for warns once and the extras stay off the wire", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BoxGeometry(0.2, 0.2, 0.2);
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
    const mesh = new S.Mesh(geometry, [
      new S.MeshStandardMaterial({ color: 0xff0000 }),
      new S.MeshStandardMaterial({ color: 0x00ff00 }),
      new S.MeshBasicMaterial({ color: 0x0000ff }),
      new S.MeshBasicMaterial({ color: 0xffff00 }),
    ]);
    mesh.name = "extra";
    scene.add(mesh);
    S.mount(scene);
  `);
  const payload = commandsFor(host.tick(), "material")[0][2];
  assert.equal(payload.length, 2, "only the materials the groups can use are sent");
  assert.equal(payload[0].type, "MeshStandardMaterial");
  const warnings = host.dump().warnings.filter((warning) => /extra materials were ignored/.test(warning));
  assert.equal(warnings.length, 1, `warned once, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /carries 4 materials but its geometry groups ask for 2/);
  host.tick();
  assert.equal(
    host.dump().warnings.filter((warning) => /extra materials were ignored/.test(warning)).length,
    1,
    "still once after another frame",
  );
});

// -------------------------------------------------------------------- FA-41

test("FA-41 the compact dump omits only geometry parameters and userData", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.BoxGeometry(0.123456789, 0.2, 0.2), new S.MeshStandardMaterial({ color: 0x336699 }));
    mesh.name = "box";
    mesh.position.set(0.123456789, 0, 0);
    mesh.rigidBody = new S.RigidBody({ type: "dynamic" });
    mesh.addEventListener("tap", () => {});
    mesh.userData.big = "x".repeat(100);
    scene.add(mesh);
    const light = new S.PointLight(0xffffff, 2);
    light.name = "lamp";
    scene.add(light);
    S.mount(scene);
  `);
  host.tick();
  const full = host.spatial.dump().objects.find((entry) => entry.name === "box");
  const compactDump = host.spatial.dump({ compact: true });
  const compact = compactDump.objects.find((entry) => entry.name === "box");
  const compactLight = compactDump.objects.find((entry) => entry.name === "lamp");

  assert.equal(compact.userData, undefined, "userData is omitted");
  assert.ok(!("parameters" in compact.geometry), "the geometry parameters key is omitted, not nulled");
  assert.equal(compact.geometry.type, full.geometry.type, "the geometry type stays");
  assert.equal(compact.material.type, full.material.type, "the material stays");
  assert.deepEqual(plain(compact.material.color), plain(full.material.color).map((v) => Math.round(v * 1e4) / 1e4));
  assert.equal(compact.rigidBody.type, "dynamic", "the body stays");
  assert.deepEqual(plain(compact.interactive), plain(full.interactive), "interactive stays");
  assert.equal(compact.opacity, 1);
  assert.equal(compact.billboard, false);
  assert.equal(compact.world, false);
  assert.equal(compactLight.light.type, "point", "a light keeps its payload");
  assert.equal(compact.position[0], 0.1235, "numbers are rounded to four decimals");
});

// -------------------------------------------------------------------- FA-42

test("FA-42 an error is reported once per second per exact message", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.add(new S.Group());
    S.onFrame(() => { throw new Error("boom " + (S.time.frame % 3)); });
    S.mount(scene);
  `);
  // Three distinct messages inside one second: each is reported once, and the
  // repeat of message 0 on frame 4 is throttled.
  for (let i = 0; i < 4; i += 1) host.tick();
  let errors = host.dump().errors;
  assert.equal(errors.length, 3, `three distinct messages, got ${JSON.stringify(errors)}`);
  assert.ok(errors.some((error) => /boom 1/.test(error)));
  assert.ok(errors.some((error) => /boom 2/.test(error)));

  // A second of scene time later the same message is allowed through again;
  // the clock is Spatial.time.elapsed, so one long frame is one second.
  host.tick(1.001);
  errors = host.dump().errors;
  assert.equal(errors.length, 4, "the same message repeats once the second is up");
});

test("FA-42 a message that is never twice the same is capped per second", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.add(new S.Group());
    S.onFrame(() => { throw new Error("unique " + S.time.frame); });
    S.mount(scene);
  `);
  // 50 frames at 1/60 s stay inside one second of scene time.
  for (let i = 0; i < 50; i += 1) host.tick();
  const errors = host.dump().errors;
  assert.ok(errors.length <= 21, `capped at the per-second budget, got ${errors.length}`);
  assert.ok(errors.some((error) => /distinct errors in one second/.test(error)));

  const before = host.dump().errors.length;
  host.tick(1.001);
  assert.ok(host.dump().errors.length > before, "the next second starts fresh");
});

// -------------------------------------------------------------------- FA-47

test("FA-47 at the id ceiling new objects stop being tracked", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const marker = new S.Group();
    marker.name = "marker";
    scene.add(marker);
    S.mount(scene);
  `);
  host.tick();
  const runtime = host.spatial.runtime;
  const tracked = host.dump().objects.length;

  // Walk the allocator up to the ceiling, then add more objects.
  runtime.nextId = (1 << 24) - 1;
  runtime.freeIds.length = 0;
  host.spatial.Spatial.scene.add(host.spatial.Spatial.scene.children[0].clone());
  const frame = host.tick();
  for (let i = 0; i < 3; i += 1) {
    const group = new host.spatial.Spatial.Group();
    group.name = `late${i}`;
    host.spatial.Spatial.scene.add(group);
  }
  const later = host.tick();

  for (const command of [...frame, ...later]) {
    if (command[0] === "create" || command[0] === "parent" || command[0] === "transforms") continue;
    assert.notEqual(command[1], 0, `no command may name the native root: ${command[0]}`);
  }
  assert.equal(commandsFor(later, "create").length, 0, "untracked objects are not created");
  assert.equal(host.dump().objects.length, tracked + 1, "and they are not in the dump");
  const errors = host.dump().errors.filter((error) => /every object id below/.test(error));
  assert.equal(errors.length, 1, "the error is recorded once");
});

// -------------------------------------------------------------------- FA-48

test("FA-48 groundingShadow applies to a mesh and is refused on anything else", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), new S.MeshStandardMaterial());
    mesh.name = "panel";
    mesh.groundingShadow = true;
    scene.add(mesh);
    const group = new S.Group();
    group.name = "group";
    group.groundingShadow = true;
    scene.add(group);
    S.mount(scene);
  `);
  const commands = commandsFor(host.tick(), "groundingShadow");
  assert.equal(commands.length, 1, "only the mesh reaches the consumer");
  assert.equal(commands[0][1], host.idFor("panel"));
  const dump = host.dump();
  assert.equal(dump.objects.find((entry) => entry.name === "group").groundingShadow, true, "the state is kept");
  assert.ok(dump.warnings.some((warning) => /groundingShadow applies to a Mesh/.test(warning)));
});

// -------------------------------------------------------------------- FA-49

test("FA-49 an unsupported feature warns once per feature per scene and again after a reload", () => {
  const host = createHost({ backend: "realitykit", platform: "macos" });
  const source = `
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial({ wireframe: true }));
    mesh.name = "wire";
    scene.add(mesh);
    const lamp = new S.PointLight(0xffffff, 1);
    lamp.name = "lamp";
    lamp.castShadow = true;
    scene.add(lamp);
    S.onFrame(() => { mesh.position.x += 0.001; });
    S.mount(scene);
  `;
  host.load(source, { backend: "realitykit", platform: "macos" });

  const warnLines = (commands) =>
    commandsFor(commands, "log").filter((command) => command[2] === "warn").map((command) => command[3]);

  // A warning raised inside the flush rides the next frame's log lane, so the
  // first two frames are read together.
  const first = [...warnLines(host.tick()), ...warnLines(host.tick())];
  assert.equal(first.filter((line) => /wireframe/.test(line)).length, 1, "one wireframe warning");
  assert.equal(first.filter((line) => /PointLight shadows/.test(line)).length, 1);

  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(plain(warnLines(host.tick())), [], "and never again this scene");
  }
  assert.equal(
    host.dump().warnings.filter((warning) => /wireframe/.test(warning)).length,
    1,
    "one entry in dump().warnings too",
  );

  // A new scene starts the count again: the warning belongs to the scene.
  host.load(source, { backend: "realitykit", platform: "macos" });
  const afterReload = [...warnLines(host.tick()), ...warnLines(host.tick())];
  assert.equal(afterReload.filter((line) => /wireframe/.test(line)).length, 1, "warned again after a reload");
});

// -------------------------------------------------------------------- FA-58

test("FA-58 a disposed texture used again gets a fresh id and a warning", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const texture = new S.TextureLoader().load("asset://grid.png");
    const material = new S.MeshStandardMaterial({ map: texture });
    const mesh = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), material);
    mesh.name = "panel";
    scene.add(mesh);
    S.onFrame(() => {
      if (S.time.frame === 2) { material.map = null; texture.dispose(); }
      if (S.time.frame === 4) material.map = texture;
    });
    S.mount(scene);
  `);
  host.tick();
  const released = host.tick();
  assert.equal(commandsFor(released, "texture")[0][2], null, "the release reaches the consumer");
  host.tick();

  const reused = host.tick();
  const texture = commandsFor(reused, "texture")[0];
  const material = commandsFor(reused, "material")[0];
  assert.ok(texture, "the texture is described again before any material names it");
  assert.notEqual(texture[2], null, "and it is a registration, not another release");
  assert.equal(texture[2].url, "asset://grid.png");
  assert.equal(material[2].maps.map, texture[1], "the material names the new id");
  const opcodes = plain(reused.map((command) => command[0]));
  assert.ok(opcodes.indexOf("texture") < opcodes.indexOf("material"), "texture precedes material");
  assert.ok(host.dump().warnings.some((warning) => /disposed Texture/.test(warning)));
});

// -------------------------------------------------------------------- FA-52

test("FA-52 assigning to a read-only body field is refused out loud", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const ball = new S.Mesh(new S.SphereGeometry(0.1), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.rigidBody = new S.RigidBody({ type: "dynamic" });
    scene.add(ball);
    ball.rigidBody.setLinearVelocity(new S.Vector3(0, 1, 0));

    // Sloppy mode: these would silently do nothing.
    ball.rigidBody.linearVelocity = new S.Vector3(9, 9, 9);
    ball.rigidBody.angularVelocity = new S.Vector3(9, 9, 9);
    ball.rigidBody.isSleeping = true;

    scene.userData.linear = ball.rigidBody.linearVelocity.toArray();
    scene.userData.angular = ball.rigidBody.angularVelocity.toArray();
    scene.userData.sleeping = ball.rigidBody.isSleeping;
    S.mount(scene);
  `);
  host.tick();
  const dump = host.dump();
  assert.deepEqual(plain(dump.scene.userData.linear), [0, 1, 0], "the setter's value stands");
  assert.deepEqual(plain(dump.scene.userData.angular), [0, 0, 0]);
  assert.equal(dump.scene.userData.sleeping, false);

  const warnings = dump.warnings.filter((warning) => /is read-only/.test(warning));
  assert.equal(warnings.length, 3, `one per field, got ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((warning) => /linearVelocity is read-only.*setLinearVelocity\(vector\)/.test(warning)));
  assert.ok(warnings.some((warning) => /angularVelocity is read-only.*setAngularVelocity\(vector\)/.test(warning)));
  assert.ok(warnings.some((warning) => /isSleeping is read-only.*syncBodies/.test(warning)));
});

// -------------------------------- SPEC 5: buffers cross once per uuid+revision

test("a plain BufferGeometry shared by many meshes crosses the boundary once", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BufferGeometry();
    geometry.setAttribute("position", new S.Float32BufferAttribute(new Float32Array(3000), 3));
    geometry.setAttribute("normal", new S.Float32BufferAttribute(new Float32Array(3000), 3));
    const material = new S.MeshStandardMaterial();
    for (let i = 0; i < 200; i += 1) {
      const mesh = new S.Mesh(geometry, material);
      mesh.name = "m" + i;
      scene.add(mesh);
    }
    S.mount(scene);
  `);
  const geometries = commandsFor(host.tick(), "geometry");
  let bytes = 0;
  for (const command of geometries) {
    for (let i = 3; i < command.length; i += 1) {
      if (command[i] && command[i].byteLength) bytes += command[i].byteLength;
    }
  }
  assert.equal(geometries.length, 200);
  assert.equal(geometries.filter((command) => command[3] !== null).length, 1);
  assert.equal(bytes, 3000 * 4 * 2, "one copy of the position and normal buffers, not 200");
});

// -------------------------------------------------------------------- FA-11

test("FA-11 a native raycast reports at most one hit per object", () => {
  // A consumer that reports one record per collision shape: several for each
  // object, plus two real-world records. Filled in once the ids are known.
  let records = new Float32Array(0);
  const host = createHost({
    native: {
      log() {},
      now: () => 0,
      raycast: () => records,
    },
  });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const near = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    near.name = "near";
    const far = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    far.name = "far";
    scene.add(near, far);
    S.onFrame(() => {
      const hits = S.raycast(new S.Vector3(0, 0, 0), new S.Vector3(0, 0, -1));
      scene.userData.hits = hits.map((hit) => [hit.object === null ? null : hit.object.name, hit.distance]);
    });
    S.mount(scene);
  `);
  host.tick();
  const nearId = host.idFor("near");
  const farId = host.idFor("far");
  records = new Float32Array([
    nearId, 0, 0, -3, 0, 0, 1, 3,
    nearId, 0, 0, -1, 0, 0, 1, 1,
    farId, 0, 0, -4, 0, 0, 1, 4,
    nearId, 0, 0, -2, 0, 0, 1, 2,
    0, 0, 0, -6, 0, 0, 1, 6,
    farId, 0, 0, -5, 0, 0, 1, 5,
    0, 0, 0, -7, 0, 0, 1, 7,
  ]);
  host.tick();

  const hits = plain(host.dump().scene.userData.hits);
  assert.deepEqual(
    hits,
    [
      ["near", 1],
      ["far", 4],
      [null, 6],
    ],
    "one hit per object, nearest first, and one for the real-world mesh",
  );
});

// -------------------------------------------------------------------- FA-21

test("FA-21 a point-light shadow warns on RealityKit and not on the web", () => {
  const source = `
    const S = require("spatial");
    const scene = new S.Scene();
    const lamp = new S.PointLight(0xffffff, 2);
    lamp.name = "lamp";
    lamp.castShadow = true;
    scene.add(lamp);
    S.mount(scene);
  `;
  const realitykit = createHost({ backend: "realitykit", platform: "macos" });
  realitykit.load(source, { backend: "realitykit", platform: "macos" });
  realitykit.tick();
  assert.ok(
    realitykit.dump().warnings.some((warning) => /PointLight shadows are unsupported in RealityKit/.test(warning)),
    "RealityKit has no point-light shadow",
  );

  const web = createHost({ backend: "three", platform: "web" });
  web.load(source, { backend: "three", platform: "web" });
  web.tick();
  assert.deepEqual(
    plain(web.dump().warnings.filter((warning) => /PointLight/.test(warning))),
    [],
    "three.js renders one, so there is nothing to warn about",
  );
  assert.equal(web.dump().objects.find((entry) => entry.name === "lamp").castShadow, true);
});

// ------------------------------------------------- native-dump scene symmetry

test("the dump's scene block is the script's Scene, named as the script named it", () => {
  const unnamed = createHost();
  unnamed.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.userData.mode = "idle";
    scene.add(new S.Group());
    S.mount(scene);
  `);
  unnamed.tick();
  const block = unnamed.dump().scene;
  assert.equal(block.name, "", "an unnamed Scene reports the empty string, not a placeholder");
  assert.equal(typeof block.name, "string");
  assert.deepEqual(plain(block.userData), { mode: "idle" });

  const named = createHost();
  named.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.name = "gallery";
    S.mount(scene);
    S.onFrame(() => { if (S.time.frame === 2) scene.name = "renamed"; });
  `);
  named.tick();
  assert.equal(named.dump().scene.name, "gallery");
  named.tick();
  assert.equal(named.dump().scene.name, "renamed", "and it follows the script");
});

// -------------------------------------------------------------------- FA-27

test("FA-27 setParameter writes any same-named fallback property and names one it lacks", () => {
  const host = createHost({ backend: "realitykit", platform: "macos" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const fallback = new S.MeshStandardMaterial({ roughness: 0.5, color: 0x111111 });
    const material = new S.ShaderGraphMaterial({
      source: "m.usda",
      name: "Glow",
      fallback,
    });
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), material);
    mesh.name = "mesh";
    scene.add(mesh);

    // A property three.js has on every material, but which the core's old
    // whitelist did not carry: the web consumer writes it, so the core must.
    material.setParameter("envMapIntensity", 4);
    // A Color-valued property is copied in place, not replaced.
    material.setParameter("color", new S.Color(1, 0, 0));
    // A scalar the fallback owns.
    material.setParameter("roughness", 0.9);
    // A name only the shader graph understands.
    material.setParameter("glowPulse", 2);

    scene.userData.envMapIntensity = fallback.envMapIntensity;
    scene.userData.roughness = fallback.roughness;
    scene.userData.color = fallback.color.toArray();
    scene.userData.isColor = fallback.color.isColor === true;
    scene.userData.glowPulse = fallback.glowPulse;
    S.mount(scene);
  `, { backend: "realitykit", platform: "macos" });
  host.tick();
  const dump = host.dump();

  assert.equal(dump.scene.userData.envMapIntensity, 4, "any same-named property is written");
  assert.equal(dump.scene.userData.roughness, 0.9);
  assert.deepEqual(plain(dump.scene.userData.color), [1, 0, 0]);
  assert.equal(dump.scene.userData.isColor, true, "a Color stays a Color");
  assert.equal(dump.scene.userData.glowPulse, undefined, "an unknown name is not invented");

  const warnings = dump.warnings.filter((warning) => /has no matching property on the fallback/.test(warning));
  assert.equal(warnings.length, 1, `only the unknown name warns, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /"glowPulse"/);

  // And the graph itself carries all four, since the fallback is only a stand-in.
  const material = dump.objects.find((entry) => entry.name === "mesh").material;
  assert.equal(material.parameters.envMapIntensity, 4);
  assert.equal(material.parameters.glowPulse, 2);
});

// -------------------------------------------------------------------- FA-38

test("FA-38 a shader parameter string past the cap is refused, never truncated", () => {
  const host = createHost({ backend: "realitykit", platform: "macos" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const material = new S.ShaderGraphMaterial({
      source: "m.usda",
      name: "Glow",
      parameters: { atLimit: "a".repeat(256), tooLong: "b".repeat(300) },
      fallback: new S.MeshStandardMaterial(),
    });
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), material);
    mesh.name = "mesh";
    scene.add(mesh);
    S.onFrame(() => {
      if (S.time.frame === 2) material.setParameter("late", "c".repeat(300));
    });
    S.mount(scene);
  `, { backend: "realitykit", platform: "macos" });

  const payload = commandsFor(host.tick(), "material")[0][2];
  assert.equal(payload.parameters.atLimit.length, 256, "a string at the cap still travels whole");
  assert.equal(payload.parameters.tooLong, undefined, "a longer one is refused, not cut to 256");

  assert.equal(commandsFor(host.tick(), "shaderParameter").length, 0, "and so is a later one");
  const dump = host.dump();
  const material = dump.objects.find((entry) => entry.name === "mesh").material;
  assert.equal(material.parameters.late, undefined);
  // The constructor path names the refused key; the setParameter path (AR-48) names the string
  // cap that refused it. Both must warn, each about its own value.
  assert.ok(dump.warnings.some((warning) => /tooLong/.test(warning) && /cannot carry|characters/.test(warning)), "the constructor value is named");
  assert.ok(dump.warnings.some((warning) => /"late"/.test(warning) && /300 characters/.test(warning)), "and so is the later one, with the cap named");
});

// ------------------------------------- SPEC 14.6: the fallback's identity fields

test("a shader parameter never writes the fallback's identity fields", () => {
  const host = createHost({ backend: "realitykit", platform: "macos" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const fallback = new S.MeshStandardMaterial({ roughness: 0.5 });
    const material = new S.ShaderGraphMaterial({ source: "m.usda", name: "Glow", fallback });
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), material);
    mesh.name = "mesh";
    scene.add(mesh);

    scene.userData.uuidBefore = fallback.uuid;
    scene.userData.typeBefore = fallback.type;
    scene.userData.nameBefore = fallback.name;

    // A shader graph may legitimately have a parameter called uuid or type;
    // writing one onto the fallback would break the material (SPEC 14.6).
    material.setParameter("uuid", "hijacked");
    material.setParameter("type", "hijacked");
    material.setParameter("name", "hijacked");
    material.setParameter("id", 999);
    material.setParameter("version", 999);
    // A real material property still goes through.
    material.setParameter("envMapIntensity", 4);

    scene.userData.uuidAfter = fallback.uuid;
    scene.userData.typeAfter = fallback.type;
    scene.userData.nameAfter = fallback.name;
    scene.userData.idAfter = fallback.id;
    scene.userData.versionAfter = fallback.version;
    scene.userData.envMapIntensity = fallback.envMapIntensity;
    S.mount(scene);
  `, { backend: "realitykit", platform: "macos" });
  host.tick();
  const dump = host.dump();
  const data = dump.scene.userData;

  assert.equal(data.uuidAfter, data.uuidBefore, "the fallback keeps its uuid");
  assert.equal(data.typeAfter, "MeshStandardMaterial", "and its type");
  assert.equal(data.nameAfter, data.nameBefore, "and its name");
  assert.notEqual(data.idAfter, 999);
  assert.notEqual(data.versionAfter, 999);
  assert.equal(data.envMapIntensity, 4, "a real property still writes");

  const refused = dump.warnings.filter((warning) => /identify the material itself/.test(warning));
  assert.equal(refused.length, 5, `one warning per identity name, got ${JSON.stringify(refused)}`);
  assert.ok(refused.some((warning) => /"uuid"/.test(warning)));

  // The graph still gets every one of them: only the fallback write is refused.
  const material = dump.objects.find((entry) => entry.name === "mesh").material;
  assert.equal(material.parameters.uuid, "hijacked", "the graph still receives the parameter");
  assert.equal(material.parameters.envMapIntensity, 4);
  assert.notEqual(material.fallback.uuid, "hijacked", "the payload's fallback is intact too");
  assert.equal(material.fallback.type, "MeshStandardMaterial");
});
