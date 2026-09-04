// Cycles, self-adds, and adding an object to two parents.
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;
const scene = new Scene(); scene.add(new AmbientLight(0xffffff, 1));
const a = new Group(); a.name = "a"; const b = new Group(); b.name = "b"; const c = new Group(); c.name = "c";
const m = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0x8844ff })); m.name = "m";
scene.add(a); a.add(b); b.add(c); c.add(m);
const results = scene.userData.results = {};
function attempt(name, fn) { try { fn(); results[name] = "ok"; } catch (e) { results[name] = "threw: " + e.message; } }
attempt("selfAdd", () => a.add(a));
attempt("ancestorIntoDescendant", () => c.add(a));      // would create a cycle a->b->c->a
attempt("sceneIntoChild", () => a.add(scene));
attempt("twoParents", () => { const g = new Group(); g.name = "shared"; a.add(g); b.add(g); results.sharedParent = g.parent && g.parent.name; });
Spatial.onFrame((dt) => { m.rotation.y += dt; scene.userData.frame = Spatial.time.frame; scene.userData.mParent = m.parent && m.parent.name; });
Spatial.mount(scene);
