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

// SPEC 14.12: a mesh may carry one material per geometry group.
const multi = add("multi", new S.MeshBasicMaterial({ color: 0xff0000 }));
multi.geometry.clearGroups();
multi.geometry.addGroup(0, 18, 0);
multi.geometry.addGroup(18, 18, 1);
multi.material = [
  new S.MeshBasicMaterial({ color: 0xff0000 }),
  new S.MeshStandardMaterial({ color: 0x00ff00 }),
];
scene.getObjectByName("basic").userData.materialCount = multi.material.length;

S.mount(scene);
