// SPEC 14.4 character controllers and force fields, 14.5 skeletons and blend
// shapes, 14.6 shader graph materials, 14.7 scene understanding, 14.11 small
// components and 14.12 multiple materials per mesh.

import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain } from "./helpers.mjs";

test("14.4 a character controller is described, moved, teleported and synced", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const player = new S.Mesh(new S.CapsuleGeometry(0.2, 1), new S.MeshStandardMaterial());
    player.name = "player";
    player.characterController = new S.CharacterController({ radius: 0.3, height: 1.8, stepLimit: 0.4 });
    scene.add(player);
    S.onFrame(() => {
      if (S.time.frame === 2) player.characterController.move(new S.Vector3(0.1, 0, -0.2));
      if (S.time.frame === 3) player.characterController.teleport(new S.Vector3(1, 0, 1));
      scene.userData.onGround = player.characterController.isOnGround;
      scene.userData.velocity = player.characterController.velocity.toArray();
    });
    S.mount(scene);
  `);
  const created = commandsFor(host.tick(), "characterController")[0];
  assert.equal(created[2].radius, 0.3);
  assert.equal(created[2].height, 1.8);
  assert.equal(created[2].stepLimit, 0.4);
  assert.equal(created[2].gravity, true);

  const move = commandsFor(host.tick(), "characterMove")[0];
  assert.deepEqual(plain(move.slice(2)), [0.1, 0, -0.2]);
  const teleport = commandsFor(host.tick(), "characterTeleport")[0];
  assert.deepEqual(plain(teleport.slice(2)), [1, 0, 1]);

  const id = host.idFor("player");
  host.spatial.syncCharacter(new Float32Array([id, 1, 0.9, 1, 1, 0, -1.5, 0]));
  host.tick();
  const dump = host.dump();
  assert.equal(dump.scene.userData.onGround, true);
  assert.deepEqual(plain(dump.scene.userData.velocity), [0, -1.5, 0]);
  const entry = dump.objects.find((object) => object.name === "player");
  const position = plain(entry.position);
  assert.ok(
    Math.abs(position[0] - 1) < 1e-5 && Math.abs(position[1] - 0.9) < 1e-5 && Math.abs(position[2] - 1) < 1e-5,
    `the synced world position landed on the object, got ${position}`,
  );
  assert.equal(entry.isOnGround, true);
});

test("14.4 the five force fields each carry their own payload", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const constant = new S.ConstantForceField({ force: new S.Vector3(0, 9.8, 0), radius: 3 });
    constant.name = "constant";
    const radial = new S.RadialForceField({ strength: 5, minimumDistance: 0.2, falloff: "linear", radius: 2 });
    radial.name = "radial";
    const vortex = new S.VortexForceField({ strength: 2, axis: new S.Vector3(0, 0, 1), radius: 1 });
    vortex.name = "vortex";
    const drag = new S.DragForceField({ coefficient: 0.5, radius: 4 });
    drag.name = "drag";
    const turbulence = new S.TurbulenceForceField({ strength: 1.5, noiseScale: 0.25, radius: 5 });
    turbulence.name = "turbulence";
    scene.add(constant, radial, vortex, drag, turbulence);
    S.onFrame(() => { if (S.time.frame === 2) drag.enabled = false; });
    S.mount(scene);
  `);
  const fields = commandsFor(host.tick(), "forceField");
  const byKind = {};
  for (const command of fields) byKind[command[2].kind] = command[2];
  assert.equal(fields.length, 5);
  assert.deepEqual(plain(byKind.ConstantForceField.force), [0, 9.8, 0]);
  assert.equal(byKind.RadialForceField.falloff, "linear");
  assert.equal(byKind.RadialForceField.minimumDistance, 0.2);
  assert.deepEqual(plain(byKind.VortexForceField.axis), [0, 0, 1]);
  assert.equal(byKind.DragForceField.coefficient, 0.5);
  assert.equal(byKind.TurbulenceForceField.noiseScale, 0.25);
  assert.equal(byKind.ConstantForceField.radius, 3);

  const disabled = commandsFor(host.tick(), "forceField")[0];
  assert.equal(disabled[2].kind, "DragForceField");
  assert.equal(disabled[2].enabled, false);
  assert.equal(host.dump().objects.find((object) => object.name === "drag").forceField.enabled, false);
});

test("14.5 an asset's skeleton and blend shapes are posed and synced", async () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    let asset = null;
    S.loadAsset({ glb: "robot.glb" }).then((group) => {
      asset = group;
      group.name = "robot";
      scene.add(group);
      scene.userData.joints = group.skeleton.joints;
      scene.userData.shapes = group.blendShapes.names;
      group.skeleton.setJointRotation("head", new S.Quaternion(0, 0.7071, 0, 0.7071));
      group.blendShapes.set("smile", 0.75);
      group.skeleton.track(true);
      group.skeleton.setJointPosition("missing", new S.Vector3(1, 1, 1));
    });
    S.onFrame(() => {
      if (asset !== null && asset.skeleton !== null) {
        const transform = asset.skeleton.getJointTransform("head");
        scene.userData.head = transform === null ? null : transform.position.toArray();
      }
    });
    S.mount(scene);
  `, { backend: "three", platform: "web" });
  const id = commandsFor(host.tick(), "asset")[0][1];
  host.spatial.dispatch("assetLoaded", id, {
    animations: ["idle"],
    joints: ["root", "head"],
    blendShapes: ["smile", "blink"],
  });
  host.tick();
  // The asset promise resolves on a microtask, so the script's poses land
  // after the tick that delivered assetLoaded.
  await Promise.resolve();
  await Promise.resolve();
  const frame = host.tick();

  const skeleton = commandsFor(frame, "skeleton")[0];
  assert.deepEqual(plain(skeleton[2].joints.head), [0, 0, 0, 0, 0.7071, 0, 0.7071]);
  assert.equal(skeleton[2].track, true);
  const blend = commandsFor(frame, "blendShapes")[0];
  assert.deepEqual(plain(blend[2]), { smile: 0.75 });

  const dump = host.dump();
  assert.deepEqual(plain(dump.scene.userData.joints), ["root", "head"]);
  assert.deepEqual(plain(dump.scene.userData.shapes), ["smile", "blink"]);
  assert.ok(dump.warnings.some((warning) => /no joint for/.test(warning)), "an unknown joint is refused");

  host.spatial.syncSkeleton(id, { head: [0, 1.6, 0, 0, 0, 0, 1] });
  host.tick();
  assert.deepEqual(plain(host.dump().scene.userData.head), [0, 1.6, 0], "syncSkeleton wins over the pose");
});

test("14.6 a shader graph material carries its source, parameters and fallback", () => {
  const host = createHost({ backend: "realitykit", platform: "macos" });
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const fallback = new S.MeshStandardMaterial({ color: 0x336699, roughness: 0.4 });
    const material = new S.ShaderGraphMaterial({
      source: "materials/glow.usda",
      name: "Glow",
      parameters: { intensity: 2, tint: new S.Color(1, 0, 0) },
      fallback,
    });
    const mesh = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), material);
    mesh.name = "glowing";
    scene.add(mesh);
    S.onFrame(() => {
      if (S.time.frame === 2) material.setParameter("intensity", 5);
    });
    S.mount(scene);
  `,
    { backend: "realitykit", platform: "macos", assetRoot: "assets" },
  );
  const payload = commandsFor(host.tick(), "material")[0][2];
  assert.equal(payload.type, "ShaderGraphMaterial");
  assert.equal(payload.source, "assets/materials/glow.usda");
  assert.equal(payload.name, "Glow");
  assert.equal(payload.parameters.intensity, 2);
  assert.deepEqual(plain(payload.parameters.tint), [1, 0, 0]);
  assert.equal(payload.fallback.type, "MeshStandardMaterial");
  assert.equal(payload.fallback.roughness, 0.4);

  const frame = host.tick();
  const parameter = commandsFor(frame, "shaderParameter")[0];
  assert.equal(parameter[2], "intensity");
  assert.equal(parameter[3], 5);
  assert.equal(host.dump().objects.find((object) => object.name === "glowing").material.parameters.intensity, 5);
});

test("14.6 the web fallback is required and warned about", () => {
  const host = createHost({ backend: "three", platform: "web" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.userData.missingFallback = null;
    try {
      new S.ShaderGraphMaterial({ source: "a.usda", name: "Glow" });
    } catch (error) {
      scene.userData.missingFallback = error.name;
    }
    const material = new S.ShaderGraphMaterial({
      source: "a.usda",
      name: "Glow",
      parameters: { roughness: 0.9 },
      fallback: new S.MeshStandardMaterial({ roughness: 0.1 }),
    });
    const mesh = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), material);
    mesh.name = "mesh";
    scene.add(mesh);
    material.setParameter("roughness", 0.6);
    scene.userData.fallbackRoughness = material.fallback.roughness;
    S.mount(scene);
  `, { backend: "three", platform: "web" });
  host.tick();
  const dump = host.dump();
  assert.equal(dump.scene.userData.missingFallback, "TypeError");
  assert.equal(dump.scene.userData.fallbackRoughness, 0.6, "setParameter updates a same-named fallback property");
  assert.ok(dump.warnings.some((warning) => /fallback material is rendered/.test(warning)));
});

test("14.7 scene understanding is kept, reported and warned about off visionOS", () => {
  const host = createHost({ backend: "realitykit", platform: "macos" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.sceneUnderstanding = { collision: true, occlusion: true };
    S.mount(scene);
  `, { backend: "realitykit", platform: "macos" });
  const command = commandsFor(host.tick(), "sceneUnderstanding")[0];
  assert.deepEqual(plain(command[2]), { collision: true, occlusion: true, physics: false, shadows: false });
  assert.equal(commandsFor(host.tick(), "sceneUnderstanding").length, 0, "unchanged state is silent");
  const dump = host.dump();
  assert.equal(dump.sceneUnderstanding.collision, true);
  assert.ok(dump.warnings.some((warning) => /no effect outside visionOS/.test(warning)));
});

test("14.7 a scene understanding hit has no object", () => {
  const host = createHost({
    native: {
      log() {},
      now: () => Date.now(),
      // id 0 is the real-world mesh.
      raycast: () => new Float32Array([0, 1, 0, -2, 0, 1, 0, 2]),
    },
  });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.onFrame(() => {
      const hits = S.raycast(new S.Vector3(0, 1, 0), new S.Vector3(0, 0, -1));
      scene.userData.hitCount = hits.length;
      scene.userData.hasObject = hits[0].object !== null;
      scene.userData.understanding = hits[0].sceneUnderstanding;
    });
    S.mount(scene);
  `);
  host.tick();
  const dump = host.dump();
  assert.equal(dump.scene.userData.hitCount, 1);
  assert.equal(dump.scene.userData.hasObject, false);
  assert.equal(dump.scene.userData.understanding, true);
});

test("14.11 accessibility, render options and the debug model view reach the wire", () => {
  const host = createHost({ backend: "realitykit", platform: "visionos" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const button = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    button.name = "button";
    button.accessibility = { label: "Start", value: "off", hint: "Begins the run", isButton: true };
    scene.add(button);
    S.render.adaptiveResolution = true;
    S.environmentLighting.intensityExponent = 1.5;
    S.debug.modelView = "normal";
    S.mount(scene);
  `, { backend: "realitykit", platform: "visionos" });
  const frame = host.tick();
  const accessibility = commandsFor(frame, "accessibility")[0];
  assert.deepEqual(plain(accessibility[2]), {
    label: "Start",
    value: "off",
    hint: "Begins the run",
    isButton: true,
  });
  const options = commandsFor(frame, "renderOptions")[0];
  assert.deepEqual(plain(options[2]), {
    adaptiveResolution: true,
    environmentIntensityExponent: 1.5,
    debugModelView: "normal",
  });
  const dump = host.dump();
  assert.equal(dump.objects.find((object) => object.name === "button").accessibility.label, "Start");
  assert.equal(dump.debug.modelView, "normal");
  assert.equal(commandsFor(host.tick(), "renderOptions").length, 0, "unchanged options are silent");
});

test("14.12 a mesh with several materials emits an array payload and geometry groups", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BoxGeometry(0.2, 0.2, 0.2);
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
    const red = new S.MeshStandardMaterial({ color: 0xff0000 });
    const blue = new S.MeshStandardMaterial({ color: 0x0000ff });
    const mesh = new S.Mesh(geometry, [red, blue]);
    mesh.name = "two-tone";
    scene.add(mesh);
    S.onFrame(() => { if (S.time.frame === 2) blue.color.set(0x00ff00); });
    S.mount(scene);
  `);
  const frame = host.tick();
  const material = commandsFor(frame, "material")[0];
  assert.ok(Array.isArray(material[2]), "the payload is an array");
  assert.equal(material[2].length, 2);
  assert.equal(material[2][0].type, "MeshStandardMaterial");
  const groups = commandsFor(frame, "geometry")[0][2].groups;
  assert.deepEqual(plain(groups), [
    { start: 0, count: 18, materialIndex: 0 },
    { start: 18, count: 18, materialIndex: 1 },
  ]);

  assert.equal(commandsFor(host.tick(), "material").length, 1, "a changed member re-emits the array");
  assert.equal(commandsFor(host.tick(), "material").length, 0, "an unchanged array is silent");
});

test("14.4 through 14.12 add nothing to a scene that uses none of them", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), new S.MeshStandardMaterial());
    mesh.name = "box";
    scene.add(mesh);
    S.onFrame(() => { mesh.position.x += 0.01; });
    S.mount(scene);
  `);
  host.tick();
  const opcodes = plain(host.tick().map((command) => command[0]));
  assert.deepEqual(opcodes, ["transforms"]);
});

test("14.12 adding geometry groups after the first flush re-emits the descriptor", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const geometry = new S.BoxGeometry(0.2, 0.2, 0.2);
    const mesh = new S.Mesh(geometry, new S.MeshStandardMaterial());
    mesh.name = "box";
    scene.add(mesh);
    S.onFrame(() => {
      if (S.time.frame === 2) {
        geometry.clearGroups();
        geometry.addGroup(0, 36, 0);
      }
    });
    S.mount(scene);
  `);
  // three gives a BoxGeometry one group per face; the descriptor carries them
  // so a consumer can build a box with a material per side.
  assert.equal(commandsFor(host.tick(), "geometry")[0][2].groups.length, 6);
  const regrouped = commandsFor(host.tick(), "geometry")[0];
  assert.deepEqual(plain(regrouped[2].groups), [{ start: 0, count: 36, materialIndex: 0 }]);
});

test("14.5 an asset with no rig reports null skeleton and blend shapes", async () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.loadAsset({ usdz: "prop.usdz" }).then((asset) => {
      asset.name = "prop";
      scene.add(asset);
      scene.userData.skeleton = asset.skeleton;
      scene.userData.blendShapes = asset.blendShapes;
    });
    S.mount(scene);
  `);
  const id = commandsFor(host.tick(), "asset")[0][1];
  host.spatial.dispatch("assetLoaded", id, { animations: [] });
  host.tick();
  await Promise.resolve();
  await Promise.resolve();
  const frame = host.tick();
  assert.equal(commandsFor(frame, "skeleton").length, 0, "no rig, no command");
  const dump = host.dump();
  assert.equal(dump.scene.userData.skeleton, null);
  assert.equal(dump.scene.userData.blendShapes, null);
});

test("14.4 a character controller cannot be shared between objects", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const a = new S.Group();
    a.name = "a";
    const b = new S.Group();
    b.name = "b";
    scene.add(a, b);
    const controller = new S.CharacterController();
    a.characterController = controller;
    try {
      b.characterController = controller;
    } catch (error) {
      scene.userData.shared = error.feature;
    }
    a.characterController = null;
    scene.userData.detached = a.characterController;
    S.mount(scene);
  `);
  host.tick();
  const dump = host.dump();
  assert.equal(dump.scene.userData.shared, "character-shared");
  assert.equal(dump.scene.userData.detached, null);
});
