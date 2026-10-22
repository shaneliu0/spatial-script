const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const probe = new S.Object3D();
probe.name = "probe";
scene.add(probe);

// The camera is an Object3D the script can parent and move (SPEC 14.3).
const rig = new S.Group();
rig.name = "rig";
rig.position.set(0.5, 0, 0);
scene.add(rig);

const camera = new S.PerspectiveCamera(50, 1.5, 0.1, 50);
camera.name = "camera";
camera.position.set(0, 0.25, 3);
rig.add(camera);

probe.userData.beforeAssign = S.camera;
S.camera = camera;
probe.userData.isSameObject = S.camera === camera;
probe.userData.isCamera = camera.isCamera === true;

// The consumer owns the viewport, so a script-set aspect is reported ignored.
camera.aspect = 2.5;

try {
  S.camera = new S.Object3D();
} catch (error) {
  probe.userData.typeError = error.name;
  probe.userData.stillAssigned = S.camera === camera;
}

S.mount(scene);
