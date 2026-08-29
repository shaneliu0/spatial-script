const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial } = Spatial;

const scene = new Scene();

const root = new Group();
root.name = "root";
root.position.set(0, 0.1, 0);
scene.add(root);

const child = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
child.name = "child";
child.position.set(0.2, 0, 0);
root.add(child);

const orphan = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshStandardMaterial());
orphan.name = "orphan";
scene.add(orphan);
scene.remove(orphan);

root.userData.found = scene.getObjectByName("child") === child;
root.userData.byId = scene.getObjectById(child.id) === child;

let visited = 0;
scene.traverse(() => { visited += 1; });
root.userData.visited = visited;

Spatial.mount(scene);
