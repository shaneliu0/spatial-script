const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
box.name = "box";
scene.add(box);

S.onFrame(() => {
  box.position.x += 0.01;
});

S.onFrame(() => {
  throw new Error("boom from onFrame");
});

box.addEventListener("tap", () => {
  throw new Error("boom from a listener");
});

setTimeout(() => {
  throw new Error("boom from a timer");
}, 10);

S.mount(scene);
