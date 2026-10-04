const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

let robot = null;

// SPEC 14.5: track(true) asks the consumer to report the rig's real joint
// transforms, which then win over anything the script posed.
S.loadAsset({ usdz: "robot.usdz", glb: "robot.glb" }).then((asset) => {
  robot = asset;
  asset.name = "robot";
  scene.add(asset);
  asset.skeleton.track(true);
  asset.skeleton.setJointRotation("head", new S.Quaternion(0, 0, 0, 1));
});

S.onFrame(() => {
  if (robot === null || robot.skeleton === null) return;
  const head = robot.skeleton.getJointTransform("head");
  scene.userData.head = head === null ? null : head.position.toArray();
  scene.userData.headRotation = head === null ? null : head.quaternion.toArray();
  scene.userData.tracking = robot.skeleton.tracking;
});

S.mount(scene);
