const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshBasicMaterial({ color: 0x00ff00 }));
box.name = "box";
scene.add(box);

S.onFrame(() => {
  if (S.time.frame === 2) box.material = new S.MeshPhysicalMaterial({ color: 0xff0000, roughness: 0.4 });
});

S.mount(scene);
