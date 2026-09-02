const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const knob = new S.Mesh(new S.SphereGeometry(0.08, 16, 12), new S.MeshStandardMaterial());
knob.name = "knob";
knob.manipulable = true;
knob.userData.events = [];
scene.add(knob);

for (const type of ["manipulationstart", "manipulation", "manipulationend"]) {
  knob.addEventListener(type, (event) => knob.userData.events.push(event.type));
}

S.mount(scene);
