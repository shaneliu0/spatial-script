const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// Only the height is fixed, so the width follows the video's own aspect once
// the consumer reports it (SPEC 14.2).
const screen = new S.VideoScreen({ url: "videos/wide.mp4", height: 1 });
screen.name = "screen";
screen.userData.before = [screen.width, screen.height];
scene.add(screen);

screen.addEventListener("loaded", (event) => {
  screen.userData.eventType = event.type;
  screen.userData.reported = [event.width, event.height, event.duration];
  screen.userData.after = [screen.width, screen.height];
  screen.userData.duration = screen.duration;
});

// A screen that fixed both dimensions keeps the plane the script asked for.
const fixed = new S.VideoScreen({ url: "videos/wide.mp4", width: 0.8, height: 0.8 });
fixed.name = "fixed";
scene.add(fixed);

S.mount(scene);
