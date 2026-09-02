const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial({ color: 0x00ff00 }));
box.name = "box";
box.position.set(0.1, 0, 0);
box.userData.taps = 0;
scene.add(box);

const quiet = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
quiet.name = "quiet";
scene.add(quiet);

function onTap(event) {
  box.userData.taps += 1;
  box.userData.point = event.point.toArray();
  box.userData.targetName = event.target.name;
  box.userData.eventType = event.type;
  box.material.color.set(0xff0000);
}
box.addEventListener("tap", onTap);
box.userData.hasListener = box.hasEventListener("tap", onTap);

S.mount(scene);
