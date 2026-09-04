// Verifies tap, hover, and drag on nested children, bubbling, and stopPropagation.
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial, DirectionalLight, AmbientLight, Vector3 } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 3); sun.position.set(1, 2, 2); scene.add(sun);

const parent = new Group(); parent.name = "parent"; scene.add(parent);
const base = new Mesh(new BoxGeometry(0.3, 0.04, 0.3), new MeshStandardMaterial({ color: 0x666666 }));
base.name = "base"; base.position.y = -0.1; parent.add(base);
const child = new Mesh(new SphereGeometry(0.06), new MeshStandardMaterial({ color: 0x3399ff }));
child.name = "child"; child.position.set(0, 0, 0); parent.add(child);
const grandchild = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshStandardMaterial({ color: 0xff9933 }));
grandchild.name = "grandchild"; grandchild.position.set(0.12, 0.05, 0); child.add(grandchild);
const stopper = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), new MeshStandardMaterial({ color: 0x33ff99 }));
stopper.name = "stopper"; stopper.position.set(-0.15, 0.05, 0); parent.add(stopper);

const log = scene.userData.log = [];
const record = (who, e) => { const line = `${e.type}@${who}<-${e.target.name}`; log.push(line); console.log(line); if (log.length > 40) log.shift(); };

for (const o of [parent, base, child, grandchild, stopper, scene]) {
  o.addEventListener("tap", (e) => record(o.name || "scene", e));
  o.addEventListener("hoverenter", (e) => record(o.name || "scene", e));
  o.addEventListener("hoverexit", (e) => record(o.name || "scene", e));
}
child.addEventListener("hoverenter", () => child.material.color.set(0xffffff));
child.addEventListener("hoverexit", () => child.material.color.set(0x3399ff));
let tapCount = 0;
grandchild.addEventListener("tap", () => grandchild.material.color.setHSL(((tapCount += 1) * 0.37) % 1, 0.7, 0.5));
stopper.addEventListener("tap", (e) => { e.stopPropagation(); stopper.scale.multiplyScalar(1.1); });

let start = null;
child.addEventListener("dragstart", (e) => { start = child.position.clone(); record("child", e); });
child.addEventListener("drag", (e) => { child.position.copy(start).add(e.translation); });
child.addEventListener("dragend", (e) => { record("child", e); start = null; });

Spatial.mount(scene);
