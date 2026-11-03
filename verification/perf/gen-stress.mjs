#!/usr/bin/env node
// Prints a stress scene script. Options: --count N --shared-geometry --shared-material --static
// --shadows --physics. Everything defaults to the harder case (unique geometry and materials, moving).
const a = process.argv.slice(2);
const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const count = Number(opt("--count", 1500));
const sharedGeometry = a.includes("--shared-geometry"), sharedMaterial = a.includes("--shared-material");
const isStatic = a.includes("--static"), shadows = a.includes("--shadows"), physics = a.includes("--physics");
console.log(`
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight, AmbientLight, RigidBody } = Spatial;
const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 3); sun.position.set(1, 2, 2); ${shadows ? "sun.castShadow = true;" : ""} scene.add(sun);
${physics ? `const floor = new Mesh(new BoxGeometry(2, 0.02, 2), new MeshStandardMaterial({ color: 0x444444 })); floor.name = "floor"; floor.position.y = -0.5; floor.rigidBody = new RigidBody({ type: "static" }); scene.add(floor);` : ""}
const N = ${count}, side = Math.ceil(Math.cbrt(N));
${sharedGeometry ? "const sharedGeo = new BoxGeometry(0.012, 0.012, 0.012);" : ""}
${sharedMaterial ? "const sharedMat = new MeshStandardMaterial({ color: 0x3366ff });" : ""}
const cubes = [];
for (let i = 0; i < N; i++) {
  const m = new Mesh(${sharedGeometry ? "sharedGeo" : "new BoxGeometry(0.012, 0.012, 0.012)"}, ${sharedMaterial ? "sharedMat" : "new MeshStandardMaterial({ color: (i * 2654435761) & 0xffffff })"});
  m.name = "c" + i;
  m.position.set(((i % side) - side / 2) * 0.03, ((Math.floor(i / side) % side) - side / 2) * 0.03 + ${physics ? "0.3" : "0"}, (Math.floor(i / side / side) - side / 2) * 0.03);
  ${shadows ? "m.castShadow = true;" : ""}
  ${physics ? "m.rigidBody = new RigidBody({ mass: 0.1 });" : ""}
  scene.add(m); cubes.push(m);
}
${isStatic ? "" : `Spatial.onFrame((dt, t) => { for (let i = 0; i < N; i++) { const c = cubes[i]; c.rotation.y = t + i * 0.01; c.position.y += Math.sin(t * 2 + i) * 0.0005; } });`}
Spatial.mount(scene);
`);
