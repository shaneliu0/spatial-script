// A consumer that reports an empty or half-filled controller record still
// produces a controller that reads cleanly: the id falls back to the slot, the
// name is empty, thumbsticks are (0, 0), triggers are 0 and every button is
// up. Nothing throws for a field that was never sent.
const Spatial = require("spatial");
const { Scene, Group } = Spatial;

const scene = new Scene();

const probe = new Group();
probe.name = "probe";
probe.userData.connected = 0;
probe.userData.readings = [];
scene.add(probe);

// SPEC 14.8: every button a controller carries.
const BUTTONS = [
  "a",
  "b",
  "x",
  "y",
  "leftShoulder",
  "rightShoulder",
  "dpadUp",
  "dpadDown",
  "dpadLeft",
  "dpadRight",
  "menu",
  "options",
];

function read(controller) {
  let missingButtons = 0;
  let anyDown = false;
  let anyPressed = false;
  let anyReleased = false;
  let totalValue = 0;
  for (let i = 0; i < BUTTONS.length; i += 1) {
    const button = controller[BUTTONS[i]];
    if (!button) {
      missingButtons += 1;
      continue;
    }
    if (button.down) anyDown = true;
    if (button.pressed) anyPressed = true;
    if (button.released) anyReleased = true;
    totalValue += button.value;
  }
  return {
    id: controller.id,
    name: controller.name,
    leftThumbstick: [controller.leftThumbstick.x, controller.leftThumbstick.y],
    rightThumbstick: [controller.rightThumbstick.x, controller.rightThumbstick.y],
    leftTrigger: controller.leftTrigger,
    rightTrigger: controller.rightTrigger,
    missingButtons,
    anyDown,
    anyPressed,
    anyReleased,
    totalValue,
  };
}

let connectedEvents = 0;
scene.addEventListener("controllerconnected", (event) => {
  connectedEvents += 1;
  // The event carries the controller, which must be readable straight away.
  probe.userData.firstSeenId = event.controller.id;
});

Spatial.onFrame(() => {
  const controllers = Spatial.input.controllers;
  probe.userData.connected = controllers.connected;
  // SPEC 14.8: current is the most recently used, by latest input change, so
  // a controller that only connected is not it.
  probe.userData.currentId = controllers.current === null ? null : controllers.current.id;
  if (Spatial.time.frame === 1) {
    probe.userData.currentBeforeUse = controllers.current === null ? null : controllers.current.id;
  }
  probe.userData.foundById = controllers.get("controller-0") !== null;
  probe.userData.missingById = controllers.get("no-such-pad");
  probe.userData.connectedEvents = connectedEvents;
  probe.userData.readings = controllers.all.map(read);
});

Spatial.mount(scene);
