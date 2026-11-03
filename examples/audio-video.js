// audio-video.js -- a positional source riding a moving object, an ambient
// bed, the Spatial.audio mixer with a named group, and a video screen a tap
// plays and pauses.
//
// Everything sits within about 0.4 m of the origin so it fills the Mac window
// with the camera roughly 1 m away.
//
// Nothing here decodes a file: the consumer owns playback. The script says
// what should sound, where it is and how loud it should be, and reads the
// playback state back once the consumer reports it.

const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  SphereGeometry,
  PlaneGeometry,
  MeshStandardMaterial,
  AmbientLight,
  DirectionalLight,
  AudioLoader,
  PositionalAudio,
  AmbientAudio,
  VideoScreen,
} = Spatial;

const scene = new Scene();

// ---------------------------------------------------------------- lighting

const ambientLight = new AmbientLight(0xffffff, 0.4);
ambientLight.name = "ambientLight";
scene.add(ambientLight);

const sun = new DirectionalLight(0xfff2e0, 2.4);
sun.name = "sun";
sun.position.set(0.6, 1.1, 0.8);
sun.castShadow = true;
scene.add(sun);

const floor = new Mesh(
  new PlaneGeometry(0.9, 0.9),
  new MeshStandardMaterial({ color: 0x22262c, roughness: 0.95 }),
);
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.24;
floor.receiveShadow = true;
scene.add(floor);

// ------------------------------------------------------------------- mixer

// The mixer is the listener as well as the bus: a master volume every source
// passes through, plus whatever named groups the scene wants. Group volumes
// are a flat name -> volume map, so a source joins a group by name alone.
Spatial.audio.masterVolume = 0.85;
Spatial.audio.setGroupVolume("effects", 0.9);
Spatial.audio.setGroupVolume("ambience", 0.35);

// Web audio will not start without a user gesture; the consumer's harness is
// what actually opens the context, and `resume()` records the intent. On
// RealityKit it is a no-op beyond flipping the reported state to "running".
Spatial.audio.resume();

// --------------------------------------------------------- positional hum

const sources = new Group();
sources.name = "sources";
scene.add(sources);

// The emitter is an ordinary mesh; the sound is a child of it, so the
// consumer places the source wherever the parent ends up each frame.
const drone = new Mesh(
  new SphereGeometry(0.055, 28, 20),
  new MeshStandardMaterial({ color: 0x4488ff, roughness: 0.3, metalness: 0.4 }),
);
drone.name = "drone";
drone.position.set(-0.22, 0.02, 0);
drone.castShadow = true;
sources.add(drone);

const hum = new PositionalAudio();
hum.name = "hum";
hum.group = "effects";
hum.setLoop(true);
hum.setVolume(0.8);
// Full volume out to 0.3 m, then a gentle roll-off: the scene is small, so
// the defaults (tuned for metres) would never attenuate inside it.
hum.setRefDistance(0.3);
hum.setRolloffFactor(1.4);
hum.setDistanceModel("inverse");
// A cone aimed down the object's -Z axis: outside 140 degrees the source
// drops to a quarter of its gain.
hum.setDirectionalCone(60, 140, 0.25);
// Decibels of send into the room's reverb, not a 0..1 mix.
hum.reverbLevel = -8;
drone.add(hum);

// `load` hands the handle back straight away and calls onLoad on the next
// microtask, so either style of script works. The handle is opaque: the url
// is all that crosses to the consumer.
const loader = new AudioLoader();
loader.load(
  "asset://spatial-tone.wav",
  (buffer) => {
    hum.setBuffer(buffer);
    hum.play();
    console.log("hum buffer ready:", buffer.url);
  },
  undefined,
  (error) => {
    console.warn("hum failed to load:", error.message);
  },
);

// ------------------------------------------------------------ ambient bed

// AmbientAudio has a place in the graph but no direction: it arrives from
// everywhere at once, which is what a room tone wants.
const bed = new AmbientAudio();
bed.name = "bed";
bed.group = "ambience";
bed.setLoop(true);
bed.setVolume(0.6);
bed.setPlaybackRate(0.95);
scene.add(bed);

new AudioLoader()
  .loadAsync("asset://spatial-tone.wav")
  .then((buffer) => {
    bed.setBuffer(buffer);
    bed.play();
  })
  .catch((error) => {
    console.warn("room tone failed to load:", error.message);
  });

// Playback state is native-driven, so `ended` is an event from the consumer
// rather than something the core can time itself.
bed.addEventListener("ended", () => {
  console.log("room tone reached its end");
});

// ------------------------------------------------------------ video screen

// A VideoScreen is a mesh sized in metres, so it raycasts, hit-tests and
// takes input like any other mesh. Giving only a width lets the height follow
// the video's own aspect once the consumer reports it.
const screen = new VideoScreen({
  url: { mp4: "asset://spatial-bars.mp4", webm: "asset://spatial-bars.webm" },
  width: 0.34,
  loop: true,
  muted: false,
  autoplay: false,
});
screen.name = "screen";
screen.position.set(0.2, 0.06, -0.05);
screen.rotation.y = -0.35;
screen.volume = 0.7;
sources.add(screen);

// A frame around the screen, so the plane reads as a panel while the video
// has not arrived yet.
const bezel = new Mesh(
  new BoxGeometry(0.37, 0.23, 0.012),
  new MeshStandardMaterial({ color: 0x15181d, roughness: 0.6 }),
);
bezel.name = "bezel";
bezel.position.copy(screen.position);
bezel.position.z -= 0.01;
bezel.rotation.y = screen.rotation.y;
bezel.castShadow = true;
sources.add(bezel);

screen.addEventListener("loaded", () => {
  console.log("video is", screen.width.toFixed(2), "x", screen.height.toFixed(2), "metres");
});

screen.addEventListener("tap", () => {
  // `isPlaying` is whatever the consumer last reported, so this toggles
  // against the real transport rather than against a local guess.
  if (screen.isPlaying) screen.pause();
  else screen.play();
});

screen.addEventListener("hoverenter", () => {
  screen.hoverEffect = "highlight";
});

screen.addEventListener("hoverexit", () => {
  screen.hoverEffect = null;
});

// ------------------------------------------------------------------ frame

const ORBIT_RADIUS = 0.22;

Spatial.onFrame((deltaTime, elapsed) => {
  // The hum rides its parent: moving the mesh moves the source, and the cone
  // turns with it.
  drone.position.x = Math.cos(elapsed * 0.7) * ORBIT_RADIUS;
  drone.position.z = Math.sin(elapsed * 0.7) * ORBIT_RADIUS;
  drone.lookAt(0, 0.02, 0);
  drone.rotation.z += deltaTime * 0.4;

  // Duck the ambience while the video is playing, so the two beds do not
  // fight. Setting the group volume moves every source in the group.
  Spatial.audio.setGroupVolume("ambience", screen.isPlaying ? 0.12 : 0.35);
});

Spatial.mount(scene);
