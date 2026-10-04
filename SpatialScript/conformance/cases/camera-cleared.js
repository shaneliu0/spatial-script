const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const probe = new S.Object3D();
probe.name = "probe";
probe.userData.seen = [];
scene.add(probe);

const camera = new S.PerspectiveCamera(70, 1, 0.05, 30);
camera.name = "camera";
camera.position.set(0, 1, 2);
scene.add(camera);

S.camera = camera;

// Handing the camera back to the consumer is what `null` means: the built-in
// camera takes over again (SPEC 14.3).
S.onFrame(() => {
  if (S.time.frame === 2) S.camera = null;
  probe.userData.seen.push(S.camera === null ? null : S.camera.name);
});

S.mount(scene);
