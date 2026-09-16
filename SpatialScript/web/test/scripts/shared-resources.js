const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
const geometry = new S.BoxGeometry(0.08, 0.08, 0.08);
const material = new S.MeshStandardMaterial({ color: 0x33aaff, roughness: 0.4 });
for (let i = 0; i < 200; i++) {
  const m = new S.Mesh(geometry, material);
  m.name = "m" + i;
  m.position.set((i % 20) * 0.02 - 0.2, Math.floor(i / 20) * 0.02 - 0.1, 0);
  scene.add(m);
}
S.onFrame((dt, t) => { if (S.time.frame === 30) material.color.set(0xff3300); });
S.mount(scene);
