const Spatial = require("spatial");
const { Scene, Group } = Spatial;

const scene = new Scene();
const marker = new Group();
marker.name = "marker";
scene.add(marker);

let count = 0;
function onTick(deltaTime, elapsed) {
  count += 1;
  marker.userData.count = count;
  marker.userData.elapsed = elapsed;
  marker.userData.frame = Spatial.time.frame;
  marker.userData.delta = deltaTime;
  if (count === 2) Spatial.offFrame(onTick);
}
Spatial.onFrame(onTick);
Spatial.mount(scene);
