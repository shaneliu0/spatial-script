const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshBasicMaterial, Matrix4, Vector3 } = Spatial;

const scene = new Scene();

const pivot = new Group();
pivot.name = "pivot";
pivot.position.set(0.1, 0, 0);
scene.add(pivot);

const spinner = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
spinner.name = "spinner";
pivot.add(spinner);
spinner.translateX(0.2);
spinner.rotateY(Math.PI / 2);

const scaled = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
scaled.name = "scaled";
scene.add(scaled);
scaled.applyMatrix4(new Matrix4().makeScale(2, 2, 2));
scaled.applyMatrix4(new Matrix4().makeTranslation(0, 0.3, 0));

const attached = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
attached.name = "attached";
attached.position.set(0.5, 0, 0);
scene.add(attached);
scene.updateMatrixWorld(true);
pivot.attach(attached);

const probe = new Group();
probe.name = "probe";
pivot.add(probe);
probe.userData.local = pivot.worldToLocal(new Vector3(0.3, 0, 0)).toArray();
probe.userData.world = pivot.localToWorld(new Vector3(0.2, 0, 0)).toArray();

Spatial.mount(scene);
