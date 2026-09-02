const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
box.name = "box";
box.userData.events = [];
scene.add(box);

box.addEventListener("hoverenter", () => {
  box.userData.events.push("enter");
  box.hoverEffect = "highlight";
});
box.addEventListener("hoverexit", () => {
  box.userData.events.push("exit");
  box.hoverEffect = null;
});

S.mount(scene);
