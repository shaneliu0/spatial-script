// A texture that fails to load must dispatch textureError and leave the material usable.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, TextureLoader } = Spatial;
const scene = new Scene(); scene.add(new AmbientLight(0xffffff, 1));
const tex = new TextureLoader().load("asset://does-not-exist.png", () => { scene.userData.loaded = true; }, undefined, (e) => { scene.userData.textureError = true; });
const m = new Mesh(new BoxGeometry(0.15, 0.15, 0.15), new MeshStandardMaterial({ color: 0xffffff, map: tex })); m.name = "textured"; scene.add(m);
Spatial.onFrame((dt) => { m.rotation.y += dt; scene.userData.frame = Spatial.time.frame; });
Spatial.mount(scene);
