// asset-control.js -- loading a model, playing its animations, and posing its
// rig: joints and blend-shape weights when the asset has them, and a scene
// that still works when it has neither.
//
// Everything sits within about 0.4 m of the origin so it fills the Mac window
// with the camera roughly 1 m away.
//
// `asset.skeleton` and `asset.blendShapes` are null until the consumer
// reports what the file actually contains, and they stay null for an asset
// with no rig and no shapes. Every use below is behind that check.

const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  PlaneGeometry,
  MeshStandardMaterial,
  AmbientLight,
  DirectionalLight,
  Quaternion,
  Euler,
} = Spatial;

const scene = new Scene();

const ambient = new AmbientLight(0xffffff, 0.45);
ambient.name = "ambient";
scene.add(ambient);

const sun = new DirectionalLight(0xfff4e8, 2.5);
sun.name = "sun";
sun.position.set(0.5, 1.2, 0.7);
sun.castShadow = true;
scene.add(sun);

const floor = new Mesh(
  new PlaneGeometry(0.9, 0.9),
  new MeshStandardMaterial({ color: 0x23262b, roughness: 0.95 }),
);
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.22;
floor.receiveShadow = true;
scene.add(floor);

// The asset is parented here rather than to the scene, so one transform
// frames it no matter what scale the file was authored at.
const holder = new Group();
holder.name = "holder";
holder.position.set(0, -0.22, 0);
scene.add(holder);

// A plinth, so the scene reads as a scene before the model arrives.
const plinth = new Mesh(
  new BoxGeometry(0.3, 0.02, 0.3),
  new MeshStandardMaterial({ color: 0x333a44, roughness: 0.8 }),
);
plinth.name = "plinth";
plinth.position.set(0, -0.23, 0);
plinth.receiveShadow = true;
scene.add(plinth);

// What the frame callback drives, once there is anything to drive.
let model = null;
let rig = null;
let shapes = null;
let smileName = null;
let headJoint = null;
let animations = [];
let animationIndex = 0;

const headRotation = new Quaternion();
const headEuler = new Euler();

// The whole model is offered to both backends: RealityKit takes the usdz,
// three the glb, and the other url is simply unused.
Spatial.loadAsset({ usdz: "asset://rig.usdz", glb: "asset://rig.glb" })
  .then((asset) => {
    model = asset;
    model.name = "figure";
    holder.add(model);

    // Fit whatever came out of the file into a 0.3 m box. The bounding box is
    // the asset's own, reported with the load.
    const size = model.boundingBox.max.clone().sub(model.boundingBox.min);
    const largest = Math.max(size.x, size.y, size.z);
    if (largest > 0) model.scale.setScalar(0.3 / largest);

    animations = model.animations.slice();
    console.log("figure has", animations.length, "animations");
    if (animations.length > 0) model.playAnimation(animations[0], { loop: true, speed: 1 });

    // --------------------------------------------------------- the rig

    // Null for a static prop; a joint list for anything skinned.
    if (model.skeleton === null) {
      console.log("figure has no skeleton; the pose stays as authored");
    } else {
      rig = model.skeleton;
      // Whichever of these the file happens to name.
      headJoint = pickJoint(rig.joints, ["head", "Head", "neck_02", "mixamorig:Head"]);
      // Ask the consumer to report the real joint transforms back: a playing
      // animation owns the pose, so this is the only way to read where a
      // joint actually is while it runs.
      rig.track(true);
      console.log("figure rig has", rig.joints.length, "joints");
    }

    // ------------------------------------------------------ blend shapes

    if (model.blendShapes === null) {
      console.log("figure has no blend shapes");
    } else {
      shapes = model.blendShapes;
      smileName = pickJoint(shapes.names, ["smile", "Smile", "mouthSmile"]);
      if (smileName === null) console.log("figure has no smile shape among", shapes.names.length);
    }
  })
  .catch((error) => {
    // A url the containment rules refuse, a backend with no usable format, or
    // a file the consumer could not open.
    console.warn("figure could not be loaded:", error.message);
  });

/** The first of `wanted` that this asset actually has, or null. */
function pickJoint(available, wanted) {
  for (let i = 0; i < wanted.length; i += 1) {
    if (available.indexOf(wanted[i]) !== -1) return wanted[i];
  }
  return null;
}

// ------------------------------------------------------------- interaction

plinth.addEventListener("tap", () => {
  if (model === null || animations.length === 0) return;
  animationIndex = (animationIndex + 1) % (animations.length + 1);
  if (animationIndex === animations.length) {
    // Past the end of the list: stop, which hands the pose back to the
    // script's own joint edits.
    model.stopAnimation();
    console.log("animation stopped");
    return;
  }
  model.playAnimation(animations[animationIndex], { loop: true, speed: 1 });
  console.log("playing", animations[animationIndex]);
});

// ------------------------------------------------------------------- frame

Spatial.onFrame((deltaTime, elapsed) => {
  holder.rotation.y += deltaTime * 0.25;

  // A joint edit is script-driven, so it is overridden while a native
  // animation is running and takes over again once it stops.
  if (rig !== null && headJoint !== null) {
    headEuler.set(0, Math.sin(elapsed * 0.9) * 0.35, Math.sin(elapsed * 1.7) * 0.12);
    headRotation.setFromEuler(headEuler);
    rig.setJointRotation(headJoint, headRotation);

    // Reported by the consumer when tracking is on, so this is where the
    // joint really ended up rather than where it was asked to go.
    const actual = rig.getJointTransform(headJoint);
    if (actual !== null) holder.userData.headHeight = actual.position.y;
  }

  // Weights are 0..1 and clamped; a name the asset does not have is ignored
  // with a warning rather than an error, but it is cheaper not to ask.
  if (shapes !== null && smileName !== null) {
    shapes.set(smileName, (Math.sin(elapsed * 1.3) + 1) / 2);
  }
});

Spatial.mount(scene);
