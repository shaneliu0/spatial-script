const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const marker = new S.Group();
marker.name = "marker";
scene.add(marker);

S.environment = new S.ImageBasedLight("asset://studio.exr", 1.5);

let badEnvironment = null;
try {
  S.environment = "studio";
} catch (error) {
  badEnvironment = error.name;
}
marker.userData.badEnvironment = badEnvironment;

let sceneBackground = null;
try {
  scene.background = new S.Color(0xff0000);
} catch (error) {
  sceneBackground = error.name;
}
marker.userData.sceneBackground = sceneBackground;

S.mount(scene);
