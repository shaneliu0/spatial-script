const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const source = new S.PositionalAudio();
source.name = "source";
source.position.set(0.3, 0.1, -0.2);
source.setBuffer(new S.AudioLoader().load("sounds/engine.wav"));
source.setRefDistance(2);
source.setRolloffFactor(0.5);
source.setDistanceModel("linear");
source.setDirectionalCone(30, 90, 0.1);
// dB, clamped into the range the RealityKit component accepts.
source.reverbLevel = -200;
source.userData.clampedReverb = source.reverbLevel;
source.reverbLevel = -6;
scene.add(source);

source.userData.getters = [
  source.getRefDistance(),
  source.getRolloffFactor(),
  source.getDistanceModel(),
];
source.userData.chained = source.setRefDistance(2) === source;

// The cone is clamped and ordered: an outer angle below the inner one is
// raised to it, and the gain is a 0..1 factor.
const cone = new S.PositionalAudio();
cone.name = "cone";
cone.setDirectionalCone(-10, 5, 4);
scene.add(cone);

try {
  source.setDistanceModel("sideways");
} catch (error) {
  source.userData.modelError = error.name;
}

S.mount(scene);
