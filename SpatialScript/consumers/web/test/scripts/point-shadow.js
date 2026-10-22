// A point light above a cube over a floor: the floor must show the cube's shadow.
const S = require("spatial");
const scene = new S.Scene();

const floor = new S.Mesh(new S.BoxGeometry(2, 0.02, 2), new S.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }));
floor.name = "floor";
floor.position.y = -0.3;
floor.receiveShadow = true;
scene.add(floor);

const cube = new S.Mesh(new S.BoxGeometry(0.25, 0.25, 0.25), new S.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }));
cube.name = "cube";
cube.position.set(0, 0.05, 0);
cube.castShadow = true;
scene.add(cube);

const lamp = new S.PointLight(0xffffff, 6);
lamp.name = "lamp";
lamp.position.set(0, 0.9, 0);
lamp.castShadow = true;
lamp.distance = 0;
scene.add(lamp);

S.mount(scene);
