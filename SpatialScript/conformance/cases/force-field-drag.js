const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const water = new S.DragForceField({ coefficient: 0.5, radius: 4 });
water.name = "water";
scene.add(water);

// A negative coefficient is clamped to zero rather than refused.
const air = new S.DragForceField({ coefficient: -2 });
air.name = "air";
scene.add(air);

water.coefficient = 1.25;
scene.userData.coefficient = water.coefficient;
scene.userData.clamped = air.coefficient;

S.mount(scene);
