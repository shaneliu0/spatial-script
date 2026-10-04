const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const fallback = new S.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.2 });

// SPEC 14.6: the graph's source is resolved against the asset root and every
// parameter is carried in the material payload.
const material = new S.ShaderGraphMaterial({
  source: "materials/glow.usda",
  name: "Glow",
  parameters: {
    intensity: 2,
    tint: new S.Color(1, 0, 0),
    offset: new S.Vector2(0.25, 0.5),
    direction: new S.Vector3(0, 1, 0),
    enabled: true,
    label: "warm",
  },
  fallback,
});

const mesh = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), material);
mesh.name = "glowing";
scene.add(mesh);

// The fallback is not optional: it is what a consumer without shader graphs
// renders.
let missingFallback = null;
try {
  new S.ShaderGraphMaterial({ source: "materials/glow.usda", name: "Glow" });
} catch (error) {
  missingFallback = error.name;
}

scene.userData.missingFallback = missingFallback;
scene.userData.isShaderGraph = material.isShaderGraphMaterial === true;
scene.userData.graphName = material.graphName;
scene.userData.intensity = material.getParameter("intensity");
scene.userData.capability = S.env.capabilities.shaderGraph;

S.mount(scene);
