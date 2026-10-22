const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
scene.userData.scores = [];
scene.userData.pings = 0;
scene.userData.once = 0;

// Host to script (SPEC 14.10).
S.host.on("score", (payload) => {
  scene.userData.scores.push(payload.value);
});

// `this.on` is the alias for Spatial.host.on.
this.on("ping", () => {
  scene.userData.pings += 1;
});

// A handler that unsubscribes itself only ever runs once.
function once() {
  scene.userData.once += 1;
  S.host.off("once", once);
}
S.host.on("once", once);
scene.userData.returnsHandler = S.host.on("later", once) === once;
S.host.off("later");

// Script to host. The payload is copied to JSON on the way out.
scene.userData.chainedSend = S.host.send("ready", { level: 2 }) === S.host;
S.host.send("ready");

try {
  S.host.send("");
} catch (error) {
  scene.userData.sendError = error.name;
}
try {
  S.host.on("bad", "not a function");
} catch (error) {
  scene.userData.onError = error.name;
}

S.mount(scene);
