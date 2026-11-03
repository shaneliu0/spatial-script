const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const probe = new S.Group();
probe.name = "probe";
probe.userData.seenEarly = null;
probe.userData.seenLate = null;
probe.userData.result = null;
probe.userData.callError = null;
scene.add(probe);

// SPEC 14.10 and the `hostFunctions` step kind of 14.13: the app registers its
// functions and `Spatial.host.functions` lists them. Here nothing is
// registered when the script loads and the app registers a frame later — a
// plugin that finishes starting up — so the script watches the list rather
// than reading it once, and calls the function only once it is there.
let called = false;

S.onFrame(() => {
  const functions = S.host.functions;
  if (probe.userData.seenEarly === null) probe.userData.seenEarly = functions.slice();

  if (!called && functions.indexOf("Late.compute") !== -1) {
    called = true;
    probe.userData.seenLate = functions.slice();
    S.host.call("Late.compute", { n: 21 }).then(
      (value) => {
        probe.userData.result = value;
      },
      (error) => {
        probe.userData.callError = error.message;
      },
    );
  }
});

S.mount(scene);
