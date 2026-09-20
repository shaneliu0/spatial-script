# SpatialScript API reference

The complete script-facing surface. Everything here is reachable from
`require("spatial")` (also the `Spatial` global). Names that are not listed do
not exist; referencing one is a plain `ReferenceError` or `TypeError`
(see [Not in scope](#not-in-scope)).

Source of truth for names, signatures and types: `types/spatial.d.ts`.
Behavioural contract: `SPEC.md`. Where the two disagree, this document follows
the shipped runtime and says so.

- Coming from three.js? Read [DIFFERENCES.md](./DIFFERENCES.md) first.
- Want a working script for a task? [COOKBOOK.md](./COOKBOOK.md).
- Something is wrong? [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## Contents

- [Conventions](#conventions)
- [1. Script model](#1-script-model)
  - [1.1 Shape of a script](#11-shape-of-a-script)
  - [1.2 Load, async bodies and top-level await](#12-load-async-bodies-and-top-level-await)
  - [1.3 Mounting and auto-mount](#13-mounting-and-auto-mount)
  - [1.4 Frame order](#14-frame-order)
  - [1.5 Legacy lifecycle members](#15-legacy-lifecycle-members)
- [2. Math](#2-math)
  - [Vector2](#vector2) · [Vector3](#vector3) · [Vector4](#vector4) · [Quaternion](#quaternion) · [Euler](#euler)
  - [Matrix3](#matrix3) · [Matrix4](#matrix4) · [Color](#color)
  - [Box3](#box3) · [Sphere](#sphere) · [Plane](#plane) · [Ray](#ray) · [Spherical](#spherical) · [MathUtils](#mathutils)
- [3. Scene graph](#3-scene-graph)
  - [Object3D](#object3d) — [three.js properties](#object3d-threejs-properties), [SpatialScript properties](#object3d-spatialscript-properties), [hierarchy methods](#object3d-hierarchy-methods), [transform methods](#object3d-transform-methods), [query methods](#object3d-query-methods), [event methods](#object3d-event-methods)
  - [Group](#group) · [Scene](#scene) · [Mesh](#mesh)
- [4. Geometry](#4-geometry)
  - [BufferGeometry](#buffergeometry) · [BufferAttribute](#bufferattribute-float32bufferattribute)
  - [Parametric geometries](#parametric-geometries) · [TextGeometry](#textgeometry)
- [5. Materials](#5-materials)
  - [Material contract](#material-contract) · [MeshBasicMaterial](#meshbasicmaterial) · [MeshStandardMaterial](#meshstandardmaterial) · [MeshPhysicalMaterial](#meshphysicalmaterial) · [OcclusionMaterial](#occlusionmaterial)
  - [Constants](#constants)
- [6. Textures](#6-textures)
  - [Texture](#texture) · [TextureLoader](#textureloader) · [URL forms](#url-forms)
- [7. Lights](#7-lights)
  - [AmbientLight](#ambientlight) · [DirectionalLight](#directionallight) · [PointLight](#pointlight) · [SpotLight](#spotlight) · [ImageBasedLight](#imagebasedlight)
  - [Intensity units](#intensity-units) · [Shadows](#shadows)
- [8. Physics](#8-physics)
  - [RigidBody](#rigidbody) · [Joint](#joint) · [Spatial.physics](#spatialphysics) · [Spatial.raycast](#spatialraycast) · [Collision groups](#collision-groups)
- [9. Input and interaction](#9-input-and-interaction)
  - [Making an object interactive](#making-an-object-interactive) · [Spatial.input](#spatialinput) · [Spatial.inject](#spatialinject)
- [10. Animation](#10-animation)
  - [AnimationClip](#animationclip) · [Keyframe tracks](#keyframe-tracks) · [AnimationMixer](#animationmixer) · [AnimationAction](#animationaction) · [AnimationUtils](#animationutils)
- [11. Particles](#11-particles)
- [12. Anchors and portals](#12-anchors-and-portals)
  - [Anchor](#anchor) · [Portal](#portal)
- [13. Assets](#13-assets)
- [14. Runtime](#14-runtime)
  - [Scene and frames](#scene-and-frames) · [Spatial.time](#spatialtime) · [Spatial.env](#spatialenv) · [Spatial.limits](#spatiallimits) · [Spatial.environment](#spatialenvironment)
  - [Spatial.find, destroy, dispose](#spatialfind-destroy-dispose) · [Spatial.dump](#spatialdump) · [Timers](#timers) · [console](#console)
- [15. Events](#15-events)
  - [Event list](#event-list) · [Payload shapes](#payload-shapes) · [Bubbling](#bubbling)
- [16. Errors and warnings](#16-errors-and-warnings)
  - [Load errors](#load-errors) · [Runtime errors](#runtime-errors) · [Warning catalogue](#warning-catalogue) · [Per-object exception safety](#per-object-exception-safety) · [SpatialUnsupportedError](#spatialunsupportederror)
- [17. Dump format](#17-dump-format)
- [Not in scope](#not-in-scope)
- [Appendix A: architecture](#appendix-a-architecture)

---

## Conventions

| Convention | Value |
|---|---|
| Units | metres, seconds, radians, kilograms |
| Coordinate system | right-handed, Y up (three.js and RealityKit agree) |
| Colours | any three.js `ColorRepresentation` (`0x3366ff`, `"red"`, `"#3366ff"`, a `Color`); stored and transmitted as linear sRGB in 0..1 |
| Scale | a comfortable scene fits within ~0.5 m of the origin; the viewer sits ~1 m away |

Backend columns throughout use three names:

| Column | Meaning |
|---|---|
| **RK macOS** | RealityKit consumer in the macOS host (`backend: "realitykit"`, `platform: "macos"`) |
| **RK visionOS** | RealityKit consumer on Vision Pro (`backend: "realitykit"`, `platform: "visionos"`) |
| **web** | three.js consumer in a browser (`backend: "three"`, `platform: "web"`) |

`yes` means fully supported. `accepted` means the value is stored, appears in
`dump()`, and reaches the consumer, but has no visual effect and produces no
warning. `warn` means the consumer logs one warning per scene, records it in
`dump().warnings`, and falls back to the behaviour named in the row.

Classes marked **(three)** are the vendored three.js classes, exported
unchanged. Their full three.js API works at runtime, but only the members
listed here are contract: consumers ignore the rest, and a future version may
tighten the export. Each such section links to the three.js documentation and
still lists the contract members inline.

---

## 1. Script model

### 1.1 Shape of a script

A script is a JavaScript file evaluated as a function body, not a module. There
is no `import`, no `export`, and no module cache; `require("spatial")` is the
only module lookup that resolves. `this` inside the body is the script object
(see [1.5](#15-legacy-lifecycle-members)).

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight } = Spatial;

const scene = new Scene();

const cube = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: 0x3366ff }));
cube.name = "cube";
scene.add(cube);

const sun = new DirectionalLight(0xffffff, 2);
sun.position.set(1, 2, 1);
scene.add(sun);

cube.addEventListener("tap", () => cube.material.color.set(0xff0000));
Spatial.onFrame((deltaTime) => { cube.rotation.y += deltaTime; });

Spatial.mount(scene);
```

`require("spatial")` and `require("Spatial")` both return the namespace. Any
other name throws:

<!-- expect-error: only require("spatial") -->
```js runnable
const Spatial = require("spatial");
const scene = new Spatial.Scene();
scene.name = "only";
Spatial.mount(scene);

// Nothing else is requireable, including "three".
require("three");
```

### 1.2 Load, async bodies and top-level await

The body is compiled twice: first as a plain function, and if that is a syntax
error, as an async function. So `await` at the top level works, and the
consequences follow from which form was used.

| Situation | Effect |
|---|---|
| Body has no top-level `await` | Runs to completion inside `load()`. Errors are load errors, thrown synchronously. |
| Body has top-level `await` | `load()` returns after the synchronous prefix. The rest resumes on later frame ticks. |
| Throw before the first `await` | Load error. If `load()` already returned, it is reported through the error channel with the same wording. |
| Throw after the first `await` | Runtime error. It lands in `dump().errors`; whatever was mounted keeps running. |
| Syntax error anywhere | Load error, with line and column where the engine supplies them. |

A load error tears the scene down. A runtime error never does.

Awaiting anything that needs time — a timer, `loadAsset`, `loadAsync` — requires
frames to pass, because the timers and the asset channel are driven by
`tick()`. Mount before you await, so the scene is on screen while the load
completes.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const cube = new Mesh(new BoxGeometry(0.15, 0.15, 0.15), new MeshStandardMaterial());
cube.name = "cube";
scene.add(cube);

Spatial.mount(scene);

// Resolved by a frame-driven timer, so the scene is already visible.
await new Promise((resolve) => setTimeout(resolve, 100));

const badge = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshStandardMaterial({ color: 0xffcc33 }));
badge.name = "badge";
badge.position.y = 0.2;
scene.add(badge);
```

### 1.3 Mounting and auto-mount

`Spatial.mount(scene)` makes `scene` the displayed scene. Exactly one scene is
mounted at a time; mounting another replaces the first and destroys the
previous scene's entities.

| Scenes constructed during load | Mounted? | Result |
|---|---|---|
| any number | yes | the mounted one is displayed |
| exactly 1 | no | auto-mounted, with the warning `No scene was mounted; auto-mounting the single Scene that was constructed` |
| 0 | no | load error: `The script finished without mounting a scene and constructed no Scene` |
| 2 or more | no | load error: `... and constructed N Scenes; call Spatial.mount(scene)` |

`Spatial.mount` throws `TypeError` for anything that is not a `Scene`.

### 1.4 Frame order

Per `tick(deltaTime)`, in order:

1. Apply native sync (physics transforms, manipulation, anchors, native animation) and body velocities.
2. Apply polled input, then dispatch every queued event (consumer events and `Spatial.inject` calls from the previous frame).
3. Run timers that are due, then pending `requestAnimationFrame` callbacks.
4. Run `this.update(dt)`, then every `Spatial.onFrame` callback in registration order.
5. `scene.updateMatrixWorld(true)`.
6. Diff against the last flushed state and emit commands.

`Spatial.time.frame` is 0 during load and 1 on the first tick.

### 1.5 Legacy lifecycle members

Assignments on `this` are still honoured. `update` runs before `onFrame`
callbacks.

| Member | When |
|---|---|
| `this.didAdd()` | once, after the body settles and a scene is mounted |
| `this.update(deltaTime)` | every frame, before `onFrame` callbacks |
| `this.willRemove()` | on `Spatial.dispose()` (consumer teardown) |

```js runnable
const Spatial = require("spatial");
const scene = new Spatial.Scene();
const box = new Spatial.Mesh(new Spatial.BoxGeometry(0.1, 0.1, 0.1), new Spatial.MeshStandardMaterial());
box.name = "box";
scene.add(box);
Spatial.mount(scene);

this.didAdd = function () { console.log("scene is live"); };
this.update = function (deltaTime) { box.rotation.y += deltaTime; };
this.willRemove = function () { console.log("torn down"); };
```

---

## 2. Math

All classes in this section are **(three)** and their full three.js API is in
scope — the contract does not restrict them. Reference:
<https://threejs.org/docs/#api/en/math/Vector3>.

Exported: `Vector2`, `Vector3`, `Vector4`, `Quaternion`, `Euler`, `Matrix3`,
`Matrix4`, `Color`, `Box3`, `Sphere`, `Plane`, `Ray`, `Spherical`, `MathUtils`.

Backend support: identical everywhere; these classes run in the core, never in
the consumer.

### Vector2

`new Vector2(x = 0, y = 0)` — <https://threejs.org/docs/#api/en/math/Vector2>

| Member | Type / signature |
|---|---|
| `x`, `y` | `number`, default 0 |
| `set(x, y)`, `copy(v)`, `clone()` | |
| `add(v)`, `sub(v)`, `multiplyScalar(s)`, `divideScalar(s)` | |
| `length()`, `lengthSq()`, `normalize()`, `dot(v)`, `distanceTo(v)` | |
| `lerp(v, alpha)`, `equals(v)`, `toArray()`, `fromArray(array, offset = 0)` | |

### Vector3

`new Vector3(x = 0, y = 0, z = 0)` — <https://threejs.org/docs/#api/en/math/Vector3>

| Member | Type / signature |
|---|---|
| `x`, `y`, `z` | `number`, default 0 |
| `set(x, y, z)`, `setScalar(s)`, `copy(v)`, `clone()` | |
| `add(v)`, `addScaledVector(v, s)`, `sub(v)`, `subVectors(a, b)` | |
| `multiply(v)`, `multiplyScalar(s)`, `divideScalar(s)`, `negate()` | |
| `applyQuaternion(q)`, `applyMatrix4(m)` | |
| `dot(v)`, `cross(v)`, `crossVectors(a, b)` | |
| `length()`, `lengthSq()`, `normalize()`, `setLength(l)` | |
| `distanceTo(v)`, `distanceToSquared(v)`, `lerp(v, alpha)`, `equals(v)` | |
| `setFromMatrixPosition(m)`, `toArray()`, `fromArray(array, offset = 0)` | |

```js runnable
const Spatial = require("spatial");
const { Scene, Group, Vector3 } = Spatial;

const scene = new Scene();
const probe = new Group();
probe.name = "probe";
scene.add(probe);

const a = new Vector3(0.2, 0, 0);
const b = new Vector3(0, 0.3, 0);
probe.position.copy(a).add(b).multiplyScalar(0.5);
probe.userData.distance = a.distanceTo(b);

Spatial.mount(scene);
```

### Vector4

`new Vector4(x = 0, y = 0, z = 0, w = 1)` — <https://threejs.org/docs/#api/en/math/Vector4>

Contract: `x`, `y`, `z`, `w`, `set`, `copy`, `clone`, `applyMatrix4`, `length`,
`normalize`, `toArray`.

### Quaternion

`new Quaternion(x = 0, y = 0, z = 0, w = 1)` — <https://threejs.org/docs/#api/en/math/Quaternion>

| Member | Signature |
|---|---|
| `x`, `y`, `z`, `w` | `number` (identity is `0, 0, 0, 1`) |
| `set`, `copy`, `clone`, `identity()`, `invert()`, `normalize()`, `equals(q)` | |
| `setFromEuler(euler, update = true)` | |
| `setFromAxisAngle(axis: Vector3, angle: number)` | angle in radians |
| `setFromRotationMatrix(m)`, `setFromUnitVectors(from, to)` | |
| `multiply(q)`, `multiplyQuaternions(a, b)`, `premultiply(q)` | |
| `slerp(q, t)`, `angleTo(q)`, `toArray()`, `fromArray(array, offset = 0)` | |

A zero-length quaternion (`0, 0, 0, 0`) is not a rotation: the frame diff
rejects the object's transform for that frame and records an error. See
[Runtime errors](#runtime-errors).

### Euler

`new Euler(x = 0, y = 0, z = 0, order = "XYZ")` — <https://threejs.org/docs/#api/en/math/Euler>

Contract: `x`, `y`, `z`, `order` (`"XYZ" | "YZX" | "ZXY" | "XZY" | "YXZ" | "ZYX"`),
`set`, `copy`, `clone`, `setFromQuaternion`, `setFromRotationMatrix`, `reorder`,
`toArray`. Angles are radians. `object.rotation` and `object.quaternion` stay in
sync automatically, as in three.js.

### Matrix3

`new Matrix3()` — <https://threejs.org/docs/#api/en/math/Matrix3>

Contract: `elements`, `set(n11..n33)`, `identity`, `copy`, `clone`, `invert`,
`transpose`, `multiply`, `determinant`, `getNormalMatrix(m4)`.

### Matrix4

`new Matrix4()` — <https://threejs.org/docs/#api/en/math/Matrix4>

Contract: `elements`, `set(n11..n44)`, `identity`, `copy`, `clone`, `invert`,
`transpose`, `multiply`, `premultiply`, `multiplyMatrices(a, b)`, `determinant`,
`compose(position, quaternion, scale)`, `decompose(position, quaternion, scale)`,
`makeTranslation(x, y, z)`, `makeRotationFromQuaternion(q)`, `makeRotationX/Y/Z(theta)`,
`makeRotationAxis(axis, angle)`, `makeScale(x, y, z)`, `lookAt(eye, target, up)`,
`setPosition(x | Vector3, y?, z?)`, `extractRotation(m)`.

A matrix containing shear cannot become a RealityKit transform. See
[Object3D.applyMatrix4](#object3d-transform-methods).

### Color

`new Color(color?)` or `new Color(r, g, b)` — <https://threejs.org/docs/#api/en/math/Color>

Channels are stored in the **linear** working space, matching three.js with
`ColorManagement` enabled: `new Color(0x3366ff)` reads the hex as sRGB and
converts, so `color.r` is not `0x33 / 255`. `getHexString()` converts back.

Contract: `r`, `g`, `b`, `set(color)`, `setHex(hex)`, `setRGB(r, g, b)`,
`setHSL(h, s, l)`, `setStyle(css)`, `copy`, `clone`, `getHex()`,
`getHexString()`, `lerp(color, alpha)`, `multiplyScalar(s)`, `equals`, `toArray()`.

An unparseable string is a three.js warning (`THREE.Color: Unknown color ...`),
not an error; the colour stays white. The warning appears in `dump().warnings`.

### Box3

`new Box3(min?, max?)` — <https://threejs.org/docs/#api/en/math/Box3>

Contract: `min`, `max`, `set`, `copy`, `clone`, `makeEmpty`, `isEmpty`,
`expandByPoint`, `expandByObject`, `setFromObject`, `setFromPoints`,
`getCenter(target)`, `getSize(target)`, `containsPoint`, `intersectsBox`,
`union`, `applyMatrix4`.

### Sphere

`new Sphere(center?, radius = 1)` — contract: `center`, `radius`, `set`, `copy`,
`clone`, `containsPoint`, `intersectsSphere`, `applyMatrix4`.

### Plane

`new Plane(normal?, constant = 0)` — contract: `normal`, `constant`, `set`,
`setFromNormalAndCoplanarPoint`, `copy`, `clone`, `normalize`,
`distanceToPoint`, `projectPoint(point, target)`, `intersectLine(line, target)`.

### Ray

`new Ray(origin?, direction?)` — contract: `origin`, `direction`, `set`, `copy`,
`clone`, `at(t, target)`, `lookAt(v)`, `distanceToPoint`,
`intersectSphere(sphere, target)`, `intersectPlane(plane, target)`,
`intersectBox(box, target)`, `applyMatrix4`.

`Ray` is pure maths. For a hit test against the live scene use
[`Spatial.raycast`](#spatialraycast).

### Spherical

`new Spherical(radius = 1, phi = 0, theta = 0)` — contract: `radius`, `phi`,
`theta`, `set`, `copy`, `clone`, `makeSafe`, `setFromVector3`,
`setFromCartesianCoords`.

### MathUtils

Namespace object — <https://threejs.org/docs/#api/en/math/MathUtils>

`DEG2RAD`, `RAD2DEG`, `generateUUID()`, `clamp(value, min, max)`,
`euclideanModulo(n, m)`, `mapLinear(x, a1, a2, b1, b2)`,
`inverseLerp(x, y, value)`, `lerp(x, y, t)`, `damp(x, y, lambda, dt)`,
`pingpong(x, length = 1)`, `smoothstep(x, min, max)`, `smootherstep(x, min, max)`,
`randInt(low, high)`, `randFloat(low, high)`, `randFloatSpread(range)`,
`seededRandom(s?)`, `degToRad(deg)`, `radToDeg(rad)`, `isPowerOfTwo(value)`.

---

## 3. Scene graph

### Object3D

**(three)**, with SpatialScript additions —
<https://threejs.org/docs/#api/en/core/Object3D>

`new Object3D()`. Rarely constructed directly; use `Group`, `Mesh`, or one of
the SpatialScript subclasses.

#### Object3D three.js properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `id` | `number` | assigned | three.js object id, not the command-stream id |
| `uuid` | `string` | generated | |
| `name` | `string` | `""` | the handle for `find`, `inject`, and the dump. Kept in full on the object and in `dump()`; the **command stream** carries at most 256 characters, warning once per object |
| `type` | `string` | class name | `"Object3D"`, `"Mesh"`, `"Scene"`, `"Anchor"`, `"Portal"`, `"ParticleEmitter"`, `"Asset"` |
| `parent` | `Object3D \| null` | `null` | |
| `children` | `Object3D[]` | `[]` | live array; snapshot it before mutating during iteration |
| `visible` | `boolean` | `true` | hides the object and its subtree |
| `userData` | `object` | `{}` | carried verbatim into `dump()`; the way to expose state for verification |
| `position` | `Vector3` | `(0,0,0)` | metres, local |
| `rotation` | `Euler` | `(0,0,0,"XYZ")` | radians, local |
| `quaternion` | `Quaternion` | identity | kept in sync with `rotation` |
| `scale` | `Vector3` | `(1,1,1)` | |
| `up` | `Vector3` | `(0,1,0)` | used by `lookAt` |
| `matrix` | `Matrix4` | identity | local; **writing it directly works** — see below |
| `matrixWorld` | `Matrix4` | identity | valid after `updateMatrixWorld` (the tick does this for you) |
| `matrixAutoUpdate` | `boolean` | `true` | `false` stops three from recomputing `matrix` from TRS each frame |
| `castShadow` | `boolean` | `false` | meshes; also on directional and spot lights |
| `receiveShadow` | `boolean` | `false` | meshes. RealityKit surfaces always receive shadows, so the value is accepted there with no visual difference and no warning |
| `renderOrder` | `number` | `0` | see the backend table below |

**Writing `matrix` directly.** The core keeps the last flushed local matrix per
object, so a direct write is picked up whether `matrixAutoUpdate` is `true` or
`false`, and is decomposed back into `position`/`quaternion`/`scale`:

```js
box.matrix.makeTranslation(0.3, 0, 0);   // box.position becomes (0.3, 0, 0)
```

With `matrixAutoUpdate` left at `true`, three.js would normally recompute
`matrix` from the TRS on the next update and lose the write; the core reads the
write first, so both forms behave the same.

**`matrixAutoUpdate = false` is the static hint.** It carries three.js
semantics — the matrix becomes authoritative and `position`/`rotation`/`scale`
are no longer read for it — and the core exploits that: a static object costs
sixteen array compares per frame and no property reads at all. That is what
makes large static scenery nearly free. Measured on the development Mac in the
interpreter (the visionOS execution mode), 8000 static objects cost **22 ms per
frame** with `matrixAutoUpdate` left on and **8.4 ms** with the hint.

The rule for using it: set the transform, call `updateMatrix()` once, then turn
the flag off. To move the object later, write `matrix` directly, or write the
TRS and call `updateMatrix()` again — writing `position` alone does nothing.

```js runnable
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, DirectionalLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.5, 1, 0.7);
scene.add(sun);

// Static scenery: one geometry, one material, and the static hint on each mesh.
const scenery = new Group();
scenery.name = "scenery";
scene.add(scenery);

const brick = new BoxGeometry(0.02, 0.02, 0.02);
const stone = new MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9 });

for (let i = 0; i < 200; i += 1) {
  const block = new Mesh(brick, stone);
  block.name = `block-${i}`;
  block.position.set((i % 20) * 0.025 - 0.25, Math.floor(i / 20) * 0.025 - 0.15, -0.3);
  block.updateMatrix();          // bake the transform into `matrix`
  block.matrixAutoUpdate = false; // and stop the core reading position/rotation/scale
  scenery.add(block);
}

// One moving object keeps its default matrixAutoUpdate.
const bird = new Mesh(new BoxGeometry(0.03, 0.02, 0.05), new MeshStandardMaterial({ color: 0xffcc33 }));
bird.name = "bird";
scene.add(bird);

Spatial.onFrame((deltaTime, elapsed) => {
  bird.position.set(Math.sin(elapsed) * 0.3, 0.15, 0);
  bird.rotation.y += deltaTime;
});

Spatial.mount(scene);
```

A static object still renders, still hit-tests, and still appears in `dump()`;
it just stops being polled for changes.

#### Object3D SpatialScript properties

| Property | Type | Default | RK macOS | RK visionOS | web |
|---|---|---|---|---|---|
| `opacity` | `number` 0..1 | `1` | yes | yes | yes |
| `billboard` | `boolean` | `false` | yes | yes | yes |
| `groundingShadow` | `boolean` | `false` | yes (mesh) | yes (mesh) | warn once, ignored |
| `hoverEffect` | `"highlight" \| "lift" \| "spotlight" \| null` | `null` | accepted, no visual (`capabilities.hoverEffect` is `false`) | yes — but `"lift"` warns once and renders as `"highlight"`, since the SDK has spotlight, highlight and shader only | accepted, no visual |
| `manipulable` | `boolean` | `false` | **warn once, ignored** | yes (system gesture) | emulated with a mouse drag on the view plane |
| `renderOrder` | `number` | `0` | **warn once, ignored** | yes (`ModelSortGroupComponent`) | yes |
| `rigidBody` | [`RigidBody`](#rigidbody) `\| null` | `null` | yes | yes | yes (Rapier) |

The three warn-once rows on RK macOS are not bugs: `ManipulationComponent` and
`ModelSortGroupComponent` are visionOS-only components, and macOS has no hover
target. They report themselves honestly through
[`Spatial.env.capabilities`](#spatialenv) — `manipulation` and `hoverEffect` are
both `false` there — so branch on the capability rather than setting the
property and hoping.

`opacity` is the whole-object opacity (RealityKit `OpacityComponent`): it
applies to the object **and every descendant** and is independent of
`material.opacity`. It never touches the material, so an opaque material under
`opacity = 0.5` still fades. A non-finite value is ignored with a warning.

Assigning `rigidBody` anything other than a `RigidBody` or `null` throws
`TypeError`. Assigning a body whose `shape` is `"mesh"` while `type` is
`"dynamic"` throws `SpatialUnsupportedError`. Assigning one `RigidBody`
**instance** to a second object throws `SpatialUnsupportedError` with `feature`
`"rigidbody-shared"`: impulses and velocity sync resolve through the body's
single owning object, so construct one `RigidBody` per object.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const panel = new Mesh(new BoxGeometry(0.2, 0.12, 0.01), new MeshStandardMaterial());
panel.name = "panel";
panel.opacity = 0.6;        // fades the panel and everything under it
panel.billboard = true;     // always faces the viewer
panel.hoverEffect = "highlight";
panel.manipulable = true;   // system grab / move / rotate / scale
panel.castShadow = true;
scene.add(panel);

Spatial.mount(scene);
```

#### Object3D hierarchy methods

| Method | Behaviour |
|---|---|
| `add(...objects): this` | Attaches, preserving local transforms. `null`/`undefined` are ignored with a warning; a non-`Object3D` throws `TypeError`; a destroyed object throws `SpatialUnsupportedError`; a parenting that would create a cycle, or push the graph past **1024 levels**, is refused and recorded in `dump().errors`. |
| `remove(...objects): this` | Detaches only. The consumer receives `parent id, -1`; the entity survives and can be re-added. Removing an object that is not a child is a no-op. |
| `removeFromParent(): this` | `parent.remove(this)`. |
| `clear(): this` | Detaches every child. |
| `attach(object): this` | Re-parents while preserving the object's **world** transform. Same validation as `add`. |
| `traverse(callback)` | Depth-first, this object first. Iterates a snapshot of `children`, so a callback may remove or destroy objects safely. |
| `traverseVisible(callback)` | Same, skipping subtrees with `visible === false`. |
| `traverseAncestors(callback)` | Walks up the parent chain, over a snapshot. |

Removing is not freeing. `remove` detaches; [`Spatial.destroy`](#spatialfind-destroy-dispose)
frees. Both matter — see [DIFFERENCES.md](./DIFFERENCES.md#destroy-versus-remove).

**Depth limit.** The scene graph is capped at 1024 levels. An `add` or `attach`
that would exceed it is refused and recorded once:
`SpatialUnsupportedError: Adding "x" would make the scene graph 1025 levels
deep; the limit is 1024` (`feature: "depth-limit"`). Everything already in the
graph keeps working. The cap exists so a runaway nesting loop cannot blow the
stack in the flush walk, the dump, or teardown.

```js runnable
const Spatial = require("spatial");
const { Scene, Group, Mesh, SphereGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const rig = new Group();
rig.name = "rig";
rig.position.set(0, 0.1, 0);
scene.add(rig);

const ball = new Mesh(new SphereGeometry(0.05, 16, 12), new MeshStandardMaterial());
ball.name = "ball";
ball.position.set(0.2, 0, 0);
scene.add(ball);

scene.updateMatrixWorld(true);
rig.attach(ball);           // keeps the ball where it looks, re-parents to rig

let count = 0;
scene.traverse(() => { count += 1; });
rig.userData.objectCount = count;

Spatial.mount(scene);
```

#### Object3D transform methods

| Method | Notes |
|---|---|
| `lookAt(target: Vector3)` / `lookAt(x, y, z)` | orients `-Z` at the target using `up` |
| `localToWorld(v): Vector3` / `worldToLocal(v): Vector3` | mutates and returns `v` |
| `getWorldPosition(target)` / `getWorldQuaternion(target)` / `getWorldScale(target)` / `getWorldDirection(target)` | write into `target` |
| `applyMatrix4(matrix): this` | premultiplies `matrix` onto the local matrix and decomposes to TRS |
| `applyQuaternion(q): this` | |
| `setRotationFromAxisAngle(axis, angle)` / `setRotationFromEuler(euler)` / `setRotationFromQuaternion(q)` | |
| `rotateX/Y/Z(angle)`, `rotateOnAxis(axis, angle)`, `rotateOnWorldAxis(axis, angle)` | radians |
| `translateX/Y/Z(distance)`, `translateOnAxis(axis, distance)` | metres |
| `updateMatrix()`, `updateMatrixWorld(force?)`, `updateWorldMatrix(updateParents, updateChildren)` | the tick calls `updateMatrixWorld(true)` on the mounted scene for you |
| `clone(recursive = true): this` / `copy(source, recursive?): this` | carries `opacity`, `billboard`, `groundingShadow`, `hoverEffect`, `manipulable` across; **event listeners and `rigidBody` are not cloned** |

**Shear.** `applyMatrix4` and direct writes to `matrix` may contain shear, which
has no TRS representation. The core does **not** throw. It records a
`SpatialUnsupportedError` in `dump().errors` naming the object, reports it once
per object, skips that object's transform for **every frame the shear persists**
(the consumer keeps the last valid transform), and keeps every other object
updating. The object recovers by itself the moment the matrix becomes
decomposable again, and a fresh error is then reported if it shears a second
time.

`attach()` onto a rotated, non-uniformly scaled parent does **not** produce a
shear error: the core composes the new local transform without going through a
sheared intermediate.

<!-- expect-error: contains shear -->
```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshBasicMaterial, Matrix4 } = Spatial;

const scene = new Scene();
const box = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
box.name = "box";
scene.add(box);

// A shear matrix: the scene keeps running, the object keeps its last transform.
box.applyMatrix4(new Matrix4().set(1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1));

Spatial.mount(scene);
```

#### Object3D query methods

| Method | Returns |
|---|---|
| `getObjectByName(name)` | `Object3D \| undefined` |
| `getObjectById(id)` | `Object3D \| undefined` |
| `getObjectByProperty(name, value)` | `Object3D \| undefined` |

[`Spatial.find(name)`](#spatialfind-destroy-dispose) is the same lookup
on the mounted scene, normalised to `null` on a miss.

#### Object3D event methods

| Method | Notes |
|---|---|
| `addEventListener(type, listener)` | For an input event type this also makes the object an input target (collision shape + `InputTargetComponent`) and emits an `interactive` command. At most `Spatial.limits.MAX_LISTENERS_PER_EVENT` (1000) listeners per object per type; a further one is dropped with a warning |
| `hasEventListener(type, listener): boolean` | |
| `removeEventListener(type, listener)` | Removing the last listener of a type clears the corresponding input flag |
| `dispatchEvent(event)` | For SpatialScript event types this bubbles; for any other type it is three's single-target dispatch |

Full list in [15. Events](#15-events).

### Group

**(three)** — <https://threejs.org/docs/#api/en/objects/Group>

`new Group()`. An `Object3D` with `type === "Group"` and `isGroup === true`. No
extra members. Use it to move a set of objects together, and as the world of a
[`Portal`](#portal).

```js runnable
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const row = new Group();
row.name = "row";
scene.add(row);

for (let i = 0; i < 3; i += 1) {
  const cube = new Mesh(new BoxGeometry(0.08, 0.08, 0.08), new MeshStandardMaterial());
  cube.name = `cube-${i}`;
  cube.position.x = (i - 1) * 0.12;
  row.add(cube);
}

Spatial.onFrame((deltaTime) => { row.rotation.y += deltaTime * 0.5; });
Spatial.mount(scene);
```

### Scene

**(three, constrained)** — <https://threejs.org/docs/#api/en/scenes/Scene>

`new Scene()`. A `Group` with `type === "Scene"`. The mounted scene's transform
is the native root; its own `position`/`rotation`/`scale` are honoured.

| Property | Behaviour |
|---|---|
| `background` | not in scope — assigning a non-null value throws `SpatialUnsupportedError` |
| `environment` | not in scope — throws. Use [`Spatial.environment`](#spatialenvironment) |
| `fog` | not in scope — throws |

The `Scene` receives every bubbled input event last, which makes it the place
for a scene-wide listener.

<!-- expect-error: Scene.background is not in scope -->
```js runnable
const Spatial = require("spatial");
const scene = new Spatial.Scene();
scene.name = "world";
scene.add(new Spatial.AmbientLight(0xffffff, 1));
Spatial.mount(scene);

scene.background = new Spatial.Color(0x101014);
```

### Mesh

**(three, constrained)** — <https://threejs.org/docs/#api/en/objects/Mesh>

`new Mesh(geometry?, material?)`

| Property | Type | Default | Notes |
|---|---|---|---|
| `geometry` | [`BufferGeometry`](#4-geometry) | an empty `BufferGeometry` | assigning a new geometry re-emits the geometry command |
| `material` | [`Material`](#5-materials) `\| null` | a `MeshStandardMaterial` | exactly one; assigning an array throws `SpatialUnsupportedError` |

Omitting an argument is tolerated but warns:

- no geometry → an empty `BufferGeometry` is substituted, warning
  `Mesh "x" was created without a geometry; an empty BufferGeometry was substituted`.
- no material → a **`MeshStandardMaterial`** is substituted (three.js would use
  the unlit `MeshBasicMaterial`), warning
  `Mesh "x" was created without a material; a MeshStandardMaterial was substituted`.

Assigning `mesh.material = null` after construction is allowed and leaves the
mesh with no material; it then renders with the consumer's default. Prefer
assigning a real material.

Mutating a material in place (`mesh.material.color.set(...)`) is picked up by
the frame diff; you do not need `needsUpdate`.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, SphereGeometry, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const shape = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial({ color: 0x3366ff }));
shape.name = "shape";
scene.add(shape);

Spatial.onFrame(() => {
  if (Spatial.time.frame === 30) shape.geometry = new SphereGeometry(0.08, 24, 16);
  if (Spatial.time.frame === 60) shape.material = new MeshStandardMaterial({ color: 0xff3366 });
});

Spatial.mount(scene);
```

---

## 4. Geometry

All geometry runs in the core. RealityKit regenerates `BoxGeometry`,
`SphereGeometry`, `PlaneGeometry`, `CylinderGeometry`, `ConeGeometry`, and
`TextGeometry` with native generators from `parameters`, and uses the vertex
buffers for everything else. The web consumer always uses the buffers.

Geometry instances are cached by `uuid` on both backends: 1500 meshes sharing
one `BoxGeometry` instance produce one native mesh resource. **Share geometry.**

### BufferGeometry

**(three)** — <https://threejs.org/docs/#api/en/core/BufferGeometry>

`new BufferGeometry()`

| Property | Type | Default |
|---|---|---|
| `uuid` | `string` | generated |
| `type` | `string` | `"BufferGeometry"` |
| `attributes` | `Record<string, BufferAttribute>` | `{}` |
| `index` | `BufferAttribute \| null` | `null` |
| `boundingBox` | `Box3 \| null` | `null` until `computeBoundingBox()` |
| `boundingSphere` | `Sphere \| null` | `null` until `computeBoundingSphere()` |
| `parameters` | `object \| undefined` | present on the parametric geometries and `TextGeometry`. Reaches native code, so it is sanitised on the way out: numbers are made finite, a string value is truncated at 256 characters, an array value longer than 64 entries is dropped, and only the first 64 keys are carried. The object you hold is untouched |

| Method | Notes |
|---|---|
| `setAttribute(name, attribute): this` | contract names: `"position"`, `"normal"`, `"uv"` — other names are kept in the core but not transmitted. **Re-emits the geometry.** |
| `getAttribute(name): BufferAttribute \| undefined` | |
| `deleteAttribute(name): this` | **re-emits the geometry** |
| `setIndex(index: BufferAttribute \| number[] \| null): this` | indices are widened to `Uint32Array` in the command stream. **Re-emits the geometry.** |
| `computeVertexNormals()` | **re-emits the geometry** |
| `computeBoundingBox()` / `computeBoundingSphere()` | fills `boundingBox` / `boundingSphere`; no command |
| `applyMatrix4(m)` | bakes a transform into the vertices. **Re-emits the geometry.** |
| `translate(x, y, z)`, `rotateX/Y/Z(angle)`, `scale(x, y, z)`, `center()` | bake a transform into the vertices (they go through `applyMatrix4`, so they re-emit too) |
| `clone(): BufferGeometry` | a new `uuid`, so a new native resource |
| `dispose()` | |

**Mutating a geometry in place is supported.** `setAttribute`,
`deleteAttribute`, `setIndex`, `computeVertexNormals` and `applyMatrix4` bump an
internal revision, so the frame diff emits a fresh `geometry` command and both
consumers rebuild the native mesh and its bounds. Every mesh sharing that
geometry instance updates.

**`uuid` plus `revision` is the cache key.** Each `geometry` command carries
`{ type, uuid, parameters, revision }`. `uuid` is stable for the life of the
geometry object and shared by every mesh using that instance; `revision` is an
**opaque token** — compare it for equality, never order or parse it — that
changes on every mutation. Consumers cache the native mesh
resource by the pair, which is why 1500 meshes sharing one `BoxGeometry` build
one native mesh.

That also decides whether the vertex buffers travel:

| Geometry | Second and later meshes at the same `uuid` + `revision` |
|---|---|
| a **parametric** geometry (`BoxGeometry`, `SphereGeometry`, …, `TextGeometry`) | buffers are `null`; the consumer reuses the resource it already has |
| a plain **`BufferGeometry`** | **always carries its buffers** — the core cannot regenerate it from parameters, so it re-sends them |

The practical consequence: a hand-built `BufferGeometry` shared by many meshes
re-uploads its vertices once per mesh, while a parametric geometry does not.
For a large repeated shape, prefer a parametric geometry, or accept the upload
cost once and never mutate it.

Editing the numbers **inside** an existing attribute array is the one case the
revision cannot see. Set `attribute.needsUpdate = true` after such an edit, or
call `setAttribute` again with the same attribute, so the change is picked up:

```js
const position = geometry.getAttribute("position");
position.setXYZ(0, x, y, z);
position.needsUpdate = true;      // otherwise the edit never leaves the core
```

Re-emitting a geometry sends its whole vertex payload again, so prefer swapping
`mesh.geometry` for a prebuilt geometry over rewriting a large buffer each
frame.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, AmbientLight, DoubleSide } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const geometry = new BufferGeometry();
geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0.2, 0, 0, 0, 0.2, 0, 0.2, 0.2, 0], 3));
geometry.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
geometry.setIndex([0, 1, 2, 2, 1, 3]);
geometry.computeVertexNormals();
geometry.computeBoundingBox();

const quad = new Mesh(geometry, new MeshStandardMaterial({ side: DoubleSide }));
quad.name = "quad";
scene.add(quad);

Spatial.mount(scene);
```

### BufferAttribute, Float32BufferAttribute

**(three)** — <https://threejs.org/docs/#api/en/core/BufferAttribute>

`new BufferAttribute(array, itemSize, normalized = false)`
`new Float32BufferAttribute(array | length, itemSize, normalized = false)`

| Member | Type / signature |
|---|---|
| `array` | `ArrayLike<number>` |
| `itemSize` | `number` |
| `count` | `number` (read-only, `array.length / itemSize`) |
| `normalized` | `boolean`, default `false` |
| `needsUpdate` | `boolean` — set `true` after editing `array` in place so the diff re-emits the geometry |
| `getX(i)`, `getY(i)`, `getZ(i)`, `setXY(i, x, y)`, `setXYZ(i, x, y, z)` | |

### Parametric geometries

**(three, with normalised arguments)**. Every one keeps its three.js
constructor signature and `parameters` object. Arguments are normalised before
three sees them: a negative size becomes its absolute value, zero becomes
`0.001`, a segment count is rounded to an integer at or above the minimum, and
a non-finite value falls back to the default. Each adjustment produces one
warning per geometry instance:
`BoxGeometry arguments were normalized: width -0.2 -> 0.2, height 0 -> 0.001`.

| Class | Constructor | Defaults | Segment minimums |
|---|---|---|---|
| `BoxGeometry` | `(width, height, depth, widthSegments, heightSegments, depthSegments)` | `1, 1, 1, 1, 1, 1` | 1 each |
| `SphereGeometry` | `(radius, widthSegments, heightSegments, phiStart, phiLength, thetaStart, thetaLength)` | `1, 32, 16, 0, 2π, 0, π` | 3, 2 |
| `PlaneGeometry` | `(width, height, widthSegments, heightSegments)` | `1, 1, 1, 1` | 1, 1 |
| `CylinderGeometry` | `(radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength)` | `1, 1, 1, 32, 1, false, 0, 2π` | 3, 1 |
| `ConeGeometry` | `(radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength)` | `1, 1, 32, 1, false, 0, 2π` | 3, 1 |
| `TorusGeometry` | `(radius, tube, radialSegments, tubularSegments, arc)` | `1, 0.4, 12, 48, 2π` | 3, 3 |
| `CapsuleGeometry` | `(radius, height, capSegments, radialSegments, heightSegments)` | `1, 1, 4, 8, 1` | 1, 3, 1 |
| `CircleGeometry` | `(radius, segments, thetaStart, thetaLength)` | `1, 32, 0, 2π` | 3 |
| `RingGeometry` | `(innerRadius, outerRadius, thetaSegments, phiSegments, thetaStart, thetaLength)` | `0.5, 1, 32, 1, 0, 2π` | 3, 1 |

The defaults are one metre across, which is enormous for a spatial scene.
Always pass explicit sizes.

Backend support: all nine on all three backends.

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));

const shapes = [
  ["box", new S.BoxGeometry(0.1, 0.1, 0.1)],
  ["sphere", new S.SphereGeometry(0.06, 20, 14)],
  ["plane", new S.PlaneGeometry(0.2, 0.15)],
  ["cylinder", new S.CylinderGeometry(0.05, 0.05, 0.14, 20)],
  ["cone", new S.ConeGeometry(0.06, 0.14, 20)],
  ["torus", new S.TorusGeometry(0.07, 0.02, 12, 32)],
  ["capsule", new S.CapsuleGeometry(0.04, 0.08, 6, 12)],
  ["circle", new S.CircleGeometry(0.07, 24)],
  ["ring", new S.RingGeometry(0.04, 0.08, 24)],
];

shapes.forEach(([name, geometry], index) => {
  const mesh = new S.Mesh(geometry, new S.MeshStandardMaterial());
  mesh.name = name;
  mesh.position.x = (index - 4) * 0.16;
  scene.add(mesh);
});

Spatial.mount(scene);
```

### TextGeometry

**(ours)**

`new TextGeometry(text: string, { size = 0.1, depth = 0.01, font = "default" } = {})`

| Option | Type | Default | Notes |
|---|---|---|---|
| `size` | `number` (metres) | `0.1` | cap height of the glyphs |
| `depth` | `number` (metres) | `0.01` | extrusion along `+Z` |
| `font` | `"default"` | `"default"` | any other value throws `SpatialUnsupportedError` with `feature` `"TextGeometry.font"` |

`parameters` is `{ text, size, depth, font }`. The core generates real vertices
with the bundled font, so `computeBoundingBox()` works and the web consumer
renders them; RealityKit regenerates the glyphs natively from `parameters`.

The glyph run starts at the origin and extends to `+X`, so centre it yourself.
Combine with `billboard = true` for a label that always faces the viewer.

| Backend | Behaviour |
|---|---|
| RK macOS / visionOS | native text generation from `parameters` |
| web | the generated vertex buffers |

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, TextGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const geometry = new TextGeometry("HELLO", { size: 0.05, depth: 0.008 });
geometry.computeBoundingBox();
const bounds = geometry.boundingBox;
geometry.translate(-(bounds.max.x + bounds.min.x) / 2, -(bounds.max.y + bounds.min.y) / 2, 0);

const label = new Mesh(geometry, new MeshStandardMaterial({ color: 0xffffff, emissive: 0x222222 }));
label.name = "label";
label.billboard = true;
scene.add(label);

Spatial.mount(scene);
```

---

## 5. Materials

**(three, with a constrained contract)** —
<https://threejs.org/docs/#api/en/materials/MeshStandardMaterial>

One material per mesh. Materials are shared by `uuid` in both consumers, so
several meshes using the same material instance share one native material and
all of them update when it changes. **Prefer fewer material instances.**

### Material contract

| Property | Type | Default | Basic | Standard | Physical | RealityKit mapping |
|---|---|---|---|---|---|---|
| `color` | `Color` | `0xffffff` | yes | yes | yes | baseColor tint |
| `map` | `Texture \| null` | `null` | yes | yes | yes | baseColor texture |
| `opacity` | `number` 0..1 | `1` | yes | yes | yes | blending `.transparent(opacity)` |
| `transparent` | `boolean` | `false` | yes | yes | yes | enables the transparent blend |
| `side` | `FrontSide \| BackSide \| DoubleSide` | `FrontSide` (`0`) | yes | yes | yes | face culling |
| `wireframe` | `boolean` | `false` | yes | yes | yes | **warn once**, rendered solid |
| `depthWrite` | `boolean` | `true` | yes | yes | yes | `writesDepth` |
| `depthTest` | `boolean` | `true` | yes | yes | yes | `readsDepth` |
| `blending` | `NormalBlending \| AdditiveBlending` | `NormalBlending` | yes | yes | yes | Additive: **warn once**, rendered transparent |
| `emissive` | `Color` | `0x000000` | — | yes | yes | `emissiveColor` |
| `emissiveIntensity` | `number` ≥ 0 | `1` | — | yes | yes | `emissiveIntensity` |
| `emissiveMap` | `Texture \| null` | `null` | — | yes | yes | emissive texture |
| `metalness` | `number` 0..1 | `0` | — | yes | yes | `metallic` |
| `metalnessMap` | `Texture \| null` | `null` | — | yes | yes | |
| `roughness` | `number` 0..1 | `1` | — | yes | yes | `roughness` |
| `roughnessMap` | `Texture \| null` | `null` | — | yes | yes | |
| `normalMap` | `Texture \| null` | `null` | — | yes | yes | `normal` |
| `clearcoat` | `number` 0..1 | `0` | — | — | yes | `clearcoat` |
| `clearcoatRoughness` | `number` 0..1 | `0` | — | — | yes | `clearcoatRoughness` |

Shared members on every material: `uuid` (read-only), `type`, `name`,
`needsUpdate`, `clone(): this`, `dispose()`.

Out-of-range scalars are clamped before they reach a consumer, with one warning
per material instance:
`MeshStandardMaterial properties were clamped: opacity 4 -> 1`.

For a transparent material set **both** `transparent = true` and
`opacity < 1`; `opacity` alone does nothing, exactly as in three.js. For
whole-object fading prefer [`Object3D.opacity`](#object3d-spatialscript-properties).

### MeshBasicMaterial

`new MeshBasicMaterial(parameters?)` — unlit. Maps to RealityKit
`UnlitMaterial`. Accepts `color`, `map`, `opacity`, `transparent`, `side`,
`wireframe`, `depthWrite`, `depthTest`, `blending`.

Use it for anything that must keep its colour with no lights in the scene.

### MeshStandardMaterial

`new MeshStandardMaterial(parameters?)` — physically based. Maps to
`PhysicallyBasedMaterial`. Adds `emissive`, `emissiveIntensity`, `emissiveMap`,
`metalness`, `metalnessMap`, `roughness`, `roughnessMap`, `normalMap`.

This is the default choice, and the one substituted when a `Mesh` is built
without a material. It is invisible without a light — see
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md#nothing-renders).

### MeshPhysicalMaterial

`new MeshPhysicalMaterial(parameters?)` — `MeshStandardMaterial` plus
`clearcoat` and `clearcoatRoughness`. Also maps to `PhysicallyBasedMaterial`.

### OcclusionMaterial

**(ours)** `new OcclusionMaterial(parameters?)`

Renders nothing but occludes what is behind it. Maps to RealityKit
`OcclusionMaterial`; on web it is depth-only (`colorWrite = false`).

| Backend | Behaviour |
|---|---|
| RK macOS / visionOS | native `OcclusionMaterial` |
| web | depth-only draw |

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 0.6));
const sun = new S.DirectionalLight(0xffffff, 2);
sun.position.set(0.5, 1, 0.8);
scene.add(sun);

const basic = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshBasicMaterial({ color: 0x3366ff }));
basic.name = "basic";
basic.position.x = -0.24;
scene.add(basic);

const standard = new S.Mesh(
  new S.BoxGeometry(0.1, 0.1, 0.1),
  new S.MeshStandardMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.25 }),
);
standard.name = "standard";
scene.add(standard);

const physical = new S.Mesh(
  new S.BoxGeometry(0.1, 0.1, 0.1),
  new S.MeshPhysicalMaterial({ color: 0xff3366, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
);
physical.name = "physical";
physical.position.x = 0.24;
scene.add(physical);

const occluder = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), new S.OcclusionMaterial());
occluder.name = "occluder";
occluder.position.z = 0.2;
scene.add(occluder);

Spatial.mount(scene);
```

### Constants

| Constant | Value | Used by |
|---|---|---|
| `FrontSide` | `0` | `material.side` |
| `BackSide` | `1` | `material.side` |
| `DoubleSide` | `2` | `material.side` |
| `NormalBlending` | three.js value | `material.blending` |
| `AdditiveBlending` | three.js value | `material.blending` (web only) |
| `RepeatWrapping` | three.js value | `texture.wrapS` / `wrapT` |
| `ClampToEdgeWrapping` | three.js value | texture wrap (the default) |
| `MirroredRepeatWrapping` | three.js value | texture wrap |
| `LoopOnce` | three.js value | `AnimationAction.setLoop` |
| `LoopRepeat` | three.js value | `AnimationAction.setLoop` |
| `LoopPingPong` | three.js value | `AnimationAction.setLoop` |

---

## 6. Textures

**(ours, three-shaped.)** Not three's `Texture`: three's loader reaches for
`document` and `Image`, which the core must never touch. The core owns the URL
and the sampler state; the consumer decodes.

### Texture

`new Texture(url = null)`

| Property | Type | Default | Notes |
|---|---|---|---|
| Property | Type | Default | RK macOS / visionOS | web |
|---|---|---|---|---|
| `url` | `string \| null` | the constructor argument | resolved against the asset root at flush time | same |
| `repeat` | `Vector2` | `(1, 1)` | texture transform scale | `texture.repeat` |
| `offset` | `Vector2` | `(0, 0)` | texture transform offset | `texture.offset` |
| `wrapS` | `number` | `ClampToEdgeWrapping` | sampler `sAddressMode` | `texture.wrapS` |
| `wrapT` | `number` | `ClampToEdgeWrapping` | sampler `tAddressMode` | `texture.wrapT` |
| `flipY` | `boolean` | `true` | `false` flips the decoded image | `texture.flipY` |
| `needsUpdate` | `boolean` | `false` | | |
| `loaded` | `boolean` | `false` | set by the consumer | set by the consumer |
| `error` | `string \| null` | `null` | set by the consumer on failure | set by the consumer on failure |

To tile a texture you must set **both** `repeat` and a repeating wrap mode;
`ClampToEdgeWrapping` (the default) stretches the edge pixels instead.

| Method | Notes |
|---|---|
| `addEventListener("load" \| "error", listener)` | `error` payload carries `message` |
| `removeEventListener(type, listener)` | |
| `clone(): Texture` | copies url and sampler state; a new texture id |
| `dispose()` | marks the texture for release — see below |

Changing `url`, `repeat`, `offset`, `wrapS`, `wrapT`, or `flipY` re-emits the
texture command; the diff picks it up without `needsUpdate`.

**Releasing a texture.** `texture.dispose()` does not free anything
immediately. The core stops re-emitting the texture's properties and queues a
release; the `["texture", id, null]` command that tells the consumer to free the
native resource is emitted only once **no live material or particle emitter
still names the texture**, and the texture's id stays reserved until then. So
the working order is: stop referencing it, then dispose.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, PlaneGeometry, MeshStandardMaterial, AmbientLight, TextureLoader } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const loader = new TextureLoader();
const first = loader.load("asset://grid.png");
const second = loader.load("asset://wood.png");

const material = new MeshStandardMaterial({ map: first });
const panel = new Mesh(new PlaneGeometry(0.3, 0.3), material);
panel.name = "panel";
scene.add(panel);

Spatial.mount(scene);

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 30) return;
  // Repoint the material first, then dispose: the release command is held back
  // until nothing references the texture any more.
  material.map = second;
  material.needsUpdate = true;
  first.dispose();
  panel.userData.swapped = true;
});
```

Disposing a texture a material still uses is not an error, but nothing is freed
until you repoint the material, and the web consumer warns once
(`texture N was released while a material still references it; it is kept until
the material changes`).

### TextureLoader

`new TextureLoader()`

| Method | Returns | Notes |
|---|---|---|
| `setPath(path): this` | | prefix prepended to every subsequent `load` url |
| `load(url, onLoad?, onProgress?, onError?): Texture` | the `Texture` **immediately** | it resolves later; `onProgress` is accepted for signature parity and never called |
| `loadAsync(url, onProgress?): Promise<Texture>` | | rejects with an `Error` carrying the consumer's message |

Backend support: all three. A failure dispatches `error` on the texture, calls
`onError`, and logs; the material stays usable and renders untextured.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, PlaneGeometry, MeshStandardMaterial, AmbientLight, TextureLoader, RepeatWrapping } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const loader = new TextureLoader();
const grid = loader.load(
  "asset://grid.png",
  () => console.log("texture ready"),
  undefined,
  (error) => console.warn("texture failed:", error.message),
);
grid.repeat.set(2, 2);
grid.wrapS = RepeatWrapping;
grid.wrapT = RepeatWrapping;

const panel = new Mesh(new PlaneGeometry(0.3, 0.3), new MeshStandardMaterial({ map: grid }));
panel.name = "panel";
scene.add(panel);

Spatial.mount(scene);
```

### URL forms

| Form | Resolved by |
|---|---|
| `https://…` / `http://…` | the consumer's network stack |
| `file:///…` | the consumer's file system |
| `data:…` | inline |
| `asset://name` | the consumer's own app bundle |
| anything else | joined onto the script's asset root |

**Containment.** A script's url reaches the file system of both consumers, so
the core resolves and checks it before anything is emitted. Every rule warns
once naming the url; nothing is dropped silently.

| Rule | Effect |
|---|---|
| Scheme allow-list: `https:`, `http:`, `file:`, `asset:`, `data:` | anything else is **dropped**: `The url scheme "ftp:" is not allowed; "ftp://x/a.png" was dropped` |
| `.` and `..` are collapsed | `sub/./a.png` becomes `sub/a.png` |
| A path that climbs above its root is **dropped** | `"../../etc/passwd" escapes the asset root and was dropped` |
| Credentials are stripped | `https://user:pw@example.com/a.png` becomes `https://example.com/a.png`, with `Credentials were stripped from … before it reached the consumer` |
| A relative path is joined onto the asset root | with `assetRoot: "assets"`, `sub/dir/a.png` becomes `assets/sub/dir/a.png` |
| `data:` urls pass through unchanged | |

**Every url a script supplies goes through this one gate** — textures, assets
and the environment alike — so the file system on the other side of the command
stream is reached through a single check rather than three.

| Where | What a refused url does |
|---|---|
| a `Texture` | the texture carries `url: null`; the material stays usable and renders untextured |
| `Spatial.loadAsset({ usdz, glb, … })` | that **key** is dropped. If the backend still has a usable key the load proceeds on it; if not the promise rejects with `SpatialUnsupportedError` (`feature: "loadAsset"`), message `loadAsset refused usdz and glb: the url leaves the asset root or uses a scheme that is not allowed` |
| `Spatial.environment` | **no environment is installed**, with a second warning: `Spatial.environment was dropped because its url was refused`. `dump().environment` is `null` |

An accepted relative url is rewritten on the way out, so
`Spatial.loadAsset({ usdz: "models/robot.usdz" })` with `assetRoot: "assets"`
reaches the consumer as `assets/models/robot.usdz`, and `dump().environment.url`
shows the resolved form rather than the one you wrote.

---

## 7. Lights

**(three)** — <https://threejs.org/docs/#api/en/lights/DirectionalLight>

Exported: `AmbientLight`, `DirectionalLight`, `PointLight`, `SpotLight`, and
`ImageBasedLight` (ours). `HemisphereLight` and `RectAreaLight` are **not in
scope**.

Shared members on every light: `color: Color`, `intensity: number`, plus the
whole `Object3D` surface. Out-of-range scalars are clamped with one warning per
light instance (`PointLight properties were clamped: intensity -5 -> 0`).

### AmbientLight

`new AmbientLight(color = 0xffffff, intensity = 1)`

Unitless multiplier. RealityKit has no ambient light: the consumer generates an
image-based light with a uniform environment at this intensity. If it cannot,
it warns once and skips.

| Backend | Behaviour |
|---|---|
| RK macOS / visionOS | uniform image-based light |
| web | three.js `AmbientLight` |

**The one visible difference between backends.** Because RealityKit implements
ambient as an image-based light, it lights **metals**: a
`MeshStandardMaterial` with `metalness: 1` under nothing but an `AmbientLight`
is lit on RealityKit and stays black on the web, where three.js's `AmbientLight`
contributes only to the diffuse term. If a metallic object has to look the same
on both, give the scene a real `DirectionalLight` or set
[`Spatial.environment`](#spatialenvironment).

**Ambient and an explicit environment do not stack.** When both an
`AmbientLight` and a `Spatial.environment` are present, RealityKit uses the
explicit environment and ignores the ambient intensity, warning once
(`Spatial.environment replaces the AmbientLight image based light; the
AmbientLight intensity is ignored while an environment is set`). Clearing
`Spatial.environment` restores the ambient one.

### DirectionalLight

`new DirectionalLight(color = 0xffffff, intensity = 1)`

| Property | Type | Default | Notes |
|---|---|---|---|
| `target` | `Object3D` | an internal object at the origin | the light points from its own world position toward the target's |
| `castShadow` | `boolean` | `false` | `DirectionalLightComponent.Shadow` |

The core resolves the world direction and sends it in the light command, so the
target object never has to be in the scene for the direction to be right.

### PointLight

`new PointLight(color = 0xffffff, intensity = 1, distance = 0, decay = 2)`

| Property | Type | Default | Notes |
|---|---|---|---|
| `distance` | `number` (metres) | `0` | `0` means no cutoff |
| `decay` | `number` | `2` | physical falloff |
| `castShadow` | `boolean` | `false` | **unsupported everywhere: warn once, ignored** |

### SpotLight

`new SpotLight(color = 0xffffff, intensity = 1, distance = 0, angle = π/3, penumbra = 0, decay = 2)`

| Property | Type | Default | Notes |
|---|---|---|---|
| `distance` | `number` (metres) | `0` | |
| `angle` | `number` (radians) | `π/3` | cone half-angle, clamped to `[0, π/2]` |
| `penumbra` | `number` 0..1 | `0` | |
| `decay` | `number` | `2` | |
| `target` | `Object3D` | origin | as `DirectionalLight` |
| `castShadow` | `boolean` | `false` | `SpotLightComponent.Shadow` |

### ImageBasedLight

**(ours)** `new ImageBasedLight(url: string, intensity = 1)`

Scene-level environment lighting. Assign it to
[`Spatial.environment`](#spatialenvironment); at most one, last set wins.
Properties: `url`, `intensity`.

Supported formats, by extension on the url:

| Format | RK macOS / visionOS | web |
|---|---|---|
| `.hdr` (equirectangular) | yes | yes |
| `.png`, `.jpg` (equirectangular) | yes | yes |
| `.exr` | yes | **warn once, no environment installed** |

An environment that fails to load warns once and leaves the scene without one.
Its url goes through [containment](#url-forms) too: a relative path is joined
onto the asset root, and a refused url means **no environment at all** —
`dump().environment` is `null` and the core warns
`Spatial.environment was dropped because its url was refused`. An explicit
environment overrides an `AmbientLight` on RealityKit — see
[AmbientLight](#ambientlight).

For a script that must run on both backends, use `.hdr`.

### Intensity units

three.js uses physical units; RealityKit uses different ones. The consumer
converts, so **write three.js numbers**:

| Light | three.js unit | Conversion applied by the RealityKit consumer |
|---|---|---|
| point, spot | candela | `lumens = candela × 4π` |
| directional | relative lux | `lux = intensity × 1000` (a sun is typically `2`–`5`) |
| ambient | unitless multiplier | drives a uniform image-based light |

### Shadows

| Light | RK macOS | RK visionOS | web |
|---|---|---|---|
| `DirectionalLight.castShadow` | yes | yes | yes |
| `SpotLight.castShadow` | yes | yes | yes |
| `PointLight.castShadow` | warn once, ignored | warn once, ignored | warn once, ignored |

A mesh also needs `castShadow = true` to cast and `receiveShadow = true` to
receive.

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();

const ambient = new S.AmbientLight(0xffffff, 0.35);
ambient.name = "ambient";
scene.add(ambient);

const sun = new S.DirectionalLight(0xfff4e6, 2.5);
sun.name = "sun";
sun.position.set(0.6, 1.2, 0.8);
sun.castShadow = true;
scene.add(sun);

const rim = new S.PointLight(0x88bbff, 3, 2, 2);
rim.name = "rim";
rim.position.set(-0.5, 0.3, -0.4);
scene.add(rim);

const spot = new S.SpotLight(0xffffff, 6, 3, Math.PI / 8, 0.3, 2);
spot.name = "spot";
spot.position.set(0, 0.8, 0.2);
scene.add(spot);

const floor = new S.Mesh(new S.PlaneGeometry(0.9, 0.9), new S.MeshStandardMaterial({ color: 0x2b2f36 }));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.2;
floor.receiveShadow = true;
scene.add(floor);

const caster = new S.Mesh(new S.BoxGeometry(0.12, 0.12, 0.12), new S.MeshStandardMaterial());
caster.name = "caster";
caster.castShadow = true;
scene.add(caster);

// The spot points at the floor rather than the origin.
spot.target = floor;

Spatial.mount(scene);
```

---

## 8. Physics

**(ours.)** three.js has no physics; this is a SpatialScript feature.
Simulation runs in the consumer (RealityKit physics, or Rapier on web); the
core owns configuration and the command stream. Parity is **structural**:
bodies, shapes, masses, joints and events exist on both backends and a dropped
body ends up resting on a floor, but trajectories are not identical.

### RigidBody

`new RigidBody(options = {})`, then `mesh.rigidBody = body`.

| Option / property | Type | Default | Notes |
|---|---|---|---|
| `type` | `"dynamic" \| "static" \| "kinematic"` | `"dynamic"` | an unknown value throws `TypeError` |
| `mass` | `number` (kg) | `1` | dynamic only; clamped to ≥ 0 |
| `shape` | `"auto" \| "box" \| "sphere" \| "capsule" \| "convex" \| "mesh"` | `"auto"` | unknown value throws `TypeError` |
| `friction` | `number` | `0.5` | clamped to ≥ 0 |
| `restitution` | `number` | `0.2` | bounciness, clamped to ≥ 0 |
| `linearDamping` | `number` | `0` | clamped to ≥ 0 |
| `angularDamping` | `number` | `0` | clamped to ≥ 0 |
| `isTrigger` | `boolean` | `false` | a collision-only volume — see below |
| `gravity` | `boolean` | `true` | when `false` the body ignores `Spatial.physics.gravity` |

Read-only state, refreshed by the consumer every frame:

| Property | Type | Notes |
|---|---|---|
| `linearVelocity` | `Vector3` | derived by the consumer; do not write it, use `setLinearVelocity` |
| `angularVelocity` | `Vector3` | |
| `isSleeping` | `boolean` | a resting body sleeps and stops syncing |
| `object` | `Object3D \| null` | the mesh this body is attached to; assigned by the runtime, one body per object |

**Triggers are never simulated.** A body with `isTrigger: true` has no mass,
never falls, never pushes anything and is never pushed. It follows its object's
transform exactly as a static or kinematic collider would, and its `type` is
ignored — you may leave `type` at its `"dynamic"` default and it still will not
move. `mass` and `gravity` are ignored too. It emits `collisionstart` and
`collisionend` for every body that overlaps it. Note that `dump()` echoes the
`type` and `mass` you set, not the ignored effective values.

| Backend | Trigger implementation |
|---|---|
| RK macOS / visionOS | `CollisionComponent` in `.trigger` mode with no physics body |
| web | a Rapier sensor collider on a kinematic body that tracks the object transform |

`shape: "auto"` resolves against the mesh's geometry: `box` for `BoxGeometry`,
`sphere` for `SphereGeometry`, `capsule` for `CapsuleGeometry`, `convex` for
everything else. `"mesh"` is a **static-only** triangle mesh; using it on a
dynamic body throws `SpatialUnsupportedError` with `feature`
`"RigidBody.shape=mesh"` — both at construction and on assignment.

| Method | Notes |
|---|---|
| `applyImpulse(impulse: Vector3, atWorldPoint?: Vector3): this` | instantaneous; omit the point for a central impulse |
| `applyForce(force: Vector3): this` | applied for one frame |
| `applyTorque(torque: Vector3): this` | |
| `setLinearVelocity(v: Vector3): this` | |
| `setAngularVelocity(v: Vector3): this` | |

Changing a property after creation (`body.mass = 2`) re-emits the body.

**Driven-ness.** A `dynamic` body's transform is owned by the consumer: it is
synced into the core every frame. Writing `position`, `quaternion` or `scale`
on a dynamic body from a script is a **teleport** — the consumer moves the body
there and zeroes its velocity. `static` and `kinematic` bodies are
script-driven: move them normally.

| Backend | Engine |
|---|---|
| RK macOS / visionOS | RealityKit physics |
| web | Rapier |

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 0.5));
const sun = new S.DirectionalLight(0xffffff, 2.5);
sun.position.set(0.5, 1.2, 0.6);
scene.add(sun);

const floor = new S.Mesh(new S.BoxGeometry(0.7, 0.02, 0.7), new S.MeshStandardMaterial({ color: 0x33383f }));
floor.name = "floor";
floor.position.y = -0.25;
floor.receiveShadow = true;
floor.rigidBody = new S.RigidBody({ type: "static", shape: "box", friction: 0.8 });
scene.add(floor);

const ball = new S.Mesh(new S.SphereGeometry(0.05, 20, 14), new S.MeshStandardMaterial({ color: 0xff5544 }));
ball.name = "ball";
ball.position.set(0, 0.3, 0);
ball.castShadow = true;
ball.rigidBody = new S.RigidBody({ type: "dynamic", mass: 0.6, restitution: 0.7 });
scene.add(ball);

ball.addEventListener("tap", () => ball.rigidBody.applyImpulse(new S.Vector3(0, 1.4, 0)));

Spatial.mount(scene);
```

### Joint

`new Joint(options)` then `Spatial.physics.add(joint)`.

| Option / property | Type | Default | Notes |
|---|---|---|---|
| `type` | `"fixed" \| "revolute" \| "spherical" \| "prismatic" \| "distance"` | `"fixed"` | unknown value throws `TypeError` |
| `bodyA` | `Object3D` | `null` | must carry a `rigidBody`, else `SpatialUnsupportedError` (`feature` `"Joint.body"`) |
| `bodyB` | `Object3D` | `null` | same |
| `anchorA` | `Vector3` | `(0,0,0)` | local offset on `bodyA` |
| `anchorB` | `Vector3` | `(0,0,0)` | local offset on `bodyB` |
| `axis` | `Vector3` | `(0,1,0)` | revolute and prismatic |
| `limits` | `[min, max] \| null` | `null` | radians (revolute), metres (prismatic, distance) |

| Backend | Mapping |
|---|---|
| RealityKit | `PhysicsFixedJoint`, `PhysicsRevoluteJoint`, `PhysicsSphericalJoint`, `PhysicsPrismaticJoint`, `PhysicsDistanceJoint` with `GeometricPin`s |
| web | Rapier fixed, revolute, spherical, prismatic, rope |

**`limits` per joint type:**

| Type | `limits` meaning |
|---|---|
| `revolute` | `[min, max]` rotation about `axis`, radians |
| `prismatic` | `[min, max]` travel along `axis`, metres |
| `distance` | `[min, max]` **allowed separation between the two anchors**, metres. `null` fixes the separation at whatever it was when the joint was added |
| `fixed`, `spherical` | ignored |

On the web a positive `min` on a distance joint is honoured only where Rapier
can express it; when it cannot, the consumer applies `max` as a rope and warns
once naming the joint. RealityKit honours both bounds.

**Destroying either body removes the joint.** `Spatial.destroy(bodyA)` drops the
joint from `Spatial.physics.joints` and `dump().joints` and emits
`["joint", id, null]`, so a joint never survives pinned to a dead body. Nothing
throws; the joint simply disappears.

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 0.8));

const hinge = new S.Mesh(new S.CylinderGeometry(0.012, 0.012, 0.05, 12), new S.MeshStandardMaterial());
hinge.name = "hinge";
hinge.rotation.z = Math.PI / 2;
hinge.position.set(0, 0.25, 0);
hinge.rigidBody = new S.RigidBody({ type: "static", shape: "capsule" });
scene.add(hinge);

const bob = new S.Mesh(new S.SphereGeometry(0.045, 20, 14), new S.MeshStandardMaterial({ color: 0xffcc33 }));
bob.name = "bob";
bob.position.set(0, 0.07, 0);
bob.rigidBody = new S.RigidBody({ type: "dynamic", mass: 1.5, linearDamping: 0.05 });
scene.add(bob);

Spatial.physics.add(new S.Joint({
  type: "revolute",
  bodyA: hinge,
  bodyB: bob,
  anchorA: new S.Vector3(0, 0, 0),
  anchorB: new S.Vector3(0, 0.18, 0),
  axis: new S.Vector3(0, 0, 1),
  limits: null,
}));

Spatial.mount(scene);
```

### Spatial.physics

| Member | Type | Default | Notes |
|---|---|---|---|
| `gravity` | `Vector3` | `(0, -9.81, 0)` | both `physics.gravity.set(...)` and `physics.gravity = new Vector3(...)` are detected; assignment copies into the existing vector |
| `joints` | `Joint[]` | `[]` | read-only view of the added joints |
| `add(joint): Joint` | | | adding the same joint twice is a no-op; a non-`Joint` throws `TypeError` |
| `remove(joint): Joint` | | | emits a joint removal |

```js runnable
const Spatial = require("spatial");
const scene = new Spatial.Scene();
scene.name = "moon";
scene.add(new Spatial.AmbientLight(0xffffff, 1));

Spatial.physics.gravity.set(0, -1.62, 0);   // lunar gravity
scene.userData.gravity = Spatial.physics.gravity.toArray();

Spatial.mount(scene);
```

### Spatial.raycast

```
Spatial.raycast(origin: Vector3, direction: Vector3, { maxDistance = Infinity, recursive = true } = {}): RaycastHit[]
```

Synchronous. Returns `[{ object, point, normal, distance }]`; `[]` on a miss.
`direction` does not have to be normalised.

The rules are identical on all three backends:

| Rule | Detail |
|---|---|
| **Meshes only** | groups, lights, anchors and emitters are never hit; a `Portal` is a mesh and can be |
| **Visible only** | `visible === false` on the object, or on any ancestor, excludes it |
| **One hit per object** | the nearest surface; a ray through a box yields one hit, not two |
| **Sorted** | nearest first |
| **`recursive: true`** (default) | every visible mesh in the mounted scene |
| **`recursive: false`** | only meshes that are **direct children of the mounted scene** |
| **`maxDistance`** | `Infinity` by default; hits beyond it are excluded |

A `rigidBody` is not required — every visible mesh is hit-testable.

| Backend | Implementation |
|---|---|
| RK macOS / visionOS | native scene raycast; the first call materialises a collision shape for every mesh (see [Collision groups](#collision-groups)) |
| web | three.js `Raycaster` over the visible meshes |
| core fallback (Node) | three.js `Raycaster`, same rules |

```js runnable
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, Vector3 } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const wall = new Mesh(new BoxGeometry(0.5, 0.5, 0.02), new MeshStandardMaterial());
wall.name = "wall";
wall.position.z = -0.5;
scene.add(wall);

const probe = new Group();
probe.name = "probe";
scene.add(probe);

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 10) return;
  // Offset from dead centre so the ray does not land on the shared triangle edge.
  const hits = Spatial.raycast(new Vector3(0.03, 0.02, 0), new Vector3(0, 0, -1), { maxDistance: 2 });
  probe.userData.hitCount = hits.length;
  probe.userData.firstHit = hits.length > 0 ? hits[0].object.name : null;
  probe.userData.distance = hits.length > 0 ? hits[0].distance : -1;
});

Spatial.mount(scene);
```

### Collision groups

Meshes without a `rigidBody` can still be tapped and raycast, but they do not
collide with physics bodies.

**RealityKit builds collision shapes lazily.** A mesh gets a
`CollisionComponent` only when one of three things happens:

1. it becomes an input target (its first `tap`, `hover` or `drag` listener), or
2. it gets a `rigidBody`, or
3. the first `Spatial.raycast` of the scene runs — which materialises a shape
   for **every** mesh, permanently.

This is what keeps 1500 moving meshes at frame rate: an eager collider costs
about 10 µs per moved entity per frame. Two consequences for verification:

- `nativeDump()` lists `CollisionComponent` only where one actually exists, so
  a mesh with no listener and no body legitimately has none. That is not a
  missing component.
- A single `Spatial.raycast` call changes that for the whole scene. Expect the
  native dump, and the per-frame cost, to change after one.

| Backend | Filter |
|---|---|
| RealityKit | hit-test-only meshes use group `hitTest` with mask `hitTest`; bodies use group `physics` with mask `physics`. The two groups never interact, and neither mask is empty — an empty mask makes RealityKit skip the shape for macOS gesture targeting. Raycast and input query with mask `.all`. |
| web | Rapier colliders exist only for objects with a `rigidBody` or `isTrigger`; raycast and picking use the three.js `Raycaster` over the visible meshes |

---

## 9. Input and interaction

**(ours.)** Input arrives as events on `Object3D` through the three.js
`EventDispatcher` API. There is no raycaster to configure and no pointer object
to consult — you register a listener and the object becomes a target.

See [15. Events](#15-events) for every event name, payload and bubbling rule.

### Making an object interactive

Registering a listener for `tap`, `hoverenter`/`hoverexit`, or
`dragstart`/`drag`/`dragend` makes the object an input target automatically
(`InputTargetComponent` plus a collision shape) and emits an `interactive`
command. Removing the last listener of a kind clears the flag.

Three consequences worth knowing:

- **Only meshes are hit-testable.** A listener on a `Group` receives bubbled
  events from its descendants, but the group itself is never hit.
- **A listener on an ancestor does not make a descendant a target.** Each
  object that should be hit-testable registers its own listener.
- **A listener costs a collider.** On RealityKit collision shapes are built
  lazily: a mesh gets a `CollisionComponent` when it becomes an input target,
  when it gets a `rigidBody`, or the first time `Spatial.raycast` runs (which
  materialises one for every mesh). Do not add tap listeners to a thousand
  meshes you never intend to tap — see [Performance](./TROUBLESHOOTING.md#memory-and-performance).

`dump().objects[i].interactive` is
`{ tap, hover, drag, manipulation, collision }` — the way to verify that a
listener took effect. All five travel in the `interactive` command, but only
`tap`, `hover` and `drag` make the object an input target and build a collider;
`manipulation` and `collision` are reported for verification, since manipulation
is driven by [`manipulable`](#object3d-spatialscript-properties) and collisions
by a [`rigidBody`](#rigidbody).

```js runnable
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, Vector3 } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const props = new Group();
props.name = "props";
scene.add(props);

const box = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial({ color: 0x3b6fd4 }));
box.name = "box";
props.add(box);

box.addEventListener("tap", (event) => {
  box.userData.lastTapPoint = event.point.toArray();
  box.material.color.set(0xff3366);
});
box.addEventListener("hoverenter", () => { box.hoverEffect = "highlight"; });
box.addEventListener("hoverexit", () => { box.hoverEffect = null; });

const origin = new Vector3();
box.addEventListener("dragstart", () => origin.copy(box.position));
box.addEventListener("drag", (event) => box.position.copy(origin).add(event.translation));

// The group only sees events that bubbled up from a real target.
props.addEventListener("tap", (event) => { props.userData.lastTapped = event.target.name; });

Spatial.mount(scene);
```

### Spatial.input

Polled state, refreshed once per frame before callbacks run. Read it inside
`onFrame`.

| Member | Type | Notes |
|---|---|---|
| `input.keyboard.isDown(code): boolean` | | `KeyboardEvent.code` names: `"KeyW"`, `"Space"`, `"ArrowLeft"`, `"ShiftLeft"` |
| `input.keyboard.wasPressed(code): boolean` | | true for the single frame the key went down |
| `input.mouse.position` | `Vector2 \| null` | view pixels; `null` when there is no pointer |
| `input.mouse.buttons` | `{ left, right, middle }` booleans | |
| `input.mouse.delta` | `Vector2` | pixels since the previous frame |
| `input.hands.left` / `.right` | `Hand \| null` | `null` on macOS and web |
| `hand.isTracked` | `boolean` | |
| `hand.isPinching` | `boolean` | |
| `hand.joint(name): { position: Vector3, quaternion: Quaternion } \| null` | | world space; `null` for an untracked or unknown joint |

Hand joint names (ARKit `HandSkeleton.JointName` in camelCase):
`wrist`, `forearmWrist`, `forearmArm`,
`thumbKnuckle`, `thumbIntermediateBase`, `thumbIntermediateTip`, `thumbTip`,
and `<finger>Metacarpal`, `<finger>Knuckle`, `<finger>IntermediateBase`,
`<finger>IntermediateTip`, `<finger>Tip` for `indexFinger`, `middleFinger`,
`ringFinger`, `littleFinger`.

| Source | RK macOS | RK visionOS | web |
|---|---|---|---|
| keyboard | yes | yes | yes |
| mouse | yes | pointer where available | yes |
| hands | `null` | tracked hands | `null` |

Always null-check `hands.left` / `hands.right`; a visionOS script that reads
them unguarded crashes its frame callback on macOS.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, Vector3 } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const rover = new Mesh(new BoxGeometry(0.09, 0.05, 0.12), new MeshStandardMaterial({ color: 0x44dd99 }));
rover.name = "rover";
scene.add(rover);

const velocity = new Vector3();

Spatial.onFrame((deltaTime) => {
  const keyboard = Spatial.input.keyboard;
  velocity.set(0, 0, 0);
  if (keyboard.isDown("KeyW")) velocity.z -= 1;
  if (keyboard.isDown("KeyS")) velocity.z += 1;
  if (keyboard.isDown("KeyA")) velocity.x -= 1;
  if (keyboard.isDown("KeyD")) velocity.x += 1;
  if (velocity.lengthSq() > 0) {
    rover.position.add(velocity.normalize().multiplyScalar(0.35 * deltaTime));
    rover.rotation.y = Math.atan2(velocity.x, velocity.z);
  }
  if (keyboard.wasPressed("Space")) rover.position.set(0, 0, 0);

  const right = Spatial.input.hands.right;   // null on macOS and web
  if (right && right.isTracked) {
    const tip = right.joint("indexFingerTip");
    if (tip) rover.userData.fingerTip = tip.position.toArray();
  }
});

Spatial.mount(scene);
```

### Spatial.inject

Synthesises exactly the events a consumer would produce, on every backend, with
no real input. This is how an agent verifies a scene. Injected events are
queued and delivered at the **start of the next tick**, so tick at least once
after injecting before reading the result.

| Method | Effect |
|---|---|
| `inject.tap(objectOrName, point?)` | one `tap`; `point` defaults to the object's world position |
| `inject.drag(objectOrName, translation: Vector3, { steps = 1 } = {})` | `dragstart`, then `steps` `drag` events with interpolated translation, then `dragend` |
| `inject.hover(objectOrName, entering: boolean)` | `hoverenter` or `hoverexit` |
| `inject.key(code: string, down: boolean)` | folds into the polled keyboard state from the next frame; `down: false` releases it, with or without a consumer sending real input |

`objectOrName` is an `Object3D` or a name. An unknown name throws `Error`; a
non-`Object3D` throws `TypeError`.

**Injection bypasses hit testing.** `inject.tap("box")` dispatches straight at
the named object; it does not cast a ray. A passing injected tap proves your
listener and your bubbling are right — it does not prove a real pointer can
reach the object. For that, check `dump().objects[i].interactive`, check the
object is a `Mesh`, and do a real click or a
[parity run](../README.md#the-parity-gate).

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, Vector3 } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const box = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial());
box.name = "box";
box.userData.taps = 0;
scene.add(box);
box.addEventListener("tap", () => { box.userData.taps += 1; });

const origin = new Vector3();
box.addEventListener("dragstart", () => origin.copy(box.position));
box.addEventListener("drag", (event) => box.position.copy(origin).add(event.translation));

Spatial.mount(scene);

Spatial.onFrame(() => {
  if (Spatial.time.frame === 10) Spatial.inject.tap("box");
  if (Spatial.time.frame === 20) Spatial.inject.drag("box", new Vector3(0.1, 0, 0), { steps: 5 });
  if (Spatial.time.frame === 40) box.userData.finalX = box.position.x;
});
```

---

## 10. Animation

**(three)** — <https://threejs.org/docs/#api/en/animation/AnimationMixer>

The real three.js mixer runs **in the core**. Because it writes to
`position`, `quaternion`, `scale`, `opacity` and material properties of core
objects, the frame diff picks the changes up and the consumers need no
animation plumbing. Call `mixer.update(deltaTime)` inside `onFrame`, exactly as
in three.js.

Native asset animations are a different mechanism — see
[13. Assets](#13-assets).

### AnimationClip

`new AnimationClip(name = "", duration = -1, tracks = [])`

| Member | Type | Notes |
|---|---|---|
| `name` | `string` | |
| `duration` | `number` (seconds) | `-1` means "compute from the tracks" |
| `tracks` | `KeyframeTrack[]` | |
| `resetDuration(): this` | | recomputes `duration` from the tracks |

### Keyframe tracks

`new VectorKeyframeTrack(name, times, values)` and the same signature for
`QuaternionKeyframeTrack`, `NumberKeyframeTrack`, `ColorKeyframeTrack`, and the
base `KeyframeTrack`.

| Member | Type |
|---|---|
| `name` | `string` — the property path, relative to the mixer root |
| `times` | `Float32Array` (seconds, ascending) |
| `values` | `Float32Array` (flattened: 3 per key for vectors, 4 for quaternions, 1 for numbers, 3 for colours) |

Property paths that work here:

| Path | Track type |
|---|---|
| `.position` | `VectorKeyframeTrack` |
| `.scale` | `VectorKeyframeTrack` |
| `.quaternion` | `QuaternionKeyframeTrack` |
| `.opacity` | `NumberKeyframeTrack` — the whole-object opacity |
| `.material.opacity` | `NumberKeyframeTrack` — the material's own opacity (set `material.transparent = true`) |
| `.material.color` | `ColorKeyframeTrack` |
| `childName.position` | any track, addressing a named descendant of the mixer root |

`.rotation` is not animatable; use `.quaternion`, as in three.js.

### AnimationMixer

`new AnimationMixer(root: Object3D)`

| Member | Signature | Notes |
|---|---|---|
| `time` | `number` | |
| `timeScale` | `number`, default `1` | |
| `clipAction(clip, root?)` | `AnimationAction` | creates or returns the action |
| `existingAction(clip, root?)` | `AnimationAction \| null` | |
| `stopAllAction(): this` | | |
| `update(deltaTime): this` | | **you must call this from `onFrame`** |
| `setTime(time): this` | | |
| `uncacheClip(clip)` / `uncacheRoot(root)` / `uncacheAction(clip, root?)` | | |
| `addEventListener("loop" \| "finished", listener)` | | |

### AnimationAction

Obtained from `mixer.clipAction(clip)`.

| Member | Type / signature | Default |
|---|---|---|
| `play()` / `stop()` / `reset()` | `this` | |
| `setLoop(mode, repetitions): this` | `LoopOnce \| LoopRepeat \| LoopPingPong` | `LoopRepeat`, `Infinity` |
| `setEffectiveWeight(w): this`, `setEffectiveTimeScale(s): this` | | |
| `fadeIn(duration): this`, `fadeOut(duration): this`, `crossFadeTo(action, duration, warp?): this` | | |
| `isRunning(): boolean` | | |
| `paused`, `enabled` | `boolean` | `false`, `true` |
| `time`, `timeScale`, `weight` | `number` | `0`, `1`, `1` |
| `clampWhenFinished` | `boolean` | `false` — set `true` to hold the last frame |
| `loop`, `repetitions` | `number` | |

### AnimationUtils

`arraySlice(array, from, to)`,
`subclip(clip, name, startFrame, endFrame, fps = 30)`,
`makeClipAdditive(targetClip, referenceFrame = 0, referenceClip?, fps = 30)`.

Backend support: identical on all three backends — the mixer never leaves the core.

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));

const box = new S.Mesh(new S.BoxGeometry(0.12, 0.12, 0.12), new S.MeshStandardMaterial({ color: 0x3366ff }));
box.name = "box";
box.material.transparent = true;
scene.add(box);

const position = new S.VectorKeyframeTrack(".position", [0, 1, 2], [-0.2, 0, 0, 0, 0.15, 0, 0.2, 0, 0]);
const turn = new S.Quaternion().setFromAxisAngle(new S.Vector3(0, 1, 0), Math.PI);
const rotation = new S.QuaternionKeyframeTrack(".quaternion", [0, 2], [0, 0, 0, 1, turn.x, turn.y, turn.z, turn.w]);
const fade = new S.NumberKeyframeTrack(".material.opacity", [0, 1, 2], [1, 0.4, 1]);

const clip = new S.AnimationClip("bounce", 2, [position, rotation, fade]);
const mixer = new S.AnimationMixer(box);
const action = mixer.clipAction(clip);
action.setLoop(S.LoopRepeat, Infinity);
action.play();

Spatial.onFrame((deltaTime) => mixer.update(deltaTime));
Spatial.mount(scene);
```

---

## 11. Particles

**(ours)** `new ParticleEmitter(options = {})` — an `Object3D`, so it has a
transform, a parent, and everything else on `Object3D`.

| Option / property | Type | Default | Notes |
|---|---|---|---|
| `preset` | `"fireworks" \| "impact" \| "magic" \| "rain" \| "snow" \| "sparks" \| "smoke" \| null` | `null` | overrides every other field except `isEmitting`; an unknown preset throws `TypeError` |
| `shape` | `"point" \| "sphere" \| "box" \| "cone" \| "plane"` | `"point"` | unknown value throws `TypeError` |
| `shapeSize` | `Vector3` (metres) | `(0.1, 0.1, 0.1)` | |
| `birthRate` | `number` per second, ≥ 0 | `100` | |
| `lifetime` | `number` (seconds), ≥ 0 | `1` | |
| `lifetimeVariation` | `number` ≥ 0 | `0` | |
| `speed` | `number` (m/s) | `1` | |
| `speedVariation` | `number` ≥ 0 | `0` | |
| `size` | `number` (metres), ≥ 0 | `0.01` | |
| `sizeVariation` | `number` ≥ 0 | `0` | |
| `color` | `Color` | `0xffffff` | colour at birth |
| `colorEnd` | `Color \| null` | `null` | colour at death; `null` keeps `color` |
| `opacity` | `number` 0..1 | `1` | **the particle's start opacity, not `Object3D.opacity`** |
| `opacityEnd` | `number` 0..1 | `0` | |
| `spreadAngle` | `number` radians 0..π | `0` | **cone half-angle about the emitter's local +Y**, on both backends. `0` is a straight beam up the emitter's Y axis, `π/2` a hemisphere, `π` every direction. Rotate the emitter to aim it |
| `acceleration` | `Vector3` (m/s²) | `(0, -1, 0)` | |
| `isEmitting` | `boolean` | `true` | |
| `burstCount` | `number` integer ≥ 0 | `0` | particles emitted by one `burst()` |
| `loops` | `boolean` | `true` | |
| `texture` | `Texture \| null` | `null` | |

| Method | Notes |
|---|---|
| `burst(): this` | emits `burstCount` particles immediately |

Because the emitter reuses `opacity` for the particle start opacity, a
`ParticleEmitter` never emits a whole-object opacity command.

| Backend | Behaviour |
|---|---|
| RK macOS / visionOS | `ParticleEmitterComponent`. `fireworks`, `impact`, `magic`, `rain`, `snow` and `sparks` are the native RealityKit presets; `smoke` has no native preset and is a hand-tuned equivalent of the web one. No warning for any of the seven |
| web | CPU point-sprite emitter honouring every field; presets map to the nearest hand-tuned parameter set |

`loops: false` stops the emitter after one particle lifetime on both backends.
An emitter's `Object3D.opacity` is reported as `1` in `dump()` regardless of the
`opacity` option, because the emitter reuses that name for the particle start
opacity — read `dump().objects[i].particles.opacity` for what you set.

**What each preset looks like.** The web set is hand-tuned against the Mac
app's renders, so the two agree by eye rather than by parameter. A preset
replaces every other field except `isEmitting`.

| Preset | Look | Direction and fall |
|---|---|---|
| `fireworks` | a bright warm shell that cools to red | every direction, falls away |
| `impact` | a short sharp burst of pale debris | hemisphere, falls hard; **does not loop** |
| `magic` | slow blue motes drifting up and shifting to violet | every direction, rises gently |
| `rain` | fine pale drops across a wide sheet | straight down, accelerating |
| `snow` | large soft white flakes | every direction, drifts down slowly |
| `sparks` | a wide spray of hot embers cooling to red | every direction, falls |
| `smoke` | big translucent grey puffs thinning out | narrow, rises. RealityKit has no native smoke preset, so this one is a hand-tuned equivalent on both backends |

Set `preset: null` (the default) to use your own fields.

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));

const sparks = new S.ParticleEmitter({
  shape: "cone",
  shapeSize: new S.Vector3(0.03, 0.03, 0.03),
  birthRate: 220,
  lifetime: 1.1,
  lifetimeVariation: 0.3,
  speed: 0.35,
  size: 0.008,
  color: 0xffaa33,
  colorEnd: 0xff2200,
  opacityEnd: 0,
  spreadAngle: 0.45,
  acceleration: new S.Vector3(0, -0.35, 0),
  burstCount: 60,
});
sparks.name = "sparks";
sparks.position.set(0, -0.1, 0);
scene.add(sparks);

const rain = new S.ParticleEmitter({ preset: "rain" });
rain.name = "rain";
rain.position.set(0.3, 0.3, 0);
scene.add(rain);

Spatial.onFrame(() => {
  if (Spatial.time.frame === 30) sparks.burst();
});

Spatial.mount(scene);
```

---

## 12. Anchors and portals

### Anchor

**(ours)** `new Anchor(target = "head")` — a `Group` with `type === "Anchor"`.
Maps to a RealityKit `AnchorEntity`. Add content as children.

| Target form | Meaning |
|---|---|
| `"head"` | follows the viewer's head |
| `{ plane: "horizontal" \| "vertical" \| "any", minimumBounds?: Vector2 }` | a detected surface at least `minimumBounds` metres across (default `(0.2, 0.2)`) |
| `{ hand: "left" \| "right", location?: "palm" \| "wrist" \| "indexFingerTip" \| "thumbTip" \| "aboveHand" }` | a hand joint; `location` defaults to `"palm"` |
| `{ image: "referenceImageName" }` | a reference image in the app's bundle |
| `{ world: Matrix4 }` | a fixed world pose |

Any other string, an unknown plane, hand or hand location, or an options object
that names none of `plane`/`hand`/`image`/`world` throws `TypeError` at
construction.

| Member | Type | Notes |
|---|---|---|
| `isAnchored` | `boolean`, initially `false` | set by the consumer |
| events | `anchored`, `unanchored` | bubble like every other event |

| Backend | Behaviour |
|---|---|
| RK visionOS | real anchoring; `isAnchored` becomes `true` and the `anchored` event fires |
| RK macOS | the entity exists at the **world origin** and never anchors; `isAnchored` stays `false`, no `anchored` event fires, and head, hand and plane anchors each warn once (`Head anchors are visionOS only; the anchor stays at the world origin on macOS`). `env.capabilities.anchors` is **`false`** here |
| web | a plain group at its own transform; `isAnchored` stays `false`; `env.capabilities.anchors` is `false`; content under a `"head"` anchor is parented to the camera |

**Always give anchored content a sensible local transform** so it is still in a
usable place on the backends where anchoring never resolves, and branch on
`Spatial.env.capabilities.anchors` when the layout has to differ.

```js runnable
const Spatial = require("spatial");
const { Scene, Anchor, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, Vector2 } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const table = new Anchor({ plane: "horizontal", minimumBounds: new Vector2(0.3, 0.3) });
table.name = "table";
table.position.set(0, -0.2, -0.4);          // where it sits when anchoring never resolves
scene.add(table);

const badge = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), new MeshStandardMaterial({ color: 0x44dd99 }));
badge.name = "badge";
table.add(badge);

table.addEventListener("anchored", () => { table.userData.anchored = true; });
table.addEventListener("unanchored", () => { table.userData.anchored = false; });

if (Spatial.env.platform !== "visionos") {
  console.log("anchoring does not resolve on", Spatial.env.platform);
}

Spatial.mount(scene);
```

### Portal

**(ours)** `new Portal({ width = 0.5, height = 0.5, world, crossing = false })`

A `Mesh` carrying a `PlaneGeometry`, whose surface shows the contents of a
separate `world` group.

| Option / property | Type | Default | Notes |
|---|---|---|---|
| `width` | `number` (metres) | `0.5` | writable; changing it regenerates the plane geometry and re-emits the portal |
| `height` | `number` (metres) | `0.5` | same |
| `world` | `Object3D` | `null` | the group rendered inside; **also add it to the scene** |
| `crossing` | `boolean` | `false` | lets the viewer pass through. RealityKit only; the web consumer warns once and ignores it |

Passing a non-`Object3D` as `world` throws `TypeError`. A `world` group that is
not in the mounted scene is refused rather than emitted, with a warning.

The world group is added to the scene as usual; the consumer marks it as a
world (`WorldComponent`) so it renders only through the portal.

**A portal only shows what lies behind the portal plane** from the viewer's
position — it is a window into the world group's space, aligned with the main
scene, and both backends behave that way. A world group placed beside or in
front of the portal renders black, which looks like a broken portal and is not.
Put the world group further from the viewer than the portal.

A world group is hidden from the main render, so **light it from inside**: add a
light to the world group itself rather than relying on the scene's lights.

| Backend | Behaviour |
|---|---|
| RK macOS / visionOS | `PortalComponent` + `WorldComponent`; `crossing` honoured |
| web | the world group is rendered to a render target from the **viewer's own camera** and each portal fragment samples it at its own screen position — a window, not a mirror, so the world is seen from where you actually stand and nothing bleeds outside the rectangle. `crossing` warns once and is ignored |

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 0.5));

const otherWorld = new S.Group();
otherWorld.name = "otherWorld";
otherWorld.position.set(0, 0, -0.8);       // behind the portal plane
scene.add(otherWorld);

const worldLight = new S.PointLight(0x66ddff, 4, 2, 2);
worldLight.position.set(0, 0.2, 0.1);
otherWorld.add(worldLight);

const orb = new S.Mesh(new S.SphereGeometry(0.07, 24, 16), new S.MeshStandardMaterial({ color: 0x22ffcc }));
orb.name = "orb";
otherWorld.add(orb);

const doorway = new S.Portal({ width: 0.3, height: 0.4, world: otherWorld, crossing: false });
doorway.name = "doorway";
doorway.position.set(0, 0, -0.3);
scene.add(doorway);

Spatial.mount(scene);
```

---

## 13. Assets

**(ours)**

```
Spatial.loadAsset(urls: { usdz?, reality?, glb?, gltf? }): Promise<AssetGroup>
```

Resolves to an `AssetGroup` (a `Group`). The RealityKit consumer loads `usdz`
or `reality`; the web consumer loads `glb` or `gltf`. Each ignores the other's
keys. **Supply both** so one script runs on both backends. If the key the
backend needs is missing the promise rejects immediately with
`SpatialUnsupportedError` (`feature` `"loadAsset"`).

Every url goes through [containment](#url-forms) first: an accepted relative
path is joined onto the asset root, and a refused one has **that key** dropped.
The load proceeds if another usable key survives; otherwise the rejection names
the refused keys — `loadAsset refused usdz and glb: the url leaves the asset
root or uses a scheme that is not allowed`.

`AssetGroup` members:

| Member | Type | Notes |
|---|---|---|
| `animations` | `string[]` | names discovered by the consumer, empty until loaded |
| `boundingBox` | `Box3` | reported by the consumer after load |
| `loaded` | `boolean` | |
| `playAnimation(name, { loop = true, speed = 1 } = {}): this` | | native, consumer-driven |
| `stopAnimation(): this` | | |

Native asset animations animate the asset's internal skeleton; they do **not**
sync transforms back into the core, so the asset group's own transform stays
script-owned.

Always `await` inside a `try`/`catch` or attach `.catch`: a missing asset is a
normal outcome, and an unhandled rejection becomes a runtime error.

| Backend | Loads |
|---|---|
| RK macOS / visionOS | `usdz`, `reality` |
| web | `glb`, `gltf` |

```js runnable
const Spatial = require("spatial");
const { Scene, Group, AmbientLight, DirectionalLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.6));
const sun = new DirectionalLight(0xffffff, 2);
sun.position.set(0.5, 1, 0.8);
scene.add(sun);

const holder = new Group();
holder.name = "holder";
scene.add(holder);

Spatial.mount(scene);       // mount first: the scene is live while the asset loads

try {
  const robot = await Spatial.loadAsset({
    usdz: "asset://robot.usdz",
    glb: "assets/robot.glb",
  });
  robot.name = "robot";
  robot.scale.setScalar(0.2);
  holder.add(robot);
  holder.userData.animations = robot.animations.slice();
  if (robot.animations.includes("walk")) robot.playAnimation("walk", { loop: true, speed: 1 });
} catch (error) {
  console.warn("asset did not load:", error.message);
  holder.userData.assetError = error.message;
}
```

---

## 14. Runtime

### Scene and frames

| Member | Signature | Notes |
|---|---|---|
| `Spatial.mount(scene)` | `(scene: Scene) => Scene` | replaces the mounted scene; throws `TypeError` for a non-`Scene` |
| `Spatial.scene` | `Scene \| null` | the mounted scene, `null` before the first mount |
| `Spatial.onFrame(callback)` | `(cb: (deltaTime, elapsedTime) => void) => cb` | returns the callback so it can be captured; registering the same function twice is a no-op; throws `TypeError` for a non-function |
| `Spatial.offFrame(callback)` | `(cb) => void` | safe to call from inside the callback itself |
| `Spatial.version` | `string` | core version, e.g. `"0.1.0"` |

`onFrame` callbacks run in registration order over a snapshot of the list, so
adding or removing a callback from inside one is safe.

### Spatial.time

| Field | Type | Notes |
|---|---|---|
| `delta` | `number` (seconds) | since the previous frame; `0` during load |
| `elapsed` | `number` (seconds) | since load |
| `frame` | `number` | `0` during load, `1` on the first tick |

`Spatial.time` is the same object every frame, so do not stash a reference to
it expecting a snapshot; read the fields.

### Spatial.env

| Field | Type | Values |
|---|---|---|
| `backend` | `"realitykit" \| "three"` | |
| `platform` | `"macos" \| "visionos" \| "web"` | |
| `capabilities` | object of booleans | `hands`, `anchors`, `portals`, `particles`, `manipulation`, `hoverEffect`, `shadows` |

Capabilities are honest per platform: `false` means the feature genuinely does
nothing there, not that it is merely degraded.

| Capability | RK macOS | RK visionOS | web | What `false` means for a script |
|---|---|---|---|---|
| `hands` | `false` | `true` | `false` | `Spatial.input.hands.left/.right` are `null` |
| `anchors` | `false` | `true` | `false` | an `Anchor` never resolves: `isAnchored` stays `false`, no `anchored` event, content sits at the anchor's own transform (macOS: the world origin) |
| `portals` | `true` | `true` | `true` | — |
| `particles` | `true` | `true` | `true` | — |
| `manipulation` | `false` | `true` | `true` (emulated) | `manipulable = true` warns once and is ignored; no `manipulation*` events ever fire |
| `hoverEffect` | `false` | `true` | `false` | `hoverEffect` produces no visual. `hoverenter`/`hoverexit` events still fire on macOS and web |
| `shadows` | `true` | `true` | `true` | — |

**The macOS picture in one line:** no hands, anchors never resolve, no system
manipulation, no hover effect visual, and `renderOrder` is ignored — everything
else works, including tap, hover and drag events, physics, portals, particles
and shadows.

A host may override any of these at load time, so branch on `capabilities`
rather than on `platform` when you are guarding a feature.

```js runnable
const Spatial = require("spatial");
const scene = new Spatial.Scene();
scene.name = "probe";
scene.add(new Spatial.AmbientLight(0xffffff, 1));

scene.userData.backend = Spatial.env.backend;
scene.userData.platform = Spatial.env.platform;
scene.userData.hands = Spatial.env.capabilities.hands;
console.log("running on", Spatial.env.backend, Spatial.env.platform, "core", Spatial.version);

Spatial.mount(scene);
```

### Spatial.limits

`Spatial.limits` is a frozen object naming the bounds the core enforces on
script-supplied work, so a scene generator can stay inside them instead of
discovering them. Crossing one is always reported — through `dump().warnings` or
`dump().errors` — never silently.

| Constant | Value | What happens at the bound |
|---|---|---|
| `MAX_NAME_LENGTH` | `256` | the name the **command stream** carries is truncated; `object.name` and `dump()` keep the full string. Warns once per object: `A name of 400 characters was truncated to 256` |
| `MAX_LOG_MESSAGE` | `16384` (16 KB) | one console message is truncated, with `… (truncated, N characters)` appended |
| `MAX_LOGS_PER_FRAME` | `200` | further log commands that frame are dropped and replaced by one line: `50 more log lines were suppressed this frame` |
| `MAX_LIVE_TIMERS` | `10000` | a further `setTimeout`/`setInterval` registration is dropped: `More than 10000 live timers; the registration was dropped` |
| `MAX_LIVE_FRAME_CALLBACKS` | `10000` | same for `requestAnimationFrame`: `More than 10000 live animation-frame callbacks; the registration was dropped` |
| `MAX_CALLBACKS_PER_TICK` | `10000` | timer and animation-frame callbacks past the budget **defer to the next tick** rather than being dropped, warning once: `More than 10000 timer and animation-frame callbacks came due in one frame; the rest were deferred to the next frame`. A `requestAnimationFrame` registered *during* the drain also lands on the next tick, so a rAF storm slows down instead of spinning |
| `MAX_LISTENERS_PER_EVENT` | `1000` | a further `addEventListener` for that type on that object is dropped: `More than 1000 "tap" listeners on "m"; the registration was dropped` |
| `MAX_DEPTH` | `1024` | an `add`/`attach` past it is refused and recorded as a `depth-limit` error |
| `MAX_ID` | `16777216` (2²⁴) | the object, texture and joint id space. Ids are recycled on destroy; exhausting it records an error and stops tracking new objects |
| `MAX_RECORDED_ERRORS` | `200` | `dump().errors` keeps the most recent; older entries drop and `dump().droppedErrors` counts how many times |
| `MAX_RECORDED_WARNINGS` | `500` | further warnings are not recorded |

All eleven are on the frozen object, so a generator can size a scene against
them directly rather than hard-coding numbers.

Geometry `parameters` are sanitised on the way out with their own bounds: a
string value is truncated at 256 characters, an array value longer than 64
entries is dropped, and only the first 64 keys survive. Names and parameters
reach native code, so nothing unbounded is forwarded.

```js runnable
const Spatial = require("spatial");
const scene = new Spatial.Scene();
scene.name = "limits";
scene.add(new Spatial.AmbientLight(0xffffff, 1));

// Stay inside the bounds rather than discovering them.
const budget = Math.min(500, Spatial.limits.MAX_LIVE_TIMERS);
scene.userData.timerBudget = budget;
scene.userData.maxDepth = Spatial.limits.MAX_DEPTH;
scene.userData.maxListeners = Spatial.limits.MAX_LISTENERS_PER_EVENT;

Spatial.mount(scene);
```

### Spatial.environment

`Spatial.environment: ImageBasedLight | null`, default `null`. The scene-level
image-based light. Assigning anything other than an `ImageBasedLight` or `null`
throws `TypeError`. At most one; the last assignment wins.

```js runnable
const Spatial = require("spatial");
const scene = new Spatial.Scene();
scene.name = "studio";

const ball = new Spatial.Mesh(
  new Spatial.SphereGeometry(0.1, 24, 16),
  new Spatial.MeshStandardMaterial({ metalness: 0.9, roughness: 0.15 }),
);
ball.name = "ball";
scene.add(ball);

Spatial.environment = new Spatial.ImageBasedLight("asset://studio.exr", 1.5);
Spatial.mount(scene);
```

### Spatial.find, destroy, dispose

| Member | Signature | Notes |
|---|---|---|
| `Spatial.find(name)` | `(name: string) => Object3D \| null` | `scene.getObjectByName(name)` on the mounted scene, normalised to `null`; `null` before mount |
| `Spatial.dump(options?)` | `(options?: DumpOptions) => Dump` | a plain object, safe to `JSON.stringify` — see [Spatial.dump](#spatialdump) and [17. Dump format](#17-dump-format) |
| `Spatial.destroy(object)` | `(object: Object3D) => Object3D` | frees the object and its whole subtree |
| `Spatial.dispose()` | `() => Command[]` | consumer teardown: runs `this.willRemove()` and destroys everything, returning the final command array. Scripts do not normally call it |

`Spatial.destroy(object)`:

- emits `destroy` for the whole subtree, descendants before ancestors;
- detaches `object` from its parent;
- releases the command-stream ids **back into a free list**, so a long-running
  scene that spawns and destroys does not exhaust the id space;
- marks every object in the subtree as destroyed, so a later `add()` or
  `attach()` throws `SpatialUnsupportedError` with `feature` `"destroyed-object"`;
- clears each body's `object` back-reference;
- removes any [`Joint`](#joint) pinned to a destroyed body.

Destroying the mounted scene throws `SpatialUnsupportedError` with `feature`
`"destroy-scene"`. Passing a non-`Object3D` throws `TypeError`.

`scene.remove(object)` keeps three.js semantics and only detaches.

**Mounting another scene destroys the first**, with the same effect as calling
`Spatial.destroy` on each of its objects: entities are destroyed, ids released,
objects marked. Re-adding an object from a replaced scene throws
`"destroyed-object"`.

Command-stream ids are bounded at 2²⁴ (they must stay exact inside the packed
float32 transform records). Recycling means a normal spawn-and-destroy scene
never approaches that; a scene that only ever creates objects will eventually
record `SpatialUnsupportedError: The scene has used every object id below
16777216; new objects are not tracked`, and later objects simply do not render.

After `destroy` the object is gone from the command stream, so an imperative
call that names it — `rigidBody.applyImpulse`, `ParticleEmitter.burst`,
`playAnimation` — is dropped with a warning rather than sent:
`RigidBody.applyImpulse on "x" was dropped: the object is not in the mounted
scene`. The same warning covers an object that was never added to the mounted
scene at all.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const live = [];
for (let i = 0; i < 5; i += 1) {
  const cube = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), new MeshStandardMaterial());
  cube.name = `cube-${i}`;
  cube.position.x = (i - 2) * 0.09;
  scene.add(cube);
  live.push(cube);
}

Spatial.onFrame(() => {
  if (Spatial.time.frame % 20 !== 0) return;
  const doomed = live.shift();
  if (!doomed) return;
  Spatial.destroy(doomed);                       // detaches and frees
  scene.userData.remaining = live.length;
  scene.userData.gone = Spatial.find(doomed.name) === null;
});

Spatial.mount(scene);
```

### Spatial.dump

```
Spatial.dump(options?: {
  names?: string[],
  fields?: string[],
  compact?: boolean,
  objects?: boolean,
}): Dump
```

`Spatial.dump()` with no options builds the full scene description of
[section 17](#17-dump-format). That is the right thing for a one-shot
assertion and the wrong thing for a poll: a large scene's dump is expensive to
build and to serialise. The options narrow the work.

| Option | Effect |
|---|---|
| `names: string[]` | only objects whose `name` is in the list. The walk still visits everything, but only matches are described |
| `fields: string[]` | only these per-object keys. `id` and `name` are always present |
| `compact: true` | every object reduced to `id`, `name`, `type`, `parent`, `visible`, `position`, `quaternion`, `scale`, `worldPosition`, with numbers rounded to four decimals. No geometry, material, light, rigid body, flags, particle payload, `world` flag or `userData` |
| `objects: false` | `objects` comes back empty; you keep `frame`, `elapsed`, `loadGeneration`, `scene`, `joints`, `gravity`, `environment`, `warnings`, `errors`, `droppedErrors` |

The top-level fields are always present, so `errors`, `warnings` and
`droppedErrors` survive every option — which is what makes
`dump({ objects: false })` the cheapest health check there is.

Roughly what they cost, on a small scene: full 3658 bytes of JSON, compact 703.
The gap widens with the scene.

**Combine them.** `dump({ names: ["cube"], fields: ["position", "visible"] })`
is the shape to poll when you are watching one object move.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.name = "readback";
scene.add(new AmbientLight(0xffffff, 1));

for (const name of ["alpha", "beta", "gamma"]) {
  const cube = new Mesh(new BoxGeometry(0.08, 0.08, 0.08), new MeshStandardMaterial());
  cube.name = name;
  cube.position.x = ["alpha", "beta", "gamma"].indexOf(name) * 0.12 - 0.12;
  scene.add(cube);
}

Spatial.mount(scene);

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 10) return;

  const full = Spatial.dump();
  const compact = Spatial.dump({ compact: true });
  const one = Spatial.dump({ names: ["beta"], fields: ["position", "visible"] });
  const health = Spatial.dump({ objects: false });

  scene.userData.report = {
    fullBytes: JSON.stringify(full).length,
    compactBytes: JSON.stringify(compact).length,
    compactKeys: Object.keys(compact.objects[0]),
    onlyBeta: one.objects.map((entry) => entry.name),
    betaKeys: Object.keys(one.objects[0]),
    healthHasObjects: health.objects.length,
    errors: health.errors.length,
  };
});
```

The macOS host exposes the same options on its `GET /dump` route — see
[the README](../README.md#get-dump-options-and-the-cheap-poll).

### Timers

Installed as globals by the core and driven by frame ticks, not by a host event
loop. A timer whose delay has not elapsed in wall-clock terms will not fire
until enough frames have passed.

| Global | Signature | Notes |
|---|---|---|
| `setTimeout(callback, delayMs = 0, ...args): number` | | fires once, at the first frame where `elapsed >= dueAt` |
| `clearTimeout(id)` | | |
| `setInterval(callback, delayMs = 0, ...args): number` | | fires at most once per frame, so a 0 ms interval cannot spin |
| `clearInterval(id)` | | |
| `requestAnimationFrame(callback): number` | `callback(timestampMs)` | runs on the next tick; `timestampMs` is `elapsed * 1000` |
| `cancelAnimationFrame(id)` | | |

A non-function callback throws `TypeError`. An exception thrown by a timer
callback is caught, reported, and does not stop the loop.

Three [limits](#spatiallimits) apply: at most `MAX_LIVE_TIMERS` (10000) live
`setTimeout`/`setInterval` registrations and `MAX_LIVE_FRAME_CALLBACKS` (10000)
live `requestAnimationFrame` registrations — a further registration is dropped
with a warning — and at most `MAX_CALLBACKS_PER_TICK` (10000) callbacks actually
run in one tick, the rest **deferring to the next**, so a callback storm slows
the scene instead of hanging it.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const box = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
box.name = "box";
scene.add(box);

const blink = setInterval(() => { box.visible = !box.visible; }, 250);
setTimeout(() => {
  clearInterval(blink);
  box.visible = true;
  console.log("stopped blinking");
}, 1500);

Spatial.mount(scene);
```

### console

`console.log`, `warn`, `error`, `info`, `debug`. Arguments are formatted into
one line: strings verbatim, `Error`s as `Name: message`, `Object3D`s as
`Type "name"`, other objects as JSON, everything else via `String()`. Output
travels to the consumer as a `log` command and appears in the macOS host's
`GET /logs` and the browser console.

`console.warn` output is also recorded in `dump().warnings`.

A single message is truncated at **16 KB**, with the original length appended:
`…… (truncated, 20000 characters)`. Logging a whole dump or a large typed array
every frame is therefore safe but useless — log the few fields you need.

---

## 15. Events

Every event listed here is delivered through `Object3D.addEventListener` and
bubbles. Listener exceptions are caught and reported; the remaining listeners
still run.

### Event list

| Event | Payload fields (besides `type`, `target`, `currentTarget`, `stopPropagation`) | macOS source | visionOS source | web source |
|---|---|---|---|---|
| `tap` | `point: Vector3` (world) | click | pinch | click |
| `hoverenter` | — | mouse over | gaze | mouse over |
| `hoverexit` | — | mouse out | gaze away | mouse out |
| `dragstart` | `translation: Vector3` (zero), `point: Vector3` | mouse down + move | pinch drag | mouse down + move |
| `drag` | `translation: Vector3`, `point: Vector3` | mouse drag | pinch drag | mouse drag |
| `dragend` | `translation: Vector3`, `point: Vector3` | mouse up | pinch release | mouse up |
| `manipulationstart` / `manipulation` / `manipulationend` | — | **never fires** (`capabilities.manipulation` is `false`) | system gesture: begin, every transform update, end | emulated view-plane mouse drag |
| `collisionstart` / `collisionend` | `other: Object3D \| null`, `point: Vector3`, `normal: Vector3`, `impulse: number` | physics | physics | physics |
| `anchored` / `unanchored` | — | **never fires** (`capabilities.anchors` is `false`) | anchor resolution | never fires |
| `assetLoaded` | `animations?: string[]` | asset load | asset load | asset load |
| `assetError` | `message?: string` | asset failure | asset failure | asset failure |

`Texture` has its own two events, `load` and `error` (the latter carrying
`message`); they are single-target and do not bubble.

### Payload shapes

Every event object carries:

| Field | Type | Notes |
|---|---|---|
| `type` | `string` | |
| `target` | `Object3D` | the object the event originated on; **unchanged while bubbling** |
| `currentTarget` | `Object3D` | the object whose listener is running |
| `stopPropagation()` | `function` | stops the event reaching further ancestors |

Drag semantics: `translation` is the world-space displacement since
`dragstart`, not since the previous event. **The script owns the object's
position** — the consumer never moves a dragged object. The standard pattern:

```js
const origin = new Vector3();
target.addEventListener("dragstart", () => origin.copy(target.position));
target.addEventListener("drag", (event) => target.position.copy(origin).add(event.translation));
```

Collision semantics: a collision is one event about a pair, and **both objects
receive it**, each with itself as `target` and the other as `other`. At least
one of the pair must have a `rigidBody`.

### Bubbling

An event dispatched on an object runs that object's listeners, then each
ancestor's, with `target` unchanged and `currentTarget` updated. The mounted
`Scene` receives every event last, even when the object is not currently under
it. Any listener may call `event.stopPropagation()` to stop the walk.

Non-SpatialScript event types dispatched with `dispatchEvent` keep three.js's
plain single-target behaviour.

```js runnable
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const group = new Group();
group.name = "group";
scene.add(group);

const child = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
child.name = "child";
group.add(child);

const order = [];
child.userData.order = order;

child.addEventListener("tap", (event) => order.push(`child sees ${event.target.name}`));
group.addEventListener("tap", (event) => order.push(`group sees ${event.target.name}`));
scene.addEventListener("tap", (event) => order.push(`scene sees ${event.target.name}`));

Spatial.mount(scene);
Spatial.onFrame(() => { if (Spatial.time.frame === 5) Spatial.inject.tap("child"); });
```

---

## 16. Errors and warnings

Two channels, with different consequences.

| Channel | Trigger | Effect | Where it shows |
|---|---|---|---|
| Load error | a throw during load, before the first `await`, or a failed auto-mount check | the scene does not start (or is torn down) | thrown from `load()`; `POST /script` responds `{ ok: false, error: { message, line, column } }` |
| Runtime error | a throw inside `onFrame`, `update`, a listener, a timer, or after the first `await`; plus core-raised validation errors | the offending call is abandoned; the scene keeps running | `dump().errors`, `console.error`, `GET /logs` |
| Warning | a supported-but-degraded feature, or a value the core had to normalise | none | `dump().warnings`, `console.warn`, `GET /logs` |

### Load errors

Reported with `message`, and with `line`/`column` where the engine supplies
them (JavaScriptCore always; V8 for runtime errors, not for syntax errors).
Line numbers are 1-based against your source.

| Message | Cause |
|---|---|
| `SyntaxError: ...` | the body did not parse as a function or async function body |
| `The script finished without mounting a scene and constructed no Scene; call Spatial.mount(scene)` | no `Scene` was ever built |
| `The script finished without mounting a scene and constructed N Scenes; call Spatial.mount(scene)` | ambiguous — mount one explicitly |
| any exception from the body | e.g. `ReferenceError: nope is not defined (line 2, column 1)` |

### Runtime errors

Each unique message is reported at most **once per second** to stop a
per-frame throw from flooding the channel. Entries are strings, deduplicated by
message, in `dump().errors`.

`dump().errors` keeps the **most recent 200** entries. Once that cap is reached
older entries are dropped and `dump().droppedErrors` counts how many times that
happened — so a non-zero `droppedErrors` means the visible list is not the whole
story, and the earliest failure is no longer in it.

Core-raised runtime errors (each reported once per object, and again only after
the value has become valid in between):

| Message | Meaning |
|---|---|
| `SpatialUnsupportedError: Transform on "x" is not finite; the last valid transform is kept` | a NaN/Infinity position, rotation or scale, or a zero-length quaternion. The object keeps its last valid transform |
| `SpatialUnsupportedError: Matrix on "x" contains shear, which cannot be represented as a transform` | a sheared matrix from `applyMatrix4` or a direct `matrix` write |
| `SpatialUnsupportedError: Adding "a" to "b" would make the scene graph cyclic; the call was ignored` | an ancestor was re-parented under its own descendant |
| `SpatialUnsupportedError: Adding "x" would make the scene graph 1025 levels deep; the limit is 1024` | the depth cap |
| `SpatialUnsupportedError: The scene has used every object id below 16777216; new objects are not tracked` | the id space is exhausted; destroy objects you are finished with |
| `SpatialUnsupportedError: A sync record for "x" carried a non-finite value or a zero-length quaternion; it was dropped and the last valid transform is kept` | a malformed transform pushed back by the consumer (physics, manipulation, an anchor); the object keeps its last pose |
| `SpatialUnsupportedError: "x" could not be processed and is skipped for the rest of the session: <engine message>` | see [Per-object exception safety](#per-object-exception-safety) |

Errors that **throw** at the call site instead of being recorded:

| Thrown | When |
|---|---|
| `TypeError` | wrong argument type to `add`/`remove`/`attach`, `mount`, `destroy`, `onFrame`, a timer, `physics.add`, `Spatial.environment`, `rigidBody`; an unknown `RigidBody`/`Joint`/`ParticleEmitter`/`Anchor` enum value |
| `SpatialUnsupportedError` | `Scene.background`/`environment`/`fog`; `Mesh.material = [...]`; `TextGeometry` with a non-default font; `RigidBody` `shape: "mesh"` on a dynamic body; one `RigidBody` on two objects (`"rigidbody-shared"`); `Joint` on a body without a `rigidBody`; re-adding a destroyed object; destroying the mounted scene; `loadAsset` missing the backend's key (as a rejection) |

### Warning catalogue

Every warning is emitted once per key per scene, logged through `console.warn`,
and recorded in `dump().warnings`.

| Warning | Meaning |
|---|---|
| `No scene was mounted; auto-mounting the single Scene that was constructed` | add an explicit `Spatial.mount(scene)` |
| `Mesh "x" was created without a geometry; an empty BufferGeometry was substituted` | `new Mesh()` with no geometry |
| `Mesh "x" was created without a material; a MeshStandardMaterial was substituted (three.js would use MeshBasicMaterial, which is unlit)` | `new Mesh(geometry)` with no material |
| `BoxGeometry arguments were normalized: width -0.2 -> 0.2, ...` | a negative, zero or non-finite geometry argument |
| `MeshStandardMaterial properties were clamped: opacity 4 -> 1, ...` | an out-of-range material scalar |
| `PointLight properties were clamped: intensity -5 -> 0, ...` | an out-of-range light scalar |
| `MeshStandardMaterial.wireframe is unsupported in RealityKit` | the mesh renders solid |
| `AdditiveBlending is unsupported in RealityKit; the material renders as transparent` | |
| `PointLight shadows are unsupported; castShadow is ignored` | |
| `Object3D.groundingShadow is unsupported on the three.js backend` | |
| `Object3D.manipulable is unsupported on macOS; ManipulationComponent is visionOS only` | RK macOS |
| `Object3D.renderOrder is unsupported on macOS; ModelSortGroupComponent is visionOS only` | RK macOS |
| `hoverEffect "lift" has no RealityKit equivalent and renders as "highlight"` | the SDK offers spotlight, highlight and shader only |
| `Object3D.opacity was not a finite number and was ignored` | a NaN reached `opacity` |
| `Head anchors are visionOS only; the anchor stays at the world origin on macOS` | also the hand and plane variants |
| `Spatial.environment replaces the AmbientLight image based light; the AmbientLight intensity is ignored while an environment is set` | RealityKit; clearing the environment restores the ambient |
| `.exr environments are unsupported in the three.js consumer (url)` | use `.hdr` for a cross-backend scene |
| `Portal crossing is unsupported in the three.js consumer` | |
| `ParticleEmitter preset 'x' has no RealityKit equivalent; the emitter falls back to its explicit fields` | only for a preset outside the documented seven |
| `CylinderGeometry with radiusTop != radiusBottom has no RealityKit generator; the mesh is rebuilt from the geometry buffers` | also partial spheres and cones — correct, just not the native fast path |
| `Portal "x" has a world group that is not in the mounted scene; add it to the scene for the portal to render` | the world group was created but never added |
| `RigidBody on "x" was ignored: the object has no geometry to build a collision shape from` | a body on a `Group` or other non-mesh |
| `RigidBody.applyImpulse on "x" was dropped: the object is not in the mounted scene` | the object was destroyed or never added; also covers `burst`, `playAnimation` and the other imperative calls |
| `texture N was released while a material still references it; it is kept until the material changes` | web; repoint the material before disposing |
| `the scene has no lights; meshes with lit materials render black` | neither consumer adds a light of its own, so the backends agree. Add one |
| `A name of 400 characters was truncated to 256` | the command stream carries at most `MAX_NAME_LENGTH`; the object keeps the full name |
| `The url scheme "ftp:" is not allowed; "ftp://x/a.png" was dropped` | texture url containment |
| `"../../etc/passwd" escapes the asset root and was dropped` | texture url containment |
| `Credentials were stripped from "https://user:pw@example.com/a.png" before it reached the consumer` | texture url containment |
| `More than 1000 "tap" listeners on "m"; the registration was dropped` | `MAX_LISTENERS_PER_EVENT` |
| `More than 10000 live timers; the registration was dropped` | `MAX_LIVE_TIMERS`; the same shape for animation-frame callbacks |
| `50 more log lines were suppressed this frame` | `MAX_LOGS_PER_FRAME` |
| `Object3D.add was called with null; the call was ignored` | also `remove` and `attach`, `undefined` as well as `null` |
| `THREE.Color: Unknown color ...` | an unparseable colour string; the colour stays white |

`dump().warnings` is capped at 500 entries.

Two things are accepted **silently**, by design, because warning on them would
fire on almost every scene: `receiveShadow` on RealityKit (its surfaces always
receive shadows, and three.js defaults the flag to `false` everywhere), and
`hoverEffect` on macOS and web at the property level — the value is stored and
appears in `dump()`, and only the RealityKit consumer's `"lift"` substitution
warns.

### Per-object exception safety

The frame walk, the world-matrix refresh and the dump are all per-object safe.
An object that cannot be processed — because it was frozen, because a property
has a hostile getter, or because a patched builtin makes an operation on it
throw — costs **that object**, not the frame and not the scene:

```
SpatialUnsupportedError: "bad" could not be processed and is skipped for the rest of the session: Cannot add property Symbol(spatial.snapshot), object is not extensible
```

The error is recorded once, the object is skipped from then on, and every other
object keeps updating. `dump()` still lists it. Two consequences:

- **`Object.freeze` on a live scene object takes it out of the render.** Freeze
  is not a way to say "static" — see
  [`matrixAutoUpdate = false`](#object3d-threejs-properties) for that.
- **The skip is for the session.** Unfreezing the object does not bring it back;
  rebuild the scene.

Patching a builtin the core uses (`Array.prototype.push`, for instance) does
not stop the scene either: the core calls its own captured copies, so a patched
prototype affects only the script's own code.

### SpatialUnsupportedError

`class SpatialUnsupportedError extends Error`

| Field | Type | Notes |
|---|---|---|
| `name` | `"SpatialUnsupportedError"` | |
| `message` | `string` | |
| `feature` | `string \| null` | e.g. `"destroyed-object"`, `"RigidBody.shape=mesh"`, `"Joint.body"`, `"TextGeometry.font"`, `"Scene.background"`, `"loadAsset"`, `"destroy-scene"`, `"cyclic-parent"` |
| `object` | `Object3D \| null` | the object involved, when there is one |

Exported as `Spatial.SpatialUnsupportedError`, so `instanceof` works.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, RigidBody, SpatialUnsupportedError } = Spatial;

const scene = new Scene();
scene.add(new Spatial.AmbientLight(0xffffff, 1));

const box = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
box.name = "box";
scene.add(box);

try {
  box.rigidBody = new RigidBody({ type: "dynamic", shape: "mesh" });
} catch (error) {
  if (error instanceof SpatialUnsupportedError) {
    box.userData.feature = error.feature;      // "RigidBody.shape=mesh"
    box.rigidBody = new RigidBody({ type: "dynamic", shape: "convex" });
  } else {
    throw error;
  }
}

Spatial.mount(scene);
```

---

## 17. Dump format

`Spatial.dump()` returns a plain object describing the core scene. The macOS host
serves it at `GET /dump`, and the RealityKit consumer's own `GET /native-dump`
returns the same shape built from the live entities — comparing the two is how
you check that the scene really reached the renderer.

This section describes the **full** dump. [`Spatial.dump(options)`](#spatialdump)
narrows it — `compact`, `names`, `fields`, `objects: false` — and both the Mac
app's `/dump` and `/native-dump` accept the same narrowing as query parameters.
Building a full dump of a large scene is expensive; poll a narrowed one.

Top level:

| Field | Type | Notes |
|---|---|---|
| `backend` | `"realitykit" \| "three"` | |
| `platform` | `"macos" \| "visionos" \| "web"` | |
| `frame` | `number` | ticks since load; `0` before the first tick |
| `elapsed` | `number` (seconds) | |
| `loadGeneration` | `number` | increments on every `load`. A dump whose `loadGeneration` is not the one you pushed belongs to an older script, and its ids mean nothing to yours |
| `scene` | `{ name, userData } \| null` | `null` before mount |
| `objects` | `DumpObject[]` | depth-first, parents before children |
| `joints` | `object[]` | `{ id, type, bodyA, bodyB, anchorA, anchorB, axis, limits }` |
| `gravity` | `[x, y, z]` | |
| `environment` | `{ url, intensity } \| null` | |
| `warnings` | `string[]` | capped at 500 |
| `errors` | `string[]` | the most recent 200 |
| `droppedErrors` | `number` | how many times the `errors` cap dropped older entries; non-zero means the first failure is no longer listed |

Each entry of `objects`:

| Field | Type | Notes |
|---|---|---|
| `id` | `number` | command-stream id; `0` is the mounted scene root |
| `name`, `type` | `string` | |
| `parent` | `number` | `0` for a child of the scene |
| `visible` | `boolean` | |
| `position`, `scale`, `worldPosition` | `[x, y, z]` | |
| `quaternion` | `[x, y, z, w]` | |
| `geometry` | `{ type, uuid, parameters } \| null` | |
| `material` | material snapshot `\| null` | `{ type, uuid, color, opacity, transparent, side, wireframe, metalness, roughness, emissive, emissiveIntensity, clearcoat, clearcoatRoughness, depthWrite, depthTest, blending, maps }` |
| `light` | light snapshot `\| null` | `{ type, color, intensity, distance, decay, angle, penumbra, castShadow, direction }` |
| `rigidBody` | body JSON `\| null` | `{ type, mass, shape, requestedShape, friction, restitution, linearDamping, angularDamping, isTrigger, gravity }` — `shape` is the **resolved** shape, `requestedShape` is what you asked for. `type` and `mass` are echoed as written even on a trigger, where both are ignored |
| `opacity` | `number` | the whole-object opacity. Always `1` on a `ParticleEmitter`, which reuses the name for the particle start opacity |
| `billboard`, `groundingShadow`, `hoverEffect`, `manipulable` | | the SpatialScript flags, as written — including on backends that ignore them |
| `castShadow`, `receiveShadow`, `renderOrder` | | |
| `interactive` | `{ tap, hover, drag, manipulation, collision }` | which listener kinds are registered. Only `tap`/`hover`/`drag` make the object an input target and build a collider |
| `world` | `boolean` | true when this object is some portal's world group |
| `userData` | `object` | verbatim — the channel for your own assertions |
| `velocity` | `[x, y, z]` | **only on objects with a `rigidBody`**; the last `syncBodies` from the consumer, `[0,0,0]` before the first |
| `isSleeping` | `boolean` | **only on objects with a `rigidBody`**; `true` once a body comes to rest and stops syncing |

Extra fields on specific types:

| Type | Extra fields |
|---|---|
| `ParticleEmitter` | `particles` (the full emitter JSON, including the real `opacity`) |
| `Anchor` | `anchor` (the normalised request), `isAnchored` |
| `Portal` | `portal` (`{ worldId, width, height, crossing }`) |
| `Asset` | `asset` (the url set), `animations`, `loaded` |

The mounted `Scene` itself is not an entry in `objects`; its children are, with
`parent: 0`. Its name and `userData` are in the top-level `scene` field.

Colours in the dump are linear sRGB in 0..1, matching the command stream, not
the hex you passed in.

`nativeDump()` — served by the macOS host at `GET /native-dump` and produced by the
web consumer for the parity gate — has the same shape, built from the live
entities. Comparing the two is how you check a scene reached the renderer.
Expect two legitimate differences: RealityKit collision shapes are lazy, so a
mesh with no listener and no body has no `CollisionComponent` until the first
raycast; and the native side reports only what it actually installed, so a
property a backend ignores (`renderOrder` on macOS, for instance) will not
appear there even though the core dump lists it.

---

## Not in scope

These names are **not exported**. A script that references one gets a plain
`ReferenceError` (bare name) or `TypeError` (`Spatial.Foo is not a
constructor`). Nothing pretends to work.

Cameras and camera control · `ShaderMaterial` and custom shaders ·
post-processing · `HemisphereLight` · `RectAreaLight` · sprites · lines and
points as primitives · skinned mesh authoring · morph targets · audio · video ·
character controller · force effects · scene understanding · game controllers ·
multiple materials per mesh · `Scene.background` · `Scene.fog` · texture
compression formats.

`Scene.background`, `Scene.environment`, `Scene.fog` and `Mesh.material = [...]`
are the exceptions: those properties exist and throw `SpatialUnsupportedError`
on assignment, because a silent no-op there would be invisible.

---

## Appendix A: architecture

Not needed to write a script, but useful when a dump and the screen disagree.

```
script.js
    |
shared core (JS)                     core/dist/spatial-core.js
  vendored three.js math, scene graph, geometry, materials, animation
  authoritative scene; runs identically in JavaScriptCore and the browser
    |
    |  flush() -> Command[]  (one array per tick)
    |
    +--> RealityKit consumer (Swift, JavaScriptCore) -- entities, RK physics
    +--> three.js consumer (web/) -- WebGLRenderer, Rapier physics
```

- The core owns the scene graph. Transforms, hierarchy, materials, geometry,
  lights and keyframe animation are computed in JavaScript; consumers mirror
  them.
- Consumers own physics simulation, native asset animation, manipulation and
  input. They push resulting world transforms back into the core through
  `sync` before each frame, and the core records them as last-flushed so no
  echo transform is emitted.
- **Commands** (SPEC section 5): `create`, `destroy`, `parent`, `name`,
  `transform`, `transforms`, `visible`, `geometry`, `material`, `texture`,
  `light`, `shadow`, `opacity`, `billboard`, `groundingShadow`, `hoverEffect`,
  `manipulable`, `renderOrder`, `interactive`, `rigidBody`, `bodyImpulse`,
  `bodyForce`, `bodyTorque`, `bodyVelocity`, `joint`, `gravity`, `particles`,
  `particlesBurst`, `anchor`, `portal`, `world`, `asset`, `assetAnimation`,
  `environment`, `log`. The core guarantees ordering: `create` before anything
  else for an id, `texture` before the `material` that references it,
  `geometry` and `material` before `rigidBody`, `world` before `portal`,
  children's `create` before their `parent`, descendants' `destroy` before
  their ancestor's, and a texture's release (`["texture", id, null]`) after the
  material commands that stopped referencing it. `create` kinds are `group`,
  `mesh`, `ambientLight`, `directionalLight`, `pointLight`, `spotLight`,
  `particles`, `anchor`, `portal`, `asset`; a text label is a `mesh` whose
  geometry descriptor is `TextGeometry`.
- **Sync in** (SPEC section 6): `sync(Float32Array)` world transforms,
  `syncBodies(Float32Array)` velocities and sleep state,
  `dispatch(type, id, payload)` events, `setInput(state)` polled input. The
  consumer also installs `__spatialNative.raycast(ox, oy, oz, dx, dy, dz,
  maxDistance, recursive)`, `.log` and `.now`.
- **Core entry points** (SPEC section 7): `__spatial.load(source, options)`,
  `.tick(dt)`, `.sync`, `.syncBodies`, `.dispatch`, `.setInput`, `.dump()`,
  `.dispose()`, `.objectForId`, `.idForObject`, `.whenLoaded()`.

The practical consequences for a script author: a change you make is visible to
the renderer at the end of the same tick; a change physics makes is visible to
your script at the start of the next one; and batching your edits inside one
`onFrame` costs nothing extra, because the diff runs once per frame regardless.

### The DEBUG watchdog

The macOS host installs a JavaScriptCore execution-time limit of **2 seconds per
synchronous entry** into the core — one `load`, one `tick`, one `dump`. A
script that exceeds it (`while (true) {}` in `onFrame`, an unbounded
`requestAnimationFrame` chain, a pathological loop) has its context terminated
and **the scene is disposed**: the app survives, the compositor keeps running,
and the dev server stays reachable so you can push a fix.

**It only bites in interpreter mode.** The JIT's interrupt check never fires in
this hardened, JIT-entitled process, so with the JIT on the limit is installed
but cannot interrupt a runaway loop. Launch the macOS host with
`SPATIAL_INTERPRETER=1` (or `--interpreter`) to turn the JIT off and arm it —
see [the README](../README.md#interpreter-mode). `GET /health` reports the
state exactly:

| `watchdog` | Meaning |
|---|---|
| `armed` | interpreter mode, DEBUG, private entry point resolved: a runaway script is terminated |
| `inactive (requires interpreter mode)` | DEBUG with the JIT on: installed, cannot interrupt |
| `unavailable` | the private JavaScriptCore entry point could not be resolved |
| `release build: no watchdog` | no protection at all |

Other things to know:

- The limit is per entry, not a frame budget. A script that takes 100 ms every
  frame is slow, not terminated; the caps in [`Spatial.limits`](#spatiallimits)
  are what keep that kind of load bounded.
- **Release builds have no watchdog**, so an infinite loop there freezes the
  app. Do not ship a script you have not run in the macOS host.

The core itself has no watchdog and neither does the browser.
