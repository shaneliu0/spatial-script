// Agents write top-level await for assets; the body must run as an async function.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;
const scene = new Scene(); scene.add(new AmbientLight(0xffffff, 1));
const m = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0x22ccff })); m.name = "before-await"; scene.add(m);
Spatial.mount(scene);
await new Promise((resolve) => setTimeout(resolve, 50));
const later = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshStandardMaterial({ color: 0xffffff })); later.name = "after-await"; later.position.y = 0.2; scene.add(later);
scene.userData.afterAwait = true;
try { await Spatial.loadAsset({ glb: "asset://missing.glb", usdz: "asset://missing.usdz" }); } catch (e) { scene.userData.assetError = e instanceof Error && e.message.length > 0; }
throw new Error("late failure after await must be a runtime error, not a load error");
