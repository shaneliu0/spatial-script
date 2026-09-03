const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshBasicMaterial } = Spatial;

const scene = new Scene();
const box = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
box.name = "box";
box.userData.order = [];
scene.add(box);
Spatial.mount(scene);

this.didAdd = function () {
  box.userData.added = true;
};

this.update = function (deltaTime) {
  box.userData.updates = (box.userData.updates || 0) + 1;
  box.userData.order.push("update");
  box.userData.delta = deltaTime;
};

this.willRemove = function () {
  box.userData.removed = true;
};

Spatial.onFrame(function () {
  box.userData.order.push("frame");
});
