const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const spin = new S.VortexForceField({ strength: 2, axis: new S.Vector3(0, 0, 1), radius: 1 });
spin.name = "spin";
scene.add(spin);

// The axis defaults to +Y and the strength to 1.
const swirl = new S.VortexForceField();
swirl.name = "swirl";
scene.add(swirl);

// A non-finite strength keeps the previous value.
spin.strength = Number.NaN;
scene.userData.strength = spin.strength;

S.mount(scene);
