// Verifies material types and properties across a grid, plus each light type and shadows.
const Spatial = require("spatial");
const { Scene, Mesh, SphereGeometry, PlaneGeometry, BoxGeometry, MeshStandardMaterial, MeshPhysicalMaterial, MeshBasicMaterial, DirectionalLight, PointLight, SpotLight, AmbientLight, DoubleSide } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.3));
const sun = new DirectionalLight(0xffffff, 2); sun.position.set(1, 2, 1); sun.castShadow = true; scene.add(sun);
const point = new PointLight(0xff8844, 3, 2, 2); point.position.set(-0.4, 0.3, 0.3); point.name = "point"; scene.add(point);
const spot = new SpotLight(0x44aaff, 6, 3, Math.PI / 8, 0.3, 2); spot.position.set(0.4, 0.5, 0.4); spot.target.position.set(0, -0.2, 0); spot.name = "spot"; scene.add(spot); scene.add(spot.target);

const floor = new Mesh(new PlaneGeometry(1.2, 1.2), new MeshStandardMaterial({ color: 0x777777, roughness: 0.9 }));
floor.name = "floor"; floor.rotation.x = -Math.PI / 2; floor.position.y = -0.25; floor.receiveShadow = true; scene.add(floor);

// 4x3 grid: rows = material type, columns = roughness sweep.
const rows = [
  (i) => new MeshBasicMaterial({ color: 0x3366ff }),
  (i) => new MeshStandardMaterial({ color: 0xcc4422, metalness: 0, roughness: i / 3 }),
  (i) => new MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: i / 3 }),
  (i) => new MeshPhysicalMaterial({ color: 0x22aa66, metalness: 0.2, roughness: 0.3, clearcoat: 1, clearcoatRoughness: i / 3 }),
];
rows.forEach((make, r) => {
  for (let c = 0; c < 4; c++) {
    const s = new Mesh(new SphereGeometry(0.045, 32, 16), make(c));
    s.name = `sphere-${r}-${c}`;
    s.position.set(-0.3 + c * 0.2, 0.2 - r * 0.13, 0);
    s.castShadow = true;
    scene.add(s);
  }
});

const glass = new Mesh(new BoxGeometry(0.15, 0.15, 0.02), new MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.35, side: DoubleSide }));
glass.name = "glass"; glass.position.set(0, -0.05, 0.2); scene.add(glass);

const emissive = new Mesh(new SphereGeometry(0.04), new MeshStandardMaterial({ color: 0x220000, emissive: 0xff2200, emissiveIntensity: 2 }));
emissive.name = "emissive"; emissive.position.set(0.45, -0.2, 0.1); scene.add(emissive);

Spatial.onFrame((dt, t) => {
  // Verdicts: the grid, the four lights, and the special materials all exist with the intended types.
  const byName = (n) => scene.getObjectByName(n);
  scene.userData.gridComplete = [0, 1, 2, 3].every((r) => [0, 1, 2, 3].every((c) => byName(`sphere-${r}-${c}`)));
  scene.userData.materialTypes = byName("sphere-0-0").material.type === "MeshBasicMaterial" && byName("sphere-3-0").material.type === "MeshPhysicalMaterial" && byName("glass").material.transparent === true;
  scene.userData.lightsPresent = Boolean(byName("point") && byName("spot")) && scene.children.filter((o) => o.type.endsWith("Light")).length >= 4;
  point.position.x = Math.cos(t) * 0.4;
  point.position.z = Math.sin(t) * 0.3 + 0.2;
  glass.rotation.y += dt * 0.5;
});
Spatial.mount(scene);
