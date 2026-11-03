# SpatialScript versus three.js

A checklist to scan before writing a SpatialScript scene. SpatialScript copies
three.js class names, constructor signatures, property names and method names
wherever a three.js equivalent exists — so most three.js habits transfer — but
it is not three.js, and the differences below are the ones that break scripts.

Much of what phase 1 sent you around no longer needs a workaround: cameras,
audio, video, character controllers, force fields, rig control, multi-material
meshes and game controllers all ship in phase 2. Section 10 lists what changed.

Full reference: [API.md](./API.md). Symptom-first debugging:
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## Contents

- [The five-minute version](#the-five-minute-version)
- [1. No renderer, and a camera you do not own by default](#1-no-renderer-and-a-camera-you-do-not-own-by-default)
- [2. mount instead of render](#2-mount-instead-of-render)
- [3. Units are metres](#3-units-are-metres)
- [4. The script body is async](#4-the-script-body-is-async)
- [5. Events instead of a raycaster](#5-events-instead-of-a-raycaster)
- [6. Physics and joints](#6-physics-and-joints)
- [7. Object3D extras](#7-object3d-extras)
- [8. destroy versus remove](#destroy-versus-remove)
- [9. Constrained classes](#9-constrained-classes)
- [10. Not in scope, and what you get instead](#10-not-in-scope-and-what-you-get-instead)
- [11. Normalisation rules](#11-normalisation-rules)
- [12. Errors never stop the scene](#12-errors-never-stop-the-scene)
- [13. RealityKit-specific behaviour](#13-realitykit-specific-behaviour)
- [14. Things that are exactly three.js](#14-things-that-are-exactly-threejs)

---

## The five-minute version

| three.js habit | SpatialScript |
|---|---|
| `new THREE.WebGLRenderer()`, `renderer.render(scene, camera)` | nothing — the host renders. Call `Spatial.mount(scene)` once |
| `new THREE.PerspectiveCamera(...)` | the class exists; assign it to `Spatial.camera`. On visionOS the viewer is the camera and the assignment does nothing |
| `requestAnimationFrame(animate)` loop | `Spatial.onFrame((deltaTime, elapsed) => ...)` |
| `import * as THREE from "three"` | `const Spatial = require("spatial")` |
| units of "1" for a cube | `0.1` — one metre is a big object |
| `new THREE.Raycaster()` + pointer events | `object.addEventListener("tap", ...)`; `Spatial.raycast()` for explicit rays |
| `scene.remove(obj)` to get rid of something | `Spatial.destroy(obj)`; `remove` only detaches |
| `new THREE.MeshBasicMaterial()` default when a `Mesh` has no material | a lit `MeshStandardMaterial` is substituted, with a warning |
| `scene.background`, `scene.fog` | throw `SpatialUnsupportedError` |
| `material.needsUpdate = true` after a change | not needed for materials or geometry method calls; still needed after editing an attribute array **in place** |
| physics via an external library | built in: `mesh.rigidBody = new Spatial.RigidBody(...)` |
| `object.visible` for fading | `object.visible` still works; `object.opacity` fades the whole subtree |
| `new THREE.Audio(listener)` with an `AudioListener` on the camera | `Spatial.audio` **is** the listener and the mixer; `Audio`/`PositionalAudio` take no listener argument, and playback state is native-driven |
| `new THREE.Mesh(geometry, [a, b])` | works, with `geometry.groups`, as in three.js |
| `matrixAutoUpdate = false` to hand-manage a matrix | same, **plus** it is the static hint: a static object stops being polled and large static scenery becomes nearly free |
| no enforced limits | `Spatial.limits` names every cap the runtime enforces (timers, listeners, depth, log size); crossing one warns, never fails silently |

---

## 1. No renderer, and a camera you do not own by default

There is no `WebGLRenderer`, no `OrbitControls`, and no render loop you own. The
host renders the mounted scene, and by default it also owns the camera: on macOS
the app's virtual camera at `(0, 0.25, 1.4)`, on the web a preset that mirrors
it, and on visionOS the viewer's head.

`PerspectiveCamera` and `OrthographicCamera` **do** exist (phase 2), and
assigning one to `Spatial.camera` takes the view over on macOS and the web:

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, PerspectiveCamera } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));
const cube = new Mesh(new BoxGeometry(0.15, 0.15, 0.15), new MeshStandardMaterial());
cube.name = "cube";
scene.add(cube);

const eye = new PerspectiveCamera(55, 1, 0.01, 20);
eye.name = "eye";
eye.position.set(0, 0.25, 1);
eye.lookAt(0, 0, 0);
Spatial.camera = eye;        // null hands the view back to the consumer

Spatial.mount(scene);

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 3) return;
  // The camera reaches the consumer as its own object: the parameters are the
  // top-level `camera` field, the pose travels with `objects`.
  scene.userData.cameraKind = Spatial.dump().camera.kind;   // "perspective"
  scene.userData.cameraIsObject = Spatial.find("eye") !== null || eye.isObject3D === true;
  scene.userData.canFrame = Spatial.env.capabilities.camera; // false on visionOS
});
```

Consequences that remain:

- **On visionOS the user is the camera.** The assignment is kept and reported and
  warns once; `capabilities.camera` is `false` there. A script that must run
  everywhere reads the capability rather than assuming it can frame the shot.
- `aspect` belongs to the consumer, which owns the viewport; a script value is
  ignored with a warning.
- An `OrthographicCamera`'s visible width follows the viewport aspect, because
  RealityKit's takes only a height.
- Screen-space work (projection, NDC, `Vector3.project`) still has no meaning;
  use [`Spatial.rayFromPoint`](./API.md#pointer-queries) and
  `Spatial.input.mouse.scenePosition` instead, both of which are `null` on
  visionOS.
- For "always faces me", `object.billboard = true` is still the portable answer —
  the consumer does the facing.

## 2. mount instead of render

`Spatial.mount(scene)` attaches a scene to the native root. Exactly one scene
is mounted; mounting another replaces the first and destroys it completely —
its entities are freed, its command-stream ids are released, and its objects
are marked destroyed, so re-adding one throws `SpatialUnsupportedError` with
`feature: "destroyed-object"`, exactly as after `Spatial.destroy`.

If the script finishes without mounting:

| Scenes constructed | Result |
|---|---|
| exactly 1 | auto-mounted, with a warning |
| 0 | **load error** |
| 2 or more | **load error** |

Mount early — usually right after building the scene and before any `await` —
so the scene is on screen while slow work finishes.

## 3. Units are metres

Right-handed, Y up, matching both three.js and RealityKit. Angles are radians,
time is seconds, mass is kilograms.

The practical rule: content lives within about half a metre of the origin, and
the viewer is roughly a metre away. Every parametric geometry defaults to
**one metre**, which is a wall, not a prop — always pass explicit sizes.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

const prop = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial());
prop.name = "prop";                  // a chunky, visible cube
scene.add(prop);

const wall = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
wall.name = "wall";                  // a 1 m cube: you are inside it
wall.position.x = 2;
scene.add(wall);

Spatial.mount(scene);

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 3) return;
  const of = (name) => Spatial.dump().objects.find((entry) => entry.name === name);
  scene.userData.propWidth = of("prop").geometry.parameters.width;   // 0.2
  scene.userData.wallWidth = of("wall").geometry.parameters.width;   // 1
});
```

## 4. The script body is async

The body is compiled as a function body first, and as an **async** function
body if that fails, so top-level `await` is allowed. That changes error
classification:

- A throw **before** the first `await` is a load error: the scene never starts.
- A throw **after** the first `await` is a runtime error: it lands in
  `dump().errors` and the mounted scene keeps running.

Timers and asset loads advance on frame ticks, not on a host event loop. So
`await new Promise(r => setTimeout(r, 100))` only resolves once ~100 ms of
frames have elapsed — which is fine, but means the awaited work needs the
scene to be ticking. Mount first.

There is no module system: no `import`, no `export`, no `require` of anything
except `"spatial"`.

## 5. Events instead of a raycaster

three.js gives you a `Raycaster` and leaves picking to you. SpatialScript
delivers input as events on `Object3D`, through three's own `EventDispatcher`
API, and the consumer does the hit testing.

| | three.js | SpatialScript |
|---|---|---|
| making something clickable | build a raycaster, track pointer events, intersect | `object.addEventListener("tap", handler)` |
| event names | DOM names on the canvas | `tap`, `hoverenter`, `hoverexit`, `dragstart`, `drag`, `dragend`, `manipulationstart`, `manipulation`, `manipulationend`, `collisionstart`, `collisionend`, `anchored`, `unanchored`, `assetLoaded`, `assetError` |
| propagation | none (you dispatch) | events **bubble** to ancestors with `target` unchanged; the mounted `Scene` sees every event last; `event.stopPropagation()` halts the walk |
| hit target | anything you intersect | only meshes; a listener on a `Group` receives bubbled events but the group itself is never hit |
| making a child hittable | up to you | each object registers its own listener — a listener on an ancestor does not make descendants targets |

Drag is the one that surprises people: **the script owns the position.** The
consumer reports `event.translation`, the world-space displacement since
`dragstart`, and never moves the object itself.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, Vector3 } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));
const box = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial());
box.name = "box";
scene.add(box);

// The whole pattern: capture where the drag began, add the world-space
// displacement the consumer reports. It never moves the object for you.
const origin = new Vector3();
box.addEventListener("dragstart", () => origin.copy(box.position));
box.addEventListener("drag", (event) => box.position.copy(origin).add(event.translation));
box.addEventListener("dragend", (event) => { scene.userData.total = event.translation.toArray(); });

Spatial.mount(scene);

Spatial.onFrame(() => {
  // inject.drag interpolates `steps` drag events, each carrying the
  // displacement since dragstart — not since the previous event.
  if (Spatial.time.frame === 5) Spatial.inject.drag("box", new Vector3(0.1, 0, 0), { steps: 4 });
  if (Spatial.time.frame === 20) scene.userData.movedX = box.position.x;   // 0.1, not 0.25
});
```

Polled input has no three.js counterpart at all: `Spatial.input.keyboard`,
`.mouse`, `.hands`. And `Spatial.inject` synthesises the same events on every
backend for verification.

`Spatial.raycast(origin, direction, options)` still exists for explicit rays,
and its rules are narrower than a three.js `Raycaster`'s. It is synchronous and
returns hits sorted by distance, but: **meshes only**, **visible meshes only**
(an invisible object, or one under an invisible ancestor, is never hit), and
**at most one hit per object** — a ray through a box gives you one hit, not an
entry and an exit. `recursive: false` means only the direct children of the
mounted scene, not "no children of the objects I pass" (you pass none). A
`rigidBody` is not required. All three backends follow the same rules.

## 6. Physics and joints

three.js has no physics. SpatialScript does, and it runs in the consumer
(RealityKit physics, or Rapier on web).

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
Spatial.physics.gravity.set(0, -9.81, 0);

const anchor = new S.Mesh(new S.BoxGeometry(0.06, 0.06, 0.06), new S.MeshStandardMaterial());
anchor.name = "anchor";
anchor.position.y = 0.2;
anchor.rigidBody = new S.RigidBody({ type: "static" });
scene.add(anchor);

const bob = new S.Mesh(new S.SphereGeometry(0.04, 16, 12), new S.MeshStandardMaterial());
bob.name = "bob";
bob.rigidBody = new S.RigidBody({ type: "dynamic", mass: 1, restitution: 0.5 });
scene.add(bob);

Spatial.physics.add(new S.Joint({
  type: "revolute", bodyA: anchor, bodyB: bob, axis: new S.Vector3(0, 0, 1),
}));

Spatial.mount(scene);

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 3) return;
  const dump = Spatial.dump();
  scene.userData.gravity = dump.gravity;                       // [0, -9.81, 0]
  scene.userData.joints = dump.joints.length;                  // 1
  // Read-only, consumer-owned: the setters are the way to write them.
  scene.userData.velocity = bob.rigidBody.linearVelocity.toArray();
});
```

Six rules that have no three.js analogue:

1. **A dynamic body's transform is not yours.** The consumer syncs it into the
   core every frame. Writing `position`/`quaternion`/`scale` on a dynamic body
   is a **teleport**: the body moves there and its velocity is zeroed. To push
   a body, use `applyImpulse` / `applyForce` / `setLinearVelocity`.
2. **Static and kinematic bodies are script-driven.** Move them normally.
3. **A trigger is never simulated.** `isTrigger: true` gives a collision-only
   volume: no mass, no falling, no pushing, and its `type`, `mass` and
   `gravity` are all ignored — leaving `type` at its `"dynamic"` default is
   fine, it still will not move. It follows its object's transform and reports
   `collisionstart`/`collisionend` for everything that overlaps it. `dump()`
   echoes the `type` and `mass` you wrote, not the ignored effective values.
4. **One `RigidBody` per object.** Assigning the same instance to a second
   object throws `SpatialUnsupportedError` (`"rigidbody-shared"`): impulses and
   velocity sync resolve through the body's single owning object.
5. **Destroying a body removes its joints.** `Spatial.destroy(bodyA)` silently
   drops every joint pinned to it from `Spatial.physics.joints`, so a joint
   never survives with a dead body.
6. **Parity is structural, not numerical.** Both backends give you bodies,
   shapes, masses, joints and collision events, and a dropped body comes to
   rest on a floor. Trajectories differ between RealityKit and Rapier — never
   assert an exact position after N frames.

`rigidBody.linearVelocity`, `.angularVelocity` and `.isSleeping` are read-only
state pushed in by the consumer; write through the setter methods instead.

A `distance` joint's `limits` is the allowed **separation between the two
anchors** in metres, and `null` pins that separation at whatever it was when the
joint was added. On web a positive `min` is honoured only where Rapier can
express it; otherwise `max` is applied as a rope, with a warning naming the
joint.

## 7. Object3D extras

Six properties three.js does not have, plus one it has that SpatialScript
narrows:

| Property | Default | What it does | Where it works |
|---|---|---|---|
| `opacity` | `1` | fades the object **and its whole subtree**, independent of `material.opacity` | everywhere |
| `billboard` | `false` | the object always faces the viewer | everywhere |
| `groundingShadow` | `false` | a contact shadow under a mesh | RealityKit; **warns once and is ignored on web** |
| `hoverEffect` | `null` | `"highlight" \| "lift" \| "spotlight"` system hover treatment | **visionOS only** (`"lift"` warns once and renders as `"highlight"`); accepted with no visual on macOS and web |
| `manipulable` | `false` | the system grab / move / rotate / scale gesture, with `manipulation*` events | **visionOS** natively; **macOS warns once and ignores it** — `ManipulationComponent` is visionOS only; web emulates it with a view-plane mouse drag |
| `rigidBody` | `null` | attaches physics; one `RigidBody` instance per object, or it throws | everywhere |
| `renderOrder` | `0` | three.js's own property | visionOS (`ModelSortGroupComponent`) and web; **macOS warns once and ignores it** |

`opacity` versus `material.opacity` is the common trap. `material.opacity`
needs `material.transparent = true`, affects only that material, and is shared
by every mesh using the material instance. `Object3D.opacity` needs nothing,
affects the object and every descendant, and does not touch the material.

`clone()` and `copy()` carry the five display flags across. They do **not**
carry event listeners or `rigidBody` — reattach those on the clone.

Everything in the "macOS ignores it" column reports itself through
`Spatial.env.capabilities` (`manipulation: false`, `hoverEffect: false`,
`anchors: false`, `hands: false` there), so branch on the capability rather
than setting the property and hoping.

## destroy versus remove

three.js has no lifetime concept: `remove` detaches and the garbage collector
does the rest. Here the consumer holds native entities, so the two operations
are distinct and both are needed.

| | `parent.remove(object)` | `Spatial.destroy(object)` |
|---|---|---|
| detaches from the parent | yes | yes |
| native entity | kept | destroyed, descendants first |
| ids | kept | released; `Spatial.find` no longer resolves the name |
| can be re-added later | yes | **no** — throws `SpatialUnsupportedError` with `feature: "destroyed-object"` |
| memory returned | no | yes |

Use `remove` to park something you will re-add. Use `destroy` when you are
done with it — a scene that spawns and removes objects without destroying them
leaks native entities.

Destroying the mounted scene throws (`feature: "destroy-scene"`); mount another
scene instead, which destroys the first for you.

## 9. Constrained classes

Familiar classes with narrower contracts:

| Class | Constraint |
|---|---|
| `Scene` | `background`, `environment`, `fog` throw on assignment. Use `Spatial.environment` for image-based lighting |
| `Mesh` | exactly one material; assigning an array throws. Omitting the material substitutes a **lit `MeshStandardMaterial`**, not three's unlit `MeshBasicMaterial` |
| materials | only `MeshBasicMaterial`, `MeshStandardMaterial`, `MeshPhysicalMaterial`, `OcclusionMaterial`. Only the properties in the [contract table](./API.md#material-contract) reach a consumer — setting, say, `aoMap` or `sheen` does nothing |
| `Texture` | not three's `Texture` (three's loader needs `document`). Same shape: `repeat`, `offset`, `wrapS`, `wrapT`, `flipY`, `needsUpdate`, plus `url`, `loaded`, `error`. `dispose()` does not free immediately: the release is held until no material or emitter still names the texture |
| lights | `AmbientLight`, `DirectionalLight`, `PointLight`, `SpotLight` only |
| geometry | the nine parametric geometries plus `BufferGeometry` and `TextGeometry`. Only `position`, `normal` and `uv` attributes are transmitted. `setAttribute`, `deleteAttribute`, `setIndex`, `computeVertexNormals` and `applyMatrix4` re-emit the whole geometry; an in-place edit of an attribute array needs `attribute.needsUpdate = true` |
| `Object3D.matrix` | may be written directly, with `matrixAutoUpdate` either way: the core reads the write before three can recompute it, and decomposes it back into `position`/`quaternion`/`scale`. A matrix containing **shear** cannot become a transform: the object keeps its last valid pose for as long as the shear persists and an error is recorded |
| `matrixAutoUpdate` | three.js semantics, used as a performance contract: `false` means "static", the matrix is authoritative, and the core stops reading `position`/`rotation`/`scale`. Writing them then does nothing until `updateMatrix()` |
| script-supplied strings and urls | object and material names are truncated at 256 characters on the wire; geometry `parameters` are bounded; **every** url — texture, asset and environment — is scheme-checked, path-normalised against the asset root, refused if it escapes it, and stripped of credentials |

## 10. Not in scope, and what you get instead

These names are simply **not exported**. Referencing one is a plain
`ReferenceError` (`ShaderMaterial is not defined`) or `TypeError`
(`Spatial.EffectComposer is not a constructor`).

| Missing, permanently | Do this instead |
|---|---|
| `ShaderMaterial`, custom GLSL/Metal shaders, `onBeforeCompile` | RealityKit only accepts pre-authored graphs: use `ShaderGraphMaterial` with a required `fallback` |
| post-processing, `EffectComposer` | nothing; bake the look into materials and lights |
| animation graphs, compute graphs | no portable story |
| synchronization (multi-user), reference components | not in scope |
| `HemisphereLight`, `RectAreaLight` | `AmbientLight` + `DirectionalLight`, or `Spatial.environment` |
| `Sprite`, `Points`, `Line`, `LineSegments` | `ParticleEmitter` for points; thin boxes or cylinders for lines; a `billboard` plane for sprites |
| skinned mesh **authoring**, morph target **authoring** | load a rigged asset and drive `asset.skeleton` / `asset.blendShapes` |
| `Scene.background`, `Scene.fog` | throw; use `Spatial.environment` for lighting |
| texture compression formats | supply PNG/JPEG |

`Scene.background`, `Scene.environment` and `Scene.fog` throw instead of being
absent, because a silent no-op there would be invisible — while
`Mesh.material = [...]`, which phase 1 also threw on, is now supported:

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

// Phase 2: an array of materials with geometry.groups is supported, where
// phase 1 threw SpatialUnsupportedError on the assignment.
const geometry = new BoxGeometry(0.15, 0.15, 0.15);
geometry.groups.length = 0;
geometry.addGroup(0, 18, 0);
geometry.addGroup(18, 18, 1);
const cube = new Mesh(geometry, [
  new MeshStandardMaterial({ color: 0xff4455 }),
  new MeshStandardMaterial({ color: 0x44dd99 }),
]);
cube.name = "cube";
scene.add(cube);

Spatial.mount(scene);

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 3) return;
  scene.userData.materials = cube.material.length;                              // 2, no throw
  scene.userData.dumped = Spatial.dump().objects.find((o) => o.name === "cube").material.length;
});
```

The three that still throw, unchanged:

<!-- expect-error: Scene.background is not in scope -->
```js runnable
const Spatial = require("spatial");
const scene = new Spatial.Scene();
scene.name = "world";
scene.add(new Spatial.AmbientLight(0xffffff, 1));
Spatial.mount(scene);

scene.background = new Spatial.Color(0x101014);   // SpatialUnsupportedError
```

**Phase 2 shipped nine things this table used to send you around.** If you are
working from older notes, these all exist now:

| Was "not available" | Now |
|---|---|
| cameras and camera control | `PerspectiveCamera`, `OrthographicCamera`, `Spatial.camera` (not on visionOS) |
| audio | `Spatial.audio`, `Audio`, `PositionalAudio`, `AmbientAudio`, `AudioLoader` |
| video | `VideoScreen` with `mp4`/`hls`/`webm` |
| character controller | `object.characterController = new CharacterController(...)` |
| force effects | `ConstantForceField`, `RadialForceField`, `VortexForceField`, `DragForceField`, `TurbulenceForceField` |
| scene understanding | `Spatial.sceneUnderstanding` (visionOS) |
| game controllers | `Spatial.input.controllers`, `Spatial.inject.controller` |
| multiple materials per mesh | `new Mesh(geometry, materials[])` with `geometry.groups` — **`Mesh.material = [...]` no longer throws** |
| posing a loaded rig | `asset.skeleton`, `asset.blendShapes` |

Plus things three.js has no equivalent for at all: a two-way host channel
(`Spatial.host`), consumer-performed `Spatial.fetchText`/`fetchJSON`, activation
hooks and hot reload with preserved state, accessibility metadata, and render
and debug options. See [API.md phase 2](./API.md#phase-2).

## 11. Normalisation rules

three.js will happily build a NaN-filled buffer from a negative radius.
SpatialScript will not let a bad value reach a consumer. Almost nothing
silently no-ops: an adjustment produces a warning and a rejection produces an
error. The deliberate exceptions, where warning on every scene would be noise,
are `receiveShadow` on RealityKit (its surfaces always receive shadows) and
`hoverEffect` on macOS and web (stored, reported in `dump()`, no visual).

| Input | Result |
|---|---|
| negative geometry size | absolute value, one warning per geometry: `BoxGeometry arguments were normalized: width -0.2 -> 0.2` |
| zero geometry size | `0.001` |
| non-finite geometry argument | the three.js default |
| segment count below the minimum, or fractional | rounded up to the minimum integer |
| material scalar out of range (`opacity`, `metalness`, `roughness`, `clearcoat`, `clearcoatRoughness`, `emissiveIntensity`, `side`) | clamped, one warning per material |
| light scalar out of range (`intensity`, `distance`, `decay`, `angle`, `penumbra`) | clamped, one warning per light |
| body scalar negative (`mass`, `friction`, `restitution`, damping) | clamped to `0` |
| `new Mesh()` with no geometry | an empty `BufferGeometry`, warning |
| `new Mesh(geometry)` with no material | a `MeshStandardMaterial`, warning |
| `add(null)` / `add(undefined)` | ignored, warning |
| `add(notAnObject3D)` | throws `TypeError` |
| `remove` of a non-child, or twice | no-op |
| NaN or Infinity in `position`/`quaternion`/`scale`, or a zero-length quaternion | the object's transform is **not sent**; the consumer keeps the last valid one; one error per object, repeated only after the value becomes valid again |
| a sheared `matrix` | same treatment: transform skipped, one error per object |
| re-parenting an ancestor under its own descendant | the call is ignored, one error (`cyclic-parent`) |
| adding an object to a second parent | three.js semantics: it moves |
| unparseable colour string | stays white, three.js logs `THREE.Color: Unknown color` |

The invariant: **no script input may crash the host or stop the frame loop.**
One bad object never stops the others from updating:

<!-- expect-error: would make the scene graph cyclic -->
```js runnable
const Spatial = require("spatial");
const { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));

// A negative size becomes its absolute value, with a warning naming the change.
const squashed = new Mesh(new BoxGeometry(-0.2, 0.1, 0.1), new MeshStandardMaterial());
squashed.name = "squashed";
scene.add(squashed);

// null is ignored with a warning, as in three.js.
scene.add(null);

// A cycle is refused and recorded, not thrown.
const outer = new Group();
outer.name = "outer";
const inner = new Group();
inner.name = "inner";
outer.add(inner);
scene.add(outer);
inner.add(outer);            // would make the graph cyclic

const healthy = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
healthy.name = "healthy";
scene.add(healthy);

Spatial.mount(scene);

Spatial.onFrame((deltaTime) => {
  healthy.rotation.y += deltaTime;      // keeps running through all of it
  if (Spatial.time.frame !== 5) return;
  const dump = Spatial.dump();
  scene.userData.width = dump.objects.find((o) => o.name === "squashed").geometry.parameters.width;
  scene.userData.warnings = dump.warnings.length;      // the normalisation notes
  scene.userData.stillTurning = healthy.rotation.y > 0;
  scene.userData.innerParent = inner.parent === outer;  // the cycle was refused
});
```

The cyclic-parent refusal is recorded in `dump().errors`, so this snippet is
expected to have one — that is the contract, not a failure.

## 12. Errors never stop the scene

| Where the throw happens | Consequence |
|---|---|
| top-level, before the first `await` | **load error** — the scene does not start |
| top-level, after an `await` | runtime error — recorded, scene keeps running |
| inside `onFrame`, `this.update`, an event listener, a timer | runtime error — that call is abandoned, the rest of the frame proceeds, the other listeners still run |
| core validation (shear, non-finite transform, cycle) | runtime error — that object is skipped for the frame |

A throw inside a callback costs that callback, not the scene:

<!-- expect-error: boom from onFrame -->
```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 1));
const box = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial());
box.name = "box";
scene.add(box);

Spatial.mount(scene);

// This one throws every frame. It is caught, reported once a second, and the
// callbacks after it still run.
Spatial.onFrame(() => { throw new Error("boom from onFrame"); });

Spatial.onFrame((deltaTime) => {
  box.rotation.y += deltaTime;
  scene.userData.frame = Spatial.time.frame;
  scene.userData.stillTurning = box.rotation.y > 0;
});
```

Runtime errors are deduplicated by message and reported at most once per
second, so a throw on every frame does not flood the log. They accumulate in
`dump().errors`, which keeps the most recent 200; `dump().droppedErrors` counts
how many times older entries were dropped, so a non-zero value means the first
failure is no longer in the list. A single `console` message is truncated at
16 KB, and at most 200 log lines leave the core per frame (the rest become one
`N more log lines were suppressed this frame`).

**One object cannot take down the frame either.** The walk, the world-matrix
refresh and the dump are per-object safe: an object that throws when touched —
frozen with `Object.freeze`, or carrying a hostile getter — is reported once and
**skipped for the rest of the session**, while every other object keeps
updating. Patching a builtin the core uses does not reach the core, which holds
its own captured copies.

**The macOS host has a DEBUG-only watchdog, in interpreter mode.** A single
synchronous entry into the core (one `load`, one `tick`, one `dump`) may take 2
seconds; past that the context is terminated and the scene disposed, so an
infinite loop costs the scene and not the app. It only bites with the
JavaScriptCore JIT off — launch with `SPATIAL_INTERPRETER=1`, which also mirrors
visionOS performance. `GET /health` reports `jit` and `watchdog`. **Release
builds have no watchdog**, and neither does the browser, so run a script in the
macOS host before shipping it.

A non-empty `errors` array is the signal that something is wrong even when the
picture looks fine — check it before believing a screenshot.

## 13. RealityKit-specific behaviour

Things that behave differently once the same script runs in the RealityKit app.

**Portals show what lies *behind* the plane.** A `PortalComponent` is a window
into the world entity's space aligned with the main scene. Content is visible
only where it sits behind the portal surface from the viewer's position. A
world group placed beside or in front of the portal renders **black** — which
looks like a broken portal but is not. Put the world group further from the
viewer than the portal.

**Ambient light is image-based, and that is visible.** RealityKit has no
ambient light. The consumer synthesises a uniform image-based light at the
`AmbientLight`'s intensity; if it cannot, it warns once and skips. Because it is
an environment light, it lights **metals**: a `MeshStandardMaterial` with
`metalness: 1` lit only by an `AmbientLight` is lit on RealityKit and black on
the web, where three.js's `AmbientLight` contributes only diffuse. Add a real
`DirectionalLight` or set `Spatial.environment` when a metallic object has to
match.

**An explicit environment overrides the ambient one.** With both an
`AmbientLight` and a `Spatial.environment` set, RealityKit uses the environment
and ignores the ambient intensity, warning once; clearing the environment
restores the ambient. Environment formats: `.hdr`, `.png` and `.jpg`
equirectangular on both backends, `.exr` on RealityKit only — the web consumer
warns once and installs no environment. Use `.hdr` for a cross-backend scene.

**Intensity units are converted for you.** Write three.js numbers:

| Light | You write | The consumer sends RealityKit |
|---|---|---|
| point, spot | candela | `candela × 4π` lumens |
| directional | `2`–`5` for a sun | `intensity × 1000` lux |
| ambient | a multiplier like `0.35` | an environment light at that exponent |

**Shadows.** Directional and spot shadows work; **point light shadows do not**
(warn once, ignored). A mesh needs `castShadow = true` to cast and
`receiveShadow = true` to receive.

**Materials.** `wireframe` is unsupported (warn once, rendered solid).
`AdditiveBlending` is unsupported — RealityKit blending is opaque or
transparent only — so it renders as transparent with one warning. `map` on a
`MeshBasicMaterial` becomes an `UnlitMaterial`; standard and physical become
`PhysicallyBasedMaterial`.

**Geometry.** `BoxGeometry`, `SphereGeometry`, `PlaneGeometry`,
`CylinderGeometry`, `ConeGeometry` and `TextGeometry` are regenerated with
native generators from `parameters`; everything else uses the vertex buffers,
and so do the parametric ones when a parameter has no native equivalent (a
partial sphere or cone, a cylinder whose two radii differ) — correct, just not
the fast path, and warned once. Meshes sharing one geometry instance share one
native resource, so share geometry aggressively.

**Collision shapes are lazy.** A mesh gets a `CollisionComponent` only when it
becomes an input target, when it gets a `rigidBody`, or the first time
`Spatial.raycast` runs — which materialises one for every mesh, permanently.
This is what keeps 1500 moving meshes at frame rate. It means `nativeDump()`
legitimately shows no collision component on a plain mesh, and that one raycast
changes that for the whole scene.

**Text is left-aligned and starts at the origin** on every backend, so centre a
`TextGeometry` on its own bounding box if you want it centred.

**What macOS does not do.** `Spatial.env.capabilities` is honest about all of
it — branch on the capability, not on the platform string:

| Capability | macOS | Effect on a script |
|---|---|---|
| `hands` | `false` | `Spatial.input.hands.left/right` are `null`; always null-check |
| `anchors` | `false` | an `Anchor` sits at the **world origin** and never resolves; `isAnchored` stays `false`, no `anchored` event, one warning per anchor kind. Give anchored content a sensible local transform |
| `manipulation` | `false` | `manipulable = true` warns once and is ignored; no `manipulation*` event ever fires. `ManipulationComponent` is visionOS only |
| `hoverEffect` | `false` | `hoverEffect` produces no visual, silently. `hoverenter`/`hoverexit` events still fire |

`renderOrder` is in the same family: visionOS maps it to
`ModelSortGroupComponent`, macOS warns once and ignores it.

**hoverEffect styles.** visionOS has spotlight, highlight and shader only:
`"lift"` warns once and renders as `"highlight"`.

**A scene with no lights is black on both backends.** Neither consumer invents
a key light; both warn once (`the scene has no lights; meshes with lit materials
render black`). Add an `AmbientLight` and a `DirectionalLight`.

## 14. Things that are exactly three.js

So you can stop worrying about them:

- All of `Vector2/3/4`, `Quaternion`, `Euler`, `Matrix3/4`, `Color`, `Box3`,
  `Sphere`, `Plane`, `Ray`, `Spherical`, `MathUtils` — the full three.js API.
- `Object3D` hierarchy and transform methods: `add`, `remove`, `attach`,
  `traverse`, `lookAt`, `localToWorld`, `rotateOnAxis`, `translateOnAxis`,
  `updateMatrixWorld`, and the rest.
- Parametric geometry constructor signatures and their `parameters` objects.
- `BufferGeometry` attribute and index handling.
- Material property names, defaults and semantics (within the contract).
- The animation system: `AnimationClip`, keyframe tracks, `AnimationMixer`,
  `AnimationAction`, `AnimationUtils` — the real three.js mixer, running in the
  core, driven by `mixer.update(deltaTime)` from `onFrame` exactly as in
  three.js. Because it writes to core objects, both backends see the result
  with no extra plumbing.
- `Color` linear working space: `new Color(0x3366ff)` reads the hex as sRGB and
  stores linear channels, matching three.js with `ColorManagement` enabled.
- `EventDispatcher` method names: `addEventListener`, `hasEventListener`,
  `removeEventListener`, `dispatchEvent`.
