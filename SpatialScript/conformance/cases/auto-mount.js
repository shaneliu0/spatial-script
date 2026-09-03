const Spatial = require("spatial");
const { Scene, Mesh, SphereGeometry, MeshStandardMaterial } = Spatial;

const scene = new Scene();
const ball = new Mesh(new SphereGeometry(0.1, 16, 12), new MeshStandardMaterial());
ball.name = "ball";
scene.add(ball);
