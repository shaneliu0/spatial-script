const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const bad = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshBasicMaterial());
bad.name = "bad";
scene.add(bad);

let caught = null;
try {
  bad.rigidBody = new S.RigidBody({ type: "dynamic", shape: "mesh" });
} catch (error) {
  caught = error.name + ":" + error.feature;
}
bad.userData.caught = caught;

let typeError = null;
try {
  bad.rigidBody = new S.RigidBody({ type: "floaty" });
} catch (error) {
  typeError = error.name;
}
bad.userData.typeError = typeError;

S.mount(scene);
