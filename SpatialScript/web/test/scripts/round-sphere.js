// A single unlit sphere, used to prove the parity capture is not stretched.
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 3));
const ball = new S.Mesh(new S.SphereGeometry(0.2, 64, 48), new S.MeshBasicMaterial({ color: 0xffffff }));
ball.name = "ball";
scene.add(ball);
S.mount(scene);
