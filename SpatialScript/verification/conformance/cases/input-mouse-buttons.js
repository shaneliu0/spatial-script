const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const probe = new S.Object3D();
probe.name = "probe";
probe.userData.left = [];
probe.userData.right = [];
probe.userData.middle = [];
probe.userData.legacy = [];
scene.add(probe);

function record(button) {
  return [button.down, button.pressed, button.released, button.value, button.pressCount];
}

// Per-button edges and the click count are computed by the core, so every
// backend reports the same pressed/released frame (SPEC 14.9).
S.onFrame(() => {
  const mouse = S.input.mouse;
  probe.userData.left.push(record(mouse.left));
  probe.userData.right.push(record(mouse.right));
  probe.userData.middle.push(record(mouse.middle));
  probe.userData.legacy.push([mouse.buttons.left, mouse.buttons.right, mouse.buttons.middle]);
});

S.mount(scene);
