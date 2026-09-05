// basics.js -- geometry, materials, lights, rotation, tap and drag.
// Everything sits within about 0.4 m of the origin so it fills the Mac window
// with the camera roughly 1 m away.

const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  SphereGeometry,
  PlaneGeometry,
  MeshStandardMaterial,
  AmbientLight,
  DirectionalLight,
  PointLight,
  Color,
  Vector3,
} = Spatial;

const scene = new Scene();

// ---------------------------------------------------------------- lighting

const ambient = new AmbientLight(0xffffff, 0.35);
ambient.name = "ambient";
scene.add(ambient);

const sun = new DirectionalLight(0xfff4e6, 2.5);
sun.name = "sun";
sun.position.set(0.6, 1.2, 0.8);
sun.castShadow = true;
scene.add(sun);

const rim = new PointLight(0x88bbff, 3, 2, 2);
rim.name = "rim";
rim.position.set(-0.5, 0.3, -0.4);
scene.add(rim);

// ------------------------------------------------------------------- floor

const floor = new Mesh(
  new PlaneGeometry(0.9, 0.9),
  new MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.9, metalness: 0 }),
);
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.2;
floor.receiveShadow = true;
scene.add(floor);

// ------------------------------------------------------------------ shapes

const shapes = new Group();
shapes.name = "shapes";
scene.add(shapes);

const cube = new Mesh(
  new BoxGeometry(0.16, 0.16, 0.16),
  new MeshStandardMaterial({ color: 0x3366ff, roughness: 0.35, metalness: 0.1 }),
);
cube.name = "cube";
cube.position.set(-0.18, 0, 0);
cube.castShadow = true;
shapes.add(cube);

const ball = new Mesh(
  new SphereGeometry(0.09, 32, 24),
  new MeshStandardMaterial({ color: 0xff9933, roughness: 0.2, metalness: 0.6 }),
);
ball.name = "ball";
ball.position.set(0.18, 0, 0);
ball.castShadow = true;
shapes.add(ball);

// ------------------------------------------------------------ interaction

const PALETTE = [0x3366ff, 0xff3366, 0x33cc88, 0xffcc33, 0xaa66ff];
let paletteIndex = 0;

cube.addEventListener("tap", () => {
  paletteIndex = (paletteIndex + 1) % PALETTE.length;
  cube.material.color.set(PALETTE[paletteIndex]);
  console.log("cube colour is now", cube.material.color.getHexString());
});

ball.addEventListener("tap", (event) => {
  ball.material.color.copy(new Color().setHSL(Math.random(), 0.7, 0.55));
  console.log("ball tapped at", event.point.toArray().map((v) => v.toFixed(3)).join(", "));
});

// The script owns the position of a dragged object: the consumer only reports
// the world-space displacement since dragstart.
const dragOrigin = new Vector3();

for (const target of [cube, ball]) {
  target.addEventListener("dragstart", () => {
    dragOrigin.copy(target.position);
    target.opacity = 0.7;
  });
  target.addEventListener("drag", (event) => {
    target.position.copy(dragOrigin).add(event.translation);
  });
  target.addEventListener("dragend", () => {
    target.opacity = 1;
  });
  target.addEventListener("hoverenter", () => {
    target.hoverEffect = "highlight";
  });
  target.addEventListener("hoverexit", () => {
    target.hoverEffect = null;
  });
}

// ------------------------------------------------------------------- frame

Spatial.onFrame((deltaTime, elapsed) => {
  cube.rotation.y += deltaTime * 0.8;
  cube.rotation.x += deltaTime * 0.3;
  ball.position.y = Math.sin(elapsed * 1.5) * 0.06;
});

Spatial.mount(scene);
