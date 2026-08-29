const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, Vector3 } = Spatial;

const scene = new Scene();

// An invisible mesh in front of everything must never be hit.
const hidden = new Mesh(new BoxGeometry(0.4, 0.4, 0.1), new MeshStandardMaterial());
hidden.name = "hidden";
hidden.position.set(0, 0, -0.5);
hidden.visible = false;
scene.add(hidden);

const group = new Group();
group.name = "group";
scene.add(group);

const child = new Mesh(new BoxGeometry(0.4, 0.4, 0.1), new MeshStandardMaterial());
child.name = "child";
child.position.set(0, 0, -1);
group.add(child);

const top = new Mesh(new BoxGeometry(0.4, 0.4, 0.1), new MeshStandardMaterial());
top.name = "top";
top.position.set(0, 0, -2);
scene.add(top);

const probe = new Group();
probe.name = "probe";
scene.add(probe);

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 2) return;
  // Offset from the centre so the ray misses the shared triangle edge.
  const origin = new Vector3(0.03, 0.02, 0);
  const direction = new Vector3(0, 0, -1);

  const all = Spatial.raycast(origin, direction);
  probe.userData.hits = all.map((hit) => hit.object.name);
  probe.userData.distances = all.map((hit) => Number(hit.distance.toFixed(3)));

  const direct = Spatial.raycast(origin, direction, { recursive: false });
  probe.userData.direct = direct.map((hit) => hit.object.name);

  const near = Spatial.raycast(origin, direction, { maxDistance: 1.5 });
  probe.userData.near = near.map((hit) => hit.object.name);
});

Spatial.mount(scene);
