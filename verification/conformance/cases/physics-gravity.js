const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const marker = new S.Group();
marker.name = "marker";
scene.add(marker);

S.physics.gravity.set(0, -1.62, 0);
marker.userData.moon = S.physics.gravity.toArray();

S.onFrame(() => {
  if (S.time.frame === 2) S.physics.gravity = new S.Vector3(0, -3, 0.5);
});

S.mount(scene);
