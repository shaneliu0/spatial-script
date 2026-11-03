// Verifies stacking, kinematic platforms, triggers, raycast, teleport, and a joint.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, SphereGeometry, PlaneGeometry, MeshStandardMaterial, DirectionalLight, AmbientLight, RigidBody, Joint, Vector3 } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 3); sun.position.set(1, 3, 2); scene.add(sun);

const floor = new Mesh(new BoxGeometry(1.2, 0.02, 1.2), new MeshStandardMaterial({ color: 0x555555 }));
floor.name = "floor"; floor.position.y = -0.3; floor.rigidBody = new RigidBody({ type: "static", friction: 0.8 }); scene.add(floor);

// Stack of three cubes.
for (let i = 0; i < 3; i++) {
  const c = new Mesh(new BoxGeometry(0.08, 0.08, 0.08), new MeshStandardMaterial({ color: 0x3366ff + i * 0x203000 }));
  c.name = `stack-${i}`; c.position.set(-0.3, -0.25 + i * 0.09, 0);
  c.rigidBody = new RigidBody({ mass: 0.5, friction: 0.8, restitution: 0.05 });
  scene.add(c);
}

// Kinematic platform sliding back and forth with a ball riding on it.
const platform = new Mesh(new BoxGeometry(0.2, 0.02, 0.2), new MeshStandardMaterial({ color: 0x88aa44 }));
platform.name = "platform"; platform.position.set(0.1, -0.15, 0);
platform.rigidBody = new RigidBody({ type: "kinematic" }); scene.add(platform);
const rider = new Mesh(new SphereGeometry(0.04), new MeshStandardMaterial({ color: 0xffaa00, metalness: 0.5 }));
rider.name = "rider"; rider.position.set(0.1, 0, 0); rider.rigidBody = new RigidBody({ mass: 0.2, friction: 1 }); scene.add(rider);

// Trigger volume counts entries.
const trigger = new Mesh(new BoxGeometry(0.15, 0.15, 0.15), new MeshStandardMaterial({ color: 0xff44ff, transparent: true, opacity: 0.25 }));
trigger.name = "trigger"; trigger.position.set(0.4, -0.2, 0);
trigger.rigidBody = new RigidBody({ type: "static", isTrigger: true }); scene.add(trigger);
scene.userData.triggerEnters = 0;
trigger.addEventListener("collisionstart", (e) => { scene.userData.triggerEnters += 1; console.log("trigger entered by", e.other.name); });

// A ball dropped into the trigger, teleported back up on tap.
const dropper = new Mesh(new SphereGeometry(0.03), new MeshStandardMaterial({ color: 0x44ffff }));
dropper.name = "dropper"; dropper.position.set(0.4, 0.3, 0); dropper.rigidBody = new RigidBody({ mass: 0.1, restitution: 0.4 }); scene.add(dropper);
dropper.addEventListener("tap", () => { dropper.position.set(0.4, 0.3, 0); console.log("teleported dropper"); });
floor.addEventListener("tap", () => { dropper.position.set(0.4, 0.3, 0); console.log("teleported dropper via floor tap"); });

// Pendulum: a fixed anchor body with a revolute joint to a swinging bob.
const hinge = new Mesh(new BoxGeometry(0.03, 0.03, 0.03), new MeshStandardMaterial({ color: 0xffffff }));
hinge.name = "hinge"; hinge.position.set(-0.05, 0.3, 0); hinge.rigidBody = new RigidBody({ type: "static" }); scene.add(hinge);
const bob = new Mesh(new SphereGeometry(0.035), new MeshStandardMaterial({ color: 0xff3333 }));
bob.name = "bob"; bob.position.set(0.15, 0.3, 0); bob.rigidBody = new RigidBody({ mass: 0.3, angularDamping: 0.1 }); scene.add(bob);
Spatial.physics.add(new Joint({ type: "revolute", bodyA: hinge, bodyB: bob, anchorA: new Vector3(0, 0, 0), anchorB: new Vector3(-0.2, 0, 0), axis: new Vector3(0, 0, 1) }));

Spatial.onFrame((dt, t) => {
  platform.position.x = 0.1 + Math.sin(t * 0.8) * 0.15;
  if (Spatial.time.frame % 60 === 0) {
    const hits = Spatial.raycast(new Vector3(-0.3, 0.5, 0), new Vector3(0, -1, 0));
    scene.userData.rayTop = hits.length ? hits[0].object.name : null;
    // Physics parity is structural: record facts, not trajectories.
    scene.userData.stackIntact = scene.getObjectByName("stack-2").position.y > scene.getObjectByName("stack-1").position.y && scene.getObjectByName("stack-1").position.y > scene.getObjectByName("stack-0").position.y;
    scene.userData.bobHangsBelowHinge = bob.position.y < hinge.position.y;
  }
});
Spatial.mount(scene);
