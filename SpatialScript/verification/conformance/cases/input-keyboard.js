const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const mover = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
mover.name = "mover";
mover.userData.pressedFrames = 0;
scene.add(mover);

S.onFrame(() => {
  if (S.input.keyboard.isDown("KeyW")) mover.position.z -= 0.05;
  if (S.input.keyboard.wasPressed("KeyW")) mover.userData.pressedFrames += 1;
  mover.userData.space = S.input.keyboard.isDown("Space");
  mover.userData.wDown = mover.userData.wDown || [];
  mover.userData.wDown.push(S.input.keyboard.isDown("KeyW"));
  mover.userData.mouse = S.input.mouse.position === null ? null : S.input.mouse.position.toArray();
  mover.userData.buttons = [S.input.mouse.buttons.left, S.input.mouse.buttons.right, S.input.mouse.buttons.middle];
  mover.userData.hands = [S.input.hands.left === null, S.input.hands.right === null];
});

S.mount(scene);
