import test from "node:test";
import assert from "node:assert/strict";
import { createHost, plain } from "./helpers.mjs";

const MATH_EXPORTS = [
  "Vector2",
  "Vector3",
  "Vector4",
  "Quaternion",
  "Euler",
  "Matrix3",
  "Matrix4",
  "Color",
  "Box3",
  "Sphere",
  "Plane",
  "Ray",
  "Spherical",
];

const SCENE_EXPORTS = ["Object3D", "Group", "Scene", "Mesh"];

const GEOMETRY_EXPORTS = [
  "BufferGeometry",
  "BufferAttribute",
  "Float32BufferAttribute",
  "BoxGeometry",
  "SphereGeometry",
  "PlaneGeometry",
  "CylinderGeometry",
  "ConeGeometry",
  "TorusGeometry",
  "CapsuleGeometry",
  "CircleGeometry",
  "RingGeometry",
  "TextGeometry",
];

const MATERIAL_EXPORTS = [
  "MeshBasicMaterial",
  "MeshStandardMaterial",
  "MeshPhysicalMaterial",
  "OcclusionMaterial",
];

const OTHER_EXPORTS = [
  "Texture",
  "TextureLoader",
  "AmbientLight",
  "DirectionalLight",
  "PointLight",
  "SpotLight",
  "ImageBasedLight",
  "RigidBody",
  "Joint",
  "ParticleEmitter",
  "Anchor",
  "Portal",
  "AnimationClip",
  "AnimationMixer",
  "AnimationAction",
  "KeyframeTrack",
  "VectorKeyframeTrack",
  "QuaternionKeyframeTrack",
  "NumberKeyframeTrack",
  "ColorKeyframeTrack",
  "SpatialUnsupportedError",
];

// Namespace objects rather than constructors.
const NAMESPACE_OBJECTS = ["MathUtils", "AnimationUtils"];

const CONSTANT_EXPORTS = [
  "FrontSide",
  "BackSide",
  "DoubleSide",
  "NormalBlending",
  "AdditiveBlending",
  "RepeatWrapping",
  "ClampToEdgeWrapping",
  "MirroredRepeatWrapping",
  "LoopOnce",
  "LoopRepeat",
  "LoopPingPong",
];

const RUNTIME_MEMBERS = [
  "mount",
  "scene",
  "onFrame",
  "offFrame",
  "time",
  "env",
  "dump",
  "find",
  "physics",
  "input",
  "inject",
  "environment",
  "raycast",
  "loadAsset",
  "dispose",
  "version",
];

// Section 4: names for out-of-scope features must not exist.
const OUT_OF_SCOPE = [
  "PerspectiveCamera",
  "OrthographicCamera",
  "ShaderMaterial",
  "RawShaderMaterial",
  "HemisphereLight",
  "RectAreaLight",
  "Sprite",
  "Line",
  "Points",
  "SkinnedMesh",
  "Audio",
  "WebGLRenderer",
  "Fog",
  "EffectComposer",
];

test("the namespace exports every class in SPEC section 3", () => {
  const host = createHost();
  host.load('const S = require("spatial"); this.S = S; S.mount(new S.Scene());');
  const namespace = host.spatial.Spatial;

  for (const name of [
    ...MATH_EXPORTS,
    ...SCENE_EXPORTS,
    ...GEOMETRY_EXPORTS,
    ...MATERIAL_EXPORTS,
    ...OTHER_EXPORTS,
  ]) {
    assert.equal(typeof namespace[name], "function", `${name} should be a constructor`);
  }
  for (const name of NAMESPACE_OBJECTS) {
    const kind = typeof namespace[name];
    assert.ok(kind === "object" || kind === "function", `${name} should be exported`);
  }
  for (const name of CONSTANT_EXPORTS) {
    assert.equal(typeof namespace[name], "number", `${name} should be a numeric constant`);
  }
  for (const name of RUNTIME_MEMBERS) {
    assert.ok(name in namespace, `Spatial.${name} should exist`);
  }
});

test("out-of-scope three.js names are not exported", () => {
  const host = createHost();
  host.load('const S = require("spatial"); S.mount(new S.Scene());');
  const namespace = host.spatial.Spatial;
  for (const name of OUT_OF_SCOPE) {
    assert.equal(namespace[name], undefined, `${name} must not be in the namespace`);
  }
});

test("math classes behave like three.js", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const probe = new S.Group();
    probe.name = "probe";
    scene.add(probe);
    const v = new S.Vector3(1, 2, 3).multiplyScalar(2).add(new S.Vector3(0, 1, 0));
    probe.userData.vector = v.toArray();
    probe.userData.length = new S.Vector2(3, 4).length();
    probe.userData.lerp = S.MathUtils.lerp(0, 10, 0.25);
    probe.userData.degrees = S.MathUtils.radToDeg(Math.PI);
    const q = new S.Quaternion().setFromEuler(new S.Euler(0, Math.PI / 2, 0));
    probe.userData.quaternion = [q.x, q.y, q.z, q.w];
    const box = new S.Box3(new S.Vector3(-1, -1, -1), new S.Vector3(1, 1, 1));
    probe.userData.contains = box.containsPoint(new S.Vector3(0.5, 0, 0));
    const spherical = new S.Spherical().setFromVector3(new S.Vector3(0, 1, 0));
    probe.userData.radius = spherical.radius;
    S.mount(scene);
  `);
  host.tick();
  const probe = host.dump().objects.find((entry) => entry.name === "probe");
  assert.deepEqual(plain(probe.userData.vector), [2, 5, 6]);
  assert.equal(probe.userData.length, 5);
  assert.equal(probe.userData.lerp, 2.5);
  assert.equal(probe.userData.degrees, 180);
  assert.ok(Math.abs(probe.userData.quaternion[1] - Math.SQRT1_2) < 1e-6);
  assert.equal(probe.userData.contains, true);
  assert.equal(probe.userData.radius, 1);
});

test("Color converts hex input to the linear working space like three.js", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const mesh = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial({ color: 0x3366ff }));
    mesh.name = "mesh";
    scene.add(mesh);
    S.mount(scene);
  `);
  const commands = host.tick();
  const material = commands.find((command) => command[0] === "material");
  const [r, g, b] = material[2].color;
  assert.ok(Math.abs(r - 0.03310477) < 1e-6);
  assert.ok(Math.abs(g - 0.13286832) < 1e-6);
  assert.equal(b, 1);
});
