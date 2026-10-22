// Wrong argument types and missing arguments an agent might produce.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial, AmbientLight, PointLight } = Spatial;
const scene = new Scene(); scene.add(new AmbientLight(0xffffff, 1));
const results = scene.userData.results = {};
function attempt(name, fn) { try { fn(); results[name] = "ok"; } catch (e) { results[name] = "threw: " + e.message; } }
attempt("meshNoArgs", () => { const m = new Mesh(); m.name = "noargs"; scene.add(m); });
attempt("negativeBox", () => { const m = new Mesh(new BoxGeometry(-1, 0, undefined), new MeshStandardMaterial()); m.name = "negbox"; scene.add(m); });
attempt("badColor", () => { const m = new Mesh(new SphereGeometry(0.05), new MeshStandardMaterial({ color: "not-a-color" })); m.name = "badcolor"; m.position.x = 0.2; scene.add(m); });
attempt("nullMaterial", () => { const m = new Mesh(new SphereGeometry(0.05), null); m.name = "nullmat"; m.position.x = -0.2; scene.add(m); });
attempt("materialLater", () => { const m = scene.getObjectByName("nullmat"); if (m) m.material = new MeshStandardMaterial({ color: 0x00ffff }); });
attempt("undefinedGeometry", () => { const m = new Mesh(undefined, new MeshStandardMaterial()); m.name = "undefgeo"; scene.add(m); });
attempt("listenerNotFunction", () => { scene.addEventListener("tap", "not a function"); });
attempt("addNonObject", () => { scene.add({ name: "plain" }); });
attempt("addNull", () => { scene.add(null); });
attempt("stringPosition", () => { const m = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshStandardMaterial()); m.name = "strpos"; m.position.set("a", "b", "c"); scene.add(m); });
attempt("lightNegative", () => { const l = new PointLight(0xffffff, -5, -1, -1); l.name = "neglight"; scene.add(l); });
attempt("removeTwice", () => { const m = scene.getObjectByName("strpos"); scene.remove(m); scene.remove(m); });
attempt("removeNotChild", () => { const m = new Mesh(); scene.remove(m); });
attempt("materialArray", () => { const m = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), [new MeshStandardMaterial(), new MeshStandardMaterial()]); m.name = "matarray"; scene.add(m); });
Spatial.onFrame(() => { scene.userData.frame = Spatial.time.frame; });
Spatial.mount(scene);
