const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshBasicMaterial } = Spatial;

const scene = new Scene();
const keep = new Group();
keep.name = "keep";
scene.add(keep);

const temp = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
temp.name = "temp";
scene.add(temp);

Spatial.onFrame(() => {
  if (Spatial.time.frame === 2) temp.removeFromParent();
});

Spatial.mount(scene);
