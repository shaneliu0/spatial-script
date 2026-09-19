import test from "node:test";
import assert from "node:assert/strict";
import { createHost, transformRecords } from "./helpers.mjs";

const OBJECT_COUNT = 2000;
const MEASURED_FRAMES = 30;
const BUDGET_MS = 8;

const CREATION_COUNT = 1500;
const CREATION_BUDGET_MS = 250;

function median(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test(`tick with ${OBJECT_COUNT} moving meshes stays under ${BUDGET_MS} ms median`, () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();

    // One shared geometry and material: the benchmark measures the transform
    // diff and the packed transforms buffer, not buffer marshalling.
    const geometry = new S.BoxGeometry(0.02, 0.02, 0.02);
    const material = new S.MeshStandardMaterial({ color: 0x3366ff });

    const meshes = [];
    for (let i = 0; i < ${OBJECT_COUNT}; i += 1) {
      const mesh = new S.Mesh(geometry, material);
      mesh.name = "mesh" + i;
      mesh.position.set((i % 40) * 0.01 - 0.2, Math.floor(i / 40) * 0.01 - 0.25, 0);
      scene.add(mesh);
      meshes.push(mesh);
    }

    S.onFrame((deltaTime, elapsed) => {
      for (let i = 0; i < meshes.length; i += 1) {
        const mesh = meshes[i];
        mesh.position.y += Math.sin(elapsed + i) * 0.0001;
        mesh.rotation.y += deltaTime;
      }
    });

    S.mount(scene);
  `);

  // First frame carries every create; measure the steady state after it.
  host.spatial.tick(1 / 60);

  const samples = [];
  for (let frame = 0; frame < MEASURED_FRAMES; frame += 1) {
    const started = process.hrtime.bigint();
    const commands = host.spatial.tick(1 / 60);
    const finished = process.hrtime.bigint();
    samples.push(Number(finished - started) / 1e6);
    assert.equal(commands.length, 1, "the steady state is a single batched transforms command");
    assert.equal(commands[0][0], "transforms");
    assert.equal(commands[0][2].length, OBJECT_COUNT * 11, "every mesh contributes one record");
  }

  const value = median(samples);
  console.log(
    `tick benchmark: ${OBJECT_COUNT} meshes, median ${value.toFixed(3)} ms, worst ${Math.max(...samples).toFixed(3)} ms over ${MEASURED_FRAMES} frames`,
  );
  assert.ok(value < BUDGET_MS, `median tick was ${value.toFixed(3)} ms, budget is ${BUDGET_MS} ms`);
});

test(`the creation frame for ${CREATION_COUNT} meshes sharing one geometry stays under ${CREATION_BUDGET_MS} ms`, () => {
  const source = `
    const S = require("spatial");
    const scene = new S.Scene();

    // One geometry and one material instance for the whole scene: the command
    // stream carries one geometry uuid and one material uuid, so a consumer
    // creates a single native mesh resource.
    const geometry = new S.BoxGeometry(0.02, 0.02, 0.02);
    const material = new S.MeshStandardMaterial({ color: 0x3366ff });

    for (let i = 0; i < ${CREATION_COUNT}; i += 1) {
      const mesh = new S.Mesh(geometry, material);
      mesh.name = "mesh" + i;
      mesh.position.set((i % 40) * 0.01 - 0.2, Math.floor(i / 40) * 0.01 - 0.2, 0);
      scene.add(mesh);
    }

    S.mount(scene);
  `;

  const samples = [];
  let firstFrame = null;
  for (let run = 0; run < 5; run += 1) {
    const host = createHost();
    host.load(source);
    const started = process.hrtime.bigint();
    const commands = host.spatial.tick(1 / 60);
    const finished = process.hrtime.bigint();
    samples.push(Number(finished - started) / 1e6);
    if (firstFrame === null) firstFrame = commands;
  }

  const creates = firstFrame.filter((command) => command[0] === "create");
  const geometries = firstFrame.filter((command) => command[0] === "geometry");
  const materials = firstFrame.filter((command) => command[0] === "material");
  const records = transformRecords(firstFrame);

  assert.equal(creates.length, CREATION_COUNT);
  assert.equal(records.length, CREATION_COUNT);
  assert.equal(geometries.length, CREATION_COUNT, "one geometry command per mesh");
  assert.equal(materials.length, CREATION_COUNT, "one material command per mesh");

  // Every mesh reports the same resource identity, which is what lets a
  // consumer build one native mesh and one native material for all of them.
  const geometryUuids = new Set(geometries.map((command) => command[2].uuid));
  const materialUuids = new Set(materials.map((command) => command[2].uuid));
  assert.equal(geometryUuids.size, 1);
  assert.equal(materialUuids.size, 1);
  // The buffers travel once for the geometry, and every later mesh that uses
  // the same uuid and revision gets the descriptor with null buffers.
  const withBuffers = geometries.filter((command) => command[3] !== null);
  assert.equal(withBuffers.length, 1, "the vertex data crosses the boundary once");
  assert.equal(
    geometries.length - withBuffers.length,
    CREATION_COUNT - 1,
    "every other mesh reuses it by uuid",
  );
  assert.equal(new Set(geometries.map((command) => command[2].revision)).size, 1);

  const value = median(samples);
  console.log(
    `creation benchmark: ${CREATION_COUNT} meshes sharing one geometry, first flush median ${value.toFixed(3)} ms, worst ${Math.max(...samples).toFixed(3)} ms over ${samples.length} runs, ${firstFrame.length} commands`,
  );
  assert.ok(
    value < CREATION_BUDGET_MS,
    `creation flush was ${value.toFixed(3)} ms, budget is ${CREATION_BUDGET_MS} ms`,
  );
});
