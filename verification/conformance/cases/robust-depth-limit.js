const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial } = Spatial;

const scene = new Scene();

// A runaway chain must be refused, not allowed to overflow the engine stack.
let node = scene;
let built = 0;
for (let i = 0; i < 2000; i += 1) {
  const g = new Group();
  g.name = "level" + i;
  node.add(g);
  if (g.parent === node) {
    node = g;
    built += 1;
  }
}

// The scene keeps working after the refusal.
const marker = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
marker.name = "marker";
scene.add(marker);

Spatial.onFrame(() => {
  marker.rotation.y += 0.01;
  marker.userData.frame = Spatial.time.frame;
  marker.userData.built = built;
});

Spatial.mount(scene);
