const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 14.11: the component keeps only the four documented fields.
const button = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
button.name = "button";
button.accessibility = { label: "Start", value: "off", hint: "Begins the run", isButton: true };
scene.add(button);

// Missing fields take their documented defaults, and anything else is dropped.
const label = new S.Group();
label.name = "label";
label.accessibility = { label: "Score", weight: 7 };
scene.add(label);

const plain = new S.Group();
plain.name = "plain";
scene.add(plain);

const cleared = new S.Group();
cleared.name = "cleared";
cleared.accessibility = { label: "Gone" };
cleared.accessibility = null;
scene.add(cleared);

S.onFrame(() => {
  if (S.time.frame === 2) label.accessibility = { label: "Score", value: "12" };
});

scene.userData.capability = S.env.capabilities.accessibility;

S.mount(scene);
