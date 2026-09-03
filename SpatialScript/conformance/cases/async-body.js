const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial } = Spatial;

const scene = new Scene();

const before = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
before.name = "before";
scene.add(before);

const marker = new Group();
marker.name = "marker";
marker.userData.stage = "sync";
scene.add(marker);

Spatial.mount(scene);

// A frame-driven timer has to keep the awaited promise moving.
await new Promise((resolve) => setTimeout(resolve, 20));

marker.userData.stage = "resumed";
marker.userData.frameWhenResumed = Spatial.time.frame > 0;

const after = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshStandardMaterial());
after.name = "after";
after.position.y = 0.2;
scene.add(after);
