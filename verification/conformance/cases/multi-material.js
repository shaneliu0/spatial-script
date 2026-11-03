const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 14.12: geometry groups select one material per index range.
const geometry = new S.BoxGeometry(0.2, 0.2, 0.2);
geometry.clearGroups();
geometry.addGroup(0, 18, 0);
geometry.addGroup(18, 18, 1);

const red = new S.MeshStandardMaterial({ color: 0xff0000, roughness: 0.3 });
const blue = new S.MeshStandardMaterial({ color: 0x0000ff, metalness: 0.8 });

const mesh = new S.Mesh(geometry, [red, blue]);
mesh.name = "two-tone";
scene.add(mesh);

// The common case stays a single material.
const single = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial({ color: 0x00ff00 }));
single.name = "single";
scene.add(single);

// SPEC 14.12, both mismatch directions. More materials than the groups ask
// for: the extras can never be drawn, so they are reported and left off.
const extraGeometry = new S.BoxGeometry(0.1, 0.1, 0.1);
extraGeometry.clearGroups();
extraGeometry.addGroup(0, 18, 0);
extraGeometry.addGroup(18, 18, 1);
const tooMany = new S.Mesh(extraGeometry, [
  new S.MeshStandardMaterial({ color: 0xff0000 }),
  new S.MeshStandardMaterial({ color: 0x00ff00 }),
  new S.MeshBasicMaterial({ color: 0x0000ff }),
]);
tooMany.name = "too-many";
scene.add(tooMany);

// Fewer materials than the groups ask for: the last one covers the rest, so
// every group still resolves to a material on every backend.
const shortGeometry = new S.BoxGeometry(0.1, 0.1, 0.1);
shortGeometry.clearGroups();
shortGeometry.addGroup(0, 12, 0);
shortGeometry.addGroup(12, 12, 1);
shortGeometry.addGroup(24, 12, 2);
const tooFew = new S.Mesh(shortGeometry, [new S.MeshStandardMaterial({ color: 0x336699 })]);
tooFew.name = "too-few";
scene.add(tooFew);

S.onFrame(() => {
  if (S.time.frame === 2) mesh.material[1].color.set(0x00ff00);
  scene.userData.warnings = S.dump({ objects: false }).warnings.filter((warning) =>
    /geometry groups/.test(warning),
  ).length;
});

scene.userData.count = mesh.material.length;
scene.userData.isArray = Array.isArray(mesh.material);
scene.userData.singleIsArray = Array.isArray(single.material);
scene.userData.groups = geometry.groups.map((group) => [
  group.start,
  group.count,
  group.materialIndex,
]);

S.mount(scene);
