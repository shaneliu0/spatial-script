const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial, PointLight, RigidBody } = Spatial;

const scene = new Scene();

// No geometry and no material at all.
const bare = new Mesh();
bare.name = "bare";
scene.add(bare);

// Negative and zero sizes, and a segment count below the minimum.
const squashed = new Mesh(new BoxGeometry(-0.2, 0, undefined), new MeshStandardMaterial());
squashed.name = "squashed";
squashed.position.x = -0.3;
scene.add(squashed);

const ball = new Mesh(new SphereGeometry(-0.1, 0, -5), new MeshStandardMaterial({ opacity: 4 }));
ball.name = "ball";
ball.position.x = 0.3;
ball.rigidBody = new RigidBody({ mass: -2, friction: -1, restitution: -1 });
scene.add(ball);

// Every light scalar out of range.
const lamp = new PointLight(0xffffff, -5, -1, -1);
lamp.name = "lamp";
scene.add(lamp);

const results = {};
bare.userData.results = results;
function attempt(name, fn) {
  try { fn(); results[name] = "ok"; } catch (error) { results[name] = error.name; }
}
attempt("addPlainObject", () => scene.add({ name: "plain" }));
attempt("addNull", () => scene.add(null));
attempt("removeString", () => scene.remove("nope"));

Spatial.mount(scene);
