const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const clock = new S.Group();
clock.name = "clock";
clock.userData.timeout = false;
clock.userData.cancelled = false;
clock.userData.intervals = 0;
clock.userData.frames = 0;
clock.userData.args = null;
scene.add(clock);

setTimeout((first, second) => {
  clock.userData.timeout = true;
  clock.userData.args = [first, second];
}, 50, "one", 2);

const doomed = setTimeout(() => {
  clock.userData.cancelled = true;
}, 50);
clearTimeout(doomed);

const interval = setInterval(() => {
  clock.userData.intervals += 1;
  if (clock.userData.intervals >= 3) clearInterval(interval);
}, 20);

requestAnimationFrame(() => {
  clock.userData.frames += 1;
});

const skipped = requestAnimationFrame(() => {
  clock.userData.frames += 100;
});
cancelAnimationFrame(skipped);

S.mount(scene);
