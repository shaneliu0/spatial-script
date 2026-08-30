const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

function add(name, material) {
  const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), material);
  mesh.name = name;
  scene.add(mesh);
  return mesh;
}

add("basic", new S.MeshBasicMaterial({ color: 0x3366ff }));
add("standard", new S.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.25 }));
add("physical", new S.MeshPhysicalMaterial({ color: 0x3366ff, clearcoat: 0.8, clearcoatRoughness: 0.1 }));
add("occluder", new S.OcclusionMaterial());

let arrayError = null;
try {
  add("bad", new S.MeshBasicMaterial()).material = [new S.MeshBasicMaterial()];
} catch (error) {
  arrayError = error.name;
}
scene.getObjectByName("basic").userData.arrayError = arrayError;

S.mount(scene);
