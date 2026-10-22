const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const holder = new S.Group();
holder.name = "holder";
holder.userData.rejected = null;
scene.add(holder);

S.mount(scene);

S.loadAsset({ glb: "https://example.com/robot.glb" }).catch((error) => {
  holder.userData.rejected = error.name;
  holder.userData.feature = error.feature;
});
