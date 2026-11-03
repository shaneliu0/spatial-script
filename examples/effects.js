// effects.js -- a particle emitter, a portal onto a separate world, a
// billboarded TextGeometry label, and an opacity fade.

const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  SphereGeometry,
  TorusGeometry,
  PlaneGeometry,
  TextGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  AmbientLight,
  DirectionalLight,
  PointLight,
  ParticleEmitter,
  Portal,
  Vector3,
} = Spatial;

const scene = new Scene();

const ambient = new AmbientLight(0xffffff, 0.35);
ambient.name = "ambient";
scene.add(ambient);

const sun = new DirectionalLight(0xffffff, 2.2);
sun.name = "sun";
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

// -------------------------------------------------------------- particles

const sparks = new ParticleEmitter({
  shape: "cone",
  shapeSize: new Vector3(0.03, 0.03, 0.03),
  birthRate: 220,
  lifetime: 1.1,
  lifetimeVariation: 0.3,
  speed: 0.35,
  speedVariation: 0.15,
  size: 0.008,
  sizeVariation: 0.004,
  color: 0xffaa33,
  colorEnd: 0xff2200,
  opacity: 1,
  opacityEnd: 0,
  spreadAngle: 0.45,
  acceleration: new Vector3(0, -0.35, 0),
  loops: true,
  burstCount: 60,
});
sparks.name = "sparks";
sparks.position.set(-0.24, -0.1, 0);
scene.add(sparks);

const emitterBase = new Mesh(
  new SphereGeometry(0.03, 20, 14),
  new MeshStandardMaterial({ color: 0x442200, emissive: 0xaa4400, emissiveIntensity: 2, roughness: 0.6 }),
);
emitterBase.name = "emitterBase";
emitterBase.position.copy(sparks.position);
scene.add(emitterBase);

emitterBase.addEventListener("tap", () => {
  sparks.burst();
  console.log("burst");
});

// ------------------------------------------------------------ portal world

// The world group is added to the scene as usual; the consumer marks it so it
// only renders through the portal surface.
const otherWorld = new Group();
otherWorld.name = "otherWorld";
otherWorld.position.set(0.2, 0, -0.55);
scene.add(otherWorld);

const worldLight = new PointLight(0x66ddff, 4, 2, 2);
worldLight.name = "worldLight";
worldLight.position.set(0, 0.2, 0.1);
otherWorld.add(worldLight);

const worldFloor = new Mesh(
  new PlaneGeometry(0.6, 0.6),
  new MeshStandardMaterial({ color: 0x113344, roughness: 0.9 }),
);
worldFloor.name = "worldFloor";
worldFloor.rotation.x = -Math.PI / 2;
worldFloor.position.y = -0.18;
otherWorld.add(worldFloor);

const worldOrb = new Mesh(
  new SphereGeometry(0.07, 28, 20),
  new MeshStandardMaterial({ color: 0x22ffcc, emissive: 0x0a4d3f, roughness: 0.2, metalness: 0.5 }),
);
worldOrb.name = "worldOrb";
otherWorld.add(worldOrb);

const worldRing = new Mesh(
  new TorusGeometry(0.13, 0.012, 12, 40),
  new MeshStandardMaterial({ color: 0x88aaff, metalness: 0.8, roughness: 0.2 }),
);
worldRing.name = "worldRing";
worldRing.rotation.x = Math.PI / 2;
otherWorld.add(worldRing);

const portal = new Portal({ width: 0.3, height: 0.4, world: otherWorld, crossing: false });
portal.name = "portal";
portal.position.set(0.2, 0.02, -0.28);
scene.add(portal);

// ------------------------------------------------------- billboarded label

const label = new Mesh(
  new TextGeometry("SPATIAL", { size: 0.045, depth: 0.008 }),
  new MeshStandardMaterial({ color: 0xffffff, emissive: 0x333333, roughness: 0.4 }),
);
label.name = "label";
label.geometry.computeBoundingBox();
const bounds = label.geometry.boundingBox;
// Centre the generated glyph run on its own origin.
label.geometry.translate(-(bounds.max.x + bounds.min.x) / 2, -(bounds.max.y + bounds.min.y) / 2, 0);
label.position.set(0, 0.22, 0);
label.billboard = true;
scene.add(label);

// ------------------------------------------------------------ opacity fade

const fader = new Mesh(
  new BoxGeometry(0.12, 0.12, 0.12),
  new MeshBasicMaterial({ color: 0xaa66ff }),
);
fader.name = "fader";
fader.position.set(0, -0.08, 0.1);
scene.add(fader);

let fadeDirection = -1;

Spatial.onFrame((deltaTime, elapsed) => {
  // Object3D.opacity is the whole-object OpacityComponent value; it is not the
  // material's opacity.
  fader.opacity += fadeDirection * deltaTime * 0.5;
  if (fader.opacity <= 0.15) {
    fader.opacity = 0.15;
    fadeDirection = 1;
  } else if (fader.opacity >= 1) {
    fader.opacity = 1;
    fadeDirection = -1;
  }

  fader.rotation.y += deltaTime * 0.6;
  worldOrb.position.y = Math.sin(elapsed * 1.2) * 0.05;
  worldRing.rotation.z += deltaTime * 0.5;
  label.position.y = 0.22 + Math.sin(elapsed) * 0.01;
});

Spatial.mount(scene);
