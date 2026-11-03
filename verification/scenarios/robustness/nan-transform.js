// Non-finite and extreme transforms must not reach the consumer or stop the loop.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;
const scene = new Scene(); scene.add(new AmbientLight(0xffffff, 1));
const good = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0x00ff00 })); good.name = "good"; good.position.x = -0.2; scene.add(good);
const bad = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0xff0000 })); bad.name = "bad"; bad.position.x = 0.2; scene.add(bad);
Spatial.onFrame((dt) => {
  good.rotation.y += dt;
  const f = Spatial.time.frame;
  if (f === 10) bad.position.x = NaN;
  if (f === 20) bad.scale.set(0, 0, 0);
  if (f === 30) bad.position.set(Infinity, 0, 0);
  if (f === 40) bad.quaternion.set(0, 0, 0, 0);
  if (f === 50) bad.position.set(1e12, 0, 0);
  if (f === 60) { bad.position.set(0.2, 0, 0); bad.scale.set(1, 1, 1); bad.quaternion.set(0, 0, 0, 1); }
  scene.userData.frame = f;
});
Spatial.mount(scene);
