const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const push = new S.RadialForceField({
  strength: 5,
  minimumDistance: 0.2,
  falloff: "linear",
  radius: 2,
});
push.name = "push";
scene.add(push);

// An unknown falloff in the options falls back to the documented default.
const pull = new S.RadialForceField({ strength: -2, falloff: "sideways" });
pull.name = "pull";
scene.add(pull);
scene.userData.defaultFalloff = pull.falloff;

// The setter is strict, unlike the constructor.
let falloffError = null;
try {
  pull.falloff = "sideways";
} catch (error) {
  falloffError = error.name;
}
scene.userData.falloffError = falloffError;

pull.falloff = "none";
pull.strength = -3;
pull.minimumDistance = 0.5;

scene.userData.strength = pull.strength;

S.mount(scene);
