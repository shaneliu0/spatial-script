const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const chime = new S.Audio();
chime.name = "chime";
chime.userData.log = [];
scene.add(chime);

// Nothing plays without a buffer: the call is dropped with a warning.
chime.play();
chime.userData.log.push(chime.isPlaying);

const buffer = new S.AudioLoader().load("sounds/chime.wav");
chime.userData.chained = chime.setBuffer(buffer) === chime;

chime.setLoop(true);
chime.setVolume(0.5);
chime.setPlaybackRate(1.5);
chime.group = "music";
chime.userData.getVolume = chime.getVolume();

chime.play();
chime.userData.log.push(chime.isPlaying);
chime.pause();
chime.userData.log.push(chime.isPlaying);
chime.currentTime = 2.5;
chime.userData.log.push(chime.currentTime);
chime.stop();
chime.userData.log.push(chime.isPlaying);
chime.userData.log.push(chime.currentTime);
chime.play();

// The property setters mirror the three.js setter methods.
const quiet = new S.Audio();
quiet.name = "quiet";
quiet.setBuffer(new S.AudioLoader().load("sounds/quiet.wav"));
quiet.loop = true;
quiet.volume = 2;
quiet.playbackRate = 0;
quiet.userData.rate = quiet.playbackRate;
quiet.userData.volume = quiet.volume;
quiet.userData.loop = quiet.loop;
scene.add(quiet);

S.mount(scene);
