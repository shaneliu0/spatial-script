// Removing and destroying objects from inside listeners and frame callbacks while iterating.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;
const scene = new Scene(); scene.add(new AmbientLight(0xffffff, 1));
const items = [];
for (let i = 0; i < 20; i++) { const m = new Mesh(new BoxGeometry(0.04, 0.04, 0.04), new MeshStandardMaterial({ color: 0x33ff33 })); m.name = `item-${i}`; m.position.x = -0.4 + i * 0.04; scene.add(m); items.push(m);
  m.addEventListener("tap", () => { scene.remove(m); Spatial.destroy(m); }); }
Spatial.onFrame(() => {
  const f = Spatial.time.frame;
  if (f === 10) scene.traverse((o) => { if (o.name === "item-3" || o.name === "item-4") { o.removeFromParent(); Spatial.destroy(o); } });
  if (f === 20) for (const o of scene.children) if (o.name === "item-7") { scene.remove(o); }
  if (f === 30) Spatial.inject.tap("item-9");
  if (f === 40) { const cb = () => { Spatial.offFrame(cb); scene.userData.selfRemoved = true; }; Spatial.onFrame(cb); }
  scene.userData.frame = f; scene.userData.remaining = scene.children.length - 1;
});
Spatial.mount(scene);
