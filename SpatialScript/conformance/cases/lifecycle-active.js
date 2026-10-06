const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
scene.userData.order = [];
scene.userData.frames = 0;

const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
box.name = "box";
scene.add(box);

// While the view is gone nothing advances: no frames, no timers (SPEC 14.10).
setTimeout(() => {
  scene.userData.timerFiredAtFrame = S.time.frame;
}, 60);

S.onFrame(() => {
  scene.userData.frames += 1;
  box.position.x += 0.1;
});

this.didActivate = function didActivate() {
  scene.userData.order.push("didActivate");
  scene.userData.activeInHook = S.isActive;
};

this.willDeactivate = function willDeactivate() {
  scene.userData.order.push("willDeactivate");
  scene.userData.inactiveInHook = S.isActive;
  scene.userData.frameAtDeactivate = S.time.frame;
};

S.mount(scene);
