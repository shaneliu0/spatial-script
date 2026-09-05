// interaction.js -- hover highlight, drag with script-owned position,
// WASD keyboard movement, and a system-manipulable object.

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
  AmbientLight,
  DirectionalLight,
  Color,
  Vector3,
} = Spatial;

const scene = new Scene();

const ambient = new AmbientLight(0xffffff, 0.4);
ambient.name = "ambient";
scene.add(ambient);

const key = new DirectionalLight(0xffffff, 2.5);
key.name = "key";
key.position.set(0.5, 1, 0.7);
key.castShadow = true;
scene.add(key);

const floor = new Mesh(
  new PlaneGeometry(0.9, 0.9),
  new MeshStandardMaterial({ color: 0x24272c, roughness: 0.95 }),
);
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.22;
floor.receiveShadow = true;
scene.add(floor);

const props = new Group();
props.name = "props";
scene.add(props);

// ------------------------------------------------- hover highlight target

const BASE_COLOR = 0x3b6fd4;
const HOVER_COLOR = 0x7fb0ff;

const hoverBox = new Mesh(
  new BoxGeometry(0.13, 0.13, 0.13),
  new MeshStandardMaterial({ color: BASE_COLOR, roughness: 0.4 }),
);
hoverBox.name = "hoverBox";
hoverBox.position.set(-0.24, 0, 0);
hoverBox.castShadow = true;
props.add(hoverBox);

hoverBox.addEventListener("hoverenter", () => {
  hoverBox.material.color.set(HOVER_COLOR);
  hoverBox.material.emissive.set(0x223355);
  hoverBox.hoverEffect = "highlight";
  hoverBox.scale.setScalar(1.12);
});

hoverBox.addEventListener("tap", () => {
  hoverBox.rotation.y += Math.PI / 8;
});

hoverBox.addEventListener("hoverexit", () => {
  hoverBox.material.color.set(BASE_COLOR);
  hoverBox.material.emissive.set(0x000000);
  hoverBox.hoverEffect = null;
  hoverBox.scale.setScalar(1);
});

// ------------------------------------------------------------ drag target

const dragBall = new Mesh(
  new SphereGeometry(0.075, 28, 20),
  new MeshStandardMaterial({ color: 0xff7744, roughness: 0.3, metalness: 0.3 }),
);
dragBall.name = "dragBall";
dragBall.position.set(0, 0, 0);
dragBall.castShadow = true;
props.add(dragBall);

const dragOrigin = new Vector3();

dragBall.addEventListener("tap", () => {
  dragBall.material.color.copy(new Color().setHSL(Math.random(), 0.6, 0.55));
});

dragBall.addEventListener("dragstart", () => {
  dragOrigin.copy(dragBall.position);
  dragBall.opacity = 0.65;
  console.log("drag started");
});

dragBall.addEventListener("drag", (event) => {
  // The consumer never moves a dragged object; the script owns the position.
  dragBall.position.copy(dragOrigin).add(event.translation);
});

dragBall.addEventListener("dragend", (event) => {
  dragBall.opacity = 1;
  console.log("dragged", event.translation.length().toFixed(3), "metres");
});

// ------------------------------------------------------- keyboard-driven

const rover = new Mesh(
  new BoxGeometry(0.09, 0.05, 0.12),
  new MeshStandardMaterial({ color: 0x44dd99, roughness: 0.5 }),
);
rover.name = "rover";
rover.position.set(0, -0.17, 0.2);
rover.castShadow = true;
props.add(rover);

const SPEED = 0.35;
const BOUND = 0.38;
const velocity = new Vector3();

Spatial.onFrame((deltaTime) => {
  const keyboard = Spatial.input.keyboard;
  velocity.set(0, 0, 0);
  if (keyboard.isDown("KeyW")) velocity.z -= 1;
  if (keyboard.isDown("KeyS")) velocity.z += 1;
  if (keyboard.isDown("KeyA")) velocity.x -= 1;
  if (keyboard.isDown("KeyD")) velocity.x += 1;

  if (velocity.lengthSq() > 0) {
    velocity.normalize().multiplyScalar(SPEED * deltaTime);
    rover.position.add(velocity);
    rover.position.x = Math.max(-BOUND, Math.min(BOUND, rover.position.x));
    rover.position.z = Math.max(-BOUND, Math.min(BOUND, rover.position.z));
    rover.rotation.y = Math.atan2(velocity.x, velocity.z);
  }

  if (keyboard.wasPressed("Space")) {
    rover.material.color.copy(new Color().setHSL(Math.random(), 0.65, 0.55));
    console.log("rover repainted");
  }
});

// ---------------------------------------------------- system manipulation

const ring = new Mesh(
  new TorusGeometry(0.075, 0.022, 16, 40),
  new MeshStandardMaterial({ color: 0xffcc33, metalness: 0.7, roughness: 0.25 }),
);
ring.name = "ring";
ring.position.set(0.24, 0.02, 0);
ring.castShadow = true;
ring.manipulable = true;
props.add(ring);

ring.addEventListener("tap", () => {
  ring.rotation.x += Math.PI / 6;
});

ring.addEventListener("manipulationstart", () => {
  ring.material.emissive.set(0x554400);
  console.log("manipulation started");
});

ring.addEventListener("manipulation", () => {
  ring.userData.manipulating = true;
});

ring.addEventListener("manipulationend", () => {
  ring.material.emissive.set(0x000000);
  ring.userData.manipulating = false;
  console.log("manipulation ended at", ring.position.toArray().map((v) => v.toFixed(3)).join(", "));
});

// Input events bubble, so the group can record whatever the pointer touched.
// A listener on an ancestor does not by itself make a descendant an input
// target: each object that should be hit-testable registers its own listener.
props.addEventListener("tap", (event) => {
  props.userData.lastTapped = event.target.name;
});

Spatial.mount(scene);
