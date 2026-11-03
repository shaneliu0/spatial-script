// Verifies rotation orders, scale, lookAt, matrix application, world queries, and shear rejection.
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, ConeGeometry, CylinderGeometry, MeshStandardMaterial, DirectionalLight, AmbientLight, Vector3, Matrix4, Quaternion, Euler } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 3); sun.position.set(1, 3, 2); scene.add(sun);

// A cone that always looks at a moving target.
const target = new Mesh(new BoxGeometry(0.04, 0.04, 0.04), new MeshStandardMaterial({ color: 0xff4444 }));
target.name = "target"; scene.add(target);
const looker = new Mesh(new ConeGeometry(0.05, 0.15, 16), new MeshStandardMaterial({ color: 0x44ff88 }));
looker.name = "looker"; looker.position.set(-0.3, 0, 0);
looker.geometry.rotateX(Math.PI / 2);   // cone tip along +Z so lookAt points the tip
scene.add(looker);

// Non-uniform scale on a cylinder (allowed: scale itself is TRS).
const bar = new Mesh(new CylinderGeometry(0.03, 0.03, 0.1, 16), new MeshStandardMaterial({ color: 0x8888ff }));
bar.name = "bar"; bar.position.set(0.3, 0, 0); bar.scale.set(1, 3, 1);
scene.add(bar);

// applyMatrix4 with a valid TRS matrix.
const mover = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), new MeshStandardMaterial({ color: 0xffaa00 }));
mover.name = "mover";
const m = new Matrix4().compose(new Vector3(0, 0.3, 0), new Quaternion().setFromEuler(new Euler(0.3, 0.6, 0.1)), new Vector3(1.5, 1.5, 1.5));
mover.applyMatrix4(m);
scene.add(mover);

// A shear matrix must be rejected without killing the scene.
const sheared = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshStandardMaterial({ color: 0x000000 }));
sheared.name = "sheared";
scene.add(sheared);

Spatial.onFrame((dt, t) => {
  target.position.set(Math.cos(t) * 0.3, Math.sin(t * 1.3) * 0.2, Math.sin(t) * 0.2);
  looker.lookAt(target.position);
  bar.rotation.z = t * 0.5;
  const wp = new Vector3(); looker.getWorldPosition(wp);
  const wq = new Quaternion(); looker.getWorldQuaternion(wq);
  scene.userData.lookerWorld = [...wp.toArray(), ...wq.toArray()].map(v => +v.toFixed(3));
  if (Spatial.time.frame === 60) {
    // The shear applied at frame 30 must have been reported by now.
    scene.userData.shearRejected = Spatial.dump({ objects: false }).errors.some((e) => String(e).includes("sheared"));
  }
  if (Spatial.time.frame === 30) {
    // Shear is applied once; the core must report it in dump().errors and keep every other object running.
    const shear = new Matrix4().set(1, 0.5, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1);
    sheared.applyMatrix4(shear);
  }
  if (Spatial.time.frame === 90) {
    // Restore a valid matrix; the error must stop being reported and the object moves again.
    sheared.matrix.identity();
    sheared.matrix.decompose(sheared.position, sheared.quaternion, sheared.scale);
    sheared.position.set(0, -0.3, 0);
    scene.userData.shearRestored = true;
  }
  scene.userData.frame = Spatial.time.frame;
});
Spatial.mount(scene);
