const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const a = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
a.name = "a";
a.rigidBody = new S.RigidBody({});
a.userData.hits = 0;
scene.add(a);

const b = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
b.name = "b";
b.rigidBody = new S.RigidBody({ type: "static" });
b.userData.hits = 0;
b.userData.ended = false;
scene.add(b);

a.addEventListener("collisionstart", (event) => {
  a.userData.hits += 1;
  a.userData.other = event.other ? event.other.name : null;
  a.userData.impulse = event.impulse;
  a.userData.normal = event.normal.toArray();
  a.userData.point = event.point.toArray();
});

b.addEventListener("collisionstart", (event) => {
  b.userData.hits += 1;
  b.userData.other = event.other ? event.other.name : null;
  b.userData.target = event.target.name;
});

b.addEventListener("collisionend", () => {
  b.userData.ended = true;
});

S.mount(scene);
