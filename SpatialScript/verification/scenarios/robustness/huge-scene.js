// 5000 meshes created in one frame, then all destroyed, then 5000 more.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;
const scene = new Scene(); scene.add(new AmbientLight(0xffffff, 1));
const geo = new BoxGeometry(0.01, 0.01, 0.01); const mat = new MeshStandardMaterial({ color: 0x6699ff });
let batch = [];
function spawn(tag) { for (let i = 0; i < 5000; i++) { const m = new Mesh(geo, mat); m.name = `${tag}-${i}`; m.position.set((i % 50) * 0.015 - 0.375, Math.floor(i / 50) * 0.015 - 0.75, 0); scene.add(m); batch.push(m); } }
spawn("first");
Spatial.onFrame(() => {
  const f = Spatial.time.frame;
  if (f === 30) { for (const m of batch) { scene.remove(m); Spatial.destroy(m); } batch = []; }
  if (f === 60) spawn("second");
  scene.userData.frame = f; scene.userData.count = batch.length;
});
Spatial.mount(scene);
