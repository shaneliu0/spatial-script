// Exceptions inside onFrame, update, listeners, and timers must not stop the loop, and must be rate limited.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;
const scene = new Scene(); scene.add(new AmbientLight(0xffffff, 1));
const m = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0xff8800 })); m.name = "m"; scene.add(m);
let healthy = 0;
Spatial.onFrame(() => { throw new Error("frame handler explodes"); });
Spatial.onFrame((dt) => { m.rotation.y += dt; healthy += 1; scene.userData.healthyFrames = healthy; });
this.update = function () { throw new TypeError("update explodes"); };
m.addEventListener("tap", () => { throw new RangeError("listener explodes"); });
m.addEventListener("tap", () => { scene.userData.secondListenerRan = true; });
setTimeout(() => { throw new Error("timer explodes"); }, 10);
setInterval(() => { scene.userData.intervalTicks = (scene.userData.intervalTicks || 0) + 1; }, 100);
Spatial.mount(scene);
