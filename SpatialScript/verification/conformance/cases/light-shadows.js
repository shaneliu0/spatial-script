const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const floor = new S.Mesh(new S.PlaneGeometry(1, 1), new S.MeshStandardMaterial());
floor.name = "floor";
floor.receiveShadow = true;
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.2;
scene.add(floor);

const caster = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
caster.name = "caster";
caster.castShadow = true;
caster.receiveShadow = false;
scene.add(caster);

const sun = new S.DirectionalLight(0xffffff, 2);
sun.name = "sun";
sun.position.set(0.5, 1, 0.5);
sun.castShadow = true;
scene.add(sun);

const spot = new S.SpotLight(0xffffff, 4, 3, 0.5, 0.2, 2);
spot.name = "spot";
spot.position.set(0, 1, 0);
spot.castShadow = true;
scene.add(spot);

const lamp = new S.PointLight(0xffffff, 3);
lamp.name = "lamp";
lamp.castShadow = true;
scene.add(lamp);

S.mount(scene);
