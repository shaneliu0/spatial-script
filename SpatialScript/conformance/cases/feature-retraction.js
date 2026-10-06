const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 14.4 and 14.11: both of these are "JSON or null", and the null has to
// reach the consumer or the component stays on the entity forever.
const button = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
button.name = "button";
button.accessibility = { label: "Start", value: "off", hint: "Begins the run", isButton: true };
scene.add(button);

const walker = new S.Group();
walker.name = "walker";
walker.characterController = new S.CharacterController({ radius: 0.25, height: 1.7 });
scene.add(walker);

// Cleared only after the consumer has seen them, which is the case the gate
// used to miss: the object's last phase-2 feature goes away.
S.onFrame(() => {
  if (S.time.frame === 2) {
    button.accessibility = null;
    walker.characterController = null;
  }
  button.userData.accessibility = button.accessibility;
  walker.userData.controller = walker.characterController;
});

S.mount(scene);
