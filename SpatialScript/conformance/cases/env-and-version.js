const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const marker = new S.Group();
marker.name = "marker";
scene.add(marker);
S.mount(scene);

marker.userData.backend = S.env.backend;
marker.userData.platform = S.env.platform;
marker.userData.capabilities = Object.keys(S.env.capabilities).sort();
marker.userData.hasVersion = typeof S.version === "string" && S.version.length > 0;
marker.userData.found = S.find("marker") === marker;
marker.userData.mounted = S.scene === scene;

let badRequire = null;
try {
  require("three");
} catch (error) {
  badRequire = error.name;
}
marker.userData.badRequire = badRequire;
