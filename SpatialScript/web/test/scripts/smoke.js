// Local smoke script used by the web consumer's own tests and screenshots.
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, SphereGeometry, PlaneGeometry,
        MeshStandardMaterial, DirectionalLight, AmbientLight, RigidBody } = Spatial;

const scene = new Scene();

const floor = new Mesh(new PlaneGeometry(1.2, 1.2), new MeshStandardMaterial({ color: 0x2a2f3a }));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.3;
floor.receiveShadow = true;
floor.rigidBody = new RigidBody({ type: "static", shape: "box" });
scene.add(floor);

const cube = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: 0x3366ff, roughness: 0.4 }));
cube.name = "cube";
cube.position.set(-0.22, 0.1, 0);
cube.castShadow = true;
scene.add(cube);

const ball = new Mesh(new SphereGeometry(0.09, 32, 16), new MeshStandardMaterial({ color: 0xff8844, metalness: 0.2, roughness: 0.3 }));
ball.name = "ball";
ball.position.set(0.22, 0.25, 0);
ball.castShadow = true;
ball.rigidBody = new RigidBody({ type: "dynamic", mass: 1, shape: "sphere", restitution: 0.4 });
scene.add(ball);

const sun = new DirectionalLight(0xffffff, 3);
sun.position.set(1, 2, 1);
sun.castShadow = true;
scene.add(sun);
scene.add(new AmbientLight(0xffffff, 0.6));

cube.addEventListener("tap", () => { cube.material.color.set(0xff2200); });

Spatial.onFrame((dt) => { cube.rotation.y += dt; });
Spatial.mount(scene);
