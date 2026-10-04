// On visionOS the user is the camera. Assigning Spatial.camera is accepted and
// reported in the dump, but it warns once that it moves nothing, and the
// pointer query rayFromPoint is null there rather than a guess.
const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  MeshStandardMaterial,
  PerspectiveCamera,
} = Spatial;

const scene = new Scene();

const probe = new Group();
probe.name = "probe";
scene.add(probe);

const cube = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial());
cube.name = "cube";
scene.add(cube);

const eye = new PerspectiveCamera(50, 1, 0.01, 20);
eye.name = "eye";
eye.position.set(0, 0.3, 1.2);

probe.userData.before = Spatial.camera;
Spatial.camera = eye;
probe.userData.assigned = Spatial.camera === eye;

// The capability says the plain truth: the consumer keeps the state but the
// feature has no effect here.
probe.userData.cameraCapability = Spatial.env.capabilities.camera;

// Null on visionOS, for any pixel, whether or not the consumer has the hook.
probe.userData.ray = Spatial.rayFromPoint(120, 80);
probe.userData.rayIsNull = Spatial.rayFromPoint(0, 0) === null;

// There is no pointer either, so the world point under it is null too.
probe.userData.scenePosition = Spatial.input.mouse.scenePosition;

Spatial.mount(scene);
