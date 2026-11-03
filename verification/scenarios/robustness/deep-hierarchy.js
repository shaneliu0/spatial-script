// 300 levels of nesting.
const Spatial = require("spatial");
const { Scene, Group, Mesh, SphereGeometry, MeshStandardMaterial, AmbientLight } = Spatial;
const scene = new Scene(); scene.add(new AmbientLight(0xffffff, 1));
let parent = scene;
for (let i = 0; i < 300; i++) { const g = new Group(); g.name = `level-${i}`; g.position.x = 0.001; g.rotation.y = 0.002; parent.add(g); parent = g; }
const tip = new Mesh(new SphereGeometry(0.03), new MeshStandardMaterial({ color: 0xff00ff })); tip.name = "tip"; parent.add(tip);
Spatial.onFrame((dt) => { scene.children[1].rotation.y += dt * 0.2; const p = new Spatial.Vector3(); tip.getWorldPosition(p); scene.userData.tipWorld = p.toArray().map(v => +v.toFixed(4)); scene.userData.frame = Spatial.time.frame; });
Spatial.mount(scene);
