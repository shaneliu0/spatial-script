// animation.js -- an AnimationMixer keyframe clip on position and quaternion,
// timers, and a TextGeometry label that counts frames.

const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  SphereGeometry,
  PlaneGeometry,
  TextGeometry,
  MeshStandardMaterial,
  AmbientLight,
  DirectionalLight,
  AnimationClip,
  AnimationMixer,
  VectorKeyframeTrack,
  QuaternionKeyframeTrack,
  NumberKeyframeTrack,
  Quaternion,
  Vector3,
  LoopRepeat,
} = Spatial;

const scene = new Scene();

const ambient = new AmbientLight(0xffffff, 0.4);
ambient.name = "ambient";
scene.add(ambient);

const sun = new DirectionalLight(0xffffff, 2.4);
sun.name = "sun";
sun.position.set(0.5, 1.1, 0.7);
sun.castShadow = true;
scene.add(sun);

const floor = new Mesh(
  new PlaneGeometry(0.9, 0.9),
  new MeshStandardMaterial({ color: 0x22252a, roughness: 0.95 }),
);
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.24;
floor.receiveShadow = true;
scene.add(floor);

// -------------------------------------------------------- the animated box

const box = new Mesh(
  new BoxGeometry(0.12, 0.12, 0.12),
  new MeshStandardMaterial({ color: 0x3366ff, roughness: 0.35, metalness: 0.15 }),
);
box.name = "box";
box.castShadow = true;
box.material.transparent = true;
scene.add(box);

const DURATION = 4;

const positionTrack = new VectorKeyframeTrack(
  ".position",
  [0, 1, 2, 3, 4],
  [
    -0.22, -0.1, 0,
    -0.11, 0.14, 0,
    0, -0.1, 0,
    0.11, 0.14, 0,
    0.22, -0.1, 0,
  ],
);

const spin = (angle) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle);
const quarters = [spin(0), spin(Math.PI / 2), spin(Math.PI), spin((3 * Math.PI) / 2), spin(2 * Math.PI - 0.001)];
const quaternionValues = [];
for (const q of quarters) quaternionValues.push(q.x, q.y, q.z, q.w);

const quaternionTrack = new QuaternionKeyframeTrack(".quaternion", [0, 1, 2, 3, 4], quaternionValues);

const opacityTrack = new NumberKeyframeTrack(
  ".material.opacity",
  [0, 2, 4],
  [1, 0.45, 1],
);

const clip = new AnimationClip("bounce", DURATION, [positionTrack, quaternionTrack, opacityTrack]);

const mixer = new AnimationMixer(box);
const action = mixer.clipAction(clip);
action.setLoop(LoopRepeat, Infinity);
action.play();

// The mixer writes straight into the core scene graph, so the flush diff picks
// the changes up; consumers need no animation plumbing for clips.
Spatial.onFrame((deltaTime) => {
  mixer.update(deltaTime);
});

// --------------------------------------------------- the frame count label

const labels = new Group();
labels.name = "labels";
labels.position.set(0, 0.22, 0);
scene.add(labels);

const labelMaterial = new MeshStandardMaterial({ color: 0xffffff, emissive: 0x222222, roughness: 0.5 });

let labelMesh = null;

function setLabel(text) {
  const geometry = new TextGeometry(text, { size: 0.035, depth: 0.006 });
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  geometry.translate(-(bounds.max.x + bounds.min.x) / 2, -(bounds.max.y + bounds.min.y) / 2, 0);

  if (labelMesh === null) {
    labelMesh = new Mesh(geometry, labelMaterial);
    labelMesh.name = "counter";
    labelMesh.billboard = true;
    labels.add(labelMesh);
  } else {
    // Assigning a new geometry emits a fresh GEOMETRY command.
    labelMesh.geometry.dispose();
    labelMesh.geometry = geometry;
  }
}

setLabel("frame 0");

// A repeating timer, driven by frame ticks rather than a host event loop.
const labelTimer = setInterval(() => {
  setLabel("frame " + Spatial.time.frame);
}, 500);

// A pulsing marker, restarted from a one-shot timer.
const marker = new Mesh(
  new SphereGeometry(0.03, 20, 14),
  new MeshStandardMaterial({ color: 0xff9933, emissive: 0x442200, roughness: 0.4 }),
);
marker.name = "marker";
marker.position.set(0, -0.2, 0.2);
scene.add(marker);

let pulsing = false;

setTimeout(() => {
  pulsing = true;
  console.log("marker pulse started");
}, 1000);

Spatial.onFrame((deltaTime, elapsed) => {
  if (!pulsing) return;
  const scale = 1 + Math.sin(elapsed * 4) * 0.35;
  marker.scale.setScalar(scale);
});

// Tapping the marker stops the label timer so the effect of clearInterval is
// visible in a dump.
marker.addEventListener("tap", () => {
  clearInterval(labelTimer);
  setLabel("stopped");
  console.log("label timer cleared");
});

Spatial.mount(scene);
