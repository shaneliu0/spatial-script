const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const probe = new S.Object3D();
probe.name = "probe";
probe.userData.scene = [];
probe.userData.scroll = [];
scene.add(probe);

// The world point under the pointer, pushed in by the consumer (SPEC 14.3).
S.onFrame(() => {
  const mouse = S.input.mouse;
  probe.userData.scene.push(mouse.scenePosition === null ? null : mouse.scenePosition.toArray());
  probe.userData.scroll.push(mouse.scroll.toArray());
  probe.userData.position = mouse.position === null ? null : mouse.position.toArray();
  probe.userData.delta = mouse.delta.toArray();
});

// rayFromPoint is a consumer query: a runner without the hook answers null,
// and a runner with one answers a world-space ray. Both shapes are valid.
const ray = S.rayFromPoint(120, 80);
probe.userData.rayIsUsable =
  ray === null || (ray.origin.isVector3 === true && ray.direction.isVector3 === true);

try {
  S.rayFromPoint("left", 80);
} catch (error) {
  probe.userData.rayTypeError = error.name;
}

S.mount(scene);
