const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const screen = new S.VideoScreen({ url: "videos/missing.mp4", width: 1, height: 1 });
screen.name = "screen";
screen.userData.errorBefore = screen.error;
scene.add(screen);

screen.addEventListener("error", (event) => {
  screen.userData.events = (screen.userData.events || 0) + 1;
  screen.userData.message = event.message;
  screen.userData.errorInHandler = screen.error;
});

// A consumer that reports no message still leaves a readable reason.
const bare = new S.VideoScreen({ url: "videos/bare.mp4", width: 1, height: 1 });
bare.name = "bare";
scene.add(bare);

S.mount(scene);
