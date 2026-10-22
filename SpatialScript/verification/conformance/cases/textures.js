const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
const loader = new S.TextureLoader();

const grid = loader.load("asset://grid.png", () => {
  panel.userData.loaded = true;
});
grid.repeat.set(2, 3);
grid.offset.set(0.25, 0.5);
grid.wrapS = S.RepeatWrapping;
grid.wrapT = S.MirroredRepeatWrapping;
grid.flipY = false;

const wood = loader.load("textures/wood.png");

const broken = loader.load("asset://missing.png", undefined, undefined, (error) => {
  panel.userData.textureError = error.message;
});

const material = new S.MeshStandardMaterial({ map: grid, normalMap: wood });
const panel = new S.Mesh(new S.PlaneGeometry(0.4, 0.4), material);
panel.name = "panel";
panel.userData.loaded = false;
panel.userData.textureError = null;
panel.userData.hasMap = material.map === grid;
panel.userData.hasNormalMap = material.normalMap === wood;
panel.userData.repeat = grid.repeat.toArray();
panel.userData.offset = grid.offset.toArray();
panel.userData.wrapS = grid.wrapS;
panel.userData.wrapT = grid.wrapT;
panel.userData.flipY = grid.flipY;
panel.userData.brokenUrl = broken.url;
scene.add(panel);

S.mount(scene);
