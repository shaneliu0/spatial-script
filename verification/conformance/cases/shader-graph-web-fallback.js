const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 14.6: the three.js backend has no shader graph, so it renders the
// fallback and warns once.
const material = new S.ShaderGraphMaterial({
  source: "materials/glow.usda",
  name: "Glow",
  parameters: { roughness: 0.9 },
  fallback: new S.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1 }),
});

const mesh = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), material);
mesh.name = "mesh";
scene.add(mesh);

material.setParameter("roughness", 0.6);

let missingFallback = null;
try {
  new S.ShaderGraphMaterial({ source: "materials/glow.usda", name: "Glow", fallback: null });
} catch (error) {
  missingFallback = error.name;
}

scene.userData.missingFallback = missingFallback;
scene.userData.fallbackRoughness = material.fallback.roughness;
scene.userData.capability = S.env.capabilities.shaderGraph;

S.mount(scene);
