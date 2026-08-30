const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const material = new S.MeshStandardMaterial({ color: 0x808080 });
material.opacity = 0.5;
material.transparent = true;
material.side = S.DoubleSide;
material.wireframe = true;
material.emissive.set(0x00ff00);
material.emissiveIntensity = 2;
material.metalness = 0.9;
material.roughness = 0.1;
material.depthWrite = false;
material.depthTest = false;
material.blending = S.AdditiveBlending;

const styled = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), material);
styled.name = "styled";
scene.add(styled);

S.mount(scene);
