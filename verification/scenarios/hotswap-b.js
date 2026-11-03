const Spatial = require("spatial");
const { Scene, Mesh, SphereGeometry, MeshStandardMaterial, DirectionalLight, AmbientLight } = Spatial;
const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 3); sun.position.set(-1, 2, 2); scene.add(sun);
for (let i = 0; i < 3; i++) { const m = new Mesh(new SphereGeometry(0.05), new MeshStandardMaterial({ color: 0x0000ff })); m.name = `blue-${i}`; m.position.y = -0.2 + i * 0.2; scene.add(m); }
Spatial.onFrame(() => {
  // Verdicts: every expected object is present and nothing from the other hot-swap script survives.
  const names = scene.children.map((o) => o.name);
  scene.userData.allPresent = names.filter((n) => n.startsWith("blue-")).length === 3;
  scene.userData.noStaleObjects = !names.some((n) => n.startsWith("red-"));
});
Spatial.mount(scene);
