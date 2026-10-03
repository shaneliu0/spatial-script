const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const screen = new S.VideoScreen({ url: "videos/clip.mp4", width: 1.6, height: 0.9 });
screen.name = "screen";
screen.userData.log = [];
scene.add(screen);

screen.userData.log.push(screen.isPlaying);
screen.userData.chainedPlay = screen.play() === screen;
screen.userData.log.push(screen.isPlaying);
screen.userData.chainedPause = screen.pause() === screen;
screen.userData.log.push(screen.isPlaying);

screen.currentTime = 4.5;
screen.userData.log.push(screen.currentTime);
// A negative seek lands at the start rather than before it.
screen.currentTime = -3;
screen.userData.log.push(screen.currentTime);

screen.volume = 0.25;
screen.muted = true;
screen.loop = true;
screen.playbackRate = 2;
screen.play();

// Every setter contains its value the way the phase 1 setters do.
const clamped = new S.VideoScreen({ url: "videos/clamped.mp4", width: 1, height: 1 });
clamped.name = "clamped";
clamped.volume = 5;
clamped.playbackRate = 100;
clamped.muted = "yes";
clamped.loop = 0;
clamped.userData.values = [clamped.volume, clamped.playbackRate, clamped.muted, clamped.loop];
scene.add(clamped);

S.mount(scene);
