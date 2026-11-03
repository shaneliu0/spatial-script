const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const sparks = new S.ParticleEmitter({
  shape: "cone",
  shapeSize: new S.Vector3(0.1, 0.2, 0.1),
  birthRate: 250,
  lifetime: 1.5,
  lifetimeVariation: 0.2,
  speed: 0.8,
  speedVariation: 0.1,
  size: 0.02,
  sizeVariation: 0.005,
  color: 0xff8800,
  colorEnd: 0x0000ff,
  opacity: 1,
  opacityEnd: 0,
  spreadAngle: 0.5,
  acceleration: new S.Vector3(0, -0.5, 0),
  burstCount: 40,
  loops: true,
});
sparks.name = "sparks";
sparks.position.set(0, 0.1, 0);
scene.add(sparks);

const rain = new S.ParticleEmitter({ preset: "rain" });
rain.name = "rain";
scene.add(rain);

let presetError = null;
try {
  new S.ParticleEmitter({ preset: "confetti" });
} catch (error) {
  presetError = error.name;
}
rain.userData.presetError = presetError;

S.onFrame(() => {
  if (S.time.frame === 2) {
    sparks.burst();
    sparks.isEmitting = false;
  }
});

S.mount(scene);
