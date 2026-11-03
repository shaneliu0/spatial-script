// 1500 cubes updated every frame; verifies batching keeps the frame rate usable.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight, AmbientLight } = Spatial;
const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 3); sun.position.set(1, 2, 2); scene.add(sun);
const geo = new BoxGeometry(0.012, 0.012, 0.012);
const cubes = [];
const N = 1500, side = Math.ceil(Math.cbrt(N));
for (let i = 0; i < N; i++) {
  const m = new Mesh(geo, new MeshStandardMaterial({ color: (i * 2654435761) & 0xffffff }));
  m.name = `c${i}`;
  m.position.set(((i % side) - side / 2) * 0.03, ((Math.floor(i / side) % side) - side / 2) * 0.03, (Math.floor(i / side / side) - side / 2) * 0.03);
  scene.add(m); cubes.push(m);
}
let acc = 0, n = 0;
Spatial.onFrame((dt, t) => {
  for (let i = 0; i < N; i++) { const c = cubes[i]; c.rotation.y = t + i * 0.01; c.position.y += Math.sin(t * 2 + i) * 0.0005; }
  acc += dt; n += 1;
  if (n === 120) { scene.userData.avgDt = +(acc / n).toFixed(4); console.log("avg dt over 120 frames", scene.userData.avgDt); acc = 0; n = 0; }
});
Spatial.mount(scene);
