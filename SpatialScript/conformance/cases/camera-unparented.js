const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const marker = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
marker.name = "marker";
scene.add(marker);

// SPEC 14.13: the `camera` command names the camera object's own id, so the
// camera has to be an object the consumer knows about. One that was never
// added to the scene becomes an extra root: it is created, and its pose
// travels through `transforms` like any other object's.
const camera = new S.PerspectiveCamera(55, 1, 0.05, 40);
camera.name = "free-camera";
camera.position.set(0, 0.25, 1.4);
camera.lookAt(new S.Vector3(0, 0, 0));
S.camera = camera;

S.onFrame(() => {
  // The dump reports the live value, not the last flushed one.
  marker.userData.kind = S.dump({ objects: false }).camera.kind;
  marker.userData.isSame = S.camera === camera;
});

S.mount(scene);
