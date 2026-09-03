const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial({ color: 0xff0000 }));
box.name = "box";
box.material.transparent = true;
scene.add(box);

const positionTrack = new S.VectorKeyframeTrack(".position", [0, 1], [0, 0, 0, 0, 0.4, 0]);

const from = new S.Quaternion();
const to = new S.Quaternion().setFromAxisAngle(new S.Vector3(0, 1, 0), Math.PI / 2);
const quaternionTrack = new S.QuaternionKeyframeTrack(
  ".quaternion",
  [0, 1],
  [from.x, from.y, from.z, from.w, to.x, to.y, to.z, to.w],
);

const opacityTrack = new S.NumberKeyframeTrack(".opacity", [0, 1], [1, 0]);
const materialOpacityTrack = new S.NumberKeyframeTrack(".material.opacity", [0, 1], [1, 0.5]);
const colorTrack = new S.ColorKeyframeTrack(".material.color", [0, 1], [1, 0, 0, 0, 0, 1]);

const clip = new S.AnimationClip("rise", 1, [
  positionTrack,
  quaternionTrack,
  opacityTrack,
  materialOpacityTrack,
  colorTrack,
]);

const mixer = new S.AnimationMixer(box);
const action = mixer.clipAction(clip);
action.setLoop(S.LoopOnce, 1);
action.clampWhenFinished = true;
action.play();

box.userData.duration = clip.duration;
box.userData.trackCount = clip.tracks.length;

S.onFrame((deltaTime) => mixer.update(deltaTime));

S.mount(scene);
