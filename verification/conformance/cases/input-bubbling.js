const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const group = new S.Group();
group.name = "group";
scene.add(group);

const child = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
child.name = "child";
group.add(child);

const order = [];
child.userData.order = order;

child.addEventListener("tap", (event) => order.push("child/" + event.target.name));
group.addEventListener("tap", (event) => order.push("group/" + event.target.name));
scene.addEventListener("tap", (event) => order.push("scene/" + event.target.name));

S.mount(scene);
