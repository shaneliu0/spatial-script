// Mount A, then B, then A again within the same load, then swap every 30 frames.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial, AmbientLight } = Spatial;
const a = new Scene(); a.name = "A"; a.add(new AmbientLight(0xffffff, 1)); const ma = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0xff0000 })); ma.name = "a-cube"; a.add(ma);
const b = new Scene(); b.name = "B"; b.add(new AmbientLight(0xffffff, 1)); const mb = new Mesh(new SphereGeometry(0.06), new MeshStandardMaterial({ color: 0x0000ff })); mb.name = "b-sphere"; b.add(mb);
Spatial.mount(a); Spatial.mount(b); Spatial.mount(a);
Spatial.onFrame((dt) => { const f = Spatial.time.frame; if (f % 30 === 0) Spatial.mount(Spatial.scene === a ? b : a); ma.rotation.y += dt; mb.rotation.x += dt; (Spatial.scene).userData.frame = f; });
