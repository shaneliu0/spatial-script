const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// The consumer performs the request and answers through `fetchResult`
// (SPEC 14.11). Relative urls follow the 3.5 rules.
S.fetchText("data/notes.txt").then((text) => {
  scene.userData.text = text;
});

S.fetchJSON("data/config.json").then((value) => {
  scene.userData.config = value;
});

// A host that answers a JSON request with text still works.
S.fetchJSON("data/inline.json").then((value) => {
  scene.userData.inline = value;
});

// A response that is not JSON rejects rather than resolving with a string.
S.fetchJSON("data/broken.json").catch((error) => {
  scene.userData.brokenName = error.name;
  scene.userData.brokenFeature = error.feature;
  scene.userData.brokenMessage = error.message;
});

S.fetchText("data/gone.txt").catch((error) => {
  scene.userData.goneMessage = error.message;
});

// A url that escapes the asset root never reaches the consumer.
S.fetchText("../secrets.txt").catch((error) => {
  scene.userData.refusedName = error.name;
  scene.userData.refusedFeature = error.feature;
});

S.fetchJSON(42).catch((error) => {
  scene.userData.typeError = error.name;
});

S.mount(scene);
