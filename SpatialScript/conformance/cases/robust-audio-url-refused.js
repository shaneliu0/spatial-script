// An audio url that climbs out of the asset root never becomes a playable
// buffer: the handle carries a null url, setBuffer and play() each warn, and
// nothing starts. The conformance asset root is "assets".
const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  MeshStandardMaterial,
  AudioLoader,
  PositionalAudio,
} = Spatial;

const scene = new Scene();

const probe = new Group();
probe.name = "probe";
probe.userData.loadErrorSaysRefused = null;
scene.add(probe);

const speaker = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
speaker.name = "speaker";
scene.add(speaker);

const chime = new PositionalAudio();
chime.name = "chime";
chime.setLoop(true);
chime.setVolume(0.8);
speaker.add(chime);

const loader = new AudioLoader();
// "assets/../outside/secret.wav" normalises to "outside/secret.wav", which is
// no longer under the asset root, so containment drops it.
const buffer = loader.load("../outside/secret.wav", undefined, undefined, (error) => {
  probe.userData.loadErrorSaysRefused = error.message.indexOf("refused") !== -1;
});

probe.userData.bufferUrl = buffer.url;
probe.userData.bufferError = buffer.error;

chime.setBuffer(buffer);
// Nothing to play: the transport is never started and no audioControl is
// queued, so the reported state stays stopped at zero.
chime.play();

probe.userData.playing = chime.isPlaying;
probe.userData.currentTime = chime.currentTime;
probe.userData.duration = chime.duration;

Spatial.mount(scene);
