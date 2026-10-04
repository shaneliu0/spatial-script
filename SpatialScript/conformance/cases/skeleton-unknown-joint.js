const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 14.5: a name the asset has no joint or blend shape for is ignored with
// a warning, never an error.
S.loadAsset({ usdz: "robot.usdz", glb: "robot.glb" }).then((asset) => {
  asset.name = "robot";
  scene.add(asset);

  asset.skeleton.setJointRotation("tail", new S.Quaternion(0, 0, 0, 1));
  asset.skeleton.setJointPosition("tail", new S.Vector3(1, 1, 1));
  asset.blendShapes.set("frown", 1);

  scene.userData.tail = asset.skeleton.getJointTransform("tail");
  scene.userData.frown = asset.blendShapes.get("frown");

  // A real joint still poses, and reset() drops every script pose.
  asset.skeleton.setJointRotation("head", new S.Quaternion(0, 0, 0.3827, 0.9239));
  scene.userData.posedHead = asset.skeleton.getJointTransform("head").quaternion.toArray();
  asset.skeleton.reset();
  scene.userData.afterReset = asset.skeleton.getJointTransform("head");
  scene.userData.joints = asset.skeleton.joints;
});

S.mount(scene);
