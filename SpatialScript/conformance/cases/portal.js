const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const innerWorld = new S.Group();
innerWorld.name = "innerWorld";
scene.add(innerWorld);

const inner = new S.Mesh(new S.SphereGeometry(0.1, 16, 12), new S.MeshStandardMaterial({ color: 0x00ffff }));
inner.name = "inner";
inner.position.set(0, 0, -0.4);
innerWorld.add(inner);

const doorway = new S.Portal({ width: 0.4, height: 0.6, world: innerWorld, crossing: true });
doorway.name = "doorway";
doorway.position.set(0, 0, -0.3);
scene.add(doorway);

S.mount(scene);
