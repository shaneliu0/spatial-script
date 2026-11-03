const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const wall = new S.Mesh(new S.BoxGeometry(0.5, 0.5, 0.02), new S.MeshStandardMaterial());
wall.name = "wall";
wall.position.set(0, 0, -0.5);
scene.add(wall);

const marker = new S.Group();
marker.name = "marker";
scene.add(marker);

S.onFrame(() => {
  if (S.time.frame !== 2) return;
  // Offset from the centre so the ray does not land on the shared edge of the
  // two triangles that make up the box face.
  const hits = S.raycast(new S.Vector3(0.03, 0.02, 0), new S.Vector3(0, 0, -1), { maxDistance: 2 });
  marker.userData.count = hits.length;
  marker.userData.first = hits.length > 0 ? hits[0].object.name : null;
  marker.userData.distance = hits.length > 0 ? hits[0].distance : -1;
  marker.userData.point = hits.length > 0 ? hits[0].point.toArray() : null;
  const missed = S.raycast(new S.Vector3(0, 1, 0), new S.Vector3(0, 1, 0), { maxDistance: 2 });
  marker.userData.missCount = missed.length;
});

S.mount(scene);
