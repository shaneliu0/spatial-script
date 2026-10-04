const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const player = new S.Mesh(new S.CapsuleGeometry(0.2, 1), new S.MeshStandardMaterial());
player.name = "player";
player.characterController = new S.CharacterController({ radius: 0.3, height: 1.8 });
scene.add(player);

// SPEC 14.4: the controller is native-driven; syncCharacter carries the
// resolved world position, the ground flag and the velocity back to the script.
S.onFrame(() => {
  const controller = player.characterController;
  scene.userData.onGround = controller.isOnGround;
  scene.userData.velocity = controller.velocity.toArray();
  scene.userData.position = player.position.toArray();
});

S.mount(scene);
