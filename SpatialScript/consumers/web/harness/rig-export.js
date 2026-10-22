// Bundled into web/dist by harness/make-rig.mjs and run in the browser, because
// three's GLTFExporter needs browser APIs. Authors a two-bone skinned mesh with
// one morph target.

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

window.__exportRig = async function exportRig() {
  const root = new THREE.Group();
  root.name = 'rig';

  const rootBone = new THREE.Bone();
  rootBone.name = 'root';
  const headBone = new THREE.Bone();
  headBone.name = 'head';
  headBone.position.set(0, 0.2, 0);
  rootBone.add(headBone);

  const geometry = new THREE.BoxGeometry(0.1, 0.4, 0.1, 1, 3, 1);
  const count = geometry.attributes.position.count;
  const indices = [];
  const weights = [];
  for (let i = 0; i < count; i++) {
    indices.push(geometry.attributes.position.getY(i) > 0 ? 1 : 0, 0, 0, 0);
    weights.push(1, 0, 0, 0);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));

  const widen = geometry.attributes.position.clone();
  for (let i = 0; i < count; i++) widen.setX(i, widen.getX(i) * 2.5);
  geometry.morphAttributes.position = [widen];

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color: 0x66ccff }));
  mesh.name = 'body';
  mesh.morphTargetDictionary = { widen: 0 };
  mesh.morphTargetInfluences = [0];
  mesh.add(rootBone);
  mesh.bind(new THREE.Skeleton([rootBone, headBone]));
  root.add(mesh);

  const glb = await new GLTFExporter().parseAsync(root, { binary: true });
  return Array.from(new Uint8Array(glb));
};
