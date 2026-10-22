const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const marker = new S.Group();
marker.name = "marker";
scene.add(marker);

console.log("hello from the scene");
console.warn("a warning line");
console.info("info", 42, { a: 1 });
console.error("an error line");

S.onFrame(() => {
  if (S.time.frame === 2) console.debug("frame two");
});

S.mount(scene);
