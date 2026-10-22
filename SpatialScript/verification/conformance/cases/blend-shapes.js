const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 14.5: an asset with blend shapes but no rig has a null skeleton.
S.loadAsset({ usdz: "robot.usdz", glb: "robot.glb" }).then((asset) => {
  asset.name = "robot";
  scene.add(asset);

  scene.userData.names = asset.blendShapes.names;
  scene.userData.before = asset.blendShapes.get("smile");

  asset.blendShapes.set("smile", 0.75);
  // Weights outside 0..1 are clamped rather than refused.
  asset.blendShapes.set("blink", 1.5);
  asset.blendShapes.set("frown", -1);

  scene.userData.smile = asset.blendShapes.get("smile");
  scene.userData.blink = asset.blendShapes.get("blink");
  scene.userData.frown = asset.blendShapes.get("frown");
  scene.userData.noSkeleton = asset.skeleton === null;
  scene.userData.chained = asset.blendShapes.set("smile", 0.75) === asset.blendShapes;
});

S.mount(scene);
