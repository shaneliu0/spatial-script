const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const holder = new S.Group();
holder.name = "holder";
scene.add(holder);

S.mount(scene);

S.loadAsset({ usdz: "asset://robot.usdz", glb: "https://example.com/robot.glb" }).then((asset) => {
  asset.name = "robot";
  holder.add(asset);
  asset.playAnimation("walk", { loop: true, speed: 1.5 });
  holder.userData.animations = asset.animations.slice();
  holder.userData.bounds = [asset.boundingBox.min.toArray(), asset.boundingBox.max.toArray()];
  holder.userData.loaded = asset.loaded;
});
