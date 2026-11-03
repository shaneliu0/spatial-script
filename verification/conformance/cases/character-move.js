const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const holder = new S.Group();
holder.name = "holder";
holder.position.set(0.5, 0, 0);
scene.add(holder);

const player = new S.Mesh(new S.CapsuleGeometry(0.2, 1), new S.MeshStandardMaterial());
player.name = "player";
player.characterController = new S.CharacterController({ radius: 0.25, height: 1.6 });
holder.add(player);

// SPEC 14.4: move() asks the consumer for a displacement and moves nothing on
// its own; teleport() is unconditional and lands on the object right away.
S.onFrame(() => {
  if (S.time.frame === 2) {
    player.characterController.move(new S.Vector3(0.1, 0, -0.2));
    scene.userData.afterMove = player.position.toArray();
  }
  if (S.time.frame === 3) {
    player.characterController.teleport(new S.Vector3(1, 0.9, 1));
    scene.userData.afterTeleport = player.position.toArray();
  }
});

let moveError = null;
try {
  player.characterController.move("forward");
} catch (error) {
  moveError = error.name;
}

let teleportError = null;
try {
  player.characterController.teleport(null);
} catch (error) {
  teleportError = error.name;
}

scene.userData.moveError = moveError;
scene.userData.teleportError = teleportError;
scene.userData.chained =
  player.characterController.move(new S.Vector3(0, 0, 0)) === player.characterController;

S.mount(scene);
