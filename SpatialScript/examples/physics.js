// physics.js -- dropped bodies on a static floor, a revolute joint pendulum,
// and an impulse on tap.

const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  SphereGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  MeshStandardMaterial,
  AmbientLight,
  DirectionalLight,
  RigidBody,
  Joint,
  Vector3,
} = Spatial;

const scene = new Scene();

const ambient = new AmbientLight(0xffffff, 0.4);
ambient.name = "ambient";
scene.add(ambient);

const sun = new DirectionalLight(0xffffff, 2.5);
sun.name = "sun";
sun.position.set(0.5, 1.2, 0.6);
sun.castShadow = true;
scene.add(sun);

Spatial.physics.gravity.set(0, -9.81, 0);

// --------------------------------------------------------------- the floor

const floor = new Mesh(
  new BoxGeometry(0.7, 0.02, 0.7),
  new MeshStandardMaterial({ color: 0x33383f, roughness: 0.95 }),
);
floor.name = "floor";
floor.position.set(0, -0.25, 0);
floor.receiveShadow = true;
floor.rigidBody = new RigidBody({ type: "static", shape: "box", friction: 0.8, restitution: 0.1 });
scene.add(floor);

// ------------------------------------------------------------ falling body

const droppers = new Group();
droppers.name = "droppers";
scene.add(droppers);

function drop(name, geometry, color, position, options) {
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 }));
  mesh.name = name;
  mesh.position.copy(position);
  mesh.castShadow = true;
  mesh.rigidBody = new RigidBody({ type: "dynamic", mass: 1, ...options });
  droppers.add(mesh);
  return mesh;
}

const crate = drop(
  "crate",
  new BoxGeometry(0.09, 0.09, 0.09),
  0x3366ff,
  new Vector3(-0.14, 0.22, 0),
  { restitution: 0.25, friction: 0.6 },
);

const bouncer = drop(
  "bouncer",
  new SphereGeometry(0.055, 24, 18),
  0xff5544,
  new Vector3(0.02, 0.3, 0.05),
  { restitution: 0.75, friction: 0.3, mass: 0.6 },
);

const pill = drop(
  "pill",
  new CapsuleGeometry(0.04, 0.07, 6, 16),
  0x44dd99,
  new Vector3(0.16, 0.26, -0.05),
  { restitution: 0.2, friction: 0.5 },
);

// -------------------------------------------------------- revolute pendulum

const hinge = new Mesh(
  new CylinderGeometry(0.012, 0.012, 0.05, 12),
  new MeshStandardMaterial({ color: 0x8899aa, metalness: 0.8, roughness: 0.3 }),
);
hinge.name = "hinge";
hinge.rotation.z = Math.PI / 2;
hinge.position.set(-0.28, 0.24, 0);
hinge.rigidBody = new RigidBody({ type: "static", shape: "capsule" });
scene.add(hinge);

const bob = new Mesh(
  new SphereGeometry(0.045, 24, 18),
  new MeshStandardMaterial({ color: 0xffcc33, metalness: 0.5, roughness: 0.25 }),
);
bob.name = "bob";
bob.position.set(-0.28, 0.06, 0);
bob.castShadow = true;
bob.rigidBody = new RigidBody({ type: "dynamic", mass: 1.5, restitution: 0.1, linearDamping: 0.05 });
scene.add(bob);

const pendulum = new Joint({
  type: "revolute",
  bodyA: hinge,
  bodyB: bob,
  anchorA: new Vector3(0, 0, 0),
  anchorB: new Vector3(0, 0.18, 0),
  axis: new Vector3(0, 0, 1),
  limits: null,
});
Spatial.physics.add(pendulum);

// ------------------------------------------------------------- interaction

const upward = new Vector3(0, 1.4, 0);
const sideways = new Vector3(0.9, 0.8, 0);

for (const body of [crate, bouncer, pill]) {
  body.addEventListener("tap", () => {
    body.rigidBody.applyImpulse(upward);
    console.log("kicked", body.name);
  });
  body.addEventListener("collisionstart", (event) => {
    const other = event.other ? event.other.name : "unknown";
    if (other === "floor") body.userData.landed = true;
  });
}

bob.addEventListener("tap", () => {
  bob.rigidBody.applyImpulse(sideways);
  console.log("pendulum pushed");
});

// Reset anything that falls off the world.
const resetHeight = new Vector3(0, 0.3, 0);

Spatial.onFrame(() => {
  for (const body of droppers.children) {
    if (body.position.y < -1) {
      body.position.copy(resetHeight);
      body.rigidBody.setLinearVelocity(new Vector3(0, 0, 0));
      body.rigidBody.setAngularVelocity(new Vector3(0, 0, 0));
    }
  }
});

Spatial.mount(scene);
