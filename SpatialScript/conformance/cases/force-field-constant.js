const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 14.4: a force field is an Object3D, so it has a world position and
// carries its own payload.
const updraft = new S.ConstantForceField({ force: new S.Vector3(0, 9.8, 0), radius: 3, mask: 6 });
updraft.name = "updraft";
updraft.position.set(0, 0.5, 0);
scene.add(updraft);

const holder = new S.Group();
holder.name = "holder";
holder.position.set(1, 0, 0);
scene.add(holder);

const wind = new S.ConstantForceField();
wind.name = "wind";
wind.position.set(0, 0, 0.25);
holder.add(wind);

scene.userData.type = updraft.type;
scene.userData.isForceField = updraft.isForceField === true;
scene.userData.isObject3D = scene.getObjectByName("updraft") === updraft;

S.mount(scene);
