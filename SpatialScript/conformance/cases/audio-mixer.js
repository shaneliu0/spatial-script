const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const probe = new S.Object3D();
probe.name = "probe";
scene.add(probe);

const mixer = S.audio;
probe.userData.stateBefore = mixer.state;
probe.userData.groupsBefore = mixer.groups;

mixer.masterVolume = 0.4;
mixer.setGroupVolume("music", 0.5);
// Out of range on both ends: the mixer clamps into 0..1.
mixer.setGroupVolume("sfx", 2);
mixer.setGroupVolume("voice", -1);
// A group name that is not a usable string falls back to the master bus.
mixer.setGroupVolume("", 0.75);

// Non-finite input keeps the value it had.
mixer.masterVolume = Number.NaN;

probe.userData.master = mixer.masterVolume;
probe.userData.groups = mixer.groups;
probe.userData.chained = mixer.setGroupVolume("music", 0.5) === mixer;
probe.userData.resumed = mixer.resume() === mixer;
probe.userData.stateAfterResume = mixer.state;

// The consumer has the last word on whether the engine is really running.
probe.userData.seen = [];
S.onFrame(() => {
  probe.userData.seen.push(mixer.state);
});

S.mount(scene);
