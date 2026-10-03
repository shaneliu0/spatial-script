const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const buffer = new S.AudioLoader().load("sounds/chime.wav");

const chime = new S.Audio();
chime.name = "chime";
chime.setBuffer(buffer);
chime.play();
scene.add(chime);

const silent = new S.Audio();
silent.name = "silent";
silent.setBuffer(new S.AudioLoader().load("sounds/silent.wav"));
scene.add(silent);

// Playback state is native-driven (SPEC 14.1): the consumer's syncAudio
// records overwrite whatever the script thought was true.
chime.userData.seen = [];
S.onFrame(() => {
  chime.userData.seen.push([chime.isPlaying, chime.currentTime, chime.duration]);
  chime.userData.bufferDuration = buffer.duration;
});

S.mount(scene);
