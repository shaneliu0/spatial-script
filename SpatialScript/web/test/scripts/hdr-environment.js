// A metal sphere lit only by an equirectangular Radiance .hdr environment.
const S = require("spatial");
const scene = new S.Scene();
const ball = new S.Mesh(
  new S.SphereGeometry(0.15, 48, 32),
  new S.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.1 }),
);
ball.name = "ball";
scene.add(ball);
S.environment = new S.ImageBasedLight("asset://studio-env.hdr", 1);
S.mount(scene);
