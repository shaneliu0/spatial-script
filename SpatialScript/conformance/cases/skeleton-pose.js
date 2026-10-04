const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 14.5: the rig only exists once the consumer has reported what the
// asset actually carries.
S.loadAsset({ usdz: "robot.usdz", glb: "robot.glb" }).then((asset) => {
  asset.name = "robot";
  scene.add(asset);
  scene.userData.joints = asset.skeleton.joints;
  scene.userData.shapes = asset.blendShapes.names;

  asset.skeleton.setJointRotation("head", new S.Quaternion(0, 0.7071, 0, 0.7071));
  asset.skeleton.setJointPosition("root", new S.Vector3(0, 0.1, 0));

  const head = asset.skeleton.getJointTransform("head");
  scene.userData.headRotation = head === null ? null : head.quaternion.toArray();
  scene.userData.headPosition = head === null ? null : head.position.toArray();
  scene.userData.unknown = asset.skeleton.getJointTransform("tail");
  scene.userData.tracking = asset.skeleton.tracking;
});

S.mount(scene);
