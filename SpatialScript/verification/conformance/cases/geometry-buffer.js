const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const geometry = new S.BufferGeometry();
geometry.setAttribute(
  "position",
  new S.Float32BufferAttribute([0, 0, 0, 0.2, 0, 0, 0, 0.2, 0, 0.2, 0.2, 0], 3),
);
geometry.setAttribute("uv", new S.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
geometry.setIndex([0, 1, 2, 2, 1, 3]);
geometry.computeVertexNormals();
geometry.computeBoundingBox();
geometry.computeBoundingSphere();

const quad = new S.Mesh(geometry, new S.MeshStandardMaterial({ side: S.DoubleSide }));
quad.name = "quad";
quad.userData.hasNormals = geometry.getAttribute("normal") !== undefined;
quad.userData.indexCount = geometry.index.count;
quad.userData.positionCount = geometry.getAttribute("position").count;
quad.userData.boundingBox = [geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()];
quad.userData.boundingSphereRadius = geometry.boundingSphere.radius;
scene.add(quad);

const clone = new S.Mesh(geometry.clone(), new S.MeshStandardMaterial());
clone.name = "clone";
clone.position.set(0.4, 0, 0);
scene.add(clone);

S.mount(scene);
