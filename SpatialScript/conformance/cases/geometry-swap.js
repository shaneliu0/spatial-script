const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const shape = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
shape.name = "shape";
scene.add(shape);

S.onFrame(() => {
  if (S.time.frame === 2) shape.geometry = new S.SphereGeometry(0.12, 20, 16);
});

S.mount(scene);
