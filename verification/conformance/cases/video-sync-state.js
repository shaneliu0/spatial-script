const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const screen = new S.VideoScreen({ url: "videos/clip.mp4", width: 1.6, height: 0.9 });
screen.name = "screen";
screen.userData.seen = [];
screen.userData.endedEvents = 0;
screen.play();
scene.add(screen);

screen.addEventListener("ended", () => {
  screen.userData.endedEvents += 1;
  screen.userData.playingAtEnd = screen.isPlaying;
});

// Playback state is native-driven: syncVideo owns isPlaying, currentTime and
// duration, and `ended` stops the screen (SPEC 14.2).
S.onFrame(() => {
  screen.userData.seen.push([screen.isPlaying, screen.currentTime, screen.duration]);
});

S.mount(scene);
