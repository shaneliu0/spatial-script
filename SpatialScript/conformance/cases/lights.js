const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const ambient = new S.AmbientLight(0x404040, 0.5);
ambient.name = "ambient";
scene.add(ambient);

const sunTarget = new S.Group();
sunTarget.name = "sunTarget";
scene.add(sunTarget);

const sun = new S.DirectionalLight(0xffffff, 2);
sun.name = "sun";
sun.position.set(0, 1, 0);
sun.target = sunTarget;
scene.add(sun);

const point = new S.PointLight(0xff0000, 5, 3, 2);
point.name = "point";
point.position.set(0.5, 0.5, 0);
scene.add(point);

const spotTarget = new S.Group();
spotTarget.name = "spotTarget";
spotTarget.position.set(1, 0, 0);
scene.add(spotTarget);

const spot = new S.SpotLight(0x00ff00, 8, 4, Math.PI / 6, 0.3, 2);
spot.name = "spot";
spot.position.set(0, 1, 0);
spot.target = spotTarget;
scene.add(spot);

S.mount(scene);
