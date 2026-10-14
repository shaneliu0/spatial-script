// camera.js -- a script-owned PerspectiveCamera that orbits and looks at the
// scene, a tap that swaps it for an orthographic one, and the two pointer
// queries that only some consumers can answer.
//
// Everything sits within about 0.4 m of the origin so it fills the Mac window
// with the camera roughly 1 m away.
//
// On visionOS the user is the camera: the assignment below is accepted and
// reported, but it warns once and moves nothing, and Spatial.rayFromPoint is
// null there. Both are read defensively so one script runs on every consumer.

const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  SphereGeometry,
  TorusGeometry,
  PlaneGeometry,
  MeshStandardMaterial,
  MeshBasicMaterial,
  AmbientLight,
  DirectionalLight,
  PerspectiveCamera,
  OrthographicCamera,
  Vector3,
} = Spatial;

const scene = new Scene();

const ambient = new AmbientLight(0xffffff, 0.4);
ambient.name = "ambient";
scene.add(ambient);

const sun = new DirectionalLight(0xffffff, 2.6);
sun.name = "sun";
sun.position.set(0.5, 1.2, 0.7);
sun.castShadow = true;
scene.add(sun);

const floor = new Mesh(
  new PlaneGeometry(0.9, 0.9),
  new MeshStandardMaterial({ color: 0x23262b, roughness: 0.95 }),
);
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.22;
floor.receiveShadow = true;
scene.add(floor);

// ------------------------------------------------------------- what to see

const props = new Group();
props.name = "props";
scene.add(props);

const pillar = new Mesh(
  new BoxGeometry(0.1, 0.24, 0.1),
  new MeshStandardMaterial({ color: 0x3a6fd8, roughness: 0.4 }),
);
pillar.name = "pillar";
pillar.position.set(-0.16, -0.1, 0);
pillar.castShadow = true;
props.add(pillar);

const ball = new Mesh(
  new SphereGeometry(0.07, 30, 22),
  new MeshStandardMaterial({ color: 0xffaa33, roughness: 0.25, metalness: 0.5 }),
);
ball.name = "ball";
ball.position.set(0.16, -0.08, 0.04);
ball.castShadow = true;
props.add(ball);

const ring = new Mesh(
  new TorusGeometry(0.07, 0.014, 14, 36),
  new MeshStandardMaterial({ color: 0x44dd99, roughness: 0.35, metalness: 0.3 }),
);
ring.name = "ring";
ring.position.set(0, 0.06, -0.12);
ring.castShadow = true;
props.add(ring);

// ---------------------------------------------------------------- cameras

// The default is the consumer's own camera, at (0, 0.25, 1.4) looking at the
// origin with a 60 degree vertical field of view. This one starts in the same
// place so the swap is not a jump cut.
const eye = new PerspectiveCamera(55, 1, 0.01, 20);
eye.name = "eye";
eye.position.set(0, 0.25, 1.0);
eye.lookAt(0, 0, 0);

// `aspect` belongs to the consumer: it owns the viewport and overwrites
// whatever a script sets, with a warning. The value above is only what three
// needs for its own projection matrix until the first viewport report.
Spatial.camera = eye;

// A second camera, so the tap below has something to swap to. Half a metre
// across at the origin frames the props without any perspective.
const flat = new OrthographicCamera(-0.3, 0.3, 0.3, -0.3, 0.01, 20);
flat.name = "flat";
flat.position.set(0, 0.6, 0.001);
flat.lookAt(0, 0, 0);

let orthographic = false;

ring.addEventListener("tap", () => {
  orthographic = !orthographic;
  // Assigning null would hand the view back to the consumer's built-in
  // camera; assigning a camera takes it over again.
  Spatial.camera = orthographic ? flat : eye;
  console.log("camera is now", orthographic ? "orthographic" : "perspective");
});

// -------------------------------------------------------- pointer markers

// Where the pointer meets the scene, when the consumer can tell us.
const cursor = new Mesh(
  new SphereGeometry(0.014, 16, 12),
  new MeshBasicMaterial({ color: 0xff4477 }),
);
cursor.name = "cursor";
cursor.visible = false;
scene.add(cursor);

// A point 0.6 m down the ray through the middle of the viewport.
const aim = new Mesh(
  new BoxGeometry(0.02, 0.02, 0.02),
  new MeshBasicMaterial({ color: 0x66ddff }),
);
aim.name = "aim";
aim.visible = false;
scene.add(aim);

const AIM_DISTANCE = 0.6;
const target = new Vector3();

// ------------------------------------------------------------------ frame

const ORBIT_RADIUS = 1.0;

Spatial.onFrame((deltaTime, elapsed) => {
  ring.rotation.z += deltaTime * 0.9;
  ball.position.y = -0.08 + Math.sin(elapsed * 1.6) * 0.03;

  // The camera is an Object3D like any other: move it, parent it, look at
  // something with it. Only the active camera reaches the consumer.
  const angle = elapsed * 0.25;
  eye.position.set(
    Math.sin(angle) * ORBIT_RADIUS,
    0.25 + Math.sin(elapsed * 0.4) * 0.12,
    Math.cos(angle) * ORBIT_RADIUS,
  );
  // Follow the ball rather than the origin, so lookAt does visible work.
  ball.getWorldPosition(target);
  eye.lookAt(target);

  // scenePosition is the world point under the pointer: the first hit mesh,
  // or the plane through the origin facing the camera when nothing is hit.
  // It is null whenever the consumer has no pointer to report -- a headset,
  // a pointer that has left the window -- so it is never assumed.
  const underPointer = Spatial.input.mouse.scenePosition;
  if (underPointer === null) {
    cursor.visible = false;
  } else {
    cursor.visible = true;
    cursor.position.copy(underPointer);
  }

  // rayFromPoint takes view pixels and answers in world space. It returns
  // null on visionOS and on any consumer without the hook, so the marker is
  // simply hidden rather than parked at the origin.
  const pointer = Spatial.input.mouse.position;
  const ray = pointer === null ? null : Spatial.rayFromPoint(pointer.x, pointer.y);
  if (ray === null) {
    aim.visible = false;
  } else {
    aim.visible = true;
    aim.position.copy(ray.origin).addScaledVector(ray.direction, AIM_DISTANCE);
  }
});

Spatial.mount(scene);
