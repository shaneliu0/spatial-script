const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const probe = new S.Object3D();
probe.name = "probe";
probe.userData.keyboard = [];
probe.userData.mouse = [];
scene.add(probe);

// `connected` is a device fact the consumer reports; it survives frames where
// no new input arrives (SPEC 14.9).
S.onFrame(() => {
  probe.userData.keyboard.push(S.input.keyboard.connected);
  probe.userData.mouse.push(S.input.mouse.connected);
  probe.userData.down = Array.from(S.input.keyboard.down);
  probe.userData.isDown = S.input.keyboard.isDown("KeyA");
  probe.userData.wasPressed = S.input.keyboard.wasPressed("KeyA");
});

S.mount(scene);
