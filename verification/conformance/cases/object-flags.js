const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const flagged = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
flagged.name = "flagged";
flagged.opacity = 0.4;
flagged.billboard = true;
flagged.groundingShadow = true;
flagged.hoverEffect = "highlight";
flagged.manipulable = true;
flagged.renderOrder = 3;
flagged.castShadow = true;
flagged.receiveShadow = true;
scene.add(flagged);

const hidden = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
hidden.name = "hidden";
hidden.visible = false;
scene.add(hidden);

const plain = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
plain.name = "plain";
scene.add(plain);

const copy = flagged.clone();
copy.name = "copy";
copy.position.set(0.3, 0, 0);
scene.add(copy);

S.mount(scene);
