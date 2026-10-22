// Shared benchmark plumbing: builds a scene in the page through the real core and
// measures the consumer's command-apply cost across the browser boundary.

/** A script that builds `count` meshes sharing one geometry, one material each. */
export function meshGridSource(count) {
  return `
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, DirectionalLight } = Spatial;
const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.6));
const sun = new DirectionalLight(0xffffff, 2.5); sun.position.set(1, 2, 2); scene.add(sun);
const geometry = new BoxGeometry(0.012, 0.012, 0.012);
const side = Math.ceil(Math.cbrt(${count}));
this.meshes = [];
for (let i = 0; i < ${count}; i++) {
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: (i * 2654435761) & 0xffffff }));
  mesh.name = "c" + i;
  mesh.position.set(
    ((i % side) - side / 2) * 0.03,
    ((Math.floor(i / side) % side) - side / 2) * 0.03,
    (Math.floor(i / side / side) - side / 2) * 0.03,
  );
  scene.add(mesh);
  this.meshes.push(mesh);
}
Spatial.mount(scene);
`;
}

/**
 * Loads `count` meshes through the real core, then times `apply` of one batched
 * `transforms` command holding one record per object. Runs entirely in the page,
 * so the Float32Array crosses the same browser boundary a real frame does.
 */
export async function benchmarkTransforms(page, { count, runs = 40, warmup = 8 }) {
  return page.evaluate(async ([objectCount, runCount, warmupCount]) => {
    const consumer = window.spatialConsumer;
    // Two ticks: the first creates the objects, the second settles the scene.
    window.spatialTick(1 / 60);
    window.spatialTick(1 / 60);

    const ids = window.spatialDump().objects
      .filter((o) => o.type === 'Mesh')
      .map((o) => o.id);
    if (ids.length < objectCount) {
      throw new Error(`expected ${objectCount} meshes in the scene, found ${ids.length}`);
    }

    const buffer = new Float32Array(objectCount * 11);
    const fill = (phase) => {
      for (let i = 0; i < objectCount; i++) {
        const o = i * 11;
        const t = phase + i * 0.0001;
        buffer[o] = ids[i];
        buffer[o + 1] = Math.sin(t) * 0.2;
        buffer[o + 2] = Math.cos(t) * 0.2;
        buffer[o + 3] = t * 0.01;
        buffer[o + 4] = 0;
        buffer[o + 5] = Math.sin(t * 0.5);
        buffer[o + 6] = 0;
        buffer[o + 7] = Math.cos(t * 0.5);
        buffer[o + 8] = 1; buffer[o + 9] = 1; buffer[o + 10] = 1;
      }
    };

    const samples = [];
    for (let run = 0; run < warmupCount + runCount; run++) {
      fill(run * 0.05);
      // The core reuses one buffer per frame; the command shape is identical.
      const command = [['transforms', 0, buffer]];
      const started = performance.now();
      consumer.apply(command);
      const elapsed = performance.now() - started;
      if (run >= warmupCount) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    return {
      objectCount,
      records: objectCount,
      median: samples[Math.floor(samples.length / 2)],
      p95: samples[Math.floor(samples.length * 0.95)],
      worst: samples[samples.length - 1],
      geometries: consumer.geometries.size,
      materials: consumer.materials.size,
    };
  }, [count, runs, warmup]);
}
