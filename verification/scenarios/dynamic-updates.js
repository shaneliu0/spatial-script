// Verifies adding and removing entities over time and mutating materials, geometry, and visibility in place.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, SphereGeometry, ConeGeometry, TorusGeometry, MeshStandardMaterial, MeshBasicMaterial, DirectionalLight, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 3);
sun.position.set(-1, 2, 2);
scene.add(sun);

const ring = [];
const MAX = 12;
let frame = 0;

const morph = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial({ color: 0x4477ff, metalness: 0.2, roughness: 0.6 }));
morph.name = "morph";
morph.position.set(0, 0.25, 0);
scene.add(morph);

const blinker = new Mesh(new SphereGeometry(0.05), new MeshBasicMaterial({ color: 0xffcc00 }));
blinker.name = "blinker";
blinker.position.set(0, -0.25, 0);
scene.add(blinker);

Spatial.onFrame((dt) => {
  frame += 1;
  // Add one cube every 20 frames until MAX, then start removing the oldest.
  if (frame % 20 === 0) {
    if (ring.length < MAX) {
      const i = ring.length;
      const m = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshStandardMaterial({ color: (i * 0x152535) & 0xffffff }));
      m.name = `ring-${i}`;
      const a = (i / MAX) * Math.PI * 2;
      m.position.set(Math.cos(a) * 0.35, 0, Math.sin(a) * 0.35);
      scene.add(m);
      ring.push(m);
    } else {
      const oldest = ring.shift();
      scene.remove(oldest);
      Spatial.destroy(oldest);   // free the native entity, not just detach it
      console.log("destroyed", oldest.name);
    }
  }
  // Material mutated in place: color cycles, metalness ramps.
  morph.material.color.setHSL((Spatial.time.elapsed * 0.1) % 1, 0.7, 0.5);
  morph.material.metalness = (Math.sin(Spatial.time.elapsed) + 1) / 2;
  morph.rotation.x += dt; morph.rotation.y += dt * 0.7;
  // Geometry swapped every 90 frames.
  if (frame % 90 === 0) {
    const cycle = (frame / 90) % 3;
    morph.geometry = cycle === 0 ? new BoxGeometry(0.12, 0.12, 0.12) : cycle === 1 ? new ConeGeometry(0.08, 0.16, 24) : new TorusGeometry(0.07, 0.025, 12, 32);
    console.log("geometry now", morph.geometry.type);
  }
  // Visibility toggles every 30 frames.
  if (frame % 30 === 0) blinker.visible = !blinker.visible;
  scene.userData.frame = frame;
  scene.userData.ringCount = ring.length;
});

Spatial.mount(scene);
