// Spatial audio in a mix group, for the routing and listener tests. It never
// calls S.audio.resume(): the harness supplies the gesture (SPEC 14.1).
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));

S.audio.setGroupVolume("music", 0.5);
S.audio.setGroupVolume("sfx", 0.25);

const chime = new S.PositionalAudio();
chime.name = "chime";
chime.group = "music";
chime.reverbLevel = 0.4;
chime.setBuffer(new S.AudioLoader().load("asset://spatial-tone.wav"));
chime.setLoop(true);
chime.setVolume(0.6);
scene.add(chime);

S.onFrame(() => {
  if (S.time.frame === 3) chime.play();
});
S.mount(scene);
