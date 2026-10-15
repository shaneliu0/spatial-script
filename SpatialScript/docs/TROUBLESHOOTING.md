# SpatialScript troubleshooting

Symptom → cause → fix. Start at the symptom you can see; each entry ends with
the check that confirms the diagnosis.

The three commands worth reaching for first, with the macOS host running a DEBUG
build:

```
curl -s 'http://127.0.0.1:8787/dump?objects=0' | jq '{frame, errors, droppedErrors, warnings}'
curl -s  http://127.0.0.1:8787/logs           | jq -r '.logs[] | "\(.level): \(.message)"'
curl -s  http://127.0.0.1:8787/stats          | jq '{framesPerSecond, commandCount, entityCount, pushToFirstFrameMs}'
```

`?objects=0` gives you every top-level field and no object list, which is both
the cheapest poll and the fastest way to see `errors`. Add
`?compact=1`, `?names=…` or `?fields=…` when you need objects too — a full dump
of a large scene is expensive enough to stall the render loop.

A non-empty `errors` array is the answer to most of this page. `errors` keeps
the most recent 200 entries; if `droppedErrors` is non-zero the **first**
failure is no longer in the list, so fix what you can see and re-push.

If the answer is "it works on one backend and not the other", skip to
[the parity gate](../README.md#the-parity-gate) — it diffs both dumps, both
native dumps and both consoles for the same deterministic run.

---

## Contents

- [Nothing renders](#nothing-renders)
- [The scene disappeared](#the-scene-disappeared)
- [The script did not load](#the-script-did-not-load)
- [Warnings and what they mean](#warnings-and-what-they-mean)
- [An object stopped moving](#an-object-stopped-moving)
- [Physics: the body will not move](#physics-the-body-will-not-move)
- [Events are not firing](#events-are-not-firing)
- [Drag does not move the object](#drag-does-not-move-the-object)
- [The portal is black](#the-portal-is-black)
- [Anchors never anchor](#anchors-never-anchor)
- [Assets and textures do not appear](#assets-and-textures-do-not-appear)
- [Animation does not play](#animation-does-not-play)
- [Timers never fire](#timers-never-fire)
- [A static object will not move](#a-static-object-will-not-move)
- [One object vanished and the rest kept going](#one-object-vanished-and-the-rest-kept-going)
- [The scene was killed by the watchdog](#the-scene-was-killed-by-the-watchdog)
- [Something hit a limit](#something-hit-a-limit)
- [A geometry edit never shows up](#a-geometry-edit-never-shows-up)
- [A command was dropped](#a-command-was-dropped)
- [Something works on visionOS but not on macOS](#something-works-on-visionos-but-not-on-macos)
- [Phase 2: sound, video and cameras](#phase-2-sound-video-and-cameras)
- [Phase 2: characters, fields, rigs and shaders](#phase-2-characters-fields-rigs-and-shaders)
- [Phase 2: controllers, the host channel and lifecycle](#phase-2-controllers-the-host-channel-and-lifecycle)
- [Memory and performance](#memory-and-performance)
- [Reading GET /stats](#reading-get-stats)
- [Backend differences that look like bugs](#backend-differences-that-look-like-bugs)

---

## Nothing renders

An empty window has four common causes, in the order worth checking.

**No scene is mounted.** `dump().scene` is `null` and `objects` is empty.
If the script constructed exactly one `Scene` it is auto-mounted with a
warning; zero or two or more is a load error. Fix: call `Spatial.mount(scene)`
explicitly, right after building the scene.

**No light.** `MeshStandardMaterial` and `MeshPhysicalMaterial` are physically
based: with no light they are black. This is the single most common cause of a
"blank" scene that has objects in the dump. Fix: add at least
`new AmbientLight(0xffffff, 0.4)` plus a `DirectionalLight` with an intensity
around `2`–`3`. To check whether lighting is the problem, temporarily swap one
material for `MeshBasicMaterial`, which is unlit — if it appears, you need
lights.

**Neither consumer invents a light.** A scene that declares none renders black
on both backends, and both warn: `the scene has no lights; meshes with lit
materials render black`. If that warning is in `dump().warnings`, that is your
answer.

A metal-only scene is the other half of this: `metalness: 1` lit by nothing but
an `AmbientLight` is lit on RealityKit (whose ambient is an image-based light)
and black on the web. Add a `DirectionalLight`, or set `Spatial.environment`.

**Nothing was added to the mounted scene.** Objects created but never `add`ed
do not render. Check `dump().objects` for the name; if it is missing, the
`add` is missing (or the object went under a different parent). A `Mesh` added
to a `Group` that was never added to the scene is a common shape of this.

**Everything is too far away, too small, or too big.** Units are metres. A
default `new BoxGeometry()` is a **one-metre** cube, so at the usual viewing
distance you are standing inside it; `position.set(0, 0, -5)` is five metres
behind the wall. Fix: sizes around `0.05`–`0.3`, positions within about `0.5`
of the origin. Check `dump().objects[i].worldPosition` — every visible thing
should be a small number.

Other possibilities: `visible === false`, `opacity === 0`, `material.opacity`
below 1 with `transparent: true`, a `PlaneGeometry` seen edge-on or from behind
(planes face `+Z`; use `side: DoubleSide`), or a mesh with `OcclusionMaterial`,
which is invisible on purpose.

**Confirm:** `curl -s http://127.0.0.1:8787/dump | jq '.objects | map({name, worldPosition, visible, opacity, material: .material.type, light: .light.type})'`.

---

## The scene disappeared

**A load error tore it down.** Only load errors do this; runtime errors never
do. The message and line come back in the `POST /script` response and in
`GET /logs`.

```
curl -s --data-binary @scene.js http://127.0.0.1:8787/script | jq
{ "ok": false, "error": { "message": "ReferenceError: nope is not defined", "line": 12, "column": 3 } }
```

**A later `mount` replaced it.** Mounting a second scene destroys the first
completely: entities freed, ids released, objects marked destroyed. If a script
mounts inside `onFrame`, it is swapping the whole scene every time the condition
is true. Re-adding an object from the replaced scene throws
`SpatialUnsupportedError` with `feature: "destroyed-object"`.

**You are looking at an older script's dump.** After a hot swap, check
`dump().loadGeneration`: it increments on every load, and ids from an earlier
generation mean nothing in the current one.

**`Spatial.destroy` took more than intended.** `destroy` frees the object *and
its whole subtree*. Destroying a `Group` destroys every child.

**What is *not* a cause:** an exception in `onFrame`, `update`, a listener, or
a timer. Those are caught, reported once per second per message, and the loop
continues. If the picture froze after such an error, the frozen thing is the
work that came after the throw in that callback — split the callback or wrap
the risky part.

---

## The script did not load

Load errors carry a line and column where the engine supplies them
(JavaScriptCore always; V8 for runtime errors, but not for syntax errors —
there the message stands alone).

| Message | Fix |
|---|---|
| `SyntaxError: ...` | the body did not parse. Note the body is compiled as a function body, so a stray `export` or a top-level `import` is a syntax error |
| `ReferenceError: X is not defined (line N, column M)` | a typo, or a name that is [not in scope](./DIFFERENCES.md#10-not-in-scope-and-what-you-get-instead) — `ShaderMaterial`, `HemisphereLight`, `Sprite`… Cameras, audio, video and the rest of [phase 2](./API.md#phase-2) **are** exported |
| `The script finished without mounting a scene and constructed no Scene` | build a `Scene` and mount it |
| `... and constructed 2 Scenes; call Spatial.mount(scene)` | mount one explicitly |
| `Error: require("three") is not available; only require("spatial") is provided` | `const Spatial = require("spatial")` |
| `TypeError: Spatial.mount expects a Scene` | you mounted a `Group` |

Line numbers are 1-based against your file. If a reported line is outside your
source, the location came from inside the core and is suppressed — you get the
bare message.

A throw **after** the first top-level `await` is not a load error: it is
reported through the error channel and the mounted scene keeps running. That is
why mounting before an `await` matters.

---

## Warnings and what they mean

Warnings never stop anything. They appear once per key per scene, in
`dump().warnings` and in the logs.

| Warning | Meaning | Fix |
|---|---|---|
| `No scene was mounted; auto-mounting the single Scene that was constructed` | the auto-mount rule saved you | add `Spatial.mount(scene)` |
| `Mesh "x" was created without a material; a MeshStandardMaterial was substituted (three.js would use MeshBasicMaterial, which is unlit)` | `new Mesh(geometry)` | pass a material; note the substitute is **lit**, unlike three.js |
| `Mesh "x" was created without a geometry; an empty BufferGeometry was substituted` | `new Mesh()` | pass a geometry — an empty one draws nothing |
| `BoxGeometry arguments were normalized: width -0.2 -> 0.2` | a negative, zero or non-finite size | pass positive sizes; zero becomes `0.001` |
| `MeshStandardMaterial properties were clamped: opacity 4 -> 1` | an out-of-range scalar | `opacity`, `metalness`, `roughness`, `clearcoat*` are 0..1 |
| `PointLight properties were clamped: intensity -5 -> 0` | negative intensity/distance/decay, or `angle` above π/2 | |
| `MeshStandardMaterial.wireframe is unsupported in RealityKit` | renders solid | use thin boxes if you need visible edges |
| `AdditiveBlending is unsupported in RealityKit; the material renders as transparent` | RealityKit blending is opaque or transparent only | accept it, or use emissive for a glow |
| `PointLight shadows are unsupported; castShadow is ignored` | | cast shadows from a directional or spot light |
| `Object3D.groundingShadow is unsupported on the three.js backend` | | expected when running the web harness |
| `Object3D.manipulable is unsupported on macOS; ManipulationComponent is visionOS only` | macOS has no system manipulation | branch on `Spatial.env.capabilities.manipulation`; implement a drag instead |
| `Object3D.renderOrder is unsupported on macOS; ModelSortGroupComponent is visionOS only` | | order by depth, or accept it |
| `hoverEffect "lift" has no RealityKit equivalent and renders as "highlight"` | the SDK has spotlight, highlight and shader only | use `"highlight"` explicitly |
| `Head anchors are visionOS only; the anchor stays at the world origin on macOS` | also hand and plane | give the anchor a fallback `position` |
| `Spatial.environment replaces the AmbientLight image based light; ...` | both were set | pick one |
| `.exr environments are unsupported in the three.js consumer (url)` | | ship `.hdr` for a cross-backend scene |
| `Portal crossing is unsupported in the three.js consumer` | `crossing: true` on web | expected |
| `Portal "x" has a world group that is not in the mounted scene; ...` | the world group was never added | `scene.add(worldGroup)` |
| `CylinderGeometry with radiusTop != radiusBottom has no RealityKit generator; the mesh is rebuilt from the geometry buffers` | also partial spheres and cones | correct output, just not the native fast path |
| `RigidBody on "x" was ignored: the object has no geometry to build a collision shape from` | a body on a `Group` | put the body on a `Mesh` |
| `RigidBody.applyImpulse on "x" was dropped: the object is not in the mounted scene` | the object was destroyed, or never added | see [A command was dropped](#a-command-was-dropped) |
| `texture N was released while a material still references it; it is kept until the material changes` | `dispose()` before repointing | repoint the material first |
| `the scene has no lights; meshes with lit materials render black` | the scene declares no light; neither consumer adds one | add an `AmbientLight` and a `DirectionalLight` |
| `Object3D.add was called with null; the call was ignored` | a variable was `undefined` at `add` time | usually an ordering bug |
| `THREE.Color: Unknown color ...` | an unparseable colour string; the colour stays white | use `0x3366ff`, `"#3366ff"`, or a CSS name |

`dump().warnings` is capped at 500 entries.

---

## An object stopped moving

**Its transform was rejected.** A NaN or Infinity in `position`, `quaternion`
or `scale`, a zero-length quaternion, or a sheared matrix means the transform
is not sent: the consumer keeps the last valid one, so the object freezes in
place while everything else keeps going. Look for one of these in
`dump().errors`:

```
SpatialUnsupportedError: Transform on "x" is not finite; the last valid transform is kept
SpatialUnsupportedError: Matrix on "x" contains shear, which cannot be represented as a transform
```

Typical sources: dividing by a zero `deltaTime`, `Math.acos` of a value
slightly outside `[-1, 1]`, normalising a zero-length vector, or
`quaternion.set(0, 0, 0, 0)`. Each is reported once per object and again only
after the value has become valid, so a single line in `errors` can represent
every frame since.

**A callback throws before reaching the movement.** One exception abandons the
rest of that callback. `dump().errors` will name it. Reorder, or wrap.

**It is a dynamic rigid body.** See the next section.

**The animation mixer is not being updated.** `mixer.update(deltaTime)` must be
called from `onFrame`; nothing calls it for you.

**It was never added to the command stream.** Two caps produce this, both
reported once in `dump().errors`:

- `Adding "x" would make the scene graph 1025 levels deep; the limit is 1024` —
  the object is not in the graph at all.
- `The scene has used every object id below 16777216; new objects are not
  tracked` — the id space ran out. Ids are recycled by `Spatial.destroy`, so
  this only happens to a scene that creates and never destroys. Destroy what
  you are finished with.

---

## Physics: the body will not move

| Cause | Check | Fix |
|---|---|---|
| the body is `static` or `kinematic` | `dump().objects[i].rigidBody.type` | `type: "dynamic"` for gravity-driven motion |
| there is no body at all | `rigidBody` is `null` | assign `mesh.rigidBody = new RigidBody(...)` |
| gravity is disabled on the body | `rigidBody.gravity === false` | set it `true`, or push with `applyImpulse` |
| the world gravity is zero | `dump().gravity` | `Spatial.physics.gravity.set(0, -9.81, 0)` |
| the body went to sleep | `dump().objects[i].isSleeping === true`, `velocity` near zero | expected once it rests; an impulse or a collision wakes it |
| you moved it by writing `position` | it snaps and stops | writing `position`/`quaternion`/`scale` on a dynamic body is a **teleport** that zeroes velocity. Use `applyImpulse`, `applyForce` or `setLinearVelocity` |
| the shape is wrong | `rigidBody.shape` is the *resolved* shape | `"auto"` gives `box`/`sphere`/`capsule` for those geometries and `convex` otherwise; pass an explicit shape if that is wrong |
| it is a trigger | `rigidBody.isTrigger === true` | **a trigger is never simulated**: no mass, no falling, never pushed, and its `type`, `mass` and `gravity` are all ignored. If you wanted a moving body, drop `isTrigger` |
| the body is on a `Group` | warning `RigidBody on "x" was ignored: the object has no geometry to build a collision shape from` | bodies go on meshes |
| one `RigidBody` on two objects | throws `SpatialUnsupportedError` (`"rigidbody-shared"`) at assignment | construct one body per object |
| nothing to land on | | the floor needs its own `RigidBody({ type: "static" })`; a bare mesh is hit-testable but not collidable |

`rigidBody.linearVelocity` is read-only state pushed in by the consumer — on
RealityKit it is derived by finite difference, because `PhysicsMotionComponent`
is an input to the simulation and is never written back. Do not assign to it;
call `setLinearVelocity`.

**Trajectories differ between backends.** RealityKit physics and Rapier are not
numerically identical. Assert that a dropped body ends lower than it started
and comes to rest — never an exact position after N frames. The parity gate
knows this and compares structure, not trajectories.

**A joint vanished.** Destroying either of a joint's bodies removes the joint:
it disappears from `Spatial.physics.joints` and `dump().joints`, and the
consumer is told to drop it. That is deliberate — a joint pinned to a dead body
is worse. Re-create the joint after re-creating the body.

**A `distance` joint behaves oddly on the web.** Its `limits` is the allowed
separation between the two anchors. Rapier cannot always express a positive
minimum; when it cannot, the consumer applies `max` as a rope and warns once
naming the joint. RealityKit honours both bounds.

---

## Events are not firing

Work down this list; the first four cover almost everything.

1. **No listener is registered.** Registering the listener is what makes an
   object an input target. `dump().objects[i].interactive` must show
   `{ tap: true }` (or `hover`/`drag`) for the object you are pointing at.
2. **The object is not a mesh.** Only meshes are hit-tested. A listener on a
   `Group`, an `Anchor`, or a `ParticleEmitter` receives events that bubbled up
   from a mesh below it, but the object itself is never hit.
3. **A listener on an ancestor does not make a descendant a target.** Each
   object that should be hit-testable registers its own listener.
4. **Something called `stopPropagation()`.** An event stops at the first
   listener that calls it, so the ancestors and the `Scene` never see it. Check
   the listeners between the target and where you expected the event.
5. **The listener throws.** The exception is caught and reported, but the rest
   of *that* listener does not run. Look in `dump().errors`. Other listeners on
   the same event still run.
6. **You are reading the result too early.** Injected and consumer events are
   queued and delivered at the **start of the next tick**. Tick at least once
   between injecting and asserting.
7. **The object is behind something.** A transparent or invisible mesh in front
   still has a collision shape and still swallows the hit. Set `visible = false`
   or remove it, or move it out of the way.
8. **Collision events with no rigid body.** `collisionstart`/`collisionend`
   need at least one of the pair to have a `rigidBody`. Two plain meshes never
   collide — they only have hit-test shapes.

9. **A raycast found nothing, so the object is not where you think.**
   `Spatial.raycast` is meshes-only, **visible-only**, one hit per object, and
   `recursive: false` means only the direct children of the mounted scene. An
   object hidden by `visible = false` — on itself *or on any ancestor* — is
   invisible to it.

Verify a listener without a pointer:

```
curl -s -X POST http://127.0.0.1:8787/inject -d '{"type":"tap","target":"box"}'
curl -s http://127.0.0.1:8787/dump | jq '.objects[] | select(.name=="box") | .userData'
```

**But note:** injection dispatches straight at the named object and bypasses
hit testing. A working injected tap proves your listener works; it does not
prove a real pointer can reach the object. For that, check `interactive` in the
dump, confirm the object is a `Mesh`, and try a real click.

`dump().objects[i].interactive` now has five flags:
`{ tap, hover, drag, manipulation, collision }`. Only `tap`, `hover` and `drag`
make the object an input target and build a collider — `manipulation` and
`collision` are reported for verification only, since those events come from
[`manipulable`](./API.md#object3d-spatialscript-properties) and from a
[`rigidBody`](./API.md#rigidbody).

**`manipulation*` events never fire on macOS.** `capabilities.manipulation` is
`false` there and `manipulable` warns once and is ignored. On visionOS all three
fire: begin, one per transform update, end.

---

## Drag does not move the object

**The script owns the position.** The consumer reports the displacement and
never moves the object for you. If you only registered `dragstart`, or your
`drag` handler does not write `position`, nothing moves.

```js
const origin = new Vector3();
box.addEventListener("dragstart", () => origin.copy(box.position));
box.addEventListener("drag", (event) => box.position.copy(origin).add(event.translation));
```

**`translation` is measured from `dragstart`, not from the previous event.**
Adding it to the *current* position every frame accelerates the object away.
Capture the origin at `dragstart` and add to that.

**`translation` is world space; `position` is local.** For an object parented
under a rotated or scaled group, convert:
`box.position.copy(box.parent.worldToLocal(worldTarget))`.

**The object is a dynamic rigid body.** Writing `position` teleports it and
zeroes its velocity; the physics step then fights the drag. Make it
`kinematic` while dragging, or use `manipulable = true` and let the system move
it.

**On macOS the translation is always zero.** That was a real bug in the
consumer, caused by `EntityTargetValue.ray(through:)` returning `nil` on macOS;
it is fixed by intersecting the app's own ray with the plane through the
object. If you see it again, it is a consumer regression, not a script problem
— check whether `Spatial.inject.drag` produces non-zero translations (it will),
which isolates it to real input.

---

## The portal is black

**The world group is not behind the portal plane.** A RealityKit
`PortalComponent` is a window: content is visible only where it lies behind the
portal surface from the viewer's position. A world group beside or in front of
the portal renders black — the portal is working, there is simply nothing
behind it.

Fix: put the world group further from the viewer than the portal. With the
portal at `z = -0.3`, put the world at `z = -0.8`.

**The world group is empty or unlit.** A world group is hidden from the main
render, so its contents need their own light *inside the group* — the scene's
lights do not necessarily reach it. Add a `PointLight` to the world group.

**`world` was never set, or is not an `Object3D`.** Check
`dump().objects[i].portal.worldId` is non-null, and that the world group's
entry has `world: true`.

**The world group was not added to the scene.** It must be added like any other
object; the consumer marks it as a world so it renders only through the portal.
The core refuses to emit a portal that names a world outside the mounted scene,
and warns: `Portal "x" has a world group that is not in the mounted scene; add
it to the scene for the portal to render`.

**`crossing: true` does nothing in the browser.** Expected — the web consumer
warns once and ignores it. RealityKit implements it.

---

## Anchors never anchor

**Only visionOS anchors.** `Spatial.env.capabilities.anchors` is **`false`** on
macOS and on the web, and that is the flag to branch on. On macOS the
`AnchorEntity` is created but sits at the **world origin** and never resolves:
`isAnchored` stays `false`, no `anchored` event fires, and each anchor kind
warns once (`Head anchors are visionOS only; the anchor stays at the world
origin on macOS`). On web an `Anchor` is a plain group at its own transform.
This is expected behaviour, not a failure.

**Give anchored content a local transform.** Content under an anchor that never
resolves sits at the anchor's own transform, which is the origin by default —
often inside the viewer. Position the anchor sensibly for the fallback case,
and switch layouts on `capabilities.anchors`.

**On visionOS, the anchor may still be searching.** A plane anchor needs a
detected surface at least `minimumBounds` across; a hand anchor needs tracked
hands. Listen for `anchored` and show a placeholder until it fires.

---

## Assets and textures do not appear

**Wrong key for the backend.** RealityKit loads `usdz` or `reality`; the web
consumer loads `glb` or `gltf`. Missing the key the backend needs rejects the
promise immediately with `SpatialUnsupportedError` (`feature: "loadAsset"`).
Supply both keys.

**A key was refused by url containment.** A url that escapes the asset root or
uses a scheme outside `https:`/`http:`/`file:`/`asset:`/`data:` has *that key*
dropped, with a warning naming it. The load still proceeds if the backend has
another usable key; otherwise it rejects with `loadAsset refused usdz and glb:
the url leaves the asset root or uses a scheme that is not allowed`.

**The rejection was not caught.** An unhandled rejection surfaces as a runtime
error in `dump().errors`. Wrap the `await` in `try`/`catch`.

**The await never resolves.** Asset loads and timers advance on frame ticks. If
the scene is not ticking — because a load error tore it down — nothing settles.
Mount before you await.

**The url did not resolve.** `https://`, `file://`, `data:` and `asset://` are
passed through; anything else is joined onto the script's asset root, so
`models/robot.usdz` becomes `assets/models/robot.usdz` in the dump.
`asset://name` resolves against the consumer's own app bundle, so a name that
works in the macOS host may not exist in the browser harness.

**The environment did not install.** Two separate causes. Its url may have been
refused by containment, in which case `dump().environment` is `null` and you get
`Spatial.environment was dropped because its url was refused` on top of the
warning naming the url. Otherwise it is the format: `.hdr`, `.png` and `.jpg`
equirectangular maps work on both backends; **`.exr` is RealityKit only** and
the web consumer warns once and installs nothing. Also note that on RealityKit an explicit
`Spatial.environment` overrides an `AmbientLight`, with a warning — if the scene
suddenly got darker after you set one, that is why.

**The texture is not tiling.** Setting `repeat` is not enough: the default wrap
is `ClampToEdgeWrapping`, which stretches the edge pixels. Set `wrapS` and
`wrapT` to `RepeatWrapping` as well. Both backends honour `repeat`, `offset`,
`wrapS`, `wrapT` and `flipY`.

**The texture disappeared after `dispose()`.** It should not — `dispose()`
holds the release until nothing references the texture. If a panel went
untextured, you probably disposed the texture *and* left the material pointing
at it, or repointed to a texture that had already been disposed. Repoint first,
then dispose. The web consumer warns: `texture N was released while a material
still references it; it is kept until the material changes`.

**The texture failed.** A failed texture dispatches `error` on the `Texture`,
calls the `onError` callback, and sets `texture.error`; the material stays
usable and renders untextured. Pass an `onError` and log it:

```js
const map = new TextureLoader().load("asset://grid.png", undefined, undefined,
  (error) => console.warn("texture failed:", error.message));
```

**The asset loaded but is the wrong size.** Assets arrive at their authored
scale, which is often metres-to-centimetres off. Set
`asset.scale.setScalar(0.2)` and check `asset.boundingBox` after load.

**A native asset animation does not move the asset's root.** Correct: native
animations drive the asset's internal skeleton and do not sync transforms back.
The group's own transform stays script-owned.

---

## Animation does not play

| Cause | Fix |
|---|---|
| `mixer.update(deltaTime)` is not called | call it from `Spatial.onFrame((dt) => mixer.update(dt))` |
| the action was never played | `mixer.clipAction(clip).play()` |
| the clip duration is `-1` or wrong | pass a duration, or call `clip.resetDuration()` |
| the track path is `.rotation` | rotation is animated through `.quaternion`, as in three.js |
| a `.material.opacity` track has no visible effect | set `material.transparent = true` |
| the mixer root is the wrong object | track names are relative to the root passed to `new AnimationMixer(root)`; use `childName.position` for a descendant |
| the action holds the wrong end state | `action.clampWhenFinished = true` with `setLoop(LoopOnce, 1)` |
| a native asset animation does not appear | check `assetGroup.animations` for the exact clip name after load |

---

## Timers never fire

Timers are driven by frame ticks, not by a host event loop. A `setTimeout(fn,
1000)` fires on the first frame where the elapsed scene time has passed one
second — so it needs the scene to be ticking, and it never fires during load.

`setInterval` fires at most once per frame, so a zero-delay interval cannot
spin the loop, and an interval shorter than the frame time effectively runs at
the frame rate.

A timer callback that throws is caught and reported; the timer itself keeps its
schedule.

---

## A static object will not move

You set `matrixAutoUpdate = false` — the static hint — and now writing
`position`, `rotation` or `scale` does nothing. That is three.js semantics and
the core follows them: the **matrix** is authoritative, and the core stops
reading the TRS entirely.

```js
tower.position.y += 0.05;
tower.updateMatrix();        // required, or nothing happens
```

Or write the matrix directly: `tower.matrix.makeTranslation(x, y, z)`.

The order when setting it up also matters: set the transform, call
`updateMatrix()` **once**, then turn the flag off. Turning it off first bakes
whatever the matrix happened to hold — usually the identity, so the object
snaps to the origin.

Two related mistakes:

- **`Object.freeze` is not a static hint.** A frozen object cannot be processed
  at all: it is reported once and skipped for the rest of the session.
- **A static child under a moving parent still moves.** The hint only stops the
  core polling the object's own local transform; the parent's world matrix still
  propagates. Making the parent static is what freezes the group.

---

## One object vanished and the rest kept going

```
SpatialUnsupportedError: "bad" could not be processed and is skipped for the rest of the session: Cannot add property Symbol(spatial.snapshot), object is not extensible
```

The frame walk, the world-matrix refresh and the dump are per-object safe. An
object that throws when the core touches it costs that object, once, and
nothing else. Causes, in order of likelihood:

| Cause | Fix |
|---|---|
| `Object.freeze(object)` or `Object.seal(object)` | do not freeze scene objects; use `matrixAutoUpdate = false` for "static" |
| `Object.preventExtensions` on an object, directly or through a proxy | same |
| a getter you defined on `position`, `visible`, `name` … that throws | do not shadow core properties |
| a `Proxy` around a scene object | add the real object, keep the proxy for your own code |

The object still appears in `dump()`, so the dump is not the way to notice —
`dump().errors` is. And the skip lasts the session: undoing the freeze does not
bring it back, you have to rebuild the scene.

---

## The scene was killed by the watchdog

The macOS host installs a JavaScriptCore execution-time limit in DEBUG builds:
**2 seconds per synchronous entry** into the core — one `load`, one `tick`, one
`dump`. Exceed it and the context is terminated and the scene disposed, with a
message naming the entry point. The app, the compositor and the dev server all
survive, so you can push a fix immediately.

What trips it:

- an unbounded loop in top-level code, `onFrame`, `update`, a listener or a
  timer (`while (true) {}`);
- a `requestAnimationFrame` chain that re-registers faster than it drains — the
  10000-callbacks-per-tick budget defers the overflow, but a body that never
  finishes still blocks;
- an accidental O(n²) over a large scene inside one frame.

Two things to know:

- **It only bites in interpreter mode.** With the JavaScriptCore JIT on, the
  limit is installed but its interrupt check never fires in this hardened
  process, so a runaway loop still freezes the app. Launch with
  `SPATIAL_INTERPRETER=1` (or `--interpreter`) to arm it.
- **`GET /health` reports the state**: `armed` (interpreter mode, protection
  live), `inactive (requires interpreter mode)` (JIT on), `unavailable` (the
  private JavaScriptCore entry point could not be resolved), or
  `release build: no watchdog`.
- **Release builds have no watchdog at all**, and neither does the browser
  consumer. A loop that the macOS host survives will hang a release build. Run
  every script in the macOS host, in interpreter mode, before shipping it.

---

## Something hit a limit

`Spatial.limits` names every cap the core enforces, and crossing one always
warns. If a scene silently stops growing, stops listening, or stops logging,
look here first.

| Symptom | Limit | Warning |
|---|---|---|
| `setTimeout`/`setInterval` returns but never fires, and no new ones register | `MAX_LIVE_TIMERS` 10000 | `More than 10000 live timers; the registration was dropped` |
| `requestAnimationFrame` stops running | `MAX_LIVE_FRAME_CALLBACKS` 10000 | `More than 10000 live animation-frame callbacks; the registration was dropped` |
| callbacks run late, in batches | `MAX_CALLBACKS_PER_TICK` 10000 | `More than 10000 timer and animation-frame callbacks came due in one frame; the rest were deferred to the next frame` — deferred, never dropped |
| a listener you added never fires | `MAX_LISTENERS_PER_EVENT` 1000 | `More than 1000 "tap" listeners on "m"; the registration was dropped` |
| console output stops mid-frame | `MAX_LOGS_PER_FRAME` 200 | `50 more log lines were suppressed this frame` |
| a log line is cut off | `MAX_LOG_MESSAGE` 16 KB | `… (truncated, N characters)` |
| a long name is short in the native dump but full in `dump()` | `MAX_NAME_LENGTH` 256 | `A name of 400 characters was truncated to 256` |
| `add`/`attach` refused | `MAX_DEPTH` 1024 | a `depth-limit` error |
| new objects stop rendering | id ceiling 2²⁴ | `The scene has used every object id below 16777216; new objects are not tracked` |
| the earliest error is missing | `errors` cap 200 | `dump().droppedErrors` is non-zero |

Read the numbers from `Spatial.limits` rather than hard-coding them, and size
generated scenes against them.

**A url disappeared.** Every url a script supplies is contained before it leaves
the core: the scheme must be one of `https:`, `http:`, `file:`, `asset:`,
`data:`; `.` and `..` are collapsed; a path that climbs above the asset root is
dropped; credentials are stripped; a plain relative path is joined onto the
asset root. Each case warns once naming the url. What a refusal costs depends on
where it was:

| Where | Result |
|---|---|
| a texture | the material renders untextured, nothing else changes |
| a `loadAsset` key | that key is dropped. The load still proceeds if the backend has another usable key; otherwise the promise rejects with `loadAsset refused usdz and glb: the url leaves the asset root or uses a scheme that is not allowed` |
| `Spatial.environment` | no environment is installed and `dump().environment` is `null`, with `Spatial.environment was dropped because its url was refused` |

An accepted relative url is **rewritten**: with `assetRoot: "assets"`,
`models/robot.usdz` reaches the consumer as `assets/models/robot.usdz`, and the
dump shows the resolved form. If a url looks wrong in the dump, check the asset
root before suspecting the script.

---

## A geometry edit never shows up

Calling a geometry **method** re-emits the geometry: `setAttribute`,
`deleteAttribute`, `setIndex`, `computeVertexNormals`, `applyMatrix4`, and the
`translate`/`rotate`/`scale`/`center` helpers that go through it. Both consumers
rebuild the native mesh and its bounds, for every mesh sharing that geometry.

Editing the numbers **inside** an existing attribute array is the case the
revision cannot see:

```js
const position = geometry.getAttribute("position");
position.setXYZ(0, x, y, z);
position.needsUpdate = true;      // without this the edit never leaves the core
```

Other reasons a geometry change does not appear:

- **You mutated a geometry no mesh uses.** Only geometries reachable from a
  mounted mesh are diffed.
- **You expected a shared geometry to diverge.** Meshes sharing one instance
  share one native resource; mutating it changes all of them. `clone()` first if
  one should differ — the clone gets a new `uuid`, and therefore a new native
  mesh.
- **The parametric `parameters` object was edited.** Writing
  `geometry.parameters.width` does not rebuild anything; construct a new
  geometry and assign `mesh.geometry`.

Re-emitting sends the whole vertex payload, so a large buffer rewritten every
frame will show up as a fat `applyMs` in `/stats`. Prefer swapping
`mesh.geometry` between prebuilt geometries.

**A shared plain `BufferGeometry` re-uploads once per mesh.** The command
carries `uuid` plus a `revision` token, and for a *parametric* geometry the
second and later meshes at the same pair get `null` buffers — the consumer
reuses the resource it already built. A hand-built `BufferGeometry` cannot be
regenerated from parameters, so it always carries its buffers. Sharing one
across a thousand meshes is a thousand uploads at load. Use a parametric
geometry for a large repeated shape.

---

## A command was dropped

```
RigidBody.applyImpulse on "crate" was dropped: the object is not in the mounted scene
```

Imperative calls — `rigidBody.applyImpulse` / `applyForce` / `applyTorque` /
`setLinearVelocity` / `setAngularVelocity`, `ParticleEmitter.burst()`,
`assetGroup.playAnimation()` — name an object in the command stream. If the
object is not there, the call is dropped with this warning rather than sent
against a stale id. Two ways to get there:

1. **The object was destroyed** (or belonged to a scene a later `mount`
   replaced). It is gone; re-create it.
2. **The object was never added to the mounted scene.** Building a mesh,
   attaching a body and calling `applyImpulse` without ever calling
   `scene.add(mesh)` produces exactly this.

Declarative state does not have this problem: setting `body.mass` or
`emitter.birthRate` on a detached object is simply picked up whenever it is
added.

---

## Something works on visionOS but not on macOS

Four capabilities are `false` on RealityKit macOS, and every one of them is a
deliberate, honest report rather than a bug:

| `Spatial.env.capabilities` | macOS | Symptom | What to do |
|---|---|---|---|
| `hands` | `false` | `Spatial.input.hands.left/.right` are `null`; a script that dereferences one throws in its frame callback every frame | null-check, always |
| `anchors` | `false` | anchored content sits at the world origin; `isAnchored` never becomes `true`; no `anchored` event | give the anchor a fallback `position`; branch on the capability |
| `manipulation` | `false` | `manipulable = true` warns once and does nothing; no `manipulation*` event ever fires | implement a drag with `dragstart`/`drag`/`dragend`, which works everywhere |
| `hoverEffect` | `false` | no hover visual; `hoverenter`/`hoverexit` still fire | do the highlight yourself in the listener, as [recipe 3](./COOKBOOK.md#3-hover-highlight) does |

`renderOrder` belongs in the same family: visionOS maps it to
`ModelSortGroupComponent`, macOS warns once and ignores it.

Branch on `Spatial.env.capabilities.x`, never on
`Spatial.env.platform === "visionos"` — a host may override a capability at
load time, and the capability is what the consumer actually honours.

---

## Phase 2: sound, video and cameras

**My sound does not play.** In order of likelihood:

| Cause | Check | Fix |
|---|---|---|
| the buffer url was refused | `dump().warnings` for a containment message; `buffer.error` | keep the url inside the asset root and on an allowed scheme |
| the mixer is suspended | `dump().audioMixer.state` | call `Spatial.audio.resume()`. It starts `"suspended"` on **every** backend and only becomes `"running"` on `resume()` or when the consumer reports its engine started |
| the buffer never arrived | `onLoad` never ran | `AudioLoader.load` calls `onLoad` on the next microtask; if it never fires, the url was refused and `onError` ran instead |
| `masterVolume` or the group volume is 0 | `dump().audioMixer` | a group volume multiplies every source in it |
| the sound was disposed | `dump().warnings` for `Audio.play on "x" was dropped: the object was destroyed` | `dispose()` is final; build a new `Audio` |
| nothing is wrong | | headless runs have no audio engine at all. `audio.playing` stays `false` in a Node or harness dump; verify audibly in the macOS host or in the browser harness with its fake audio device |

**`isPlaying` is false right after `play()`.** Correct and expected: playback
state is **native-driven**. `isPlaying`, `currentTime` and `duration` are what
the consumer last reported through `syncAudio`, so they lag your call by a frame
at least. Toggle against them next frame, or keep your own intent flag.

**My spatial sound ignores `setVolume`, or the cone does nothing.** Check
`dump().objects[i].audio` first — if the values are there, the core did its job
and the difference is the backend. Two known RealityKit limits:
**directivity is a single beam**, so a three-part cone collapses to one setting
and `outerGain` is approximated; and **`refDistance` folds into the rolloff**,
because the engine has one distance control rather than two. A scene tuned by
ear on one backend will not match the other exactly.

**Nothing attenuates with distance.** The defaults are metre-scale. In a 0.4 m
scene, `setRefDistance(0.3)` with `setRolloffFactor(1.4)` is a starting point;
the default `refDistance` of 1 m means full volume everywhere.

**My video is blank.**

| Cause | Check | Fix |
|---|---|---|
| no encoding this backend can play | `dump().objects[i].video.url` | RealityKit needs `mp4` or `hls`, the web needs `webm` or `mp4`. Supply both |
| every url was refused | `warnings`, and `video.url === null` | the `error` event fires with `no url survived containment` |
| no url at all | `video.url === null` | the `error` event fires with `no url was given` |
| the consumer could not decode it | the `error` event's `message` | re-encode |
| it is simply not playing | `video.playing` | `autoplay` is `false` by default; call `play()` |

**The video is the wrong shape.** Give only `width` **or** only `height` and the
other follows the video's real aspect once the consumer reports `loaded`. Until
then it is 16:9. Giving both fixes the plane and lets the image letterbox.

**My camera does nothing.** On visionOS the user is the camera:
`capabilities.camera` is `false`, the assignment is kept and reported, and
`warnings` contains `On visionOS the user is the camera; Spatial.camera is kept
and reported but has no effect`. There is no way around it — branch on the
capability.

**`aspect` has no effect.** The consumer owns it, from the viewport;
`PerspectiveCamera.aspect is managed by the consumer from the viewport; the
script value is ignored`. For an `OrthographicCamera` the visible **height** is
`top - bottom` and the width follows the viewport, because RealityKit's
orthographic camera takes only a height — `left`/`right` warn when they disagree.

**`scenePosition` or `rayFromPoint` is null.** Both are `null` on visionOS, when
the pointer has left the window, and when the consumer supplies no hook —
`Spatial.rayFromPoint needs the consumer's rayFromPoint hook; it returned null`.
Guard both; never park a marker at the origin instead.

---

## Phase 2: characters, fields, rigs and shaders

**My character does not move.**

| Cause | Fix |
|---|---|
| you wrote `object.position` | a character controller is **native-driven**. Use `move(displacement)`, or `teleport(position)` for a respawn |
| more than one `move` per frame | one per frame; the consumer applies it on the next step |
| there is nothing to stand on | the floor needs its own `RigidBody({ type: "static" })` |
| the step is too tall or the slope too steep | `stepLimit` is metres, `slopeLimit` is **radians** |
| `isOnGround` is always false | it is reported by the consumer after it resolves a move, so it is `false` until the first sync arrives — and stays `false` in a headless dump |

The controller never rotates anything. Set `object.rotation.y` yourself to face
the direction of travel.

**A force field does nothing.** It acts only on **dynamic** rigid bodies within
`radius` of its own **world** position — check `dump().objects[i].forceField`
for `enabled`, `radius` and the per-kind strength, and check that the bodies you
expect to move are `type: "dynamic"`. A `RadialForceField` with no
`minimumDistance` goes to infinity at its centre; that is what the option is for.

**A joint edit did nothing.**

| Cause | Check | Fix |
|---|---|---|
| a native animation is playing | it overrides script poses while it runs | `stopAnimation()` hands the pose back |
| the name is not in the rig | `warnings` for `Skeleton.setJointRotation was given "x", which this asset has no joint for` | read `asset.skeleton.joints` and match against it |
| the asset has no rig at all | `asset.skeleton === null` | expected for a static prop; guard every use |
| you read `getJointTransform` during an animation | | call `skeleton.track(true)` first — that is the only way to see where a joint really is |

Blend shapes behave the same way: an unknown name warns and is ignored, and the
weight is clamped to 0..1.

**`setParameter` did nothing.**

| Cause | Fix |
|---|---|
| you are on the web | `capabilities.shaderGraph` is `false` there; the `fallback` renders and `setParameter` only reaches a same-named property the fallback owns |
| the value was refused | `warnings` names the parameter: accepted values are a finite number, a boolean, a string, a `Color`, a `Vector2`/`3`/`4`, an array of two to four finite numbers, or a `Texture` |
| RealityKit texture parameters | binding a `Texture` into a graph is not wired up today; numbers, colours and vectors are |
| the value was `0` or `1` | some numeric edges are refused by the RealityKit binder; nudge to `0.001`/`0.999` if a parameter refuses to move |

`ShaderGraphMaterial` requires a `fallback`; omitting it throws `TypeError` at
construction, which is a load error.

---

## Phase 2: controllers, the host channel and lifecycle

**No controller appears.** `Spatial.input.controllers.connected` is `0` when
nothing is attached — and nothing ever is in a test. Drive it with
`Spatial.inject.controller(state)`; the shape is the same one a consumer pushes,
every field optional. On RealityKit also check that the app called
`ScriptingRuntime.setup(inputOptions:)` **with** `.gamepad`: without it the
provider is skipped and `capabilities.controllers` is `false`.

**`current` is null even though a pad is connected.** `current` is the
controller whose **input changed** most recently. Connecting alone does not make
one current — inject a stick or a button, or pass `current: true`.

**A button fires every frame.** `pressed` and `released` are one-frame edges;
`down` is the level. Use `pressed` for "on press" and `down` for "while held".
`pressCount` is 2 for a double click, within 400 ms.

**`rumble` does nothing.** It always reaches the consumer as a
`controllerRumble` command; where the hardware or the backend has no haptics you
get one warning and no vibration.

**`Spatial.host.call` rejected.** It rejects **immediately** with
`SpatialUnsupportedError` (`feature: "host-function"`) when the name is not
registered — `The host function "X" is not registered; Spatial.host.functions
lists what is`. Check `Spatial.host.functions` first. A host-side failure comes
back as a rejection whose message is `Module.function: <the app's message>`.
Nothing here ever hangs, so never write a timeout around it.

**My host events go nowhere.** `Spatial.host.send` is fire-and-forget: the app
may have no listener. From outside, `GET /events` **drains** what the script
sent — each event is returned once, so a second poll looks empty. A `/parity`
run returns the same events under `hostEvents` in its own response.

**A `fetch` never settles.** `Spatial.fetchText`/`fetchJSON` are answered by the
consumer; a host with no network never answers, and a headless run answers
nothing at all. **Never `await` one at the top level** — it would hold up the
rest of the script body. Use `.then`/`.catch`.

**My state was empty after a reload.**

| Cause | Fix |
|---|---|
| the push did not ask for it | `POST /script` with `{ "source": …, "preserveState": true }`; without it `scriptChanged` is not called at all |
| the state was not JSON-serialisable | `this.state` is **copied** to JSON. A `Vector3`, a `Map`, a function or a scene object does not survive. Store numbers, strings, booleans, arrays and plain objects |
| you read it in the wrong place | `scriptChanged(previousState)` runs after load and before the first frame, not during the body |

**Nothing happens while the window is in the background.** That is
`Spatial.isActive`. Ticks pause while inactive: time does not advance, timers do
not fire and `onFrame` does not run. `this.willDeactivate()` is the last call
before the pause and `this.didActivate()` the first after it. Losing frontmost
status alone never deactivates — the dev tooling drives the app from another
process.

**Verification limits worth knowing before you chase a ghost:**

- **Nothing is audible headless.** Node and the conformance runners have no
  audio engine; the browser harness runs Chromium with a fake audio device, so
  it proves the graph is wired, not that it sounds right.
- **No real gamepads in any test.** `Spatial.inject.controller` is the only
  driver.
- **RealityKit does not report scene-understanding raycast hits**, so
  `hit.sceneUnderstanding` is `false` and `hit.object` is never `null` today.
- **Release builds ship only `SpatialScript/assets`** — no examples, scenarios or
  conformance cases, and no dev server.

---

## Memory and performance

Measured on the development Mac, with the macOS host in a DEBUG build:

| Scene | Result |
|---|---|
| 1500 independently moving meshes, one shared geometry and one shared material | **120 fps** |
| moving meshes, same sharing | 60 fps holds to roughly **4000** |
| 1500 meshes, shared geometry and material | **0.2 s** from script push to first frame |
| 1500 meshes, a unique geometry and material each | **1.1 s** — five times slower, for the same picture |
| steady state of a moving scene | **1 command per frame** (the packed `transforms` array) |

**Share geometry.** Both consumers cache native mesh resources by the
geometry's `uuid`, so 1500 meshes referencing one `BoxGeometry` **instance**
create exactly one native mesh — `/stats` shows `meshBuilds: 1` against
`meshHits: 1499`. Creating a new `BoxGeometry(0.1, 0.1, 0.1)` per mesh creates
1500. `geometry.clone()` produces a new `uuid` and therefore a new resource —
clone only when you need to diverge.

```js
const geometry = new BoxGeometry(0.05, 0.05, 0.05);   // once
const material = new MeshStandardMaterial({ color: 0x6699ff });
for (let i = 0; i < 1500; i += 1) scene.add(new Mesh(geometry, material));
```

**Share materials too.** Materials are cached by `uuid` the same way, and the
difference is the 0.2 s versus 1.1 s row above: unique geometries and materials
are what make a large scene slow to load, not the object count. A material
change re-emits the full material state to every user, so a per-frame tweak on
a shared material is cheap in commands but touches every mesh that uses it —
give an object its own material only when it genuinely needs to differ.

**Mark static scenery static.** `matrixAutoUpdate = false` after one
`updateMatrix()` turns an object into sixteen array compares per frame with no
property reads at all. Measured on the development Mac in the interpreter (the
visionOS execution mode), 8000 static objects cost **22 ms per frame** without
the hint and **8.4 ms** with it. Set the transform, bake it, turn the flag off —
and remember that writing `position` afterwards does nothing until the next
`updateMatrix()`. See [recipe 20](./COOKBOOK.md#20-static-scenery-with-the-matrixautoupdate-hint).

**Tweening many separate materials is the expensive shape.** Sharing is what the
caches are built for; the opposite case is not. A thousand meshes each with its
own material, all animating colour, re-sends a full material payload per mesh
per frame — cheap in the browser and very expensive on RealityKit, where each
one rebuilds a native material. If a crowd has to shimmer, animate one shared
material and let every mesh follow it, or animate `Object3D.opacity` (a single
scalar) instead of a colour.

**`Spatial.dump()` is not free, and `nativeDump()` is much less so.** Both run
on the same thread as the frame. An unfiltered `GET /dump` is serialised inside
JavaScriptCore in one pass, so a 10 000-object scene costs about **90 ms**; the
same scene through `GET /native-dump`, which is rebuilt value by value from the
live entities, costs about **0.6 s**. Never call either every frame. Poll
`dump({ objects: false })` for health, `dump({ names, fields })` for one object,
`dump({ compact: true })` for all the transforms; over HTTP the same narrowing
is available as query parameters on **both** routes, and identical requests are
answered from a 100 ms cache. Save the full native dump for a one-shot
comparison.

**Do not make things interactive that you will never touch.** On RealityKit
collision shapes are built lazily: a mesh gets a `CollisionComponent` only when
it becomes an input target, when it gets a `rigidBody`, or the first time
`Spatial.raycast` runs — and that one call materialises a shape for **every**
mesh in the scene, permanently. An eager collider costs about 10 µs per moved
entity per frame, so a tap listener on a thousand moving meshes is a real cost.
Put the listener on the few objects that need it, or on an ancestor plus a
`raycast` when a tap actually happens.

**Batch changes inside one `onFrame`.** The diff runs once per frame no matter
how many times you touched a property, so there is nothing to gain from
throttling your own writes, and nothing to lose from doing them all in one
callback. Transform changes are packed into a single typed array per frame.

**Use `destroy`, not just `remove`.** `remove` detaches but keeps the native
entity alive. A scene that spawns and removes without destroying leaks entities
and never returns memory. `Spatial.destroy(object)` frees the object and its
subtree and recycles its ids.

**Keep the object count honest.** `dump().objects.length` is the live count and
`/stats`'s `entityCount` is the native one. If either grows without bound,
something is spawning without destroying.

**visionOS is slower than the Mac at the same scene, and it is the JIT.** Mac
builds run JavaScriptCore with the JIT enabled; visionOS never allows it, so the
core tick is interpreted there. Measure it locally rather than guessing: launch
the macOS host with `SPATIAL_INTERPRETER=1` (or `--interpreter`) and it runs
interpreted too. Measured here, 1500 independently moving meshes:

| Mode | Frame rate | Core tick |
|---|---|---|
| JIT (the default) | 120 fps | a fraction of a millisecond |
| interpreter (`SPATIAL_INTERPRETER=1`, and visionOS) | ~83 fps | ~3.7 ms |

`GET /stats` reports `jit`, so a saved measurement always says which mode
produced it — never compare across the two. What this means in practice: the
per-frame JavaScript you write is the visionOS budget. Precompute, avoid
allocating in `onFrame`, prefer moving a parent group over moving a thousand
children, and mark static scenery static.

**Cheaper choices:** lower segment counts on spheres and cylinders; `visible =
false` instead of destroy-and-recreate for something that comes back; a
`ParticleEmitter` instead of many small meshes; primitive rigid-body shapes
(`box`, `sphere`, `capsule`) instead of `convex` or `mesh`; shadows only on the
lights and meshes that need them; and swapping `mesh.geometry` between prebuilt
geometries rather than rewriting a vertex buffer every frame.

**Measure, do not guess.**

```bash
node perf/check.mjs                                  # asserts the SPEC 12 targets
perf/measure.sh --count 1500 --shared-geometry       # one ad-hoc measurement
node perf/gen-stress.mjs --count 1500 --shared-geometry --shared-material > stress.js
```

`gen-stress.mjs` flags: `--count N`, `--shared-geometry`, `--shared-material`,
`--static`, `--shadows`, `--physics`; the defaults are the hard case. Comparing
two authoring choices is one `measure.sh` run each.

---

## Reading `GET /stats`

`curl -s http://127.0.0.1:8787/stats | jq` reports the last 120 frames.

| Field | Reads high when |
|---|---|
| `coreTickMs` | your `onFrame` does too much, or too many objects changed. This is the number that grows ~10× on visionOS, where there is no JIT |
| `applyMs` | a big command batch landed: a geometry re-emission, a material change on a widely shared material, a burst of creates |
| `frameIntervalMs` | 8.3 ms is 120 Hz, 16.7 ms is 60 Hz. If `coreTickMs + applyMs` is far below the interval, the renderer is the limit, not the script |
| `commandCount` | should be **1** in the steady state of a moving scene. A steady 2+ means something is re-emitting every frame — a material tweaked in `onFrame`, a geometry mutated, a body respecced |
| `entityCount` | should track `dump().objects.length`. Growing without bound means missing `destroy` calls |
| `pushToFirstFrameMs` | unique geometries and materials. Under 1000 ms for 1500 meshes is the target; 0.2 s is what sharing gets you |
| `resourceCache.meshBuilds` / `materialBuilds` | climbing every frame means you are constructing geometries or materials in a loop. With sharing they should stop at 1 |

If `frameIntervalMs` spikes exactly when you poll, you are polling a full
`/dump`. Add `?objects=0`, `?compact=1` or `?names=…`; identical requests are
served from a 100 ms cache, so a tight loop then costs one build per 100 ms.

---

## Backend differences that look like bugs

| You see | It is |
|---|---|
| `hoverEffect` does nothing on macOS or web | by design — accepted with no visual, silently; `capabilities.hoverEffect` is `false` |
| `hoverEffect: "lift"` looks like `"highlight"` on visionOS | expected; the SDK has spotlight, highlight and shader only. Warned once |
| `manipulable` does nothing on macOS | expected; `ManipulationComponent` is visionOS only. Warned once, `capabilities.manipulation` is `false` |
| `renderOrder` does nothing on macOS | expected; `ModelSortGroupComponent` is visionOS only. Warned once |
| `Spatial.input.hands.left` is `null` | expected on macOS and web; always null-check |
| an anchor never anchors on macOS | expected; it sits at the world origin, `isAnchored` stays `false`, `capabilities.anchors` is `false` |
| an unlit scene is black in the browser too | expected, and deliberate: the web consumer used to invent a key light and no longer does, so the two backends agree. Warned once |
| a metallic object is lit on RealityKit and black on the web with only an `AmbientLight` | expected; RealityKit's ambient is an image-based light |
| `.exr` environment ignored in the browser | expected; `.exr` is RealityKit only. Warned once |
| `Portal.crossing` ignored in the browser | expected. Warned once |
| a `Group` or plain mesh has no `CollisionComponent` in the native dump | expected; RealityKit builds shapes lazily. One `Spatial.raycast` materialises them all |
| `audio.playing` never becomes `true` in a headless dump | expected; playback state is native-driven and there is no engine. Verify in the macOS host or the browser harness |
| a spatial sound's cone sounds broader on RealityKit | expected; RealityKit directivity is a single beam, so the three-part cone collapses to it |
| a scripted camera does nothing on visionOS | expected; `capabilities.camera` is `false` there. Warned once |
| `hit.sceneUnderstanding` is always `false` | expected today: RealityKit does not report real-world raycast hits yet |
| `Spatial.host.functions` is empty | the app registered none; `capabilities.hostFunctions` can still read `true` |
| a portal on the web shows the world from your own viewpoint, not mirrored | expected, and deliberate: a portal is a window on both backends. An earlier build used a mirrored camera and disagreed with RealityKit |
| a particle preset looks different in detail between backends | expected; the web presets are hand-tuned to match the RealityKit ones by eye, not by parameter |
| `dump()` is slower than you expected | expected on a large scene; narrow it with `compact`, `names`, `fields` or `objects: false`. `native-dump` is roughly seven times dearer again — never poll it unfiltered |
| the macOS host is much slower than usual and `/stats` says `"jit": false` | expected: it was launched in interpreter mode, which is the visionOS-like measurement |
| `groundingShadow` warns in the browser harness | expected; RealityKit only |
| a wireframe material renders solid on RealityKit | expected; warned once |
| additive blending looks like plain transparency on RealityKit | expected; warned once |
| a point light casts no shadow | expected on every backend; warned once |
| physics settles differently between the app and the browser | expected; parity is structural, not numerical |
| text looks slightly different between backends | expected; RealityKit regenerates glyphs natively, the web uses the core's vertices |
| `dump()` colours do not match the hex you passed | expected; the dump carries linear sRGB in 0..1, matching the command stream |
| `dump()` and `native-dump` disagree on a property a backend ignores | expected; the native dump reports what was actually installed |
| `dump()` and `native-dump` disagree on transform, hierarchy, material or light | **not** expected — that is a real consumer bug. Run the [parity gate](../README.md#the-parity-gate), which diffs both backends' core and native dumps and writes `issues.json` |
