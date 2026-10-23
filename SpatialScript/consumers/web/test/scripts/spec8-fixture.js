// SPEC 8 fixture: one scene carrying every object kind and every phase 2
// feature, so the native dump's key set can be held against the core dump's.
const S = require("spatial");

const scene = new S.Scene();
scene.name = "fixture";
scene.userData.built = true;

// Lights: all four kinds, one with a shadow.
const ambient = new S.AmbientLight(0xffffff, 0.3);
ambient.name = "ambient";
scene.add(ambient);
const sun = new S.DirectionalLight(0xffeecc, 2);
sun.name = "sun";
sun.position.set(0.4, 0.6, 0.5);
sun.castShadow = true;
scene.add(sun);
const lamp = new S.PointLight(0xff8844, 3);
lamp.name = "lamp";
lamp.position.set(-0.3, 0.3, 0);
lamp.distance = 2;
lamp.decay = 2;
scene.add(lamp);
const spot = new S.SpotLight(0x88ccff, 4);
spot.name = "spot";
spot.position.set(0.3, 0.5, 0.2);
spot.angle = 0.5;
spot.penumbra = 0.3;
spot.castShadow = true;
scene.add(spot);

// A textured, interactive mesh with a rigid body and a joint to a static one.
const texture = new S.TextureLoader().load("asset://checker.png");
const crate = new S.Mesh(
  new S.BoxGeometry(0.2, 0.2, 0.2),
  new S.MeshStandardMaterial({ color: 0x8844ff, map: texture, metalness: 0.2, roughness: 0.6 }),
);
crate.name = "crate";
crate.position.set(0, 0.3, 0);
crate.castShadow = true;
crate.opacity = 0.8;
crate.renderOrder = 2;
crate.manipulable = true;
crate.addEventListener("tap", () => {});
crate.addEventListener("collisionstart", () => {});
crate.rigidBody = new S.RigidBody({ type: "dynamic", mass: 1, shape: "box" });
scene.add(crate);

const anchorPoint = new S.Mesh(new S.BoxGeometry(0.4, 0.02, 0.4), new S.MeshStandardMaterial({ color: 0x333333 }));
anchorPoint.name = "floor";
anchorPoint.position.set(0, -0.1, 0);
anchorPoint.receiveShadow = true;
anchorPoint.rigidBody = new S.RigidBody({ type: "static", shape: "box" });
scene.add(anchorPoint);
S.physics.add(new S.Joint({
  type: "revolute", bodyA: crate, bodyB: anchorPoint,
  anchorA: new S.Vector3(0, -0.1, 0), anchorB: new S.Vector3(0, 0.1, 0),
  axis: new S.Vector3(0, 0, 1), limits: null,
}));

// A multi-material mesh: two groups, two materials, one a shader graph fallback.
const panelGeometry = new S.BoxGeometry(0.2, 0.2, 0.2);
panelGeometry.addGroup(0, 18, 0);
panelGeometry.addGroup(18, 18, 1);
const panel = new S.Mesh(panelGeometry, [
  new S.MeshStandardMaterial({ color: 0x22cc88 }),
  new S.ShaderGraphMaterial({
    source: "asset://spatial-materials.usda",
    name: "Glow",
    parameters: { roughness: 0.3 },
    fallback: new S.MeshStandardMaterial({ color: 0xffaa00 }),
  }),
]);
panel.name = "panel";
panel.position.set(0.4, 0.2, 0);
scene.add(panel);

// Particles, a portal with its world, an anchor, and a billboard.
const sparks = new S.ParticleEmitter({ preset: "sparks", isEmitting: true });
sparks.name = "sparks";
sparks.position.set(-0.4, 0.2, 0);
scene.add(sparks);

const world = new S.Group();
world.name = "portal-world";
const inside = new S.Mesh(new S.SphereGeometry(0.08, 12, 8), new S.MeshStandardMaterial({ color: 0x2255ff }));
inside.name = "inside";
world.add(inside);
scene.add(world);
const portal = new S.Portal({ width: 0.3, height: 0.3, world, crossing: false });
portal.name = "portal";
portal.position.set(0, 0.6, -0.2);
scene.add(portal);

const anchor = new S.Anchor("head");
anchor.name = "head-anchor";
const badge = new S.Mesh(new S.BoxGeometry(0.05, 0.05, 0.01), new S.MeshStandardMaterial({ color: 0xffffff }));
badge.name = "badge";
badge.billboard = true;
badge.accessibility = { label: "badge", value: "new", hint: "look at it", isButton: true };
anchor.add(badge);
scene.add(anchor);

// Audio, video, a rigged asset, a character controller and a force field.
const chime = new S.PositionalAudio();
chime.name = "chime";
chime.setBuffer(new S.AudioLoader().load("asset://spatial-tone.wav"));
chime.setLoop(true);
chime.group = "effects";
scene.add(chime);

const screen = new S.VideoScreen({ url: { webm: "asset://spatial-bars.webm", mp4: "asset://spatial-bars.mp4" }, width: 0.3, muted: true });
screen.name = "screen";
screen.position.set(-0.5, 0.4, 0);
scene.add(screen);

const walker = new S.Mesh(new S.BoxGeometry(0.06, 0.16, 0.06), new S.MeshStandardMaterial({ color: 0xcc4444 }));
walker.name = "walker";
walker.position.set(0.2, 0.1, 0.2);
walker.characterController = new S.CharacterController({ radius: 0.03, height: 0.16, gravity: true });
scene.add(walker);

const breeze = new S.ConstantForceField({ force: new S.Vector3(0.1, 0, 0), radius: 2 });
breeze.name = "breeze";
scene.add(breeze);

const rig = new S.Group();
rig.name = "rig-holder";
scene.add(rig);
S.loadAsset({ glb: "asset://rig.glb" }).then((asset) => {
  asset.name = "rig";
  rig.add(asset);
  if (asset.skeleton) asset.skeleton.setJointRotation("head", new S.Quaternion(0, 0.2, 0, 0.98));
  if (asset.blendShapes) asset.blendShapes.set("widen", 0.4);
});

// A scripted camera, scene understanding, render options and the environment.
const eye = new S.PerspectiveCamera(55, 1, 0.02, 30);
eye.name = "eye";
eye.position.set(0, 0.3, 1.2);
scene.add(eye);
S.camera = eye;
S.sceneUnderstanding = { collision: true, occlusion: false, physics: false, shadows: true };
S.environment = new S.ImageBasedLight("asset://studio-env.png", 1.5);

S.onFrame(() => {
  if (S.time.frame === 2) walker.characterController.move(new S.Vector3(0.01, 0, 0));
});
S.mount(scene);
