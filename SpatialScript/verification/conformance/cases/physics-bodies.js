const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const floor = new S.Mesh(new S.BoxGeometry(1, 0.02, 1), new S.MeshStandardMaterial());
floor.name = "floor";
floor.position.set(0, -0.2, 0);
floor.rigidBody = new S.RigidBody({ type: "static", shape: "mesh" });
scene.add(floor);

const ball = new S.Mesh(new S.SphereGeometry(0.05, 16, 12), new S.MeshStandardMaterial());
ball.name = "ball";
ball.position.set(0, 0.3, 0);
ball.rigidBody = new S.RigidBody({ type: "dynamic", mass: 2, friction: 0.3, restitution: 0.6, linearDamping: 0.1, angularDamping: 0.2 });
scene.add(ball);

const pill = new S.Mesh(new S.CapsuleGeometry(0.05, 0.1), new S.MeshStandardMaterial());
pill.name = "pill";
pill.position.set(-0.3, 0.2, 0);
pill.rigidBody = new S.RigidBody({ type: "kinematic" });
scene.add(pill);

const donut = new S.Mesh(new S.TorusGeometry(0.1, 0.03), new S.MeshStandardMaterial());
donut.name = "donut";
donut.position.set(0.3, 0.2, 0);
donut.rigidBody = new S.RigidBody({ isTrigger: true, gravity: false });
scene.add(donut);

const crate = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
crate.name = "crate";
crate.position.set(0, 0.2, 0.3);
crate.rigidBody = new S.RigidBody({});
scene.add(crate);

const plain = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
plain.name = "plain";
plain.position.set(0, 0.2, -0.3);
scene.add(plain);

S.onFrame(() => {
  if (S.time.frame !== 2) return;
  ball.rigidBody.mass = 5;
  ball.rigidBody.applyImpulse(new S.Vector3(0, 1, 0));
  ball.rigidBody.applyForce(new S.Vector3(0, 0, 1));
  ball.rigidBody.applyTorque(new S.Vector3(0, 0.5, 0));
  crate.rigidBody.setLinearVelocity(new S.Vector3(0.2, 0, 0));
  crate.rigidBody.setAngularVelocity(new S.Vector3(0, 1, 0));
});

S.mount(scene);
