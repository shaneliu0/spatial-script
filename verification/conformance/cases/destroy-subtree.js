const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial } = Spatial;

const scene = new Scene();

const keep = new Group();
keep.name = "keep";
scene.add(keep);

const branch = new Group();
branch.name = "branch";
scene.add(branch);

const leafA = new Mesh(new BoxGeometry(0.08, 0.08, 0.08), new MeshStandardMaterial());
leafA.name = "leafA";
branch.add(leafA);

const leafB = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), new MeshStandardMaterial());
leafB.name = "leafB";
leafA.add(leafB);

keep.userData.reuseError = null;
keep.userData.leafError = null;
keep.userData.sceneError = null;
keep.userData.branchParent = "pending";

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 3) return;

  Spatial.destroy(branch);
  keep.userData.branchParent = branch.parent === null ? "detached" : "still attached";
  keep.userData.foundAfterDestroy = Spatial.find("leafA") === null;

  try {
    scene.add(branch);
  } catch (error) {
    keep.userData.reuseError = error.name + ":" + error.feature;
  }

  try {
    keep.add(leafB);
  } catch (error) {
    keep.userData.leafError = error.name + ":" + error.feature;
  }

  try {
    Spatial.destroy(scene);
  } catch (error) {
    keep.userData.sceneError = error.name + ":" + error.feature;
  }
});

Spatial.mount(scene);
