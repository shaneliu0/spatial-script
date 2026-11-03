const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const probe = new S.Object3D();
probe.name = "probe";
probe.userData.a = [];
scene.add(probe);

S.onFrame(() => {
  const set = S.input.controllers;
  probe.userData.connected = set.connected;
  probe.userData.currentId = set.current === null ? null : set.current.id;
  probe.userData.byId = set.get("pad-1") === set.current;
  probe.userData.missing = set.get("nobody");

  const pad = set.current;
  if (pad === null) {
    probe.userData.a.push(null);
    return;
  }
  probe.userData.name = pad.name;
  probe.userData.sticks = [pad.leftThumbstick.toArray(), pad.rightThumbstick.toArray()];
  probe.userData.triggers = [pad.leftTrigger, pad.rightTrigger];
  probe.userData.a.push([pad.a.down, pad.a.pressed, pad.a.released, pad.a.value]);
  probe.userData.dpad = [pad.dpadUp.down, pad.dpadDown.down, pad.dpadLeft.down, pad.dpadRight.down];
  probe.userData.shoulders = [pad.leftShoulder.down, pad.rightShoulder.down];
  probe.userData.system = [pad.menu.down, pad.options.down];
  probe.userData.xy = [pad.x.value, pad.y.value, pad.b.value];
  probe.userData.rumbleChains = pad.rumble(0.5, 0.2) === pad;
});

S.mount(scene);
