// Real audio, video and a rigged asset, for the browser-only phase 2 tests.
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));

const chime = new S.Audio();
chime.name = "chime";
chime.setBuffer(new S.AudioLoader().load("asset://spatial-tone.wav"));
chime.setLoop(true);
chime.setVolume(0.4);
scene.add(chime);

const screen = new S.VideoScreen({ url: "asset://spatial-bars.webm", width: 0.4, muted: true, loop: true });
screen.name = "screen";
screen.position.x = 0.5;
scene.add(screen);

const holder = new S.Group();
holder.name = "holder";
scene.add(holder);

S.loadAsset({ glb: "asset://rig.glb" }).then((asset) => {
  asset.name = "rig";
  holder.add(asset);
  scene.userData.joints = asset.skeleton ? asset.skeleton.joints.slice() : null;
  scene.userData.blendShapes = asset.blendShapes ? asset.blendShapes.names.slice() : null;
  if (asset.blendShapes) asset.blendShapes.set("widen", 0.75);
  if (asset.skeleton) asset.skeleton.setJointRotation("head", new S.Quaternion(0, 0.3826834, 0, 0.9238795));
}).catch((error) => { scene.userData.assetError = error.message; });

S.onFrame(() => {
  if (S.time.frame === 3) { S.audio.resume(); chime.play(); screen.play(); }
});
S.mount(scene);
