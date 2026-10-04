const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const fallback = new S.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1 });
const material = new S.ShaderGraphMaterial({
  source: "materials/glow.usda",
  name: "Glow",
  parameters: { intensity: 2 },
  fallback,
});

const mesh = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), material);
mesh.name = "glowing";
scene.add(mesh);

// SPEC 14.6: setParameter also updates a same-named property on the fallback,
// so the scene still reacts where there is no shader graph.
S.onFrame(() => {
  if (S.time.frame === 2) {
    material.setParameter("intensity", 5);
    material.setParameter("roughness", 0.6);
  }
  if (S.time.frame === 3) material.setParameter("tint", new S.Color(0, 0, 1));
  if (S.time.frame === 4) {
    scene.userData.fallbackRoughness = material.fallback.roughness;
    scene.userData.intensity = material.getParameter("intensity");
    scene.userData.generation = material.generation;
  }
});

let nameError = null;
try {
  material.setParameter(7, 1);
} catch (error) {
  nameError = error.name;
}
scene.userData.nameError = nameError;

S.mount(scene);
