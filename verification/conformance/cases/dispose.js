const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
box.name = "box";
scene.add(box);

const child = new S.Mesh(new S.BoxGeometry(0.05, 0.05, 0.05), new S.MeshStandardMaterial());
child.name = "child";
box.add(child);

S.mount(scene);

this.willRemove = function () {
  console.log("willRemove ran");
};
