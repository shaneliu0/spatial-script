const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const holder = new S.Group();
holder.name = "holder";
holder.position.set(0.1, 0, 0);
scene.add(holder);

const ball = new S.Mesh(new S.SphereGeometry(0.05, 12, 8), new S.MeshStandardMaterial());
ball.name = "ball";
ball.position.set(0, 0.5, 0);
ball.rigidBody = new S.RigidBody({ type: "dynamic", mass: 1 });
holder.add(ball);

S.mount(scene);
