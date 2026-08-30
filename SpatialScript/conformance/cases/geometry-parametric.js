const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

function add(name, geometry) {
  const mesh = new S.Mesh(geometry, new S.MeshStandardMaterial());
  mesh.name = name;
  scene.add(mesh);
  return mesh;
}

add("box", new S.BoxGeometry(0.2, 0.3, 0.4));
add("sphere", new S.SphereGeometry(0.15, 16, 12));
add("plane", new S.PlaneGeometry(0.5, 0.25));
add("cylinder", new S.CylinderGeometry(0.1, 0.12, 0.3, 12));
add("cone", new S.ConeGeometry(0.1, 0.3, 12));
add("torus", new S.TorusGeometry(0.2, 0.05, 8, 24));
add("capsule", new S.CapsuleGeometry(0.08, 0.2, 4, 8));
add("circle", new S.CircleGeometry(0.15, 20));
add("ring", new S.RingGeometry(0.08, 0.16, 20));

S.mount(scene);
