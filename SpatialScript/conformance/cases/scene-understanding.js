const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const marker = new S.Group();
marker.name = "marker";
scene.add(marker);

// SPEC 14.7: the flags are kept and reported everywhere; only visionOS acts
// on them.
S.sceneUnderstanding = { collision: true, physics: true };
marker.userData.afterFirst = [
  S.sceneUnderstanding.collision,
  S.sceneUnderstanding.occlusion,
  S.sceneUnderstanding.physics,
  S.sceneUnderstanding.shadows,
];

S.sceneUnderstanding = null;
marker.userData.afterNull = [
  S.sceneUnderstanding.collision,
  S.sceneUnderstanding.physics,
];

S.sceneUnderstanding = { collision: true, occlusion: true };

let typeError = null;
try {
  S.sceneUnderstanding = 5;
} catch (error) {
  typeError = error.name;
}

marker.userData.typeError = typeError;
marker.userData.capability = S.env.capabilities.sceneUnderstanding;

S.mount(scene);
