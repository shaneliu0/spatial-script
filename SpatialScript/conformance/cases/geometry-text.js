const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const geometry = new S.TextGeometry("Hi", { size: 0.1, depth: 0.02 });
geometry.computeBoundingBox();

const label = new S.Mesh(geometry, new S.MeshStandardMaterial({ color: 0xffffff }));
label.name = "label";
label.userData.hasVertices = geometry.getAttribute("position").count > 0;
label.userData.hasWidth = geometry.boundingBox.max.x - geometry.boundingBox.min.x > 0.05;
label.userData.hasDepth = geometry.boundingBox.max.z - geometry.boundingBox.min.z > 0.01;
scene.add(label);

let fontError = null;
try {
  new S.TextGeometry("x", { font: "comic" });
} catch (error) {
  fontError = error.name + ":" + error.feature;
}
label.userData.fontError = fontError;

S.mount(scene);
