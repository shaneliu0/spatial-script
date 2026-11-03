import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain, transformIds, transformRecords } from "./helpers.mjs";

const SIMPLE_SCENE = `
  const S = require("spatial");
  const scene = new S.Scene();
  const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
  box.name = "box";
  scene.add(box);
  S.mount(scene);
`;

test("a settled scene emits nothing", () => {
  const host = createHost();
  host.load(SIMPLE_SCENE);
  const first = host.tick();
  assert.ok(first.length > 0);
  assert.deepEqual(plain(host.tick()), []);
  assert.deepEqual(plain(host.tick()), []);
});

test("create precedes every other command for the same id", () => {
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
    S.mount(scene);
  `);
  const commands = host.tick();
  const firstIndexById = new Map();
  for (let i = 0; i < commands.length; i += 1) {
    const [opcode, id] = commands[i];
    // Scene-level opcodes carry id 0 and are not about a single object.
    if (opcode === "log" || opcode === "gravity" || opcode === "environment" || opcode === "transforms") {
      continue;
    }
    if (!firstIndexById.has(id)) {
      assert.equal(opcode, "create", `first command for id ${id} was ${opcode}`);
      firstIndexById.set(id, i);
    }
  }
  // Children are created after their parents, and every create precedes the
  // matching parent command.
  const createIndex = commands.findIndex((c) => c[0] === "create" && c[3] === "child");
  const parentIndex = commands.findIndex((c) => c[0] === "parent" && c[1] === commands[createIndex][1]);
  assert.ok(createIndex < parentIndex);

  // The batched transforms land after every create, parent and name of the
  // frame, and before anything that describes an object's contents.
  const transformsIndex = commands.findIndex((c) => c[0] === "transforms");
  const lastHierarchy = commands.reduce(
    (last, command, index) =>
      command[0] === "create" || command[0] === "parent" || command[0] === "name" ? index : last,
    -1,
  );
  const firstContent = commands.findIndex((c) =>
    ["geometry", "material", "light", "rigidBody", "texture", "visible"].includes(c[0]),
  );
  assert.ok(transformsIndex > lastHierarchy, "transforms follows create/parent/name");
  assert.ok(transformsIndex < firstContent, "transforms precedes geometry and material");
  assert.equal(commands.filter((c) => c[0] === "transform").length, 0, "no per-object transform");
});

test("texture precedes the material that references it", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const texture = new S.TextureLoader().load("asset://grid.png");
    const mesh = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), new S.MeshStandardMaterial({ map: texture }));
    mesh.name = "panel";
    scene.add(mesh);
    S.mount(scene);
  `);
  const commands = host.tick();
  const textureIndex = commands.findIndex((c) => c[0] === "texture");
  const materialIndex = commands.findIndex((c) => c[0] === "material");
  assert.ok(textureIndex >= 0 && materialIndex >= 0);
  assert.ok(textureIndex < materialIndex, "texture must be emitted before material");
  assert.equal(commands[materialIndex][2].maps.map, commands[textureIndex][1]);
});

test("geometry and material precede rigidBody, and world precedes portal", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();

    const body = new S.Mesh(new S.SphereGeometry(0.05, 12, 8), new S.MeshStandardMaterial());
    body.name = "body";
    body.rigidBody = new S.RigidBody({});
    scene.add(body);

    const world = new S.Group();
    world.name = "world";
    scene.add(world);

    const portal = new S.Portal({ width: 0.3, height: 0.3, world });
    portal.name = "portal";
    scene.add(portal);

    S.mount(scene);
  `);
  const commands = host.tick();
  const geometryIndex = commands.findIndex((c) => c[0] === "geometry");
  const materialIndex = commands.findIndex((c) => c[0] === "material");
  const bodyIndex = commands.findIndex((c) => c[0] === "rigidBody");
  const worldIndex = commands.findIndex((c) => c[0] === "world");
  const portalIndex = commands.findIndex((c) => c[0] === "portal");
  assert.ok(geometryIndex < bodyIndex, "geometry before rigidBody");
  assert.ok(materialIndex < bodyIndex, "material before rigidBody");
  assert.ok(worldIndex < portalIndex, "world before portal");
});

test("sync writes the world transform as local and produces no echo", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const holder = new S.Group();
    holder.name = "holder";
    holder.position.set(0.1, 0, 0);
    scene.add(holder);
    const ball = new S.Mesh(new S.SphereGeometry(0.05, 12, 8), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.rigidBody = new S.RigidBody({});
    holder.add(ball);
    S.mount(scene);
  `);
  host.tick();

  const ballId = host.idFor("ball");
  host.spatial.sync(new Float32Array([ballId, 0.4, 0.2, 0, 0, 0, 0, 1, 1, 1, 1]));
  const commands = host.tick();

  assert.deepEqual(
    transformIds(commands),
    [],
    "a synced transform must not echo back as a command",
  );

  const ball = host.dump().objects.find((entry) => entry.name === "ball");
  assert.deepEqual(plain(ball.position).map((v) => Number(v.toFixed(5))), [0.3, 0.2, 0]);
  assert.deepEqual(plain(ball.worldPosition).map((v) => Number(v.toFixed(5))), [0.4, 0.2, 0]);
});

test("a script write after sync emits a teleport transform", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const ball = new S.Mesh(new S.SphereGeometry(0.05, 12, 8), new S.MeshStandardMaterial());
    ball.name = "ball";
    ball.rigidBody = new S.RigidBody({});
    scene.add(ball);
    S.onFrame(() => {
      if (S.time.frame === 3) ball.position.set(0, 1, 0);
    });
    S.mount(scene);
  `);
  host.tick();

  const ballId = host.idFor("ball");
  host.spatial.sync(new Float32Array([ballId, 0, 0.5, 0, 0, 0, 0, 1, 1, 1, 1]));
  assert.deepEqual(transformIds(host.tick()), []);

  host.spatial.sync(new Float32Array([ballId, 0, 0.45, 0, 0, 0, 0, 1, 1, 1, 1]));
  const commands = host.tick();
  const records = transformRecords(commands);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, ballId);
  assert.equal(records[0].position[1], 1);
});

test("syncBodies updates read-only velocity state", () => {
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
  const ballId = host.idFor("ball");
  host.spatial.syncBodies(new Float32Array([ballId, 0, -2, 0, 0, 1, 0, 1]));
  host.tick();
  const ball = host.dump().objects.find((entry) => entry.name === "ball");
  assert.deepEqual(plain(ball.velocity), [0, -2, 0]);
  assert.equal(ball.isSleeping, true);
});

test("removing an object detaches it instead of destroying it", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const group = new S.Group();
    group.name = "group";
    scene.add(group);
    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    box.name = "box";
    scene.add(box);
    S.onFrame(() => {
      if (S.time.frame === 2) box.removeFromParent();
      if (S.time.frame === 4) group.add(box);
    });
    S.mount(scene);
  `);
  host.tick();
  const boxId = host.idFor("box");
  const groupId = host.idFor("group");

  const detached = host.tick();
  assert.deepEqual(plain(commandsFor(detached, "destroy")), []);
  assert.deepEqual(plain(commandsFor(detached, "parent")), [["parent", boxId, -1]]);

  host.tick();
  const reattached = host.tick();
  assert.deepEqual(plain(commandsFor(reattached, "parent")), [["parent", boxId, groupId]]);
});

test("mounting a different scene destroys descendants before their ancestors", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const first = new S.Scene();
    const parent = new S.Group();
    parent.name = "parent";
    first.add(parent);
    const child = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    child.name = "child";
    parent.add(child);

    const second = new S.Scene();
    const replacement = new S.Group();
    replacement.name = "replacement";
    second.add(replacement);

    S.mount(first);
    this.second = second;
    S.onFrame(() => {
      if (S.time.frame === 2) S.mount(second);
    });
  `);
  host.tick();
  const parentId = host.idFor("parent");
  const childId = host.idFor("child");

  const commands = host.tick();
  const destroys = plain(commandsFor(commands, "destroy"));
  assert.deepEqual(destroys, [["destroy", childId], ["destroy", parentId]]);
  assert.ok(commands.some((command) => command[0] === "create" && command[3] === "replacement"));
});

test("dispose destroys everything, descendants first", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const parent = new S.Group();
    parent.name = "parent";
    scene.add(parent);
    const child = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    child.name = "child";
    parent.add(child);
    S.mount(scene);
    this.willRemove = function () { console.log("teardown"); };
  `);
  host.tick();
  const parentId = host.idFor("parent");
  const childId = host.idFor("child");

  const commands = host.spatial.dispose();
  const destroys = plain(commandsFor(commands, "destroy"));
  assert.deepEqual(destroys, [["destroy", childId], ["destroy", parentId]]);
  assert.ok(commands.some((command) => command[0] === "log" && command[3] === "teardown"));
  assert.equal(host.dump().objects.length, 0);
});

test("material and geometry replacement re-emit full state", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshBasicMaterial({ color: 0x00ff00 }));
    mesh.name = "mesh";
    scene.add(mesh);
    S.onFrame(() => {
      if (S.time.frame === 2) {
        mesh.geometry = new S.SphereGeometry(0.1, 12, 8);
        mesh.material = new S.MeshStandardMaterial({ color: 0xff0000 });
      }
      if (S.time.frame === 3) mesh.material.roughness = 0.2;
    });
    S.mount(scene);
  `);
  host.tick();
  const swapped = host.tick();
  assert.equal(commandsFor(swapped, "geometry").length, 1);
  assert.equal(commandsFor(swapped, "material").length, 1);
  assert.equal(commandsFor(swapped, "material")[0][2].type, "MeshStandardMaterial");

  const mutated = host.tick();
  assert.equal(commandsFor(mutated, "geometry").length, 0);
  assert.equal(commandsFor(mutated, "material").length, 1);
  assert.equal(commandsFor(mutated, "material")[0][2].roughness, 0.2);
});

test("the geometry command carries typed arrays", () => {
  const host = createHost();
  host.load(SIMPLE_SCENE);
  const geometry = host.tick().find((command) => command[0] === "geometry");
  const [, , descriptor, positions, normals, uvs, indices] = geometry;
  assert.equal(descriptor.type, "BoxGeometry");
  assert.equal(descriptor.parameters.width, 0.1);
  assert.equal(positions.constructor.name, "Float32Array");
  assert.equal(positions.length, 72);
  assert.equal(normals.length, 72);
  assert.equal(uvs.length, 48);
  assert.equal(indices.constructor.name, "Uint32Array");
  assert.equal(indices.length, 36);
});

test("gravity and environment changes are detected", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.add(new S.Group());
    S.mount(scene);
    S.onFrame(() => {
      if (S.time.frame === 2) S.physics.gravity.set(0, -1.62, 0);
      if (S.time.frame === 3) S.environment = new S.ImageBasedLight("asset://studio.exr", 2);
      if (S.time.frame === 4) S.environment = null;
    });
  `);
  assert.deepEqual(plain(commandsFor(host.tick(), "gravity")), [["gravity", 0, 0, -9.81, 0]]);
  assert.deepEqual(plain(commandsFor(host.tick(), "gravity")), [["gravity", 0, 0, -1.62, 0]]);
  assert.deepEqual(plain(commandsFor(host.tick(), "environment")), [
    ["environment", 0, { url: "asset://studio.exr", intensity: 2 }],
  ]);
  assert.deepEqual(plain(commandsFor(host.tick(), "environment")), [["environment", 0, null]]);
  assert.deepEqual(plain(commandsFor(host.tick(), "environment")), []);
});

test("relative texture urls resolve against the asset root", () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    const loader = new S.TextureLoader();
    const relative = loader.load("textures/wood.png");
    const absolute = loader.load("https://example.com/sky.png");
    const bundled = loader.load("asset://grid.png");
    const mesh = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), new S.MeshStandardMaterial({ map: relative }));
    mesh.name = "panel";
    scene.add(mesh);
    S.mount(scene);
  `,
    { assetRoot: "/scripts/demo" },
  );
  const urls = commandsFor(host.tick(), "texture").map((command) => command[2].url);
  assert.deepEqual(plain(urls).sort(), [
    "/scripts/demo/textures/wood.png",
    "asset://grid.png",
    "https://example.com/sky.png",
  ]);
});
