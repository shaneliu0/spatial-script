const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
scene.userData.connected = [];
scene.userData.disconnected = [];
scene.userData.counts = [];

// Controllers coming and going are scene events (SPEC 14.8).
scene.addEventListener("controllerconnected", (event) => {
  scene.userData.connected.push(event.controller.id);
  scene.userData.connectType = event.type;
});
scene.addEventListener("controllerdisconnected", (event) => {
  scene.userData.disconnected.push(event.controller.id);
});

S.onFrame(() => {
  const set = S.input.controllers;
  scene.userData.counts.push(set.connected);
  scene.userData.ids = set.all.map((controller) => controller.id);
  scene.userData.current = set.current === null ? null : set.current.id;
});

S.mount(scene);
