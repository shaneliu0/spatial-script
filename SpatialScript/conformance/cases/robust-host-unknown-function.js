// Calling a host function no app registered rejects with a
// SpatialUnsupportedError whose feature is "host-function". The rejection
// belongs to the script, so the runtime records no error and the scene keeps
// ticking afterwards.
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial } = Spatial;

const scene = new Scene();

const probe = new Group();
probe.name = "probe";
// Nothing is registered, so this is the empty list the guard would read.
probe.userData.registered = Spatial.host.functions;
probe.userData.settled = "pending";
probe.userData.frames = 0;
scene.add(probe);

const cube = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
cube.name = "cube";
scene.add(cube);

Spatial.mount(scene);

Spatial.host.call("Nothing.here", { value: 1 }).then(
  () => {
    probe.userData.settled = "resolved";
  },
  (error) => {
    probe.userData.settled = "rejected";
    probe.userData.errorName = error.name;
    probe.userData.feature = error.feature;
    probe.userData.isUnsupported = error instanceof Spatial.SpatialUnsupportedError;
    probe.userData.namesTheFunction = error.message.indexOf("Nothing.here") !== -1;
  },
);

// Still running: the frame callback keeps advancing after the rejection.
Spatial.onFrame((deltaTime) => {
  cube.rotation.y += deltaTime;
  probe.userData.frames = Spatial.time.frame;
});
