const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const marker = new S.Group();
marker.name = "marker";
scene.add(marker);

// SPEC 14.1: dispose() stops the sound, releases it on the consumer and frees
// the object. A playback call afterwards is dropped and never brings it back.
const hum = new S.Audio();
hum.name = "hum";
hum.setBuffer(new S.AudioLoader().load("sounds/hum.wav"));
hum.play();

const chime = new S.PositionalAudio();
chime.name = "chime";
chime.setBuffer(new S.AudioLoader().load("sounds/chime.wav"));
scene.add(chime);

S.onFrame(() => {
  if (S.time.frame === 2) {
    hum.dispose();
    S.destroy(chime);
  }
  if (S.time.frame === 3) {
    hum.play();
    marker.userData.playingAfterDispose = hum.isPlaying;
    marker.userData.dropped = S.dump({ objects: false }).warnings.filter((warning) =>
      /Audio\.play .* was dropped: the object was destroyed/.test(warning),
    ).length;
  }
});

S.mount(scene);
