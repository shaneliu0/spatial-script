// Exercises the consumer's real GLTF and environment paths against files in the shared asset root.
const Spatial = require("spatial");
const { Scene, Mesh, SphereGeometry, MeshStandardMaterial, ImageBasedLight, Group } = Spatial;

const scene = new Scene();

const metal = new Mesh(
  new SphereGeometry(0.12, 32, 20),
  new MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.15 }),
);
metal.name = "metal";
metal.position.set(-0.2, 0, 0);
scene.add(metal);

const holder = new Group();
holder.name = "holder";
holder.position.set(0.2, 0, 0);
scene.add(holder);

Spatial.loadAsset({ glb: "asset://panel.gltf" }).then((asset) => {
  asset.name = "panel";
  holder.add(asset);
  holder.userData.animations = asset.animations;
  holder.userData.boundingBox = [asset.boundingBox.min.toArray(), asset.boundingBox.max.toArray()];
  asset.playAnimation("spin", { loop: true, speed: 1 });
}).catch((error) => {
  holder.userData.assetError = error.message;
});

Spatial.environment = new ImageBasedLight("asset://studio-env.png", 2);

Spatial.mount(scene);
