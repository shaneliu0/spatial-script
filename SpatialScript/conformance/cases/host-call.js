const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
scene.userData.functions = S.host.functions;

// A registered native function answers through `hostResult` (SPEC 14.10).
S.host.call("MyApp.save", { slot: 1 }).then((value) => {
  scene.userData.saved = value;
});

// A function that fails rejects with a SpatialUnsupportedError.
S.host.call("MyApp.fail").catch((error) => {
  scene.userData.failedName = error.name;
  scene.userData.failedFeature = error.feature;
  scene.userData.failedMessage = error.message;
});

// One that was never registered rejects without waiting for an answer.
S.host.call("Nope.missing").catch((error) => {
  scene.userData.missingName = error.name;
  scene.userData.missingFeature = error.feature;
});

S.host.call("").catch((error) => {
  scene.userData.nameError = error.name;
});

// The list is the app's, not the script's: it survives being read.
scene.userData.functionsAreCopies = S.host.functions !== S.host.functions;

S.mount(scene);
