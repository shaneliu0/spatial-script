const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const probe = new S.Object3D();
probe.name = "probe";
probe.userData.callbacks = [];
scene.add(probe);

const loader = new S.AudioLoader();
probe.userData.chainedPath = loader.setPath("sounds/") === loader;

// Relative urls are joined onto the asset root (SPEC 3.5).
const chime = loader.load("chime.wav", (buffer) => {
  probe.userData.callbacks.push("load");
  probe.userData.loadedUrl = buffer.url;
  probe.userData.sameHandle = buffer === chime;
}, () => {
  probe.userData.callbacks.push("progress");
});
probe.userData.url = chime.url;
probe.userData.error = chime.error;
probe.userData.durationBeforeSync = chime.duration;

// A url that climbs out of the asset root never becomes a playable buffer.
const escaped = new S.AudioLoader().load("../escape.wav", null, null, (error) => {
  probe.userData.refusedMessage = error.message;
});
probe.userData.refusedUrl = escaped.url;
probe.userData.refusedError = escaped.error;

new S.AudioLoader().setPath("sounds/").loadAsync("loop.wav").then((buffer) => {
  probe.userData.asyncUrl = buffer.url;
});

const player = new S.Audio();
player.name = "player";
player.setBuffer(chime);
scene.add(player);

// setBuffer only accepts a handle the loader made.
try {
  player.setBuffer({ url: "sounds/fake.wav" });
} catch (error) {
  probe.userData.typeError = error.name;
}

S.mount(scene);
