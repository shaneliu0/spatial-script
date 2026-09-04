const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight, AmbientLight } = Spatial;
const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 3); sun.position.set(1, 2, 2); scene.add(sun);
for (let i = 0; i < 5; i++) { const m = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), new MeshStandardMaterial({ color: 0xff0000 })); m.name = `red-${i}`; m.position.x = -0.3 + i * 0.15; scene.add(m); }
Spatial.mount(scene);
