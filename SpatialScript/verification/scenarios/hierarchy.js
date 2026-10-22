// Verifies nested hierarchies, inherited transforms, runtime reparenting, and removal.
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial, DirectionalLight, AmbientLight, Vector3 } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.6));
const sun = new DirectionalLight(0xffffff, 3);
sun.position.set(1, 2, 2);
scene.add(sun);

// Three levels: root group -> arm group -> hand mesh.
const root = new Group();
root.name = "root";
root.position.set(0, 0, 0);
scene.add(root);

const arm = new Group();
arm.name = "arm";
arm.position.set(0.25, 0, 0);
root.add(arm);

const hand = new Mesh(new BoxGeometry(0.08, 0.08, 0.08), new MeshStandardMaterial({ color: 0x33aa55 }));
hand.name = "hand";
hand.position.set(0.15, 0, 0);
arm.add(hand);

const pivot = new Mesh(new SphereGeometry(0.03), new MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: 0.2 }));
pivot.name = "pivot";
root.add(pivot);

// A free object that gets reparented at runtime.
const orphan = new Mesh(new SphereGeometry(0.05), new MeshStandardMaterial({ color: 0xcc3333 }));
orphan.name = "orphan";
orphan.position.set(-0.3, 0.2, 0);
scene.add(orphan);

let frame = 0;
Spatial.onFrame((dt) => {
  frame += 1;
  root.rotation.y += dt * 0.8;       // whole assembly spins
  arm.rotation.z = Math.sin(Spatial.time.elapsed) * 0.6;   // arm swings; hand must follow
  if (frame === 120) {
    // attach keeps the orphan's world position while making it a child of the hand
    hand.attach(orphan);
    console.log("attached orphan to hand; local pos", orphan.position.toArray().map(v => v.toFixed(3)).join(","));
  }
  if (frame === 240) {
    arm.remove(hand);   // hand and orphan disappear together
    console.log("removed hand subtree");
  }
  if (frame === 300) {
    arm.add(hand);      // and come back
    console.log("re-added hand subtree");
  }
  const wp = new Vector3();
  hand.getWorldPosition(wp);
  scene.userData.handWorld = wp.toArray();
  scene.userData.frame = frame;
});

Spatial.mount(scene);
