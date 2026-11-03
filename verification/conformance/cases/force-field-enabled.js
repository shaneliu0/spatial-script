const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 14.4: `enabled` toggles a field without removing it from the scene.
const brake = new S.DragForceField({ coefficient: 0.5, radius: 4 });
brake.name = "brake";
scene.add(brake);

const asleep = new S.ConstantForceField({ force: new S.Vector3(1, 0, 0), enabled: false });
asleep.name = "asleep";
scene.add(asleep);

S.onFrame(() => {
  if (S.time.frame === 2) brake.enabled = false;
  if (S.time.frame === 3) {
    brake.radius = 8;
    brake.mask = 2;
  }
  if (S.time.frame === 4) {
    asleep.enabled = true;
    scene.userData.woken = asleep.enabled;
    scene.userData.disabled = brake.enabled;
  }
});

S.mount(scene);
