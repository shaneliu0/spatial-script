# SpatialScript Specification

SpatialScript is a JavaScript scene API for building interactive 3D scenes that render in
RealityKit (macOS and visionOS) and in three.js (browser). One script runs unchanged in both.

The API follows three.js class names, constructor signatures, property names, and method names
wherever a three.js equivalent exists. It is not three.js: there is no renderer, no camera the
script controls, no custom shaders, and no post-processing. Features RealityKit cannot express
are not in the namespace or fail loudly.

This document is the contract. All three implementations (shared core, RealityKit consumer,
three.js consumer) must conform to it. When this document and an implementation disagree, the
implementation is wrong.

---

## 1. Architecture

```
                 script.js  (agent-authored, three.js-style)
                     |
        +------------v-------------+
        |   Shared core (JS)       |   vendored three.js math + scene graph + geometry +
        |   core/dist/spatial-core.js   material + animation classes, plus Spatial namespace
        |   authoritative scene    |   Runs identically in JavaScriptCore and the browser
        +------+------------+------+
               |            |
     command stream      command stream       (per frame: flush() -> Command[])
               |            |
   +-----------v---+   +----v-----------------+
   | RealityKit    |   | three.js consumer    |
   | consumer      |   | web/                 |
   | (Swift, JSC)  |   | WebGLRenderer +      |
   | entities,     |   | Rapier physics       |
   | RK physics    |   |                      |
   +---------------+   +----------------------+
```

Rules:

- The core owns the scene graph. Transforms, hierarchy, materials, geometry, lights, and
  keyframe animation are computed in JavaScript. Consumers mirror them.
- Consumers own physics simulation, native asset animation, manipulation, and input. They push
  resulting transforms back into the core through `sync` before each frame.
- Consumers never mutate the core's scene graph directly. They call only the entry points in
  section 7.
- Every command the core emits must be handled by both consumers. Handling may be "log an
  unsupported warning once" only where this document says so.

Units are meters. Coordinate system is right-handed, Y up, matching both three.js and RealityKit.
Angles are radians. Colors are linear sRGB values in 0..1 in the command stream. Time is seconds.

---

## 2. Script model

A script is a JavaScript file evaluated as a function body. `this` is the script object.
`require("spatial")` returns the namespace. `Spatial` is also a global.

```js
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight } = Spatial;

const scene = new Scene();
const cube = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: 0x3366ff }));
cube.name = "cube";
cube.position.set(-0.2, 0, 0);
scene.add(cube);

const sun = new DirectionalLight(0xffffff, 2);
sun.position.set(1, 2, 1);
scene.add(sun);

cube.addEventListener("tap", (e) => { cube.material.color.set(0xff0000); });

Spatial.onFrame((dt, elapsed) => { cube.rotation.y += dt; });
Spatial.mount(scene);
```

Lifecycle:

- Top-level code runs once at load. Objects created before `mount` are flushed in the first frame.
- The script body is evaluated as an `async` function, so top-level `await` is allowed (for
  example `const robot = await Spatial.loadAsset(...)`). `load` returns after the synchronous part
  of the body completes; the auto-mount check below runs when the body's promise settles. An
  exception thrown before the first `await` is a load error. An exception thrown after an `await`
  is reported through the error channel like a runtime error, and the scene keeps running with
  whatever was mounted. A body with no top-level `await` runs to completion inside `load`, so for
  it the auto-mount check and any load error are still raised synchronously by `load`; only a body
  that needs the async form defers them, and a load error that surfaces after `load` has returned
  travels through the error channel instead of being thrown.
- Robustness rule: no script input may crash the host or stop the frame loop. Invalid values
  (NaN or non-finite transforms, negative geometry sizes, unparseable colors, wrong argument
  types, null geometry or material, cyclic parenting, adding a destroyed object, removing twice)
  are either handled the way three.js handles them or reported through the error channel with the
  object named, and every other object keeps updating. Non-finite transform components are
  never sent to consumers; the object's last valid transform is kept and an error is recorded once
  until the value becomes finite again.
- `Spatial.mount(scene)` makes `scene` the displayed scene, attached to the native root entity.
  Only one scene is mounted at a time. Mounting another replaces the first.
- If load finishes with nothing mounted and exactly one `Scene` was constructed, the core mounts it
  and logs a warning. If zero or more than one were constructed, the core throws a load error.
- `Spatial.onFrame(cb)` registers `cb(deltaTime, elapsedTime)` to run every frame before flush.
  `Spatial.offFrame(cb)` removes it.
- Legacy lifecycle members on `this` keep working: `this.didAdd()`, `this.update(dt)`,
  `this.willRemove()`. `update` runs before `onFrame` callbacks.
- `Spatial.dispose()` is called by the consumer on teardown. It runs `willRemove`, destroys
  every object, tears down joints, environment, gravity, timers, and callbacks, and returns the
  final command array. A `tick` after dispose returns an empty array.
- Limits: hierarchy depth is capped at 1024 (an `add` or `attach` beyond it is refused with a
  recorded `depth-limit` error); object, texture, and joint ids are recycled after destroy and
  never exceed 2^24 (a scene that would need more records an error and stops tracking new
  objects); `dump().errors` keeps the last 200 entries and counts the rest in `droppedErrors`; a
  single log message is truncated at 16 KB.
- Imperative calls on an object that is not in the mounted scene (impulses, forces, particle
  bursts, asset animation) are dropped with a warning naming the call and the object; they are
  never queued for later.

Frame order in the core, per tick:

1. Apply pending native sync (transforms from physics, manipulation, native animation).
2. Apply pending input state and dispatch queued events.
3. Run timers that are due.
4. Run `this.update(dt)`, then every `onFrame` callback.
5. `scene.updateMatrixWorld(true)`.
6. Diff the scene against the last flushed state and emit commands.

---

## 3. Namespace surface

Everything below is exported from `require("spatial")`. Classes marked (three) are the vendored
three.js class, exported unchanged unless a note says otherwise. Classes marked (ours) are
SpatialScript classes. Members not listed are not part of the contract even if the vendored class
has them; consumers ignore them.

### 3.1 Math (three)

`Vector2`, `Vector3`, `Vector4`, `Quaternion`, `Euler`, `Matrix3`, `Matrix4`, `Color`, `Box3`,
`Sphere`, `Plane`, `Ray`, `MathUtils`, `Spherical`.

Full three.js API for these classes is in scope.

### 3.2 Scene graph (three)

`Object3D`, `Group`, `Scene`, `Mesh`.

Contract members on `Object3D`: `id`, `uuid`, `name`, `type`, `parent`, `children`, `visible`,
`userData`, `position`, `rotation`, `quaternion`, `scale`, `up`, `matrix`, `matrixWorld`,
`castShadow`, `receiveShadow`, `renderOrder`, `add`, `remove`, `removeFromParent`, `clear`,
`attach`, `traverse`, `traverseVisible`, `traverseAncestors`, `getObjectByName`, `getObjectById`,
`getObjectByProperty`, `lookAt`, `localToWorld`, `worldToLocal`, `getWorldPosition`,
`getWorldQuaternion`, `getWorldScale`, `getWorldDirection`, `applyMatrix4`, `applyQuaternion`,
`setRotationFromAxisAngle`, `setRotationFromEuler`, `setRotationFromQuaternion`, `rotateX`,
`rotateY`, `rotateZ`, `rotateOnAxis`, `rotateOnWorldAxis`, `translateX`, `translateY`,
`translateZ`, `translateOnAxis`, `updateMatrix`, `updateMatrixWorld`, `updateWorldMatrix`,
`clone`, `copy`, `addEventListener`, `hasEventListener`, `removeEventListener`, `dispatchEvent`.

Matrix rule: `applyMatrix4` and direct `matrix` writes are allowed. The core decomposes to
translate, rotate, scale. If the matrix contains shear (the three column vectors are not
orthogonal after removing scale, tolerance 1e-4), the flush diff does not throw. It records a
`SpatialUnsupportedError` message naming the object in `dump().errors`, reports it through the
error channel once per object until the object's matrix becomes valid again, skips that object's
`transform` command for the frame (the native side keeps the last valid transform), and continues
with every other object. The scene keeps running.

SpatialScript members added to `Object3D`:

- `opacity: number` default 1. Applies to the object and its descendants (OpacityComponent
  semantics). Consumer-side; does not touch material opacity.
- `billboard: boolean` default false. Object faces the viewer.
- `groundingShadow: boolean` default false. Mesh only. Unsupported on web: warn once.
- `hoverEffect: "highlight" | "lift" | "spotlight" | null` default null. visionOS only. macOS and
  web: accepted, no visual, no warning. Where the SDK has no lift style, RealityKit uses highlight
  and warns once.
- `renderOrder` (three.js) maps to `ModelSortGroupComponent` on visionOS; on macOS that component
  is unavailable, so it is accepted with a one-time warning.
- `manipulable: boolean` default false. Enables the system grab, move, rotate, and scale
  interaction (ManipulationComponent). Native-driven transform while active. Web: emulated with
  mouse drag that moves the object on the view plane. Emits `manipulationstart`, `manipulation`,
  `manipulationend` events.
- `rigidBody: RigidBody | null` default null. See 3.7.

`Mesh(geometry, material)`: `geometry`, `material` (a single material; arrays are not in scope and
throw on assignment).

`Scene`: a `Group` with `type === "Scene"`. `background`, `environment`, `fog` are not in scope
and throw on assignment.

Assigning a new `geometry` or `material` to a mesh after creation is supported and emits a new
GEOMETRY or MATERIAL command. Mutating material properties in place is detected by the diff.

### 3.3 Geometry (three)

`BufferGeometry`, `BufferAttribute`, `Float32BufferAttribute`, `BoxGeometry`, `SphereGeometry`,
`PlaneGeometry`, `CylinderGeometry`, `ConeGeometry`, `TorusGeometry`, `CapsuleGeometry`,
`CircleGeometry`, `RingGeometry`, `TextGeometry` (ours, see below).

All parametric geometries keep their three.js constructor signatures and `parameters` object.
`BufferGeometry` contract: `setAttribute("position" | "normal" | "uv", attr)`, `getAttribute`,
`setIndex`, `index`, `computeVertexNormals`, `computeBoundingBox`, `computeBoundingSphere`,
`boundingBox`, `boundingSphere`, `dispose`, `clone`.

`TextGeometry(text, { size = 0.1, depth = 0.01, font = "default" })` (ours). Produces a 3D text
mesh. The core generates vertices with the bundled default font so the web consumer renders it
and `computeBoundingBox` works. The RealityKit consumer uses native text generation from the
parameters and ignores the vertices. `font` other than `"default"` throws.

### 3.4 Materials (three, with a constrained contract)

`MeshBasicMaterial`, `MeshStandardMaterial`, `MeshPhysicalMaterial`, `OcclusionMaterial` (ours).

Contract properties, all with three.js defaults:

| Property | Basic | Standard | Physical | RealityKit mapping |
|---|---|---|---|---|
| `color: Color` | yes | yes | yes | baseColor tint |
| `map: Texture` | yes | yes | yes | baseColor texture |
| `opacity`, `transparent` | yes | yes | yes | blending .transparent(opacity) |
| `side` (`FrontSide`, `BackSide`, `DoubleSide`) | yes | yes | yes | faceCulling |
| `wireframe` | yes | yes | yes | unsupported, warn once |
| `emissive: Color`, `emissiveIntensity`, `emissiveMap` | | yes | yes | emissiveColor, emissiveIntensity |
| `metalness`, `metalnessMap` | | yes | yes | metallic |
| `roughness`, `roughnessMap` | | yes | yes | roughness |
| `normalMap` | | yes | yes | normal |
| `clearcoat`, `clearcoatRoughness` | | | yes | clearcoat, clearcoatRoughness |
| `depthWrite`, `depthTest` | yes | yes | yes | writesDepth, readsDepth |

`MeshBasicMaterial` maps to `UnlitMaterial`. `MeshStandardMaterial` and `MeshPhysicalMaterial`
map to `PhysicallyBasedMaterial`. `OcclusionMaterial()` maps to RealityKit `OcclusionMaterial`;
on web it renders as an invisible depth-only material (`colorWrite = false`).

Constants exported: `FrontSide`, `BackSide`, `DoubleSide`, `NormalBlending`, `AdditiveBlending`,
`RepeatWrapping`, `ClampToEdgeWrapping`, `MirroredRepeatWrapping`, `LoopOnce`, `LoopRepeat`,
`LoopPingPong`.

`blending`: `NormalBlending` supported everywhere. `AdditiveBlending` is supported on web and
unsupported in RealityKit (its material blending modes are opaque and transparent only): the
RealityKit consumer renders it as transparent and warns once.

### 3.5 Textures (ours, three-shaped)

`Texture`: `repeat: Vector2`, `offset: Vector2`, `wrapS`, `wrapT`, `flipY`, `needsUpdate`.
`TextureLoader().load(url, onLoad?, onProgress?, onError?)` returns a `Texture` immediately and
resolves asynchronously. `TextureLoader().loadAsync(url)` returns a Promise.

`url` forms: `https://...`, `file:///...`, a path relative to the script's asset root, or
`asset://name` for an asset bundled with the app. The shared asset root is
`SpatialScript/assets/`: the web consumer serves `asset://` from it, and the Mac and visionOS host
targets bundle its contents so the same `asset://name` resolves on every backend (examples and
conformance cases reference only names that exist there). On failure the consumer emits an `error` event on the texture and logs. The same
rules apply to `loadAsset` and `ImageBasedLight` URLs: the core normalizes every URL before it
reaches a consumer (`.` and `..` segments collapsed, a path that escapes the asset root refused,
schemes limited to http, https, file, data, blob, and asset, userinfo stripped), each refusal
warns naming the URL, and a refused asset rejects with an error while a refused environment is
ignored.

### 3.6 Lights (three)

`AmbientLight(color, intensity)`, `DirectionalLight(color, intensity)`,
`PointLight(color, intensity, distance, decay)`, `SpotLight(color, intensity, distance, angle,
penumbra, decay)`, `HemisphereLight` is not in scope.

`DirectionalLight.target` and `SpotLight.target` are `Object3D`s per three.js; the light points
from its world position toward the target's world position. The core sends the resolved world
direction in the LIGHT command so consumers never need the target object.

`castShadow` on directional and spot lights maps to `DirectionalLightComponent.Shadow` and
`SpotLightComponent.Shadow`. Point light shadows are unsupported, warn once.

Intensity units. three.js uses physically based units: candela for point and spot, lux for
directional, and a unitless multiplier for ambient. RealityKit uses lumens for point and spot
lights and lux for directional. Consumers convert:

- point and spot: `lumens = candela * 4 * PI`
- directional: `lux = intensity * 1000` (three.js scenes typically use 1..5 for the sun; RealityKit
  wants ~1000..10000 lux)
- ambient: maps to an image-based light with a uniform environment at `intensity` exponent. If the
  consumer cannot generate one, warn once and skip.

`ImageBasedLight(url, intensity = 1)` (ours): scene-level environment lighting. At most one; the
last set wins. Set through `Spatial.environment = new ImageBasedLight(...)` or `null`. Supported
formats: equirectangular `.hdr`, `.png`, and `.jpg` on both backends; `.exr` on RealityKit only
(web warns once). When both an explicit environment and an `AmbientLight` are present on
RealityKit, the explicit environment wins and the ambient intensity is ignored with a one-time
warning; removing the environment restores the ambient one.

### 3.7 Physics (ours)

```js
mesh.rigidBody = new Spatial.RigidBody({
  type: "dynamic" | "static" | "kinematic",   // default "dynamic"
  mass: 1,                                     // kg, dynamic only
  shape: "auto" | "box" | "sphere" | "capsule" | "convex" | "mesh",  // default "auto"
  friction: 0.5, restitution: 0.2,
  linearDamping: 0, angularDamping: 0,
  isTrigger: false,                            // trigger volumes emit collision events but do not push (see below)
  gravity: true,
});
```

`shape: "auto"` picks box for BoxGeometry, sphere for SphereGeometry, capsule for
CapsuleGeometry, convex for everything else. `"mesh"` is a static-only triangle mesh; using it on
a dynamic body throws.

`RigidBody` members: `applyImpulse(v: Vector3, atWorldPoint?: Vector3)`, `applyForce(v: Vector3)`,
`applyTorque(v: Vector3)`, `setLinearVelocity(v)`, `setAngularVelocity(v)`, `linearVelocity:
Vector3` (read-only, updated by sync), `angularVelocity: Vector3` (read-only), `isSleeping`
(read-only). Property assignment after creation (`body.mass = 2`) re-emits RIGIDBODY.

Dynamic bodies are native-driven: the consumer syncs their world transform into the core each
frame. Writing `position`, `quaternion`, or `scale` on a dynamic body's object from script
teleports it (the diff sees a change versus last synced state and emits TRANSFORM; consumers
treat TRANSFORM on a dynamic body as a teleport that also zeroes velocity). Kinematic and static
bodies are script-driven.

`Spatial.physics.gravity: Vector3` default `(0, -9.81, 0)`. Assignments and `.set` are detected.

Collision events on the object: `collisionstart`, `collisionend` with
`{ type, target, other, point: Vector3, normal: Vector3, impulse: number }`. Both objects receive
the event. Requires at least one of the pair to be a rigid body.

Triggers. A rigid body with `isTrigger: true` is never simulated: it has no mass, never falls,
never pushes, and follows its object's transform like a static or kinematic collider. Its `type`
is ignored. It emits `collisionstart` and `collisionend` for every body that overlaps it. Both
backends implement it as a collision-only volume (RealityKit: `CollisionComponent` with
`.trigger` mode and no physics body; web: a sensor collider on a kinematic body that tracks the
object transform).

Distance joints. `limits: [min, max]` is the allowed separation between the two anchors in
meters; `null` fixes the separation at its value when the joint is added. On web a positive
`min` is honored only where Rapier can express it; if it cannot, the consumer applies `max` as a
rope and warns once naming the joint.

Collision groups. Meshes without a `rigidBody` can still be hit tested and raycast, but they do
not collide with physics bodies. Implementations:

- RealityKit: collision shapes are built lazily. A mesh gets a `CollisionComponent` when it
  becomes an input target (first tap, hover, or drag listener), when it gets a `rigidBody`, or
  when the first `Spatial.raycast` runs (which materializes every mesh). Hit-test-only meshes use
  group `hitTest = 1 << 0` with mask `hitTest` (an empty mask makes RealityKit skip the shape for
  gesture targeting on macOS); bodies use group `physics = 1 << 1` with mask `physics`. Raycast
  and input use mask `.all`. This keeps 1500 moving meshes at 120 Hz; eager colliders cost about
  10 µs per moved entity per frame. The native dump lists `CollisionComponent` only where one
  exists.
- Web: Rapier colliders exist only for objects with a `rigidBody` or `isTrigger`; raycast uses
  three.js `Raycaster` over all visible meshes.

`Spatial.raycast(origin: Vector3, direction: Vector3, { maxDistance = Infinity, recursive = true }
= {})` returns `[{ object, point, normal, distance }]` sorted by distance, synchronously, at most
one hit per object, over visible meshes only. `recursive: false` limits hits to direct children of
the mounted scene. Both consumers and the core's fallback follow the same rules.

Joints:

```js
const joint = new Spatial.Joint({
  type: "fixed" | "revolute" | "spherical" | "prismatic" | "distance",
  bodyA: meshA, bodyB: meshB,                 // Object3Ds with rigidBody
  anchorA: new Vector3(), anchorB: new Vector3(),   // local offsets
  axis: new Vector3(0, 1, 0),                 // revolute, prismatic
  limits: [min, max] | null,                  // revolute (radians), prismatic (meters), distance
});
Spatial.physics.add(joint); Spatial.physics.remove(joint);
```

RealityKit maps to `PhysicsFixedJoint`, `PhysicsRevoluteJoint`, `PhysicsSphericalJoint`,
`PhysicsPrismaticJoint`, `PhysicsDistanceJoint` with `GeometricPin`s. Rapier maps to its fixed,
revolute, spherical, prismatic, and rope joints.

Physics parity is structural. Conformance checks that bodies, shapes, masses, joints, and events
exist and that a dropped body ends lower than it started and comes to rest on a static floor. It
does not compare trajectories.

### 3.8 Input and interaction (ours)

Events dispatched on `Object3D` through the three.js `EventDispatcher` API. Registering a
listener for any of the input events makes the object an input target (InputTargetComponent and
collision shape) automatically.

| Event | Payload fields (besides `type`, `target`) | macOS source | visionOS source | web source |
|---|---|---|---|---|
| `tap` | `point: Vector3` world | click | pinch | click |
| `hoverenter`, `hoverexit` | | mouse over | gaze | mouse over |
| `dragstart`, `drag`, `dragend` | `translation: Vector3` world delta since start, `point: Vector3` | mouse drag | pinch drag | mouse drag |
| `manipulationstart`, `manipulation`, `manipulationend` | | when `manipulable` | system | emulated |
| `collisionstart`, `collisionend` | see 3.7 | physics | physics | physics |

Events bubble: an event on a child dispatches to ancestors with the same payload and
`target` unchanged, stopping if a listener calls `e.stopPropagation()`. The `Scene` receives every
event last.

Drag semantics: `translation` is world-space displacement since `dragstart`. Scripts own the
object's position; the consumer never moves a dragged object. On macOS the consumer converts mouse
displacement to world displacement on the plane through the object's world position facing the
camera, so a 1:1 on-screen drag results.

Polled input, updated every frame before callbacks:

```js
Spatial.input.keyboard.isDown("KeyW")      // KeyboardEvent.code names
Spatial.input.keyboard.wasPressed("Space") // true for one frame
Spatial.input.mouse.position               // Vector2 in view pixels, or null when absent
Spatial.input.mouse.buttons                // { left, right, middle } booleans
Spatial.input.mouse.delta                  // Vector2 since last frame
Spatial.input.hands.left / .right          // Hand or null when unsupported
hand.isTracked, hand.isPinching
hand.joint("indexFingerTip")               // { position: Vector3, quaternion: Quaternion } world, or null
```

Joint names follow ARKit `HandSkeleton.JointName` in camelCase: `wrist`, `thumbTip`,
`thumbKnuckle`, `thumbIntermediateBase`, `thumbIntermediateTip`, `indexFingerTip`,
`indexFingerKnuckle`, `indexFingerMetacarpal`, `indexFingerIntermediateBase`,
`indexFingerIntermediateTip`, and the same pattern for `middleFinger`, `ringFinger`,
`littleFinger`, plus `forearmWrist`, `forearmArm`. On macOS and web `hands.left` and
`hands.right` are `null`.

`Spatial.inject.tap(objectOrName, point?)`, `Spatial.inject.drag(objectOrName, translation,
{ steps = 1 } = {})`, `Spatial.inject.hover(objectOrName, entering)`, `Spatial.inject.key(code,
down)`. These synthesize the same events the consumer would, for agent verification. They work in
every backend without real input.

### 3.9 Animation (three)

`AnimationClip`, `AnimationMixer`, `AnimationAction`, `KeyframeTrack`, `VectorKeyframeTrack`,
`QuaternionKeyframeTrack`, `NumberKeyframeTrack`, `ColorKeyframeTrack`, `AnimationUtils`.

Keyframe animation runs in the core with the real three.js mixer. Scripts call
`mixer.update(dt)` inside `onFrame` exactly as in three.js. Because the mixer writes to
`position`, `quaternion`, `scale`, `opacity`, and material properties of core objects, the diff
picks the changes up; consumers need no animation plumbing for clips.

Native asset animations are separate; see 3.12.

### 3.10 Particles (ours)

```js
const fx = new Spatial.ParticleEmitter({
  preset: null | "fireworks" | "impact" | "magic" | "rain" | "snow" | "sparks" | "smoke",
  shape: "point" | "sphere" | "box" | "cone" | "plane",   // default "point"
  shapeSize: new Vector3(0.1, 0.1, 0.1),
  birthRate: 100, lifetime: 1, lifetimeVariation: 0,
  speed: 1, speedVariation: 0,
  size: 0.01, sizeVariation: 0,
  color: 0xffffff, colorEnd: null, opacity: 1, opacityEnd: 0,
  spreadAngle: 0,                                     // radians, cone half-angle
  acceleration: new Vector3(0, -1, 0),
  isEmitting: true, burstCount: 0, loops: true,
  texture: null,
});
scene.add(fx); fx.burst(); fx.isEmitting = false;
```

`ParticleEmitter` is an `Object3D`. RealityKit maps to `ParticleEmitterComponent`; a preset
overrides other fields except `isEmitting`. Web implements a CPU point-sprite emitter that honors
every field except presets, which map to the nearest hand-tuned parameter set.

### 3.11 Anchoring and portals (ours)

```js
const anchor = new Spatial.Anchor("head");
const anchor = new Spatial.Anchor({ plane: "horizontal" | "vertical" | "any", minimumBounds: new Vector2(0.2, 0.2) });
const anchor = new Spatial.Anchor({ hand: "left" | "right", location: "palm" | "wrist" | "indexFingerTip" | "thumbTip" | "aboveHand" });
const anchor = new Spatial.Anchor({ image: "referenceImageName" });
const anchor = new Spatial.Anchor({ world: new Matrix4() });   // fixed world pose
anchor.addEventListener("anchored", e => {}); anchor.addEventListener("unanchored", e => {});
anchor.isAnchored
```

`Anchor` is a `Group`. RealityKit maps to `AnchorEntity`. On macOS the entity exists but never
anchors; `isAnchored` stays false. Web: a plain group at its own transform, `isAnchored` false.
Content under a head anchor on web is parented to the camera.

```js
const portal = new Spatial.Portal({ width: 0.5, height: 0.5, world: worldGroup, crossing: false });
scene.add(portal);   // portal is a Mesh with a PlaneGeometry; worldGroup is rendered inside it
```

`worldGroup` is a `Group` the script also adds to the scene; the consumer marks it as a world
(WorldComponent) so it renders only through the portal. If the world group is not in the mounted
scene the portal warns once and emits nothing until the group is added. `width` and `height` are
writable after construction and regenerate the portal plane. Web renders the world group to a render
target from a camera mirrored through the portal plane and maps it onto the portal mesh.
`crossing` is implemented on RealityKit only; web accepts it with a one-time warning. RealityKit
portals show the part of the world that lies behind the portal plane from the viewer, so author
world content behind the portal.

### 3.12 Assets (ours)

```js
const asset = await Spatial.loadAsset({ usdz: "asset://robot.usdz", glb: "https://.../robot.glb" });
scene.add(asset);
asset.animations               // string[] names discovered by the consumer
asset.playAnimation("walk", { loop: true, speed: 1 }); asset.stopAnimation();
asset.boundingBox              // Box3 reported by the consumer after load
```

`loadAsset` returns a Promise of a `Group`. The RealityKit consumer loads `usdz` or `reality`;
the web consumer loads `glb` or `gltf`. Each ignores the other's keys. If the key it needs is
missing, the promise rejects with `SpatialUnsupportedError`. Native animations are consumer-driven
and do not sync transforms back (they animate the asset's internal skeleton, not its root).

### 3.13 Runtime (ours)

- `Spatial.mount(scene)`, `Spatial.scene` (mounted scene or null), `Spatial.onFrame`,
  `Spatial.offFrame`, `Spatial.time` `{ delta, elapsed, frame }`.
- `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `requestAnimationFrame`,
  `cancelAnimationFrame` are installed as globals by the core, driven by frame ticks. `console`
  is installed with `log`, `warn`, `error`, `info`, `debug`; output goes to the consumer.
- `Spatial.env` `{ backend: "realitykit" | "three", platform: "macos" | "visionos" | "web",
  capabilities: { hands, anchors, portals, particles, manipulation, hoverEffect, shadows } }`.
  Capabilities are honest per platform: on RealityKit macOS `hands`, `anchors`, `manipulation`,
  and `hoverEffect` are false; on visionOS all are true; on web `hands`, `anchors`, `hoverEffect`
  are false, `manipulation` is true (emulated), `portals`, `particles`, `shadows` true.
- `Spatial.dump(options?)` returns the scene dump (section 8) as a plain object. `options`:
  `names: string[]` restricts `objects` to those names, `fields: string[]` restricts each object's
  keys, `compact: true` rounds numbers to four decimals and omits geometry parameters and
  userData, `objects: false` returns only the top-level fields. Hosts use these for cheap polling.
- `Spatial.limits` exposes the enforced caps (timers, animation frame callbacks, callbacks per
  tick, listeners per object per event, hierarchy depth, ids, errors kept, log message length).
- `Spatial.find(name)` is `scene.getObjectByName`.
- `Spatial.destroy(object)` frees `object` and its descendants. It emits `destroy` for the whole
  subtree with descendants before their ancestors, detaches `object` from its parent, releases the
  ids so `objectForId` no longer resolves them, and marks every object in the subtree as destroyed.
  A later `add()` (or `attach()`) of a destroyed object throws `SpatialUnsupportedError` with
  `feature` `"destroyed-object"`. Destroying the mounted scene throws. `scene.remove(object)` keeps
  three.js semantics and only detaches, which emits `parent id, -1`.
- `Spatial.physics`, `Spatial.input`, `Spatial.inject`, `Spatial.environment` as above.
- `SpatialUnsupportedError extends Error` with `feature` and `object` fields.
- `Spatial.version` string.

Errors thrown during load abort the script; the consumer reports the message with line and column
where JavaScriptCore or the browser provide them. Errors thrown inside `onFrame`, `update`, event
listeners, or timers are caught, reported with the same channel, and do not stop the scene. Each
unique message is reported at most once per second to avoid floods.

---

## 4. Scope by phase

Phase 1 (sections 2 and 3) is complete. Phase 2 (section 14) brings SpatialScript to parity with
every capability Apple's RealityKitScripting exposes, with honest per-backend behavior.

Permanently out of scope, on every backend: custom GLSL or Metal shaders (RealityKit only accepts
pre-authored shader graphs; see 14.6), post-processing, animation graphs and compute graphs,
synchronization (multi-user), reference components, `Scene.background`, `Scene.fog`, texture
compression formats. Names for these are not exported; a script that references them gets a
normal JavaScript `TypeError` for an undefined export.

---

## 5. Command protocol

The core produces an array of commands on every `tick`. A command is a JavaScript array whose
first element is an opcode string and whose second element is the target object id (an integer
the core assigns, starting at 1; 0 is the native root). Remaining elements are numbers, strings,
booleans, `null`, plain JSON objects, or typed arrays. Consumers apply commands in order.

| Opcode | Arguments | Notes |
|---|---|---|
| `create` | id, kind, name | kind: `group`, `mesh`, `ambientLight`, `directionalLight`, `pointLight`, `spotLight`, `particles`, `anchor`, `portal`, `asset`. A text label is a `mesh` whose geometry descriptor is `TextGeometry`. |
| `destroy` | id | Consumer removes the entity and every child. Children get their own `destroy` first. |
| `parent` | id, parentId | `parentId` 0 is the mounted scene root. `-1` detaches without destroying. |
| `name` | id, string | |
| `transform` | id, px, py, pz, qx, qy, qz, qw, sx, sy, sz | Local TRS for one object. Accepted by consumers, but the core emits `transforms` instead. On a dynamic body this is a teleport. |
| `transforms` | 0, Float32Array | All transform changes of the frame as packed records `[id, px, py, pz, qx, qy, qz, qw, sx, sy, sz]` (11 floats each; ids are exact in float32 below 2^24). Consumers read the array once through the typed-array bytes pointer. Semantics per record are identical to `transform`. The core reuses its buffer across frames, so consumers must copy what they need before returning. |
| `visible` | id, bool | |
| `geometry` | id, { type, parameters, uuid, revision }, positions: Float32Array or null, normals: Float32Array or null, uvs: Float32Array or null, indices: Uint32Array or null | `uuid` is the three.js geometry uuid, stable for the life of the geometry object and shared by every mesh using the same geometry instance; `revision` is an opaque token that changes on every mutation (the core encodes the geometry revision and the attribute versions in it; consumers compare it for equality only). Consumers cache native mesh resources by uuid and revision (and by a parameters hash for parametric types) so 1500 meshes sharing one geometry create one native mesh. For a parametric geometry the consumer has already received at that uuid and revision, the buffers are `null` and the consumer reuses its resource; a plain `BufferGeometry` always carries its buffers. | RealityKit uses native generators for `BoxGeometry`, `SphereGeometry`, `PlaneGeometry`, `CylinderGeometry`, `ConeGeometry`, `TextGeometry` and buffers otherwise. Web always uses the buffers, including for TextGeometry. |
| `material` | id, { type, uuid, color:[r,g,b], opacity, transparent, side, wireframe, metalness, roughness, emissive:[r,g,b], emissiveIntensity, clearcoat, clearcoatRoughness, depthWrite, depthTest, blending, maps: { map, normalMap, roughnessMap, metalnessMap, emissiveMap } as texture ids or null } | Full material state every time; consumers replace. `uuid` identifies the material instance so consumers may share native materials between meshes and must update every user when a shared material changes. |
| `texture` | textureId, { url, repeat:[x,y], offset:[x,y], wrapS, wrapT, flipY } or null | Emitted before any material that references it. Re-emitted on property change. `null` releases the texture: the consumer frees the native resource, drops the id, and ignores any in-flight load for it; the core emits it from `Texture.dispose()` once no material references the texture. |
| `light` | id, { type, color:[r,g,b], intensity, distance, decay, angle, penumbra, castShadow, direction:[x,y,z] world or null } | Full state. |
| `shadow` | id, castShadow, receiveShadow | Meshes. |
| `opacity` | id, value | |
| `billboard` | id, bool | |
| `groundingShadow` | id, bool | |
| `hoverEffect` | id, string or null | |
| `manipulable` | id, bool | |
| `renderOrder` | id, int | |
| `interactive` | id, { tap, hover, drag, manipulation, collision } booleans | Emitted when the first listener of a type is added or the last removed. Consumers make the object an input target and build its collider for `tap`, `hover`, and `drag`; `manipulation` and `collision` are informational. |
| `rigidBody` | id, body JSON or null | Full state or removal. The JSON carries the options of 3.7 with `shape` resolved (never `"auto"`) and `requestedShape` holding the authored value. |
| `bodyImpulse` | id, x, y, z, px, py, pz or nulls | |
| `bodyForce` | id, x, y, z | |
| `bodyTorque` | id, x, y, z | |
| `bodyVelocity` | id, lx, ly, lz or nulls, ax, ay, az or nulls | Set. |
| `joint` | jointId, joint JSON with bodyA, bodyB ids, or null | |
| `gravity` | 0, x, y, z | |
| `particles` | id, emitter JSON | Full state. |
| `particlesBurst` | id | |
| `anchor` | id, anchor JSON | |
| `portal` | id, { worldId, width, height, crossing } | |
| `world` | id, bool | Marks a group as a portal world. |
| `asset` | id, { usdz, reality, glb, gltf } | Consumer loads asynchronously and calls `dispatch("assetLoaded", id, { animations, boundingBox })` or `dispatch("assetError", id, { message })`. |
| `assetAnimation` | id, name or null, loop, speed | null stops. |
| `environment` | 0, { url, intensity } or null | Image-based light. |
| `log` | 0, level, message | Console output. |

Ordering guarantees the core provides: `create` precedes any other command for that id;
`texture` precedes a `material` referencing it; `geometry` and `material` precede `rigidBody`;
`world` precedes `portal`; children's `create` precede their `parent` command; `destroy` for
descendants precede the ancestor's `destroy`.

Typed arrays cross the JavaScriptCore boundary as `JSValue`s. The Swift consumer must read them
through `JSObjectGetTypedArrayBytesPtr`, not element by element.

---

## 6. Sync and event protocol (consumer to core)

Before each `tick`, the consumer may call:

- `sync(Float32Array)`: a flat array of `[id, px, py, pz, qx, qy, qz, qw, sx, sy, sz]` records in
  world space for native-driven objects (dynamic bodies, objects under manipulation, anchors that
  moved). The core converts to local space against the parent's world matrix, writes the TRS, and
  records the value as last-flushed so no echo TRANSFORM is emitted.
- `syncBodies(Float32Array)`: `[id, lvx, lvy, lvz, avx, avy, avz, sleeping]` records.
- `dispatch(type, id, payload)`: queues an event. `type` is one of the events in 3.8, plus
  `anchored`, `unanchored`, `assetLoaded`, `assetError`, `textureLoaded`, `textureError`.
  Payload vectors are `[x, y, z]` arrays; the core wraps them in `Vector3`s.
- `setInput({ keyboard: { down: string[], pressed: string[] }, mouse: { position: [x, y] or null,
  buttons: [l, r, m], delta: [dx, dy] }, hands: { left: HandJSON or null, right: HandJSON or null } })`.
  `HandJSON` is `{ isTracked, isPinching, joints: { name: [px, py, pz, qx, qy, qz, qw] } }`.

Native functions the consumer must install before `load`:

- `__spatialNative.raycast(ox, oy, oz, dx, dy, dz, maxDistance, recursive)` returns a flat array
  of `[id, px, py, pz, nx, ny, nz, distance]` records sorted by distance, at most one per object,
  over visible meshes only. `maxDistance` below zero means unbounded. `recursive` false limits
  hits to direct children of the mounted scene.
- `__spatialNative.log(level, message)`.
- `__spatialNative.now()` returns milliseconds.

---

## 7. Core entry points

`core/dist/spatial-core.js` is an IIFE that defines `globalThis.__spatial` with:

- `load(source, { backend, platform, capabilities, assetRoot })`: evaluates the script. Throws a
  `SpatialLoadError` with `message`, `line`, `column` when available.
- `tick(deltaTime)`: runs the frame order in section 2 and returns the command array.
- `sync(records)`, `syncBodies(records)`, `dispatch(type, id, payload)`, `setInput(state)`.
- `dump()`: section 8.
- `dispose()`: runs teardown and returns the final command array (destroys).
- `objectForId(id)`, `idForObject(object)`.

The script's `require("spatial")` and the `Spatial` global are bound inside `load`.

---

## 8. Dump format

```json
{
  "backend": "realitykit", "platform": "macos", "frame": 120, "elapsed": 2.0,
  "loadGeneration": 1, "droppedErrors": 0,
  "scene": { "name": "", "userData": {} },
  "objects": [
    {
      "id": 3, "name": "cube", "type": "Mesh", "parent": 1, "visible": true,
      "position": [x, y, z], "quaternion": [x, y, z, w], "scale": [x, y, z],
      "worldPosition": [x, y, z],
      "geometry": { "type": "BoxGeometry", "parameters": { "width": 0.2, "height": 0.2, "depth": 0.2 } },
      "material": { "type": "MeshStandardMaterial", "color": [r, g, b], "metalness": 0, "roughness": 1, "opacity": 1 },
      "light": null, "rigidBody": null, "opacity": 1, "billboard": false,
      "groundingShadow": false, "hoverEffect": null, "manipulable": false,
      "castShadow": false, "receiveShadow": false, "renderOrder": 0, "world": false,
      "interactive": { "tap": true, "hover": false, "drag": false },
      "velocity": [0, 0, 0], "isSleeping": true,
      "userData": {}
    }
  ],
  "joints": [{ "id": 10, "type": "revolute", "bodyA": 8, "bodyB": 9 }],
  "gravity": [0, -9.81, 0], "environment": null,
  "warnings": ["MeshStandardMaterial.wireframe is unsupported in RealityKit"],
  "errors": []
}
```

Objects of other kinds carry their own fields in addition: `particles` (emitter state),
`anchor` and `isAnchored`, `portal`, and for assets `asset`, `animations`, and `loaded`.
`velocity` and `isSleeping` are present only on objects with a rigid body and reflect the last
`syncBodies` from the consumer.

`Spatial.dump()` in the core produces this from the core scene. The Swift consumer additionally
exposes `nativeDump()` producing the same shape from RealityKit entities (transform, hierarchy,
component presence, material type and color). Conformance compares both.

---

## 9. Conformance suite

`conformance/cases/<name>.js` is a script. `conformance/cases/<name>.expected.json` is a subset
of the dump that must match after `frames` ticks (default 3, at 1/60 s) plus any `inject` steps
listed in an optional `<name>.steps.json` (`[{ "inject": "tap", "target": "cube" }, { "frames": 60 }]`).

Matching rules: every key in expected must exist in actual with an equal value; numbers match
within 1e-3; arrays match element-wise; objects in `objects` are matched by `name`. Keys absent
from expected are unconstrained. `warnings` in expected must each appear as a substring of some
actual warning.

Runners:

- `conformance/run-node.mjs`: runs the core in Node with a recording consumer (no rendering).
  Fast structural check for the core itself.
- `web/harness/run.mjs`: runs each case in headless Chromium through Playwright, compares the
  dump, and writes a screenshot per case to `web/harness/out/<name>.png`.
- Swift: `RealityKitScriptingPackageTests` loads every case from the repository path, runs it
  through `JavaScriptScene`, ticks, compares both `dump()` and `nativeDump()` against expected.

A case fails in any runner if it throws, if the dump does not match, or if `errors` is non-empty
unless expected lists the error.

---

## 10. Repository layout

```
./
  SpatialScript/
    SPEC.md                       this document
    package.json                  pnpm workspace root
    pnpm-workspace.yaml
    types/spatial.d.ts            TypeScript declarations for scripts (the agent-facing contract)
    core/                         shared runtime, ESM sources, esbuild to dist/spatial-core.js
      src/
      dist/spatial-core.js        committed build artifact
      test/                       node unit tests
      scripts/sync-to-swift.sh    copies dist into the Swift package resources
    web/                          three.js consumer, dev page, Playwright harness
      src/
      harness/
    conformance/
      cases/
      run-node.mjs
      match.mjs                   shared subset matcher used by node and web runners
    examples/                     demo scripts used by the macOS host and by verification
  Packages/RealityKitScripting/   Swift package: JavaScriptCore host and RealityKit consumer
    Sources/RealityKitScripting/
      Resources/spatial-core.js   copy of the core bundle
    Tests/
```

---

## 11. Dev transport (DEBUG builds only)

The macOS host starts an HTTP server on `127.0.0.1:8787` inside `#if DEBUG`. Routes:

- `POST /script` body is JavaScript; the app replaces the scene's script. Response is
  `{ ok, error: { message, line, column } | null }`.
- `GET /dump` returns `Spatial.dump()`; `GET /native-dump` returns the RealityKit dump.
- `GET /logs` returns console and error lines since the last call.
- `POST /inject` body `{ "type": "tap" | "drag" | "hover" | "key", ... }` mirrors `Spatial.inject`.
- `GET /health`.
- `GET /stats` returns the last 120 frames' core tick time, command apply time, command count,
  frame interval, native entity count, the last push-to-first-frame time, and resource cache
  counters.
- `POST /parity` body `{ "source": "<script>", "dt": 0.0166, "steps": [ { "frames": N } |
  { "inject": ... } ] }` (steps in the conformance format, section 9). The app loads the script,
  then runs the plan deterministically: every tick uses exactly `dt`, one tick per display frame,
  and each inject is applied at the exact frame the plan reaches it. When the plan completes the
  app stops ticking and holds the final frame until the next `/script` or `/parity`, so a window
  capture matches the returned state. Response: `{ ok, error, dump, nativeDump, console:
  [{ level, message }], frames }`. This is the Mac side of the cross-backend parity gate in
  `SpatialScript/parity`, whose web side is `web/harness/parity.mjs` with the same plan.

`examples/push.sh <file.js>` posts a script. Screenshots are taken from outside the app with
`screencapture -l <windowID>`. Release builds compile none of this.

---

## 12. Implementation rules

- Swift 6 language mode, strict concurrency. Every RealityKit and JavaScriptCore access is
  `@MainActor`. No `defer` in async functions. New Swift files carry the file header with
  `Shane Liu` as author.
- No tool or assistant attribution anywhere in code, comments, tests, sample data, or commit messages.
- The three.js bundle in the core is built from the npm `three` package with esbuild, tree-shaken
  to the exports in section 3. The LICENSE for three.js is reproduced in `core/THIRD_PARTY.md`.
- The core must not reference `window`, `document`, `self`, `navigator`, `fetch`, or `Image` at
  load time or during `tick`. A Node test asserts that the bundle evaluates in a bare VM context
  with only `globalThis` and `__spatialNative` present.
- Consumers must apply a `tick` of 2000 objects with transform changes within 8 ms on this
  machine. A benchmark test in each consumer asserts this, and the benchmark must go through the
  real engine boundary (JavaScriptCore values or the browser), not native arrays.
- End-to-end targets on this machine for the RealityKit consumer, measured in the macOS host:
  1500 independently moving meshes that share one geometry render at 60 frames per second or
  better, a scene of 1500 meshes loads in under one second from script push to first frame, and
  memory returns to within 10 percent of baseline after the scene is replaced. The macOS host's
  DEBUG dev server exposes `GET /stats` with the last 120 frames' core tick time, command apply
  time, command count, frame interval, and native entity count so these can be measured.
- Unsupported behavior warns once per feature per scene through `console.warn` and appears in
  `dump().warnings`. Nothing silently no-ops.
- Every public behavior in sections 2, 3, 5, 6, 8 has at least one conformance case or unit test.

---

## 14. Phase 2: parity with Apple RealityKitScripting

Every item below is part of the contract on both backends. "RealityKit only" means the web
consumer accepts the API, keeps the state in the dump, and warns once that it has no visual or
audible effect; "visionOS only" means the same for RealityKit on macOS. Nothing here is silent.

### 14.1 Audio (ours, three.js-shaped)

- `Spatial.audio` is the listener and mixer: `masterVolume` (0..1), `setGroupVolume(name,
  volume)`, `groups` (read-only names), `resume()` (web needs a user gesture to start audio; the
  harness calls it), `state: "running" | "suspended"`. `state` starts `"suspended"` on every
  backend; `resume()` sets it to `"running"` optimistically and the consumer's `audioState`
  dispatch is authoritative afterwards.
- `AudioLoader().load(url, onLoad?, onProgress?, onError?)` and `loadAsync(url)` return an
  `AudioBuffer` handle (opaque, URL-backed; consumers load the file). URL rules of 3.5 apply.
- `Audio` (non-spatial, three.js name): `setBuffer(buffer)`, `play()`, `pause()`, `stop()`,
  `setLoop(bool)`, `setVolume(0..1)`, `setPlaybackRate(rate)`, `isPlaying`, `currentTime`,
  `duration` (after load), `group` (mix group name, default `"master"`), `onEnded` callback and an
  `ended` event. RealityKit: `ChannelAudioComponent` with an `AudioPlaybackController`.
- `PositionalAudio` extends `Audio` and is an `Object3D`: `setRefDistance(m)`,
  `setRolloffFactor(f)`, `setDistanceModel("inverse" | "linear" | "exponential")`,
  `setDirectionalCone(innerAngle, outerAngle, outerGain)`, `reverbLevel` (dB, RealityKit
  `SpatialAudioComponent.reverbLevel`; web maps to a convolver send level). RealityKit:
  `SpatialAudioComponent` on the object's entity, gain from volume in dB, directivity from the
  cone.
- `AmbientAudio` (ours): an `Object3D` whose sound comes from every direction at its position
  (RealityKit `AmbientAudioComponent`; web: a non-spatial `Audio` scaled by distance).
- Playback state is native-driven: consumers sync `isPlaying`, `currentTime`, and `duration`
  through a `syncAudio` channel (section 14.13) and dispatch `ended`. Consumers dispatch
  `audioState` with `"running"` once their engine has started (RealityKit on the first play).
- Release: `audio.dispose()` (or `Spatial.destroy(audio)`) stops the sound, emits `audio id null`,
  and frees the object; a playback call on a destroyed sound is dropped with a warning and never
  resurrects it. `setRefDistance` maps to RealityKit's rolloff distance where the engine has one and
  is otherwise dump-only with a one-time warning.
- Dump: each audio object reports `audio: { url, playing, loop, volume, rate, currentTime,
  duration, group, spatial, refDistance, rolloff, cone, reverbLevel }`.

### 14.2 Video (ours)

`VideoScreen({ url, width, height, loop = false, muted = false, autoplay = false, docking =
false })` is an `Object3D` that renders the video on a plane of the given size. `url` is a string
or `{ mp4, hls, webm }`: the core forwards every key that survives URL containment and the
consumer picks what it can play (RealityKit `mp4` then `hls`; the web `webm` then `mp4` where the
browser has the codec). The core dispatches `error` when no url was given or none survived
containment; the consumer dispatches `error` when none of the surviving keys is playable (if only one of
width and height is given, the other follows the video's aspect once known). Members: `play()`,
`pause()`, `currentTime` (settable), `duration`, `isPlaying`, `volume`, `muted`, `loop`,
`playbackRate`; events `loaded`, `ended`, `error`. RealityKit: `VideoPlayerComponent` with an
`AVPlayer`; `docking: true` adds `DockingRegionComponent` (visionOS only). Web: a `VideoTexture`
on a plane. Playback state is native-driven through `syncVideo`. URL rules of 3.5 apply. A
`VideoScreen` is a mesh for hit testing and raycast.

### 14.3 Cameras (three, non-visionOS)

`PerspectiveCamera(fov, aspect, near, far)` and `OrthographicCamera(left, right, top, bottom,
near, far)` are the three.js classes. `Spatial.camera` (settable) selects the active camera; it is
an `Object3D` the script can move, parent, and `lookAt` with. Default: the consumer's built-in
camera (the Mac RealityView virtual camera at (0, 0.25, 1.4) looking at the origin with a 60
degree vertical field of view; the web preset that mirrors it). On visionOS the user is the
camera: assigning `Spatial.camera` is accepted, kept in the dump, and warns once. `aspect` is
managed by the consumer from the viewport; a script-set value is ignored with a warning. For an
`OrthographicCamera` the visible height is `top - bottom` and the visible width follows the
viewport aspect on both backends (RealityKit's orthographic camera takes only a height); `left`
and `right` are honored when they match that width and otherwise warn once. Images never
stretch anisotropically.
Consumers emit `camera` commands with the camera's kind, parameters, and world transform.

Pointer queries: `Spatial.input.mouse.scenePosition` is the world point under the pointer on the
first hit mesh (or on the plane through the origin facing the camera when nothing is hit), or
null; `Spatial.rayFromPoint(x, y)` returns `{ origin, direction }` in world space for a view pixel
(null on visionOS).

### 14.4 Character controller and force effects (ours)

- `object.characterController = new CharacterController({ radius = 0.2, height = 1, slopeLimit =
  0.785, stepLimit = 0.3, gravity = true })`. Members: `move(displacement: Vector3)` (applied next
  frame, sliding along obstacles), `teleport(position)`, `isOnGround` (native-driven),
  `velocity` (read-only). The object becomes native-driven like a dynamic body. RealityKit:
  `CharacterControllerComponent` and `moveCharacter`; web: Rapier's kinematic character
  controller.
- Force effects are `Object3D`s: `ConstantForceField({ force: Vector3, mask })`,
  `RadialForceField({ strength, minimumDistance, falloff: "none" | "linear" | "inverseSquare",
  radius })`, `VortexForceField({ strength, axis, radius })`, `DragForceField({ coefficient,
  radius })`, `TurbulenceForceField({ strength, noiseScale, radius })`. They act on dynamic
  bodies within `radius` of the effect's world position (RealityKit `ForceEffectComponent` with
  the matching effect; web: a per-frame force loop in the physics step). `enabled` toggles.

### 14.5 Skeletons and blend shapes on loaded assets (ours)

After `loadAsset` resolves, `asset.skeleton` is `{ joints: string[], getJointTransform(name):
{ position, quaternion } | null, setJointRotation(name, quaternion), setJointPosition(name,
position), reset() }` (RealityKit `SkeletalPosesComponent`; web: the SkinnedMesh bones) and
`asset.blendShapes` is `{ names: string[], get(name), set(name, weight 0..1) }` (RealityKit
`BlendShapeWeightsComponent`; web: `morphTargetInfluences`). Both are null when the asset has no
skeleton or blend shapes. Joint edits are script-driven and emitted as `skeleton` and
`blendShapes` commands; playing a native animation on the asset overrides script poses while it
runs, and the consumer reports joint transforms through `syncSkeleton` when requested with
`asset.skeleton.track(true)`.

### 14.6 Shader graph materials (RealityKit, with a web fallback)

`ShaderGraphMaterial({ source: "asset://materials.usda", name: "Glow", parameters: { ... },
fallback: new MeshStandardMaterial({ ... }) })`. RealityKit loads the named material from the
bundled USD file and exposes `setParameter(name, value)` for numbers, vectors, colors, and
textures. Web renders `fallback` (required) and warns once; `setParameter` updates the fallback
where a same-named property exists. The dump reports `material.type: "ShaderGraphMaterial"` with
`source`, `name`, and the parameters.

### 14.7 Scene understanding (visionOS only)

`Spatial.sceneUnderstanding = { collision: false, occlusion: false, physics: false, shadows:
false }`. Setting any flag adds `SceneUnderstandingComponent` with those options to the root on
visionOS; macOS and web keep the state and warn once. Raycasts against the real-world mesh report
`object === null` with `sceneUnderstanding: true` on the hit.

### 14.8 Game controllers (ours, Apple-shaped)

`Spatial.input.controllers`: `all` (array), `current` (the most recently used, by latest input
change, or null), `connected` (count), events `controllerconnected` and `controllerdisconnected`
on the scene with `{ controller }` in the payload.
Each controller: `id`, `name`, `leftThumbstick: Vector2`, `rightThumbstick: Vector2`,
`leftTrigger`, `rightTrigger` (0..1), `leftShoulder`, `rightShoulder`, `a`, `b`, `x`, `y`,
`dpadUp`, `dpadDown`, `dpadLeft`, `dpadRight`, `menu`, `options` each `{ down, pressed,
released, value }`, and `rumble(intensity, duration)` where supported. RealityKit:
GameController framework on macOS and visionOS; web: the Gamepad API. Consumers push state
through `setInput` under `controllers`. `ScriptingRuntime.setup(inputOptions:)` is honored:
omitting `.gamepad` or `.ar` skips that provider and the corresponding capability is false.

### 14.9 Input completeness

`Spatial.input.keyboard.connected`, `mouse.connected`, per-button edges `mouse.left.pressed`,
`mouse.left.released`, `mouse.left.down`, `mouse.left.pressCount` (clicks within 400 ms), and the
same for `right` and `middle`; `mouse.scroll: Vector2` per frame. Existing fields stay.

### 14.10 Lifecycle and host events

- `this.didActivate()` and `this.willDeactivate()` run when the consumer activates or deactivates
  the scene: the view appears or disappears, the window is hidden or miniaturized, or the
  immersive space closes. Losing frontmost status alone never deactivates (development tooling
  drives the app from other processes). `Spatial.isActive` reflects it and ticks pause while
  inactive (timers do not advance). While inactive, consumer queues (dispatch and every sync
  channel) are bounded: the latest sync record per object is kept and events beyond 1000 are
  dropped with a recorded warning.
- Hot reload with state: `POST /script` accepts `{ "source": ..., "preserveState": true }` (or the
  raw body as before). Before the old script is disposed the consumer reads
  `this.state` (a JSON-serializable object the script maintains); the new script receives it in
  `this.scriptChanged(previousState)` after load and before its first frame. Without
  `preserveState` the hook is not called.
- Host events. `Spatial.host.on(name, handler)`, `off`, and `Spatial.host.send(name, payload)`
  form a bidirectional channel with the embedding app: the Swift host exposes
  `JavaScriptScene.send(name:payload:)` and `onHostEvent` (and `ScriptingRuntime.on(name)` at
  the runtime level); the web page exposes `window.spatialHost.send(name, payload)` and
  `window.spatialHost.on(name, handler)`. Payloads are JSON. `this.on(name, handler)` is an alias
  for `Spatial.host.on`. The dev server exposes `POST /event` `{ name, payload }` and `GET /events`
  (drains script-sent events) so an agent can drive and observe the channel.
- Host functions. Apps register native functions: Swift `ScriptingRuntime.register(module:
  "MyApp", function: "save") { args in ... }` (sync or async, JSON in and out); web
  `window.spatialHost.register("MyApp", "save", fn)`. Scripts call
  `await Spatial.host.call("MyApp.save", args)`; an unknown function rejects with
  `SpatialUnsupportedError` (feature "host-function"). `Spatial.host.functions` lists what is
  registered and is read at call time, so functions registered after load are callable. A host
  error result rejects with a `SpatialUnsupportedError` whose message is
  `Module.function: <message>`. This is the equivalent of Apple's module functions and type
  schemas.

### 14.11 Small components

- `object.accessibility = { label, value, hint, isButton }`: RealityKit `AccessibilityComponent`;
  web mirrors it onto an offscreen DOM element per object with `aria-label`. Dump reports it.
- `Spatial.render.adaptiveResolution: boolean` (visionOS only, warns elsewhere).
- `Spatial.environmentLighting.intensityExponent: number` (visionOS
  `EnvironmentLightingConfigurationComponent`; macOS and web scale the ambient environment).
- `Spatial.debug.modelView: null | "normal" | "uv" | "baseColor" | "roughness" | "metallic" |
  "occlusion" | "emissive"` (RealityKit `ModelDebugOptionsComponent`; web substitutes a debug
  material where three.js has one, normal and uv, and warns for the rest).
- `Spatial.fetchText(url)` and `Spatial.fetchJSON(url)` return promises (URL rules of 3.5; the
  consumer performs the fetch and rejects on failure). This covers what Apple's `Foundation`
  module is used for in scripts.

### 14.12 Multiple materials per mesh (three)

`Mesh(geometry, materials[])` with `geometry.groups` selects a material per index range, as in
three.js. RealityKit receives one `ModelComponent` with a material per mesh part; the core emits
`material` with an array payload when a mesh carries several. `mesh.material` remains a single
material for the common case. Fewer materials than the groups ask for is a one-time warning and
the last material repeats; more materials than groups warns and the extras are ignored.

### 14.13 Protocol additions

New opcodes, all following the section 5 conventions:

| Opcode | Arguments |
|---|---|
| `audio` | id, { url, spatial, ambient, loop, volume, rate, group, refDistance, rolloff, distanceModel, cone:[inner, outer, gain] or null, reverbLevel } or null |
| `audioControl` | id, "play" \| "pause" \| "stop" \| "seek", value or null |
| `audioMixer` | 0, { masterVolume, groups: { name: volume }, state: "running" \| "suspended" } | The consumer reports the real engine state with `dispatch("audioState", 0, { state })`. |
| `video` | id, { url: string \| { mp4?, hls?, webm? } \| null, width, height, loop, muted, autoplay, docking, volume, rate } or null | Consumers pick the encoding they can play; a null url means every source was refused and the core has already dispatched `error`. |
| `videoControl` | id, "play" \| "pause" \| "seek", value or null |
| `camera` | cameraId, { kind: "perspective" \| "orthographic" \| null, fov, near, far, left, right, top, bottom } | `cameraId` is the camera object's id (it is an `Object3D` in the graph, or an extra root when not added), so its transform arrives through `transforms` like any object and the consumer attaches the camera component to that entity. `["camera", 0, { kind: null }]` restores the consumer's built-in camera. |
| `characterController` | id, { radius, height, slopeLimit, stepLimit, gravity } or null |
| `characterMove` | id, dx, dy, dz |
| `characterTeleport` | id, x, y, z |
| `forceField` | id, { kind, enabled, radius, mask, ...per kind } or null | `kind` is the class name; per-kind fields are `force`, or `strength` with `minimumDistance` and `falloff`, or `strength` with `axis`, or `coefficient`, or `strength` with `noiseScale`. |
| `skeleton` | id, { joints: { name: [px, py, pz, qx, qy, qz, qw] } , track } | Retraction is the empty payload `{ joints: {}, track: false }`. |
| `blendShapes` | id, { name: weight } | Retraction is `{}`. |
| `shaderParameter` | id, name, value, materialIndex | `materialIndex` is 0 for a single material and the array index for a shader graph inside a material array. |
| `sceneUnderstanding` | 0, { collision, occlusion, physics, shadows } |
| `accessibility` | id, JSON or null | Clearing the last phase 2 feature on an object always emits its retraction (`null` for audio, video, characterController, forceField, accessibility). |
| `renderOptions` | 0, { adaptiveResolution, environmentIntensityExponent, debugModelView } |
| `hostEvent` | 0, name, payloadJSON | script to host |
| `hostCall` | callId, name, argsJSON | script to host; the host answers with `dispatch("hostResult", callId, { value } or { error })` |
| `fetch` | requestId, { url, kind: "text" \| "json" } | the host answers with `dispatch("fetchResult", requestId, { text } or { json } or { error })` |
| `controllerRumble` | 0, controllerId, intensity, duration | second element is not an object id, like `hostEvent`, `hostCall`, and `fetch` |

Payload details fixed by the core: a shader graph `material` payload is `{ type: "ShaderGraphMaterial", uuid, source, name, parameters, fallback, generation }` where `generation` increments on every `setParameter`; `shaderParameter` values are numbers, booleans, short strings, arrays of two to four floats, or texture ids. The `geometry` descriptor gains `groups: [{ start, count, materialIndex }] | null`. `setInput.controllers` is an array of `{ id?, name?, leftThumbstick?: [x, y], rightThumbstick?: [x, y], leftTrigger?, rightTrigger?, buttons?: { a, b, x, y, leftShoulder, rightShoulder, dpadUp, dpadDown, dpadLeft, dpadRight, menu, options: boolean | number }, current? }` with every field optional (a missing id defaults to `controller-<slot>`); the core computes pressed and released edges. `setInput.mouse` gains `scenePosition: [x, y, z] | null`, `scroll: [dx, dy]`, `connected`; `setInput.keyboard` gains `connected`. Event payloads: video `loaded` is `{ width, height, duration }`, video `error` is `{ message }`, `hostResult` is `{ value } | { error }`, `assetLoaded` gains `joints: string[]` and `blendShapes: string[]`. A raycast record with id 0 is the real-world mesh and yields `{ object: null, sceneUnderstanding: true }`; every hit carries a `sceneUnderstanding` boolean. `Spatial.camera` is null until a script assigns one, meaning the consumer's built-in camera, and no `camera` command is emitted until then. `Audio` objects are Object3Ds created with kind `group`; their dump `type` is the class name. Extra roots (an `Audio`, camera, or asset group the script never added to the scene) are parented to the native root (`parent id 0`) so consumers can attach components to a live entity. Imperative commands (impulses, forces, character moves, bursts, asset animation) issued before the object's first flush are deferred to the frame after its creation, not dropped.

Dump additions: top-level `isActive`, `audioMixer`, `camera`, `sceneUnderstanding`, `render`, `environmentLighting`, `debug`, `hostFunctions`, `controllers`; per object `audio`, `video`, `characterController` with `isOnGround`, `forceField`, `accessibility`, `skeleton`, `blendShapes`.

New consumer-to-core entry points: `syncAudio(records)` `[id, playing, currentTime, duration]`,
`syncVideo(records)` the same shape, `syncSkeleton(id, joints)`, `syncCharacter(records)` `[id,
px, py, pz, isOnGround, vx, vy, vz]`, `setActive(bool)`, `hostEvent(name, payload)`, and the
`controllers` member of `setInput`. The `material` command may carry an array payload (14.12).
`dispatch` accepts the new event types `ended`, `loaded`, `controllerconnected`,
`controllerdisconnected`, `hostResult`, `fetchResult`, `audioState`. Additional entry points:
`setHostFunctions(names)` (also accepted as a `hostFunctions` load option and preserved across a
reload) and `captureState()`; `load(source, env, { previousState })` delivers state to
`scriptChanged`. Conformance step kinds: `syncAudio`, `syncVideo`, `syncCharacter`,
`syncSkeleton`, `setActive`, `hostEvent`, `hostFunctions`, `inject: "controller"`, and `dispatch`
by `call` or `fetch` id or with no target.

### 14.13a Parity plans and live input

While a `POST /parity` plan runs, the Mac consumer feeds the core only injected input; live
keyboard, mouse, and controller state are excluded so a plan is deterministic. Release builds do
not bundle the examples, scenarios, or conformance cases; only `SpatialScript/assets` ships.

### 14.14 Capabilities and verification

`Spatial.env.capabilities` gains `audio`, `video`, `camera`, `characterController`,
`forceFields`, `skeleton`, `blendShapes`, `shaderGraph`, `sceneUnderstanding`, `controllers`,
`hostFunctions`, `accessibility`. Each is true only where the consumer implements the feature
with effect.

Verification on macOS: audio and video are verified through the native dump and the sync
channels (an `AudioComponent` present, `isPlaying` true, `currentTime` advancing), through the
macOS host's window capture for video frames on the plane, and through the browser harness where
Chromium runs with a fake audio device. Controllers are verified with injected controller state
(`Spatial.inject.controller(state)`) since no hardware is attached. Cameras are verified by
projecting a known point on both backends. Everything else follows the phase 1 gates:
conformance cases for every member above, the parity gate, and the three adversarial reviews.
