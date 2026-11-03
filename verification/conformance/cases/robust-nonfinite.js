const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial } = Spatial;

const scene = new Scene();

const good = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
good.name = "good";
scene.add(good);

const bad = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
bad.name = "bad";
bad.position.set(0.2, 0, 0);
scene.add(bad);

Spatial.onFrame(() => {
  good.position.x += 0.01;
  const frame = Spatial.time.frame;
  // Non-finite position, then a zero-length quaternion, then valid again.
  if (frame === 2) bad.position.x = NaN;
  if (frame === 4) { bad.position.set(0.3, 0, 0); bad.quaternion.set(0, 0, 0, 0); }
  if (frame === 6) bad.quaternion.set(0, 0, 0, 1);
});

Spatial.mount(scene);
