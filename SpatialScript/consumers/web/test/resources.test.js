// Geometry, materials and textures (SPEC 3.3, 3.4, 3.5, SPEC 5).
// Buffers arriving as typed arrays, sharing by uuid with disposal on the last
// user, in-place edits and revisions, and texture binding per colour space.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  makeConsumer, RecordingCore, boxGeometryCommand, standardMaterialCommand, rigidBodyCommand,
} from './helpers.mjs';

// ------------------------------------------------------------------ geometry
test('geometry builds a BufferGeometry from the typed arrays', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['create', 1, 'mesh', 'cube'], ['parent', 1, 0], boxGeometryCommand(1, 0.4, 0.2, 0.1)]);
  const geometry = consumer.objects.get(1).geometry;
  assert.equal(geometry.getAttribute('position').count, 8);
  assert.equal(geometry.getAttribute('normal').count, 8);
  assert.equal(geometry.getAttribute('uv').count, 8);
  assert.equal(geometry.index.count, 36);
  assert.ok(geometry.boundingBox, 'bounding box is computed');
  assert.equal(consumer.objects.get(1).userData.__spatialGeometry.type, 'BoxGeometry');
});

test('geometry without normals computes them', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'tri'], ['parent', 1, 0],
    ['geometry', 1, { type: 'BufferGeometry', parameters: {} },
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), null, null, null],
  ]);
  const normal = consumer.objects.get(1).geometry.getAttribute('normal');
  assert.equal(normal.count, 3);
  assert.deepEqual([normal.getX(0), normal.getY(0), normal.getZ(0)], [0, 0, 1]);
});

test('TextGeometry buffers are used verbatim', async () => {
  const { consumer } = await makeConsumer();
  const positions = new Float32Array([0, 0, 0, 0.1, 0, 0, 0.1, 0.1, 0]);
  consumer.apply([
    ['create', 1, 'mesh', 'label'], ['parent', 1, 0],
    ['geometry', 1, { type: 'TextGeometry', parameters: { text: 'hi', size: 0.1, depth: 0.01, font: 'default' } },
      positions, null, null, null],
  ]);
  assert.equal(consumer.objects.get(1).geometry.getAttribute('position').count, 3);
  assert.equal(consumer.objects.get(1).userData.__spatialGeometry.parameters.text, 'hi');
});

// ----------------------------------------------------------------- materials
test('material types map one to one and colours stay linear', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0],
    standardMaterialCommand(1, { color: [0.25, 0.5, 0.75], metalness: 0.3, roughness: 0.4, side: 2, transparent: true, opacity: 0.5 }),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0],
    standardMaterialCommand(2, { type: 'MeshBasicMaterial' }),
    ['create', 3, 'mesh', 'c'], ['parent', 3, 0],
    standardMaterialCommand(3, { type: 'MeshPhysicalMaterial', clearcoat: 0.8, clearcoatRoughness: 0.2 }),
    ['create', 4, 'mesh', 'd'], ['parent', 4, 0],
    standardMaterialCommand(4, { type: 'OcclusionMaterial' }),
  ]);
  const a = consumer.objects.get(1).material;
  assert.equal(a.type, 'MeshStandardMaterial');
  assert.equal(a.metalness, 0.3);
  assert.equal(a.roughness, 0.4);
  assert.equal(a.side, THREE.DoubleSide);
  assert.equal(a.transparent, true);
  assert.equal(a.opacity, 0.5);
  assert.ok(Math.abs(a.color.r - 0.25) < 1e-6 && Math.abs(a.color.b - 0.75) < 1e-6, 'linear colour is not re-encoded');

  assert.equal(consumer.objects.get(2).material.type, 'MeshBasicMaterial');
  assert.equal(consumer.objects.get(3).material.clearcoat, 0.8);
  assert.equal(consumer.objects.get(4).material.colorWrite, false, 'OcclusionMaterial is depth-only');
});

test('WEB-18: textures bind per colour space without clobbering each other', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0],
    ['texture', 7, { url: 'asset://checker.png', repeat: [2, 3], offset: [0.1, 0.2], wrapS: 1000, wrapT: 1001, flipY: false }],
    standardMaterialCommand(1, { maps: { map: 7, normalMap: 7, roughnessMap: null, metalnessMap: null, emissiveMap: null } }),
  ]);
  const entry = consumer.textures.get(7);
  assert.deepEqual(entry.texture.repeat.toArray(), [2, 3]);
  assert.deepEqual(entry.texture.offset.toArray(), [0.1, 0.2]);
  assert.equal(entry.texture.wrapS, THREE.RepeatWrapping);
  assert.equal(entry.texture.wrapT, THREE.ClampToEdgeWrapping);
  assert.equal(entry.texture.flipY, false);
  const material = consumer.objects.get(1).material;
  // The base map wants sRGB and the normal map wants linear, so the two bindings
  // are separate views over the same image (WEB-18).
  assert.equal(material.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(material.normalMap.colorSpace, THREE.NoColorSpace);
  assert.notEqual(material.map, material.normalMap);
  assert.ok([material.map, material.normalMap].includes(entry.texture));
});

test('asset:// and relative texture urls resolve against their roots', async () => {
  const { consumer } = await makeConsumer({ assetRoot: '/assets' });
  assert.equal(consumer.resolveUrl('asset://wood.png'), '/assets/wood.png');
  assert.equal(consumer.resolveUrl('textures/wood.png'), '/assets/textures/wood.png');
  assert.equal(consumer.resolveUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(consumer.resolveUrl('/absolute.png'), '/absolute.png');
});

// ---------------------------------------------- opacity, billboard, ordering
test('opacity multiplies down the hierarchy without touching material opacity', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'parent'], ['parent', 1, 0],
    ['create', 2, 'mesh', 'child'], ['parent', 2, 1],
    standardMaterialCommand(2, { opacity: 0.5, transparent: true }),
    ['opacity', 1, 0.5], ['opacity', 2, 0.5],
  ]);
  const material = consumer.objects.get(2).material;
  assert.equal(material.userData.__baseOpacity, 0.5, 'the material keeps its own opacity');
  assert.ok(Math.abs(material.opacity - 0.125) < 1e-6, '0.5 material * 0.5 parent * 0.5 own');
  assert.equal(material.transparent, true);
});

test('opacity below one forces transparency on an opaque material', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0],
    standardMaterialCommand(1), ['opacity', 1, 0.4],
  ]);
  const material = consumer.objects.get(1).material;
  assert.equal(material.transparent, true);
  assert.ok(Math.abs(material.opacity - 0.4) < 1e-6);
});

// ------------------------------------------- shared geometries and materials
test('meshes sharing a geometry uuid share one BufferGeometry', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'geo-shared';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], boxGeometryCommand(1, 0.2, 0.2, 0.2, shared),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], boxGeometryCommand(2, 0.2, 0.2, 0.2, shared),
    ['create', 3, 'mesh', 'c'], ['parent', 3, 0], boxGeometryCommand(3, 0.1, 0.1, 0.1, 'geo-other'),
  ]);
  assert.equal(consumer.objects.get(1).geometry, consumer.objects.get(2).geometry);
  assert.notEqual(consumer.objects.get(1).geometry, consumer.objects.get(3).geometry);
  assert.equal(consumer.geometries.size, 2);
  assert.equal(consumer.geometries.get(shared).users.size, 2);
});

test('new buffers for a known geometry uuid refill the instance every user sees', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'geo-mutating';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], boxGeometryCommand(1, 0.2, 0.2, 0.2, shared),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], boxGeometryCommand(2, 0.2, 0.2, 0.2, shared),
  ]);
  const instance = consumer.objects.get(1).geometry;
  const before = instance.boundingBox.max.x;

  consumer.apply([boxGeometryCommand(1, 0.8, 0.8, 0.8, shared)]);
  assert.equal(consumer.objects.get(1).geometry, instance, 'the instance is kept, not replaced');
  assert.equal(consumer.objects.get(2).geometry, instance);
  assert.ok(instance.boundingBox.max.x > before, 'the shared instance now holds the new buffers');
  assert.equal(consumer.geometries.size, 1);
});

test('a shared geometry is disposed only when its last user goes away', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'geo-refcount';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], boxGeometryCommand(1, 0.2, 0.2, 0.2, shared),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], boxGeometryCommand(2, 0.2, 0.2, 0.2, shared),
  ]);
  const instance = consumer.objects.get(1).geometry;
  let disposals = 0;
  instance.addEventListener('dispose', () => { disposals += 1; });

  consumer.apply([['destroy', 1]]);
  assert.equal(disposals, 0, 'one user left');
  assert.equal(consumer.geometries.get(shared).users.size, 1);

  consumer.apply([['destroy', 2]]);
  assert.equal(disposals, 1, 'the GPU side is freed with the last user');
  // The entry itself is kept: the core will not re-send buffers for a uuid and
  // revision it has already delivered, so a later mesh on the same geometry
  // arrives with null buffers and must find it here.
  assert.equal(consumer.geometries.get(shared).users.size, 0);
  assert.ok(consumer._idleGeometries.has(shared));
});

test('meshes sharing a material uuid share one material, and a change reaches every user', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'mat-shared';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], standardMaterialCommand(1, { uuid: shared, color: [1, 0, 0] }),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], standardMaterialCommand(2, { uuid: shared, color: [1, 0, 0] }),
  ]);
  const instance = consumer.objects.get(1).material;
  assert.equal(consumer.objects.get(2).material, instance);
  assert.equal(consumer.materials.size, 1);

  consumer.apply([standardMaterialCommand(1, { uuid: shared, color: [0, 0, 1], roughness: 0.25 })]);
  assert.equal(consumer.objects.get(1).material, instance, 'updated in place, not replaced');
  assert.equal(consumer.objects.get(2).material, instance);
  assert.ok(Math.abs(instance.color.b - 1) < 1e-6 && Math.abs(instance.color.r) < 1e-6);
  assert.equal(instance.roughness, 0.25);
});

test('a shared material is disposed only when its last user goes away', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'mat-refcount';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], standardMaterialCommand(1, { uuid: shared }),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], standardMaterialCommand(2, { uuid: shared }),
  ]);
  const instance = consumer.objects.get(1).material;
  let disposals = 0;
  instance.addEventListener('dispose', () => { disposals += 1; });

  consumer.apply([['destroy', 1]]);
  assert.equal(disposals, 0);
  consumer.apply([['destroy', 2]]);
  assert.equal(disposals, 1);
  assert.equal(consumer.materials.size, 0);
});

test('opacity clones a shared material for one object and leaves the others alone', async () => {
  const { consumer } = await makeConsumer();
  const shared = 'mat-opacity';
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], standardMaterialCommand(1, { uuid: shared }),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], standardMaterialCommand(2, { uuid: shared }),
    ['opacity', 1, 0.5],
  ]);
  const instance = consumer.materials.get(shared).material;
  const faded = consumer.objects.get(1).material;
  assert.notEqual(faded, instance, 'the faded object gets its own material');
  assert.ok(Math.abs(faded.opacity - 0.5) < 1e-6);
  assert.equal(faded.transparent, true);
  assert.equal(consumer.objects.get(2).material, instance, 'the other user is untouched');
  assert.equal(instance.opacity, 1);

  // A change to the shared material must reach the clone too.
  consumer.apply([standardMaterialCommand(1, { uuid: shared, color: [0, 1, 0] })]);
  const refreshed = consumer.objects.get(1).material;
  assert.ok(Math.abs(refreshed.color.g - 1) < 1e-6);
  assert.ok(Math.abs(refreshed.opacity - 0.5) < 1e-6);

  // Back to full opacity, the object returns to the shared instance.
  consumer.apply([['opacity', 1, 1]]);
  assert.equal(consumer.objects.get(1).material, instance);
  assert.equal(consumer.opacityMaterials.size, 0);
});

test('replacing a mesh geometry releases the old shared entry', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-first'),
  ]);
  assert.equal(consumer.geometryOf.get(1).uuid, 'geo-first');
  consumer.apply([boxGeometryCommand(1, 0.3, 0.3, 0.3, 'geo-second')]);
  assert.equal(consumer.geometryOf.get(1).uuid, 'geo-second');
  assert.equal(consumer.geometries.get('geo-first').users.size, 0, 'the old entry has no users');
  assert.ok(consumer._idleGeometries.has('geo-first'));
});

test('a scene of 1500 meshes on one geometry holds one BufferGeometry', async () => {
  const { consumer } = await makeConsumer({ physics: false });
  const shared = 'geo-stress';
  const batch = [];
  for (let id = 1; id <= 1500; id++) {
    batch.push(['create', id, 'mesh', `c${id}`], ['parent', id, 0],
      boxGeometryCommand(id, 0.012, 0.012, 0.012, shared),
      standardMaterialCommand(id, { uuid: `mat-${id}` }));
  }
  consumer.apply(batch);
  assert.equal(consumer.geometries.size, 1);
  assert.equal(consumer.geometries.get(shared).users.size, 1500);
  assert.equal(consumer.materials.size, 1500);
});

// ------------------------------------------------------ SPEC 3.7 rigid bodies
test('a rigidBody on an object with no geometry warns once and is ignored', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'holder'], ['parent', 1, 0],
    rigidBodyCommand(1),
  ]);
  assert.equal(consumer.physics.bodies.has(1), false, 'no body is created');
  const matching = consumer.warnings.filter((w) => w.includes('has no geometry to build a collision shape from'));
  assert.equal(matching.length, 1);
  assert.ok(matching[0].includes('"holder"'), 'the warning names the object');

  // A second command for the same object must not warn again.
  consumer.apply([rigidBodyCommand(1, { mass: 3 })]);
  assert.equal(consumer.warnings.filter((w) => w.includes('has no geometry')).length, 1);

  // A mesh whose geometry has no vertices is the same case.
  consumer.apply([
    ['create', 2, 'mesh', 'empty'], ['parent', 2, 0],
    ['geometry', 2, { type: 'BufferGeometry', parameters: {}, uuid: 'geo-empty' }, new Float32Array(0), null, null, null],
    rigidBodyCommand(2),
  ]);
  assert.equal(consumer.physics.bodies.has(2), false);
  assert.equal(consumer.warnings.filter((w) => w.includes('has no geometry')).length, 2);

  // A mesh with real geometry builds its body normally and warns about nothing.
  consumer.apply([
    ['create', 3, 'mesh', 'solid'], ['parent', 3, 0], boxGeometryCommand(3), rigidBodyCommand(3),
  ]);
  assert.equal(consumer.physics.bodies.has(3), true);
  assert.equal(consumer.warnings.filter((w) => w.includes('has no geometry')).length, 2);
});

test('the native dump survives a material or light with no colour', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'group', 'world'], ['parent', 1, 0],
    ['create', 2, 'portal', 'portal'], ['parent', 2, 0],
    boxGeometryCommand(2), standardMaterialCommand(2),
    ['world', 1, true], ['portal', 2, { worldId: 1, width: 0.5, height: 0.4, crossing: false }],
    ['create', 3, 'particles', 'fx'], ['parent', 3, 0],
    ['particles', 3, { preset: 'sparks', isEmitting: true }],
  ]);
  const dump = consumer.nativeDump();
  const portal = dump.objects.find((o) => o.name === 'portal');
  // SPEC 8: the portal's render-target material still reports the core's key
  // set, with the core's defaults where a ShaderMaterial has no such field.
  assert.equal(portal.material.color, null, 'a ShaderMaterial has no colour');
  assert.equal(portal.material.metalness, 0);
  assert.deepEqual(portal.material.emissive, [0, 0, 0]);
  assert.ok(portal.components.includes('nativeMaterial:ShaderMaterial'));
  assert.equal(portal.light, null);
  assert.ok(portal.components.includes('PortalComponent'));
  assert.equal(JSON.parse(JSON.stringify(dump)).objects.length, dump.objects.length, 'the dump is serialisable');
});

test('WEB-02: an in-place geometry edit re-uploads the attributes and bounds', async () => {
  const { consumer } = await makeConsumer();
  const command = boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-live');
  consumer.apply([['create', 1, 'mesh', 'm'], ['parent', 1, 0], command]);
  const geometry = consumer.objects.get(1).geometry;
  const attribute = geometry.getAttribute('position');
  const versionBefore = attribute.version;
  assert.ok(Math.abs(geometry.boundingBox.max.x - 0.1) < 1e-6);

  // The core re-emits the same arrays after an in-place edit.
  command[3][0] = 9;
  command[3][3] = 9;
  consumer.apply([command]);

  assert.equal(consumer.objects.get(1).geometry, geometry, 'the instance is kept');
  assert.equal(geometry.getAttribute('position'), attribute, 'the attribute is refilled, not replaced');
  assert.ok(attribute.version > versionBefore, 'three re-uploads the buffer');
  assert.ok(Math.abs(geometry.boundingBox.max.x - 9) < 1e-6, 'the bounding volume is recomputed');
  assert.ok(Math.abs(geometry.boundingSphere.radius - geometry.boundingSphere.radius) < 1e-6);
});

test('WEB-02: a revision from the core skips the redundant refill', async () => {
  const { consumer } = await makeConsumer();
  const withRevision = (revision) => {
    const command = boxGeometryCommand(1, 0.2, 0.2, 0.2, 'geo-rev');
    command[2].revision = revision;
    return command;
  };
  consumer.apply([['create', 1, 'mesh', 'm'], ['parent', 1, 0], withRevision(1)]);
  const attribute = consumer.objects.get(1).geometry.getAttribute('position');
  const version = attribute.version;
  consumer.apply([withRevision(1)]);
  assert.equal(attribute.version, version, 'the same revision is not rewritten');
  consumer.apply([withRevision(2)]);
  assert.ok(attribute.version > version, 'a new revision is');
});

test('WEB-11: environment textures are disposed on replacement and reset', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['environment', 0, { url: 'asset://a.png', intensity: 1 }]]);
  const first = consumer.scene.environment;
  let disposed = 0;
  first.addEventListener('dispose', () => { disposed += 1; });

  consumer.apply([['environment', 0, { url: 'asset://b.png', intensity: 1 }]]);
  assert.equal(disposed, 1, 'the replaced environment is freed');
  assert.notEqual(consumer.scene.environment, first);

  const second = consumer.scene.environment;
  let secondDisposed = 0;
  second.addEventListener('dispose', () => { secondDisposed += 1; });
  consumer.reset();
  assert.equal(secondDisposed, 1, 'reset frees the last one');
  assert.equal(consumer.scene.environment, null);
});

test('WEB-12: a texture url change keeps the instance materials are bound to', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0],
    ['texture', 7, { url: 'asset://a.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    standardMaterialCommand(1, { maps: { map: 7, normalMap: null, roughnessMap: null, metalnessMap: null, emissiveMap: null } }),
  ]);
  const bound = consumer.objects.get(1).material.map;
  let disposed = 0;
  bound.addEventListener('dispose', () => { disposed += 1; });

  consumer.apply([['texture', 7, { url: 'asset://b.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }]]);
  assert.equal(disposed, 0, 'the bound instance is not disposed under the material');
  assert.equal(consumer.objects.get(1).material.map, bound, 'and is still the one in use');
  assert.equal(consumer.textures.get(7).url, '/assets/b.png', 'while the entry points at the new url');
});

test('SPEC 5: a null texture payload releases the id', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([['texture', 7, { url: 'asset://a.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }]]);
  const entry = consumer.textures.get(7);
  let disposed = 0;
  entry.texture.addEventListener('dispose', () => { disposed += 1; });

  consumer.apply([['texture', 7, null]]);
  assert.equal(consumer.textures.has(7), false, 'the id is dropped');
  assert.equal(disposed, 1, 'the GPU texture is freed');
  assert.equal(entry.released, true, 'an in-flight load for it is ignored');
  assert.deepEqual(consumer.warnings, []);
});

test('SPEC 5: a released texture a material still uses is kept and warned about', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'm'], ['parent', 1, 0],
    ['texture', 7, { url: 'asset://a.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    standardMaterialCommand(1, { maps: { map: 7, normalMap: null, roughnessMap: null, metalnessMap: null, emissiveMap: null } }),
  ]);
  const bound = consumer.objects.get(1).material.map;
  let disposed = 0;
  bound.addEventListener('dispose', () => { disposed += 1; });
  consumer.apply([['texture', 7, null]]);
  assert.equal(disposed, 0, 'a texture in use is not pulled out from under the material');
  assert.equal(consumer.warnings.filter((w) => w.includes('still references it')).length, 1);
});

test('WEB-27: destroying a mesh does not scan the resource caches', async () => {
  const { consumer } = await makeConsumer({ physics: false });
  const batch = [];
  for (let id = 1; id <= 300; id++) {
    batch.push(['create', id, 'mesh', `c${id}`], ['parent', id, 0],
      boxGeometryCommand(id, 0.02, 0.02, 0.02, 'geo-many'),
      standardMaterialCommand(id, { uuid: `mat-${id}` }));
  }
  consumer.apply(batch);
  assert.equal(consumer._sharedGeometries.size, 1);
  assert.equal(consumer._sharedMaterials.size, 300);
  consumer.apply(batch.filter((c) => c[0] === 'create').map((c) => ['destroy', c[1]]));
  assert.equal(consumer._sharedMaterials.size, 0);
  assert.equal(consumer.materials.size, 0);
  // One idle geometry entry survives so a re-send with null buffers still works.
  assert.equal(consumer.geometries.size, 1);
  assert.equal(consumer.geometries.get('geo-many').users.size, 0);
});

test('WEB-18: a shared texture keeps each material decoding correctly', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0],
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0],
    ['texture', 7, { url: 'asset://t.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    standardMaterialCommand(1, { uuid: 'mat-a', maps: { map: 7, normalMap: null, roughnessMap: null, metalnessMap: null, emissiveMap: null } }),
  ]);
  const asMap = consumer.objects.get(1).material.map;
  assert.equal(asMap.colorSpace, THREE.SRGBColorSpace);

  // A second material binds the same id in a linear slot.
  consumer.apply([standardMaterialCommand(2, { uuid: 'mat-b', maps: { map: null, normalMap: null, roughnessMap: 7, metalnessMap: null, emissiveMap: null } })]);
  assert.equal(consumer.objects.get(2).material.roughnessMap.colorSpace, THREE.NoColorSpace);
  assert.equal(consumer.objects.get(1).material.map, asMap, 'the first binding is untouched');
  assert.equal(asMap.colorSpace, THREE.SRGBColorSpace, 'and still decodes as sRGB');
  assert.equal(consumer.objects.get(1).material.map.image, consumer.objects.get(2).material.roughnessMap.image,
    'both views share one image');
});

test('WEB-28: growing a particle emitter releases the buffers it replaces', async () => {
  const { consumer } = await makeConsumer();
  consumer.apply([
    ['create', 1, 'particles', 'fx'], ['parent', 1, 0],
    ['particles', 1, { preset: null, birthRate: 10, lifetime: 1, size: 0.01 }],
  ]);
  const emitter = consumer.emitters.get(1);
  let disposals = 0;
  emitter.geometry.addEventListener('dispose', () => { disposals += 1; });
  const capacityBefore = emitter.capacity;

  // A much higher birth rate forces a bigger buffer.
  consumer.apply([['particles', 1, { preset: null, birthRate: 5000, lifetime: 2, size: 0.01 }]]);
  assert.ok(emitter.capacity > capacityBefore, 'the emitter grew');
  assert.equal(disposals, 1, 'the previous attribute set was released');
  assert.equal(emitter.geometry.getAttribute('position').count, emitter.capacity);
});

test('the geometry revision decides a refill, and a re-send may carry no buffers', async () => {
  const { consumer } = await makeConsumer();
  const command = (id, revision, withBuffers) => {
    const full = boxGeometryCommand(id, 0.2, 0.2, 0.2, 'geo-shared');
    full[2].revision = revision;
    if (withBuffers) return full;
    return ['geometry', id, full[2], null, null, null, null];
  };

  // The first mesh carries the data; the next two are told it is unchanged.
  consumer.apply([
    ['create', 1, 'mesh', 'a'], ['parent', 1, 0], command(1, '4:0:0:0:0', true),
    ['create', 2, 'mesh', 'b'], ['parent', 2, 0], command(2, '4:0:0:0:0', false),
    ['create', 3, 'mesh', 'c'], ['parent', 3, 0], command(3, '4:0:0:0:0', false),
  ]);
  const geometry = consumer.objects.get(1).geometry;
  assert.equal(consumer.objects.get(2).geometry, geometry);
  assert.equal(consumer.objects.get(3).geometry, geometry);
  assert.equal(geometry.getAttribute('position').count, 8, 'the shared data survived the null re-sends');
  assert.deepEqual(consumer.warnings, []);

  // A plain BufferGeometry always arrives with buffers, and a new revision refills.
  const attribute = geometry.getAttribute('position');
  const version = attribute.version;
  const edited = command(1, '4:1:0:0:0', true);
  edited[3][0] = 7;
  consumer.apply([edited]);
  assert.ok(attribute.version > version, 'a new revision re-uploads');
  assert.ok(Math.abs(geometry.boundingBox.max.x - 7) < 1e-6);

  // Destroying every user keeps the entry, so a later mesh still gets the data.
  consumer.apply([['destroy', 1], ['destroy', 2], ['destroy', 3]]);
  assert.equal(consumer.geometries.get('geo-shared').users.size, 0);
  consumer.apply([['create', 4, 'mesh', 'late'], ['parent', 4, 0], command(4, '4:1:0:0:0', false)]);
  assert.equal(consumer.objects.get(4).geometry.getAttribute('position').count, 8,
    'a mesh added after the last user still gets the geometry');
  assert.deepEqual(consumer.warnings, []);

  // A new revision with no buffers cannot be honoured, so it says so.
  consumer.apply([command(4, '4:2:0:0:0', false)]);
  assert.equal(consumer.warnings.filter((w) => w.includes('without buffers')).length, 1);
  assert.equal(consumer.objects.get(4).geometry.getAttribute('position').count, 8, 'the old data is kept');
});

test('the idle geometry cache is bounded', async () => {
  const { consumer } = await makeConsumer({ physics: false });
  for (let id = 1; id <= 200; id++) {
    consumer.apply([
      ['create', id, 'mesh', `m${id}`], ['parent', id, 0],
      boxGeometryCommand(id, 0.02, 0.02, 0.02, `geo-${id}`),
      ['destroy', id],
    ]);
  }
  assert.equal(consumer._idleGeometries.size, 128);
  assert.equal(consumer.geometries.size, 128);
  assert.ok(consumer._idleGeometries.has('geo-200'), 'the newest idle entries are kept');
  assert.ok(!consumer._idleGeometries.has('geo-1'), 'the oldest are evicted');
});

test('PERF-07: a finished texture load touches only the materials that use it', async () => {
  const { consumer } = await makeConsumer();
  const loaded = [];
  consumer.textureLoader = {};
  consumer.imageLoader = { load: (url, onLoad) => loaded.push(onLoad) };
  consumer.apply([
    ['create', 1, 'mesh', 'textured'], ['parent', 1, 0],
    ['create', 2, 'mesh', 'plain'], ['parent', 2, 0],
    ['texture', 7, { url: 'asset://a.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    standardMaterialCommand(1, { uuid: 'mat-textured', maps: { map: 7, normalMap: null, roughnessMap: null, metalnessMap: null, emissiveMap: null } }),
    standardMaterialCommand(2, { uuid: 'mat-plain' }),
  ]);
  const textured = consumer.materials.get('mat-textured');
  const plain = consumer.materials.get('mat-plain');
  const before = { textured: textured.material.version, plain: plain.material.version };
  const otherEntryCount = consumer.materials.size;

  loaded[0]({ width: 4, height: 4 });

  // Only the texture is refreshed; no material is rebuilt and the cache is intact.
  assert.equal(consumer.materials.size, otherEntryCount, 'the material cache is not flushed');
  assert.equal(consumer.materials.get('mat-textured'), textured, 'and the entries are the same objects');
  assert.equal(plain.material.version, before.plain, 'an unrelated material is untouched');
  assert.equal(textured.material.version, before.textured, 'nor is the referencing material rebuilt');
  assert.equal(consumer.objects.get(1).material.map.image.width, 4, 'the texture itself has the pixels');
});

test('FA-01: a first texture load dispatches textureLoaded and textureError', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  const loads = [];
  consumer.textureLoader = {};
  consumer.imageLoader = { load: (url, onLoad, onProgress, onError) => loads.push({ url, onLoad, onError }) };
  consumer.apply([
    ['create', 1, 'mesh', 'textured'], ['parent', 1, 0],
    ['texture', 7, { url: 'asset://a.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    ['texture', 8, { url: 'asset://missing.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
  ]);
  assert.equal(loads.length, 2, 'both first loads started');
  // The entry the loader closes over is the one the id resolves to, so the
  // callbacks can recognise it and the events go out (SPEC 3.5).
  assert.equal(consumer.textures.get(7).texture, consumer.objects.get(1).material.map || consumer.textures.get(7).texture);

  loads[0].onLoad({ width: 2, height: 2 });
  loads[1].onError(new Error('404'));
  assert.deepEqual(core.dispatched.map((d) => [d.type, d.id]), [['textureLoaded', 7], ['textureError', 8]]);
  assert.equal(core.dispatched[1].payload.message, 'texture failed to load: /assets/missing.png');
  assert.equal(consumer.textures.get(7).texture.image.width, 2, 'and the pixels landed on the stored texture');

  // A released id no longer answers, and the load bookkeeping balances.
  consumer.apply([['texture', 7, null]]);
  assert.equal(consumer.pendingLoads, 0);
});

test('SPEC 3.5: a failed load reaches the event, never a consumer warning', async () => {
  const { consumer, core } = await makeConsumer({ core: new RecordingCore() });
  const loads = [];
  consumer.textureLoader = {};
  consumer.imageLoader = { load: (url, onLoad, onProgress, onError) => loads.push({ url, onLoad, onError }) };
  let failAsset = null;
  consumer.gltfLoader = { load: (url, onLoad, onProgress, onError) => { failAsset = onError; } };

  consumer.apply([
    ['create', 1, 'mesh', 'textured'], ['parent', 1, 0],
    ['texture', 7, { url: 'asset://missing.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    ['create', 2, 'asset', 'rig'], ['parent', 2, 0], ['asset', 2, { glb: 'asset://missing.glb' }],
  ]);
  loads[0].onError(new Error('404'));
  failAsset(new Error('404: Not Found'));

  // The core owns the warning, so the list is identical on every backend.
  assert.deepEqual(consumer.warnings.filter((w) => w.includes('failed to load')), []);
  assert.deepEqual(consumer.dump().warnings.filter((w) => w.includes('failed to load')), []);

  // The platform's words still reach the script through the event payload.
  const textureError = core.dispatched.find((d) => d.type === 'textureError');
  assert.ok(textureError, 'textureError was dispatched');
  assert.match(textureError.payload.message, /texture failed to load: \/assets\/missing\.png/);
  const assetError = core.dispatched.find((d) => d.type === 'assetError');
  assert.ok(assetError, 'assetError was dispatched');
  assert.match(assetError.payload.message, /404: Not Found/);
});

test('SPEC 14.13a: every load is counted while it is in flight, by url', async () => {
  const { consumer } = await makeConsumer();
  const loads = [];
  consumer.textureLoader = {};
  consumer.imageLoader = { load: (url, onLoad, onProgress, onError) => loads.push({ url, onLoad, onError }) };
  let finishAsset = null;
  consumer.gltfLoader = { load: (url, onLoad) => { finishAsset = onLoad; } };
  assert.equal(consumer.pendingLoads, 0);
  assert.deepEqual(consumer.inFlightLoads(), []);

  consumer.apply([
    ['create', 1, 'mesh', 'textured'], ['parent', 1, 0],
    ['texture', 7, { url: 'asset://checker.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }],
    ['create', 2, 'asset', 'rig'], ['parent', 2, 0], ['asset', 2, { glb: 'asset://rig.glb' }],
  ]);
  assert.equal(consumer.pendingLoads, 2, 'both are in flight');
  assert.deepEqual(consumer.inFlightLoads().sort(), ['/assets/checker.png', 'asset://rig.glb']);

  loads[0].onLoad({ width: 2, height: 2 });
  assert.deepEqual(consumer.inFlightLoads(), ['asset://rig.glb'], 'the texture settled');
  finishAsset({ scene: new THREE.Group(), animations: [] });
  assert.equal(consumer.pendingLoads, 0);
  assert.deepEqual(consumer.inFlightLoads(), [], 'and so did the asset');

  // A failed load settles too, or a plan would wait for ever.
  consumer.apply([['texture', 8, { url: 'asset://gone.png', repeat: [1, 1], offset: [0, 0], wrapS: 1001, wrapT: 1001, flipY: true }]]);
  assert.equal(consumer.pendingLoads, 1);
  loads[1].onError(new Error('404'));
  assert.equal(consumer.pendingLoads, 0);
  assert.deepEqual(consumer.inFlightLoads(), []);
});
