// character.js -- a keyboard-driven CharacterController walking a small
// arena, with a radial field that pushes loose bodies away from the centre
// and a drag field that keeps them from flying off.
//
// Everything sits within about 0.4 m of the origin so it fills the Mac window
// with the camera roughly 1 m away. WASD walks, Space jumps.
//
// A character controller is native-driven: the script asks for a displacement
// and the consumer resolves it against the world, sliding along walls and
// climbing steps, then reports the result back. Nothing here writes the
// character's position directly except the one deliberate teleport.

const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  SphereGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  TorusGeometry,
  MeshStandardMaterial,
  AmbientLight,
  DirectionalLight,
  RigidBody,
  CharacterController,
  RadialForceField,
  DragForceField,
  Vector3,
} = Spatial;

const scene = new Scene();

const ambient = new AmbientLight(0xffffff, 0.4);
ambient.name = "ambient";
scene.add(ambient);

const sun = new DirectionalLight(0xfff6ec, 2.6);
sun.name = "sun";
sun.position.set(0.5, 1.2, 0.6);
sun.castShadow = true;
scene.add(sun);

Spatial.physics.gravity.set(0, -9.81, 0);

// ------------------------------------------------------------------- arena

const ground = new Mesh(
  new BoxGeometry(0.8, 0.02, 0.8),
  new MeshStandardMaterial({ color: 0x2c3138, roughness: 0.95 }),
);
ground.name = "ground";
ground.position.set(0, -0.26, 0);
ground.receiveShadow = true;
ground.rigidBody = new RigidBody({ type: "static", shape: "box", friction: 0.9 });
scene.add(ground);

// A low step, so `stepLimit` has something to prove: the controller climbs it
// without a jump, and refuses anything taller.
const step = new Mesh(
  new BoxGeometry(0.26, 0.05, 0.14),
  new MeshStandardMaterial({ color: 0x3a4049, roughness: 0.9 }),
);
step.name = "step";
step.position.set(0.22, -0.225, -0.2);
step.receiveShadow = true;
step.castShadow = true;
step.rigidBody = new RigidBody({ type: "static", shape: "box", friction: 0.9 });
scene.add(step);

// ---------------------------------------------------------------- character

const walker = new Mesh(
  new CapsuleGeometry(0.035, 0.09, 6, 14),
  new MeshStandardMaterial({ color: 0x5aa9ff, roughness: 0.4, metalness: 0.1 }),
);
walker.name = "walker";
walker.position.set(-0.2, -0.16, 0.18);
walker.castShadow = true;

// The capsule the consumer collides with, not the mesh: they are given the
// same size here so what is drawn is what is simulated.
walker.characterController = new CharacterController({
  radius: 0.035,
  height: 0.16,
  // Radians, like every other angle in the namespace: about 40 degrees.
  slopeLimit: 0.7,
  stepLimit: 0.06,
  gravity: true,
});

// A nose, so the facing the script computes is visible.
const nose = new Mesh(
  new BoxGeometry(0.018, 0.018, 0.04),
  new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }),
);
nose.name = "nose";
nose.position.set(0, 0.02, -0.045);
walker.add(nose);

scene.add(walker);

// ------------------------------------------------------------ loose bodies

const debris = new Group();
debris.name = "debris";
scene.add(debris);

function crate(name, position, color) {
  const mesh = new Mesh(
    new SphereGeometry(0.03, 20, 14),
    new MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.3 }),
  );
  mesh.name = name;
  mesh.position.copy(position);
  mesh.castShadow = true;
  mesh.rigidBody = new RigidBody({
    type: "dynamic",
    shape: "sphere",
    mass: 0.25,
    restitution: 0.4,
    friction: 0.5,
  });
  debris.add(mesh);
  return mesh;
}

crate("pebbleA", new Vector3(0.08, -0.02, 0.06), 0xff8855);
crate("pebbleB", new Vector3(-0.06, 0.04, -0.05), 0xffd166);
crate("pebbleC", new Vector3(0.02, 0.1, 0.12), 0x9b7bff);
crate("pebbleD", new Vector3(-0.12, 0.02, 0.1), 0x62d99a);

// ------------------------------------------------------------ force fields

// Force effects are Object3Ds: they act on dynamic bodies within `radius` of
// their own world position, so parenting one to a moving object carries the
// effect along with it.

// A repeller at the middle of the arena. inverseSquare falls off fast, and
// `minimumDistance` is what stops the force going to infinity at the centre.
const repeller = new RadialForceField({
  strength: 0.6,
  minimumDistance: 0.04,
  falloff: "inverseSquare",
  radius: 0.3,
});
repeller.name = "repeller";
repeller.position.set(0, -0.1, 0);
scene.add(repeller);

// A wider, gentler drag so the pebbles settle instead of rattling forever.
const molasses = new DragForceField({ coefficient: 1.6, radius: 0.45 });
molasses.name = "molasses";
molasses.position.set(0, -0.1, 0);
scene.add(molasses);

// Something to see where the repeller is.
const marker = new Mesh(
  new TorusGeometry(0.06, 0.006, 10, 30),
  new MeshStandardMaterial({ color: 0xff5577, emissive: 0x330011, roughness: 0.4 }),
);
marker.name = "marker";
marker.position.copy(repeller.position);
marker.rotation.x = -Math.PI / 2;
scene.add(marker);

// A plinth the walker can be sent back to.
const home = new Mesh(
  new CylinderGeometry(0.05, 0.05, 0.012, 20),
  new MeshStandardMaterial({ color: 0x445066, roughness: 0.8 }),
);
home.name = "home";
home.position.set(-0.2, -0.244, 0.18);
home.receiveShadow = true;
scene.add(home);

// ------------------------------------------------------------------- input

const WALK_SPEED = 0.5;
const JUMP_SPEED = 1.4;
const HOME = new Vector3(-0.2, -0.16, 0.18);

const displacement = new Vector3();
let verticalSpeed = 0;

Spatial.onFrame((deltaTime) => {
  const keyboard = Spatial.input.keyboard;
  const controller = walker.characterController;

  displacement.set(0, 0, 0);
  if (keyboard.isDown("KeyW")) displacement.z -= 1;
  if (keyboard.isDown("KeyS")) displacement.z += 1;
  if (keyboard.isDown("KeyA")) displacement.x -= 1;
  if (keyboard.isDown("KeyD")) displacement.x += 1;

  if (displacement.lengthSq() > 0) {
    displacement.normalize().multiplyScalar(WALK_SPEED * deltaTime);
    // Face the way the walk is going; the controller never rotates anything.
    walker.rotation.y = Math.atan2(displacement.x, displacement.z);
  }

  // `isOnGround` is reported by the consumer after it resolves the move, so
  // it is the ground truth for whether a jump is allowed.
  if (controller.isOnGround) {
    verticalSpeed = keyboard.wasPressed("Space") ? JUMP_SPEED : 0;
  } else {
    verticalSpeed -= 9.81 * deltaTime;
  }
  displacement.y = verticalSpeed * deltaTime;

  // One move per frame: the consumer applies it on the next step, sliding it
  // along whatever it runs into. A move made before the consumer has seen the
  // object waits for the frame after its create rather than being lost.
  controller.move(displacement);

  // Teleport ignores collision entirely, which is what makes it the right
  // tool for a respawn and the wrong one for walking.
  if (keyboard.wasPressed("KeyR")) {
    controller.teleport(HOME);
    verticalSpeed = 0;
    console.log("walker sent home");
  }

  // The repeller pulses, so the pebbles keep moving without any script force.
  repeller.strength = 0.6 + Math.sin(Spatial.time.elapsed * 1.2) * 0.35;
  marker.scale.setScalar(1 + Math.sin(Spatial.time.elapsed * 1.2) * 0.08);

  // Toggling a field is one flag; the consumer drops the effect entirely.
  if (keyboard.wasPressed("KeyF")) {
    molasses.enabled = !molasses.enabled;
    console.log("drag field", molasses.enabled ? "on" : "off");
  }
});

Spatial.mount(scene);
