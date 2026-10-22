const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

function body(name, type) {
  const mesh = new S.Mesh(new S.BoxGeometry(0.06, 0.06, 0.06), new S.MeshStandardMaterial());
  mesh.name = name;
  mesh.rigidBody = new S.RigidBody({ type });
  scene.add(mesh);
  return mesh;
}

const base = body("base", "static");
const a = body("a", "dynamic");
const b = body("b", "dynamic");
const c = body("c", "dynamic");
const d = body("d", "dynamic");
const e = body("e", "dynamic");

S.physics.add(new S.Joint({ type: "fixed", bodyA: base, bodyB: a }));
S.physics.add(new S.Joint({
  type: "revolute", bodyA: base, bodyB: b,
  axis: new S.Vector3(0, 0, 1),
  anchorA: new S.Vector3(0, 0.1, 0),
  anchorB: new S.Vector3(0, -0.1, 0),
  limits: [-1, 1],
}));
S.physics.add(new S.Joint({ type: "spherical", bodyA: base, bodyB: c }));
S.physics.add(new S.Joint({ type: "prismatic", bodyA: base, bodyB: d, axis: new S.Vector3(1, 0, 0), limits: [0, 0.5] }));

const removable = new S.Joint({ type: "distance", bodyA: base, bodyB: e, limits: [0.1, 0.3] });
S.physics.add(removable);

let noBodyError = null;
try {
  const loose = new S.Mesh(new S.BoxGeometry(0.05, 0.05, 0.05), new S.MeshBasicMaterial());
  loose.name = "loose";
  scene.add(loose);
  new S.Joint({ type: "fixed", bodyA: base, bodyB: loose });
} catch (error) {
  noBodyError = error.name;
}
base.userData.noBodyError = noBodyError;

S.onFrame(() => {
  if (S.time.frame === 2) S.physics.remove(removable);
});

S.mount(scene);
