// SPEC 8's native dump shape rule: a native dump has exactly the core dump's
// key set at every depth, minus `userData`, `coreSource` and `uuid`, plus only
// `scene.childCount`, per-object `nativeType` and `components`.
//
// The fixture scene runs on the real core in Node, its commands are applied to
// the real consumer, and the two dumps are compared key for key.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeConsumer } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

/** Runs the real core bundle in a Node context, the way the node runner does. */
function loadCore() {
  const source = fs.readFileSync(path.join(ROOT, 'core/dist/spatial-core.js'), 'utf8');
  const context = {
    __spatialNative: { log() {}, now: () => Date.now() },
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'spatial-core.js' });
  return context.__spatial;
}

/** Every key path in a dump, with array entries flattened onto one path. */
function keyPaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) keyPaths(item, prefix, out);
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.add(prefix + key);
      keyPaths(inner, `${prefix}${key}.`, out);
    }
  }
  return out;
}

/** SPEC 8: what a native dump may leave out and what it may add. */
const OMITTED = (key) => key === 'coreSource'
  || key === 'userData' || key.endsWith('.userData') || key.includes('userData.')
  || key === 'uuid' || key.endsWith('.uuid');
const ADDED = new Set(['scene.childCount', 'objects.nativeType', 'objects.components']);

test('SPEC 8: the native dump key set is the core dump key set', async (t) => {
  const core = loadCore();
  const source = fs.readFileSync(path.join(HERE, 'scripts/spec8-fixture.js'), 'utf8');
  core.load(source, { backend: 'three', platform: 'web', assetRoot: 'assets' });

  const { consumer } = await makeConsumer();
  // Assets and textures are network work a Node test cannot do; the consumer
  // records the commands and reports them the way it would mid-load.
  consumer.gltfLoader = { load: () => {} };
  consumer.setCore(core);

  for (let i = 0; i < 6; i += 1) {
    const commands = core.tick(1 / 60);
    consumer.apply(commands);
  }

  const coreDump = core.dump();
  const native = consumer.nativeDump();

  const coreKeys = keyPaths(coreDump);
  const nativeKeys = keyPaths(native);

  const missing = [...coreKeys].filter((key) => !nativeKeys.has(key) && !OMITTED(key)).sort();
  const extra = [...nativeKeys].filter((key) => !coreKeys.has(key) && !ADDED.has(key)).sort();

  // A readable diff: what the core has that the native dump does not, and the
  // other way round, with the object that carries it where it helps.
  const report = [];
  if (missing.length) report.push(`missing from the native dump:\n  ${missing.join('\n  ')}`);
  if (extra.length) report.push(`extra in the native dump:\n  ${extra.join('\n  ')}`);
  assert.deepEqual([missing, extra], [[], []], report.join('\n\n'));

  // SPEC 8: the values mirror the core's defaults where the platform has no
  // notion of the field, so a comparator never sees a null against a number.
  for (const object of native.objects.filter((o) => o.light)) {
    for (const key of ['intensity', 'distance', 'decay', 'angle', 'penumbra']) {
      assert.equal(typeof object.light[key], 'number',
        `${object.name}.light.${key} is a number, not ${JSON.stringify(object.light[key])}`);
    }
  }
  assert.equal(typeof native.render.adaptiveResolution, 'boolean');
  assert.equal(native.loadGeneration, coreDump.loadGeneration, 'the load generation matches the core');
  assert.equal(native.scene.name, coreDump.scene.name, 'and so does the scene name');
  for (const object of native.objects) {
    // Every material slot reports the five map slots, as the core does.
    for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
      if (!material) continue;
      const block = material.type === 'ShaderGraphMaterial' ? material.fallback : material;
      if (!block) continue;
      assert.deepEqual(Object.keys(block.maps).sort(),
        ['emissiveMap', 'map', 'metalnessMap', 'normalMap', 'roughnessMap']);
    }
  }

  // SPEC 8: `type` is the script class the core reports, and the three.js class
  // is the separate `nativeType`.
  const coreTypes = Object.fromEntries(coreDump.objects.filter((o) => o.name).map((o) => [o.name, o.type]));
  for (const object of native.objects.filter((o) => o.name)) {
    assert.equal(object.type, coreTypes[object.name], `${object.name}.type matches the core`);
  }

  // The additions really are there, on the objects that should carry them.
  assert.equal(typeof native.scene.childCount, 'number');
  for (const object of native.objects) {
    assert.equal(typeof object.nativeType, 'string', `${object.name} has a nativeType`);
    assert.ok(Array.isArray(object.components), `${object.name} has components`);
  }
  // And the fixture really did exercise every kind, or the comparison proves little.
  const kinds = new Set(native.objects.map((o) => o.type));
  for (const kind of ['Mesh', 'AmbientLight', 'DirectionalLight', 'PointLight', 'SpotLight',
    'ParticleEmitter', 'Portal', 'Anchor', 'Group']) {
    assert.ok(kinds.has(kind), `the fixture carries a ${kind} (got ${[...kinds].join(', ')})`);
  }
  const has = (key) => native.objects.some((o) => o[key] !== undefined && o[key] !== null);
  for (const key of ['audio', 'video', 'characterController', 'forceField', 'accessibility',
    'particles', 'portal', 'anchor', 'rigidBody', 'light']) {
    assert.ok(has(key), `the fixture exercises ${key}`);
  }
  // The rig's own file cannot load in Node, so the asset object carries the
  // skeleton and blend shape keys with the core's null, which is the point:
  // the key set is what this test holds, not the loaded pose.
  // SPEC 8: the skeleton reports the joints the script named, the same ones the
  // core dumps — every bone still reaches the core through `syncSkeleton`.
  const rigged = native.objects.find((o) => o.skeleton && o.skeleton.joints);
  const coreRigged = coreDump.objects.find((o) => o.skeleton && o.skeleton.joints);
  if (rigged && coreRigged) {
    assert.deepEqual(Object.keys(rigged.skeleton.joints).sort(),
      Object.keys(coreRigged.skeleton.joints).sort(), 'the same joint names as the core');
  }

  const asset = native.objects.find((o) => o.asset);
  assert.ok(asset, 'the fixture carries an asset');
  for (const key of ['skeleton', 'blendShapes', 'animations', 'loaded']) {
    assert.ok(key in asset, `the asset carries ${key}`);
  }
  assert.ok(native.joints.length > 0, 'the fixture has a joint');
  assert.ok(native.camera, 'the fixture has a scripted camera');
});

test('SPEC 8: a silent scene reports a suspended audio engine', async () => {
  const { consumer } = await makeConsumer();
  // No audio anywhere: nothing may open an AudioContext, so the mixer reports
  // the core's state rather than a running engine nothing is using.
  consumer.apply([['create', 1, 'mesh', 'quiet'], ['parent', 1, 0]]);
  assert.equal(consumer.nativeDump().audioMixer.state, 'suspended');

  // The host's gesture on its own does not open one either.
  consumer.audio.resume();
  assert.equal(consumer.audio.listener, null, 'no listener without a sound');
  assert.equal(consumer.nativeDump().audioMixer.state, 'suspended');

  // Nor does setting a volume.
  consumer.apply([['audioMixer', 0, { masterVolume: 0.5, groups: { music: 0.2 }, state: 'suspended' }]]);
  assert.equal(consumer.audio.listener, null);
  const mixer = consumer.nativeDump().audioMixer;
  assert.equal(mixer.state, 'suspended');
  assert.equal(mixer.masterVolume, 0.5, 'but the mixer state is still recorded');
  assert.deepEqual(mixer.groups, { music: 0.2 });
});

test('SPEC 14.6: the fallback takes every carryable parameter the core writes', async () => {
  // The core and the consumer must end with the same fallback state and the
  // same warning list, so this drives the real core and the real consumer with
  // one script and compares both.
  const core = loadCore();
  core.load(`
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
const fallback = new S.MeshStandardMaterial({ color: 0x223344 });
const graph = new S.ShaderGraphMaterial({
  source: "asset://spatial-materials.usda", name: "Glow", fallback,
});
const panel = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), graph);
panel.name = "panel";
scene.add(panel);
S.onFrame(() => {
  if (S.time.frame !== 2) return;
  graph.setParameter("precision", "highp");      // a string
  graph.setParameter("flatShading", true);       // a boolean
  graph.setParameter("emissive", new S.Vector3(0.2, 0.4, 0.6)); // a vector
  graph.setParameter("glowWidth", 2);            // a name the fallback lacks
  graph.setParameter("name", "hijack");          // an identity field
});
S.mount(scene);
`, { backend: 'three', platform: 'web', assetRoot: 'assets' });

  const { consumer } = await makeConsumer();
  consumer.setCore(core);
  for (let i = 0; i < 5; i += 1) consumer.apply(core.tick(1 / 60));

  const material = consumer.objects.get(consumer.nativeDump().objects.find((o) => o.name === 'panel').id);
  const fallback = material.material;

  // The carryable values reached the same-named properties.
  assert.equal(fallback.precision, 'highp', 'a string parameter');
  assert.equal(fallback.flatShading, true, 'a boolean parameter');
  assert.deepEqual(
    [fallback.emissive.r, fallback.emissive.g, fallback.emissive.b].map((n) => +n.toFixed(4)),
    [0.2, 0.4, 0.6],
    'a vector parameter',
  );
  // And the two refusals wrote nothing.
  assert.equal('glowWidth' in fallback, false, 'a name the fallback does not have');
  assert.notEqual(fallback.name, 'hijack', 'an identity field');

  // The warning list is the core's, once each, with no consumer copy.
  const warnings = consumer.dump().warnings;
  const shaderWarnings = warnings.filter((w) => w.includes('ShaderGraphMaterial parameter'));
  assert.deepEqual(shaderWarnings, [
    'ShaderGraphMaterial parameter "glowWidth" has no matching property on the fallback '
    + 'MeshStandardMaterial; a consumer without shader graphs renders without it',
    'ShaderGraphMaterial parameter "name" is not written to the fallback MeshStandardMaterial: '
    + 'uuid, id, type, name, version identify the material itself. The shader graph still receives it',
  ], warnings.join('\n'));
  assert.deepEqual(consumer.warnings.filter((w) => w.includes('shader graph parameter')), [],
    'the consumer adds no warning of its own');

  // Every parameter still reaches the dump, refused ones included.
  // (JSON round-trip: the parameters ride the command stream, so compare values.)
  const dumped = JSON.parse(JSON.stringify(
    consumer.nativeDump().objects.find((o) => o.name === 'panel').material.parameters,
  ));
  assert.deepEqual(dumped, {
    precision: 'highp', flatShading: true, emissive: [0.2, 0.4, 0.6], glowWidth: 2, name: 'hijack',
  });
});
