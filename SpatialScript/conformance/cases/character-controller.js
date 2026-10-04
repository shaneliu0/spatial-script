const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 14.4: every option is reported back through the dump.
const player = new S.Mesh(new S.CapsuleGeometry(0.2, 1), new S.MeshStandardMaterial());
player.name = "player";
player.characterController = new S.CharacterController({
  radius: 0.3,
  height: 1.8,
  slopeLimit: 0.6,
  stepLimit: 0.4,
  gravity: false,
});
scene.add(player);

// The documented defaults.
const walker = new S.Mesh(new S.CapsuleGeometry(0.2, 1), new S.MeshStandardMaterial());
walker.name = "walker";
walker.characterController = new S.CharacterController();
scene.add(walker);

// Out-of-range options are sanitized, never passed on as given.
const clamped = new S.Group();
clamped.name = "clamped";
clamped.characterController = new S.CharacterController({
  radius: -4,
  height: 0,
  slopeLimit: 12,
  stepLimit: -1,
});
scene.add(clamped);

const ghost = new S.Group();
ghost.name = "ghost";
scene.add(ghost);

let sharedError = null;
try {
  ghost.characterController = player.characterController;
} catch (error) {
  sharedError = error.name;
}

let typeError = null;
try {
  ghost.characterController = { radius: 0.2 };
} catch (error) {
  typeError = error.name;
}

const detached = new S.Group();
detached.name = "detached";
detached.characterController = new S.CharacterController();
detached.characterController = null;
scene.add(detached);

scene.userData.sharedError = sharedError;
scene.userData.typeError = typeError;
scene.userData.onGround = player.characterController.isOnGround;
scene.userData.velocity = player.characterController.velocity.toArray();
scene.userData.ownedByPlayer = player.characterController.object === player;

S.mount(scene);
