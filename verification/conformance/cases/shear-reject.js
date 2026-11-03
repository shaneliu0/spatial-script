const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshBasicMaterial } = Spatial;

const scene = new Scene();

const sheared = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
sheared.name = "sheared";
scene.add(sheared);

// A neighbour that must keep updating even though its sibling is rejected.
const healthy = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
healthy.name = "healthy";
scene.add(healthy);

// matrixAutoUpdate off keeps the sheared matrix in place every frame, so the
// rejection has to stay reported exactly once.
sheared.matrixAutoUpdate = false;
sheared.matrix.set(
  1, 0.5, 0, -0.2,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
);

Spatial.onFrame(() => {
  healthy.position.x += 0.01;
  healthy.userData.frames = Spatial.time.frame;
});

Spatial.mount(scene);
