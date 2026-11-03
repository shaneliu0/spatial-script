const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
box.name = "box";
box.userData.events = [];
scene.add(box);

box.addEventListener("dragstart", (event) => {
  box.userData.origin = box.position.toArray();
  box.userData.startTranslation = event.translation.toArray();
  box.userData.events.push("dragstart");
});
box.addEventListener("drag", (event) => {
  box.userData.events.push("drag");
  box.position.set(
    box.userData.origin[0] + event.translation.x,
    box.userData.origin[1] + event.translation.y,
    box.userData.origin[2] + event.translation.z,
  );
});
box.addEventListener("dragend", (event) => {
  box.userData.events.push("dragend");
  box.userData.total = event.translation.toArray();
  box.userData.endPoint = event.point.toArray();
});

S.mount(scene);
