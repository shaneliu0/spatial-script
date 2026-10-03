const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const screen = new S.VideoScreen({
  url: "videos/clip.mp4",
  width: 1.6,
  height: 0.9,
  loop: true,
  muted: true,
  autoplay: true,
  docking: true,
});
screen.name = "screen";
screen.position.set(0, 1.5, -2);
scene.add(screen);

screen.userData.width = screen.width;
screen.userData.height = screen.height;
screen.userData.docking = screen.docking;
screen.userData.url = screen.url;
screen.userData.isMesh = screen.isMesh === true;
screen.userData.autoplaying = screen.isPlaying;

// A screen with no size is one metre wide at 16:9 until the video reports its
// own aspect, and defaults to a paused, unmuted, non-looping player.
const plain = new S.VideoScreen({ url: "videos/plain.mp4" });
plain.name = "plain";
scene.add(plain);

// A url that escapes the asset root leaves the screen blank.
const blank = new S.VideoScreen({ url: "../secret.mp4", width: 1, height: 1 });
blank.name = "blank";
scene.add(blank);

// SPEC 14.2: one url per encoding. Each key goes through the same containment
// as a plain url, and a refused key is dropped rather than taking the screen
// down with it.
const encodings = new S.VideoScreen({
  url: { mp4: "videos/clip.mp4", webm: "videos/clip.webm", hls: "../../elsewhere/clip.m3u8" },
  width: 1.2,
});
encodings.name = "encodings";
encodings.userData.url = encodings.url;
scene.add(encodings);

// A screen whose every source is refused has nothing to play and says so.
const sourceless = new S.VideoScreen({ url: { mp4: "../../a.mp4", webm: "javascript:alert(1)" }, width: 1 });
sourceless.name = "sourceless";
sourceless.userData.error = null;
sourceless.addEventListener("error", (event) => {
  sourceless.userData.error = event.message;
});
scene.add(sourceless);

S.mount(scene);

// A VideoScreen is a mesh, so it takes part in raycasts like any other.
S.onFrame(() => {
  const hits = S.raycast(new S.Vector3(0, 1.5, 0), new S.Vector3(0, 0, -1));
  screen.userData.raycastHit = hits.length > 0 ? hits[0].object.name : null;
});
