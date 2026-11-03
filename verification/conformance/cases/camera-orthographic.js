const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const probe = new S.Object3D();
probe.name = "probe";
scene.add(probe);

const camera = new S.OrthographicCamera(-1, 1, 0.75, -0.75, 0.1, 20);
camera.name = "camera";
camera.position.set(0, 0, 4);
// An Object3D the script can aim: from straight down +Z this is the identity.
camera.lookAt(new S.Vector3(0, 0, 0));
scene.add(camera);

S.camera = camera;

probe.userData.frustum = [camera.left, camera.right, camera.top, camera.bottom];
probe.userData.clip = [camera.near, camera.far];
probe.userData.isOrthographic = camera.isOrthographicCamera === true;
probe.userData.hasFov = camera.fov === undefined;

S.mount(scene);
