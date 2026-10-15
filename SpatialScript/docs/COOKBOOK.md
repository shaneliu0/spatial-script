# SpatialScript cookbook

Complete, runnable scripts for the tasks that come up. Every recipe is a whole
script: paste it into a file, push it with
`curl --data-binary @file.js http://127.0.0.1:8787/script`, and it runs.

Each recipe says **what you should see** and **which dump fields confirm it**,
so a scene can be verified without looking at the screen.

Reference: [API.md](./API.md). Coming from three.js: [DIFFERENCES.md](./DIFFERENCES.md).
Something wrong: [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## Contents

1. [A lit scene with a floor](#1-a-lit-scene-with-a-floor)
2. [Tappable and draggable](#2-tappable-and-draggable)
3. [Hover highlight](#3-hover-highlight)
4. [Keyboard-driven movement](#4-keyboard-driven-movement)
5. [Dropping bodies with collision events](#5-dropping-bodies-with-collision-events)
6. [A pendulum with a joint](#6-a-pendulum-with-a-joint)
7. [A trigger volume](#7-a-trigger-volume)
8. [Particles bursting on tap](#8-particles-bursting-on-tap)
9. [A portal into another world](#9-a-portal-into-another-world)
10. [A billboarded text label](#10-a-billboarded-text-label)
11. [Keyframe animation with AnimationMixer](#11-keyframe-animation-with-animationmixer)
12. [Opacity fade with timers](#12-opacity-fade-with-timers)
13. [Loading a USDZ or GLB asset](#13-loading-a-usdz-or-glb-asset)
14. [Spawning and destroying over time](#14-spawning-and-destroying-over-time)
15. [Nested hierarchies with attach](#15-nested-hierarchies-with-attach)
16. [Reading the scene back with dump and find](#16-reading-the-scene-back-with-dump-and-find)
17. [Verifying a scene with inject and the dump](#17-verifying-a-scene-with-inject-and-the-dump)
18. [Anchoring to a hand or plane, with a macOS fallback](#18-anchoring-to-a-hand-or-plane-with-a-macos-fallback)
19. [Swapping and releasing a texture](#19-swapping-and-releasing-a-texture)
20. [Static scenery with the matrixAutoUpdate hint](#20-static-scenery-with-the-matrixautoupdate-hint)
21. [Polling a scene cheaply with a compact dump](#21-polling-a-scene-cheaply-with-a-compact-dump)

**Phase 2**

22. [A tapped sound with a positional source and mix groups](#22-a-tapped-sound-with-a-positional-source-and-mix-groups)
23. [A video screen that plays and pauses on tap](#23-a-video-screen-that-plays-and-pauses-on-tap)
24. [A scripted camera orbit and the pointer's scene position](#24-a-scripted-camera-orbit-and-the-pointers-scene-position)
25. [A character walking over a floor with force fields](#25-a-character-walking-over-a-floor-with-force-fields)
26. [Posing a loaded rig's joint and blend shape](#26-posing-a-loaded-rigs-joint-and-blend-shape)
27. [A shader graph material with a fallback](#27-a-shader-graph-material-with-a-fallback)
28. [Game controller polling with injected state](#28-game-controller-polling-with-injected-state)
29. [Preserving state across a hot reload](#29-preserving-state-across-a-hot-reload)
30. [Calling a host function and exchanging host events](#30-calling-a-host-function-and-exchanging-host-events)
31. [A multi-material mesh](#31-a-multi-material-mesh)

---

## 1. A lit scene with a floor

The base every other recipe builds on: ambient fill, a key light that casts
shadows, a floor that receives them, and one object.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, PlaneGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight,
} = Spatial;

const scene = new Scene();

// Ambient fill so nothing is pure black. RealityKit turns this into a uniform
// image-based light; three.js uses its own AmbientLight.
const ambient = new AmbientLight(0xffffff, 0.35);
ambient.name = "ambient";
scene.add(ambient);

// The key light. Directional intensity is in three.js units (2-5 for a sun);
// the RealityKit consumer multiplies by 1000 to get lux.
const sun = new DirectionalLight(0xfff4e6, 2.5);
sun.name = "sun";
sun.position.set(0.6, 1.2, 0.8);
sun.castShadow = true;
scene.add(sun);

const floor = new Mesh(
  new PlaneGeometry(0.9, 0.9),
  new MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.9 }),
);
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;   // a PlaneGeometry faces +Z; lay it flat
floor.position.y = -0.2;
floor.receiveShadow = true;
scene.add(floor);

const cube = new Mesh(
  new BoxGeometry(0.16, 0.16, 0.16),
  new MeshStandardMaterial({ color: 0x3366ff, roughness: 0.35, metalness: 0.1 }),
);
cube.name = "cube";
cube.castShadow = true;
scene.add(cube);

Spatial.onFrame((deltaTime) => { cube.rotation.y += deltaTime * 0.8; });

Spatial.mount(scene);
```

**Expect:** a blue cube turning slowly above a dark grey floor, with a soft
shadow beneath it.

**Confirm in the dump:** `objects` contains `ambient`, `sun`, `floor`, `cube`;
`floor.receiveShadow === true`; `cube.castShadow === true`;
`sun.light.castShadow === true` and `sun.light.direction` points down-ish;
`warnings` and `errors` are empty.

---

## 2. Tappable and draggable

Registering a listener is what makes an object an input target. The script owns
the position of a dragged object — the consumer only reports the world-space
displacement since `dragstart`.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, SphereGeometry, PlaneGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, Color, Vector3,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.4));
const key = new DirectionalLight(0xffffff, 2.5);
key.position.set(0.5, 1, 0.7);
key.castShadow = true;
scene.add(key);

const floor = new Mesh(new PlaneGeometry(0.9, 0.9), new MeshStandardMaterial({ color: 0x24272c }));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.22;
floor.receiveShadow = true;
scene.add(floor);

const ball = new Mesh(
  new SphereGeometry(0.08, 28, 20),
  new MeshStandardMaterial({ color: 0xff7744, roughness: 0.3, metalness: 0.3 }),
);
ball.name = "ball";
ball.castShadow = true;
ball.userData.taps = 0;
scene.add(ball);

ball.addEventListener("tap", (event) => {
  ball.userData.taps += 1;
  ball.userData.lastTapPoint = event.point.toArray();
  ball.material.color.copy(new Color().setHSL(Math.random(), 0.65, 0.55));
});

// translation is the displacement since dragstart, not since the last event,
// so anchor to the position the drag began at.
const dragOrigin = new Vector3();

ball.addEventListener("dragstart", () => {
  dragOrigin.copy(ball.position);
  ball.opacity = 0.65;
});
ball.addEventListener("drag", (event) => {
  ball.position.copy(dragOrigin).add(event.translation);
});
ball.addEventListener("dragend", (event) => {
  ball.opacity = 1;
  ball.userData.dragDistance = event.translation.length();
});

Spatial.mount(scene);
```

**Expect:** clicking (macOS/web) or pinching (visionOS) the ball recolours it;
dragging moves it 1:1 with the pointer and fades it while held.

**Confirm in the dump:** `ball.interactive` is `{ tap: true, hover: false,
drag: true }`; after a tap `ball.userData.taps` increases and
`userData.lastTapPoint` is a world point; after a drag `ball.position` has
moved and `userData.dragDistance` is set; `ball.opacity` returns to `1`.

---

## 3. Hover highlight

Two layers of feedback: a material change your script controls everywhere, and
the system `hoverEffect`, which is a real visual only on visionOS.

```js runnable
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, DirectionalLight } = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const key = new DirectionalLight(0xffffff, 2.4);
key.position.set(0.4, 1, 0.6);
scene.add(key);

const BASE = 0x3b6fd4;
const HOVER = 0x7fb0ff;

const box = new Mesh(new BoxGeometry(0.14, 0.14, 0.14), new MeshStandardMaterial({ color: BASE, roughness: 0.4 }));
box.name = "box";
box.userData.hovering = false;
scene.add(box);

box.addEventListener("hoverenter", () => {
  box.userData.hovering = true;
  box.material.color.set(HOVER);
  box.material.emissive.set(0x223355);
  box.scale.setScalar(1.12);
  // visionOS only; accepted with no visual on macOS and web, and no warning.
  box.hoverEffect = "highlight";
});

box.addEventListener("hoverexit", () => {
  box.userData.hovering = false;
  box.material.color.set(BASE);
  box.material.emissive.set(0x000000);
  box.scale.setScalar(1);
  box.hoverEffect = null;
});

Spatial.mount(scene);
```

**Expect:** the box brightens, glows faintly and grows ~12% while the pointer
or gaze is on it, and returns when it leaves.

**Confirm in the dump:** `box.interactive.hover === true`; while hovering,
`box.userData.hovering === true`, `box.hoverEffect === "highlight"`, and
`box.scale` is `[1.12, 1.12, 1.12]`. Drive it without a pointer with
`Spatial.inject.hover("box", true)`.

---

## 4. Keyboard-driven movement

Polled input, read inside `onFrame`. `isDown` is level, `wasPressed` is an edge
that is true for exactly one frame.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, PlaneGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, Color, Vector3,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.4));
const key = new DirectionalLight(0xffffff, 2.5);
key.position.set(0.5, 1, 0.7);
key.castShadow = true;
scene.add(key);

const floor = new Mesh(new PlaneGeometry(0.9, 0.9), new MeshStandardMaterial({ color: 0x24272c }));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.2;
floor.receiveShadow = true;
scene.add(floor);

const rover = new Mesh(new BoxGeometry(0.09, 0.05, 0.12), new MeshStandardMaterial({ color: 0x44dd99 }));
rover.name = "rover";
rover.position.set(0, -0.17, 0);
rover.castShadow = true;
scene.add(rover);

const SPEED = 0.35;      // metres per second
const BOUND = 0.38;
const velocity = new Vector3();

Spatial.onFrame((deltaTime) => {
  const keyboard = Spatial.input.keyboard;

  velocity.set(0, 0, 0);
  if (keyboard.isDown("KeyW")) velocity.z -= 1;
  if (keyboard.isDown("KeyS")) velocity.z += 1;
  if (keyboard.isDown("KeyA")) velocity.x -= 1;
  if (keyboard.isDown("KeyD")) velocity.x += 1;

  if (velocity.lengthSq() > 0) {
    velocity.normalize().multiplyScalar(SPEED * deltaTime);
    rover.position.add(velocity);
    rover.position.x = Math.max(-BOUND, Math.min(BOUND, rover.position.x));
    rover.position.z = Math.max(-BOUND, Math.min(BOUND, rover.position.z));
    rover.rotation.y = Math.atan2(velocity.x, velocity.z);
  }

  // An edge, true for one frame only.
  if (keyboard.wasPressed("Space")) {
    rover.material.color.copy(new Color().setHSL(Math.random(), 0.65, 0.55));
    rover.userData.repaints = (rover.userData.repaints || 0) + 1;
  }
});

Spatial.mount(scene);
```

**Expect:** WASD drives the green box around the floor, turning to face its
direction of travel; Space repaints it.

**Confirm in the dump:** `rover.position` changes while a key is held;
`rover.userData.repaints` counts Space presses. Drive it headlessly with
`Spatial.inject.key("KeyW", true)` then `Spatial.inject.key("KeyW", false)`.

---

## 5. Dropping bodies with collision events

A static floor, three dynamic bodies, and a `collisionstart` listener. A
collision is one event about a pair: **both** objects receive it, each with
itself as `target` and the other as `other`.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, BoxGeometry, SphereGeometry, CapsuleGeometry,
  MeshStandardMaterial, AmbientLight, DirectionalLight, RigidBody, Vector3,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.4));
const sun = new DirectionalLight(0xffffff, 2.5);
sun.position.set(0.5, 1.2, 0.6);
sun.castShadow = true;
scene.add(sun);

Spatial.physics.gravity.set(0, -9.81, 0);

const floor = new Mesh(new BoxGeometry(0.7, 0.02, 0.7), new MeshStandardMaterial({ color: 0x33383f }));
floor.name = "floor";
floor.position.y = -0.25;
floor.receiveShadow = true;
// A box shape for a static floor: "mesh" also works for static bodies, but a
// primitive shape is cheaper. "mesh" on a dynamic body throws.
floor.rigidBody = new RigidBody({ type: "static", shape: "box", friction: 0.8, restitution: 0.1 });
scene.add(floor);

const droppers = new Group();
droppers.name = "droppers";
scene.add(droppers);

function drop(name, geometry, color, position, options) {
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color, roughness: 0.4 }));
  mesh.name = name;
  mesh.position.copy(position);
  mesh.castShadow = true;
  mesh.rigidBody = new RigidBody({ type: "dynamic", mass: 1, ...options });
  mesh.userData.landed = false;
  droppers.add(mesh);

  mesh.addEventListener("collisionstart", (event) => {
    const other = event.other ? event.other.name : "unknown";
    if (other === "floor") mesh.userData.landed = true;
    mesh.userData.lastImpulse = event.impulse;
  });

  // Tapping a body kicks it upward. Never write .position on a dynamic body
  // to move it: that is a teleport and zeroes the velocity.
  mesh.addEventListener("tap", () => mesh.rigidBody.applyImpulse(new Vector3(0, 1.4, 0)));
  return mesh;
}

drop("crate", new BoxGeometry(0.09, 0.09, 0.09), 0x3366ff, new Vector3(-0.14, 0.22, 0), { restitution: 0.25 });
drop("bouncer", new SphereGeometry(0.055, 24, 18), 0xff5544, new Vector3(0.02, 0.3, 0.05), { restitution: 0.75, mass: 0.6 });
drop("pill", new CapsuleGeometry(0.04, 0.07, 6, 16), 0x44dd99, new Vector3(0.16, 0.26, -0.05), { restitution: 0.2 });

Spatial.mount(scene);
```

**Expect:** three shapes fall, bounce with different restitutions, and settle
on the slab. Tapping one launches it.

**Confirm in the dump:** each body's `rigidBody.type === "dynamic"` and
`rigidBody.shape` is the resolved shape (`"box"`, `"sphere"`, `"capsule"`);
after a second of ticks, each `position[1]` is lower than it started and
`userData.landed === true`; `velocity` approaches zero and `isSleeping` becomes
`true` once they rest. Do **not** assert exact positions — RealityKit and
Rapier trajectories differ.

---

## 6. A pendulum with a joint

A static hinge, a dynamic bob, and a revolute joint between them. Anchors are
local offsets on each body.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, CylinderGeometry, SphereGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, RigidBody, Joint, Vector3,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const sun = new DirectionalLight(0xffffff, 2.5);
sun.position.set(0.5, 1.2, 0.6);
sun.castShadow = true;
scene.add(sun);

const hinge = new Mesh(
  new CylinderGeometry(0.012, 0.012, 0.05, 12),
  new MeshStandardMaterial({ color: 0x8899aa, metalness: 0.8, roughness: 0.3 }),
);
hinge.name = "hinge";
hinge.rotation.z = Math.PI / 2;
hinge.position.set(0, 0.25, 0);
hinge.rigidBody = new RigidBody({ type: "static", shape: "capsule" });
scene.add(hinge);

const bob = new Mesh(
  new SphereGeometry(0.045, 24, 18),
  new MeshStandardMaterial({ color: 0xffcc33, metalness: 0.5, roughness: 0.25 }),
);
bob.name = "bob";
bob.position.set(0, 0.07, 0);       // 0.18 m below the hinge
bob.castShadow = true;
bob.rigidBody = new RigidBody({ type: "dynamic", mass: 1.5, restitution: 0.1, linearDamping: 0.05 });
scene.add(bob);

const pendulum = new Joint({
  type: "revolute",
  bodyA: hinge,
  bodyB: bob,
  anchorA: new Vector3(0, 0, 0),      // the hinge's own centre
  anchorB: new Vector3(0, 0.18, 0),   // the top of the bob's "rod"
  axis: new Vector3(0, 0, 1),         // swings in the XY plane
  limits: null,                       // [min, max] radians to clamp the swing
});
Spatial.physics.add(pendulum);

bob.addEventListener("tap", () => bob.rigidBody.applyImpulse(new Vector3(0.9, 0.8, 0)));

Spatial.mount(scene);
```

**Expect:** the yellow ball hangs below the hinge and swings when tapped,
losing amplitude to damping.

**Confirm in the dump:** `joints` has one entry with `type: "revolute"`,
`bodyA`/`bodyB` matching the hinge's and bob's ids, `axis: [0, 0, 1]`, and
`anchorB: [0, 0.18, 0]`. The bob's `worldPosition` stays roughly 0.18 m from
the hinge's.

---

## 7. A trigger volume

`isTrigger: true` gives a collision-only volume: no mass, no falling, no
pushing and never pushed. Its `type`, `mass` and `gravity` are ignored, so it
stays wherever you put it whatever you write there.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, RigidBody,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.4, 1, 0.6);
scene.add(sun);

const floor = new Mesh(new BoxGeometry(0.7, 0.02, 0.7), new MeshStandardMaterial({ color: 0x33383f }));
floor.name = "floor";
floor.position.y = -0.3;
floor.rigidBody = new RigidBody({ type: "static", shape: "box" });
scene.add(floor);

// The volume itself: visible only so the recipe is easy to watch. In a real
// scene give it an OcclusionMaterial or visible = false.
const zone = new Mesh(
  new BoxGeometry(0.24, 0.12, 0.24),
  new MeshStandardMaterial({ color: 0x33ff99, transparent: true, opacity: 0.18 }),
);
zone.name = "zone";
zone.position.set(0, -0.05, 0);
// isTrigger wins: type, mass and gravity are ignored on a trigger.
zone.rigidBody = new RigidBody({ shape: "box", isTrigger: true });
zone.userData.inside = 0;
scene.add(zone);

zone.addEventListener("collisionstart", (event) => {
  zone.userData.inside += 1;
  zone.userData.lastEntered = event.other ? event.other.name : null;
  zone.material.color.set(0xffcc33);
});

zone.addEventListener("collisionend", (event) => {
  zone.userData.inside = Math.max(0, zone.userData.inside - 1);
  zone.userData.lastLeft = event.other ? event.other.name : null;
  if (zone.userData.inside === 0) zone.material.color.set(0x33ff99);
});

const ball = new Mesh(new SphereGeometry(0.045, 20, 14), new MeshStandardMaterial({ color: 0xff5544 }));
ball.name = "ball";
ball.position.set(0, 0.35, 0);
ball.rigidBody = new RigidBody({ type: "dynamic", mass: 0.5, restitution: 0.4 });
scene.add(ball);

Spatial.mount(scene);
```

**Expect:** the ball falls straight **through** the green box — it is not
pushed — turning the box amber while it is inside, then lands on the slab.

**Confirm in the dump:** `zone.rigidBody.isTrigger === true`. Note the dump
echoes `type: "dynamic"` and `mass: 1` — the values you did not set — because it
reports what you wrote, not the ignored effective values; the trigger still
never moves. While the ball passes through, `zone.userData.inside >= 1`
and `userData.lastEntered === "ball"`; afterwards `inside` returns to `0` and
`userData.lastLeft === "ball"`. The ball's `position[1]` keeps decreasing while
crossing the zone — proof that a trigger does not push.

---

## 8. Particles bursting on tap

A cone emitter that idles quietly and fires `burstCount` particles when its
base is tapped.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, SphereGeometry, MeshStandardMaterial, AmbientLight,
  DirectionalLight, ParticleEmitter, Vector3,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.35));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

const sparks = new ParticleEmitter({
  shape: "cone",
  shapeSize: new Vector3(0.03, 0.03, 0.03),
  birthRate: 60,           // the idle trickle
  lifetime: 1.1,
  lifetimeVariation: 0.3,
  speed: 0.35,
  speedVariation: 0.15,
  size: 0.008,
  sizeVariation: 0.004,
  color: 0xffaa33,
  colorEnd: 0xff2200,
  opacity: 1,              // the particle's start opacity, not Object3D.opacity
  opacityEnd: 0,
  spreadAngle: 0.45,       // radians, cone half-angle
  acceleration: new Vector3(0, -0.35, 0),
  loops: true,
  burstCount: 60,          // how many one burst() emits
});
sparks.name = "sparks";
sparks.position.set(0, -0.05, 0);
scene.add(sparks);

const base = new Mesh(
  new SphereGeometry(0.03, 20, 14),
  new MeshStandardMaterial({ color: 0x442200, emissive: 0xaa4400, emissiveIntensity: 2 }),
);
base.name = "base";
base.position.copy(sparks.position);
base.userData.bursts = 0;
scene.add(base);

base.addEventListener("tap", () => {
  sparks.burst();
  base.userData.bursts += 1;
});

Spatial.mount(scene);
```

**Expect:** a thin orange plume rising and fading to red; tapping the glowing
base throws a thick puff of 60 particles.

**Confirm in the dump:** the `sparks` entry has a `particles` object with
`shape: "cone"`, `birthRate: 60`, `burstCount: 60`, `isEmitting: true`, and
linear-sRGB `color`/`colorEnd` arrays; `base.interactive.tap === true` and
`base.userData.bursts` counts taps. A burst itself is a one-shot command and
leaves no dump state.

---

## 9. A portal into another world

The world group is added to the scene like anything else; the consumer marks it
so it renders **only** through the portal.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, SphereGeometry, TorusGeometry, PlaneGeometry,
  MeshStandardMaterial, AmbientLight, PointLight, Portal,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.35));

// The other world. It MUST sit behind the portal plane from the viewer's
// position: a RealityKit portal is a window, and content in front of or beside
// the plane renders black.
const otherWorld = new Group();
otherWorld.name = "otherWorld";
otherWorld.position.set(0, 0, -0.8);
scene.add(otherWorld);

const worldLight = new PointLight(0x66ddff, 4, 2, 2);
worldLight.name = "worldLight";
worldLight.position.set(0, 0.2, 0.1);
otherWorld.add(worldLight);

const worldFloor = new Mesh(new PlaneGeometry(0.6, 0.6), new MeshStandardMaterial({ color: 0x113344 }));
worldFloor.name = "worldFloor";
worldFloor.rotation.x = -Math.PI / 2;
worldFloor.position.y = -0.18;
otherWorld.add(worldFloor);

const orb = new Mesh(
  new SphereGeometry(0.07, 28, 20),
  new MeshStandardMaterial({ color: 0x22ffcc, emissive: 0x0a4d3f, metalness: 0.5, roughness: 0.2 }),
);
orb.name = "orb";
otherWorld.add(orb);

const ring = new Mesh(
  new TorusGeometry(0.13, 0.012, 12, 40),
  new MeshStandardMaterial({ color: 0x88aaff, metalness: 0.8, roughness: 0.2 }),
);
ring.name = "ring";
ring.rotation.x = Math.PI / 2;
otherWorld.add(ring);

const doorway = new Portal({ width: 0.3, height: 0.4, world: otherWorld, crossing: false });
doorway.name = "doorway";
doorway.position.set(0, 0.02, -0.3);
scene.add(doorway);

Spatial.onFrame((deltaTime, elapsed) => {
  orb.position.y = Math.sin(elapsed * 1.2) * 0.05;
  ring.rotation.z += deltaTime * 0.5;
});

Spatial.mount(scene);
```

**Expect:** a 0.3 × 0.4 m rectangle floating ahead, showing a cyan orb bobbing
over a dark blue floor inside a rotating ring. Nothing of that world is visible
outside the rectangle.

**Confirm in the dump:** the `doorway` entry has
`portal: { worldId, width: 0.3, height: 0.4, crossing: false }`, and the
`otherWorld` entry has `world: true`. If the portal renders black, check that
`otherWorld.position.z` is more negative than `doorway.position.z`.

---

## 10. A billboarded text label

`TextGeometry` generates a glyph run starting at the origin, so centre it on
its own bounds, and set `billboard = true` so it always faces the viewer.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, BoxGeometry, TextGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

const subject = new Mesh(new BoxGeometry(0.14, 0.14, 0.14), new MeshStandardMaterial({ color: 0x3366ff }));
subject.name = "subject";
scene.add(subject);

const labels = new Group();
labels.name = "labels";
labels.position.set(0, 0.16, 0);
scene.add(labels);

const labelMaterial = new MeshStandardMaterial({ color: 0xffffff, emissive: 0x333333, roughness: 0.4 });
let label = null;

function setLabel(text) {
  const geometry = new TextGeometry(text, { size: 0.035, depth: 0.006 });
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  // The run starts at the origin and extends to +X; recentre it.
  geometry.translate(-(bounds.max.x + bounds.min.x) / 2, -(bounds.max.y + bounds.min.y) / 2, 0);

  if (label === null) {
    label = new Mesh(geometry, labelMaterial);
    label.name = "label";
    label.billboard = true;
    labels.add(label);
  } else {
    label.geometry.dispose();
    label.geometry = geometry;   // assigning a geometry re-emits it
  }
  label.userData.text = text;
}

setLabel("READY");
subject.addEventListener("tap", () => setLabel("TAPPED"));

Spatial.mount(scene);
```

**Expect:** the word READY hovering above the cube, always square to the
viewer no matter where you stand; tapping the cube swaps it to TAPPED.

**Confirm in the dump:** the `label` entry has `billboard === true`,
`geometry.type === "TextGeometry"` and
`geometry.parameters === { text: "READY", size: 0.035, depth: 0.006, font: "default" }`;
after a tap `parameters.text === "TAPPED"` and `userData.text` matches.

---

## 11. Keyframe animation with AnimationMixer

The real three.js mixer, running inside the core. It writes to core objects, so
the frame diff sends the result to both backends with no extra plumbing. You
must call `mixer.update(deltaTime)` yourself.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, DirectionalLight,
  AnimationClip, AnimationMixer, VectorKeyframeTrack, QuaternionKeyframeTrack,
  NumberKeyframeTrack, ColorKeyframeTrack, Quaternion, Vector3, LoopRepeat,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.4));
const sun = new DirectionalLight(0xffffff, 2.4);
sun.position.set(0.5, 1.1, 0.7);
scene.add(sun);

const box = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial({ color: 0x3366ff }));
box.name = "box";
box.material.transparent = true;    // needed for .material.opacity to have effect
scene.add(box);

const DURATION = 4;

const position = new VectorKeyframeTrack(
  ".position",
  [0, 1, 2, 3, 4],
  [-0.22, -0.1, 0, -0.11, 0.14, 0, 0, -0.1, 0, 0.11, 0.14, 0, 0.22, -0.1, 0],
);

// Rotation is animated through .quaternion, never .rotation.
const spin = (angle) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle);
const keys = [spin(0), spin(Math.PI / 2), spin(Math.PI), spin((3 * Math.PI) / 2), spin(2 * Math.PI - 0.001)];
const quaternionValues = [];
for (const q of keys) quaternionValues.push(q.x, q.y, q.z, q.w);
const rotation = new QuaternionKeyframeTrack(".quaternion", [0, 1, 2, 3, 4], quaternionValues);

const fade = new NumberKeyframeTrack(".material.opacity", [0, 2, 4], [1, 0.45, 1]);
const tint = new ColorKeyframeTrack(".material.color", [0, 2, 4], [0.04, 0.15, 1, 1, 0.2, 0.4, 0.04, 0.15, 1]);

const clip = new AnimationClip("bounce", DURATION, [position, rotation, fade, tint]);
const mixer = new AnimationMixer(box);
const action = mixer.clipAction(clip);
action.setLoop(LoopRepeat, Infinity);
action.play();

Spatial.onFrame((deltaTime) => mixer.update(deltaTime));

Spatial.mount(scene);
```

**Expect:** the cube arcing left to right in a four-second loop, spinning once
per pass, fading to 45% at the midpoint and shifting blue → red → blue.

**Confirm in the dump:** `box.position` and `box.quaternion` change every
frame; `box.material.opacity` dips toward `0.45` around `elapsed % 4 === 2`;
`box.material.transparent === true`. If the box does not move, you forgot
`mixer.update(deltaTime)`.

---

## 12. Opacity fade with timers

`Object3D.opacity` fades an object **and its whole subtree** without touching
any material. Timers are driven by frame ticks, not by a host event loop.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, MathUtils,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const sun = new DirectionalLight(0xffffff, 2.3);
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

// One opacity value covers the group and everything under it.
const card = new Group();
card.name = "card";
scene.add(card);

const panel = new Mesh(new BoxGeometry(0.24, 0.16, 0.01), new MeshStandardMaterial({ color: 0xaa66ff }));
panel.name = "panel";
card.add(panel);

const pip = new Mesh(new SphereGeometry(0.02, 16, 12), new MeshStandardMaterial({ color: 0xffcc33 }));
pip.name = "pip";
pip.position.set(0.08, 0.05, 0.01);
card.add(pip);

let target = 0.15;
card.opacity = 1;

// A repeating timer flips the target; onFrame eases toward it.
const flip = setInterval(() => { target = target === 1 ? 0.15 : 1; }, 1200);

Spatial.onFrame((deltaTime) => {
  card.opacity = MathUtils.damp(card.opacity, target, 4, deltaTime);
});

// A one-shot timer stops the pulsing and settles fully opaque.
setTimeout(() => {
  clearInterval(flip);
  target = 1;
  card.userData.settled = true;
}, 6000);

Spatial.mount(scene);
```

**Expect:** the purple card and its yellow pip fade together, in and out, every
1.2 s; after six seconds they settle fully opaque.

**Confirm in the dump:** `card.opacity` moves between about `0.15` and `1`
while `panel.opacity` and `pip.opacity` stay at `1` — the whole-object opacity
is inherited by the consumer, not multiplied into the children's values. After
six seconds `card.userData.settled === true`.

---

## 13. Loading a USDZ or GLB asset

Supply **both** keys so one script runs on both backends: RealityKit loads
`usdz`/`reality`, the web consumer loads `glb`/`gltf`, and each ignores the
other's. Mount before awaiting so the scene is live while the asset loads.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.5, 1, 0.8);
sun.castShadow = true;
scene.add(sun);

const holder = new Group();
holder.name = "holder";
scene.add(holder);

// A stand-in so the scene is never empty, removed once the asset arrives.
const placeholder = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0x444a55 }));
placeholder.name = "placeholder";
holder.add(placeholder);

Spatial.mount(scene);

try {
  const robot = await Spatial.loadAsset({
    usdz: "asset://robot.usdz",     // RealityKit
    glb: "assets/robot.glb",        // web
  });
  robot.name = "robot";
  robot.scale.setScalar(0.2);
  holder.add(robot);

  Spatial.destroy(placeholder);

  holder.userData.animations = robot.animations.slice();
  holder.userData.loaded = robot.loaded;

  if (robot.animations.includes("walk")) {
    robot.playAnimation("walk", { loop: true, speed: 1 });
  } else if (robot.animations.length > 0) {
    robot.playAnimation(robot.animations[0], { loop: true, speed: 1 });
  }
} catch (error) {
  // A missing asset is a normal outcome, not a crash. Left uncaught it would
  // become a runtime error in dump().errors.
  console.warn("asset did not load:", error.message);
  holder.userData.assetError = error.message;
  placeholder.material.color.set(0xaa3333);
}
```

**Expect:** a grey placeholder cube, replaced by the model once it loads and
walking if the asset has a `walk` clip. If the file is missing, the placeholder
turns red and stays.

**Confirm in the dump:** on success the `robot` entry has `type: "Asset"`,
`loaded: true`, an `animations` array of clip names, and an `asset` object with
your url set; `placeholder` is gone from `objects`. On failure
`holder.userData.assetError` holds the message and `errors` stays empty
because you caught it.

**Note:** native asset animations animate the asset's internal skeleton. They
do not sync transforms back, so the asset group's own transform stays yours.

---

## 14. Spawning and destroying over time

`remove` detaches; `destroy` frees the native entity. A scene that spawns and
removes without destroying leaks entities.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, MathUtils,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

const field = new Group();
field.name = "field";
scene.add(field);

// Share one geometry and one material across every spawn: both backends cache
// native resources by uuid, so this is one mesh resource and one material.
const cubeGeometry = new BoxGeometry(0.05, 0.05, 0.05);
const cubeMaterial = new MeshStandardMaterial({ color: 0x6699ff, roughness: 0.4 });

const live = [];
let spawned = 0;

function spawn() {
  const cube = new Mesh(cubeGeometry, cubeMaterial);
  cube.name = `cube-${spawned}`;
  cube.position.set(MathUtils.randFloatSpread(0.5), MathUtils.randFloat(-0.1, 0.25), MathUtils.randFloatSpread(0.3));
  cube.userData.bornAt = Spatial.time.elapsed;
  field.add(cube);
  live.push(cube);
  spawned += 1;
}

const MAX_AGE = 3;      // seconds

Spatial.onFrame((deltaTime, elapsed) => {
  if (Spatial.time.frame % 15 === 0 && live.length < 12) spawn();

  // Iterate backwards so removal does not skip an entry.
  for (let i = live.length - 1; i >= 0; i -= 1) {
    const cube = live[i];
    cube.rotation.y += deltaTime;
    if (elapsed - cube.userData.bornAt < MAX_AGE) continue;
    live.splice(i, 1);
    // destroy() detaches AND frees; scene.remove() alone would leak the entity.
    Spatial.destroy(cube);
  }

  field.userData.live = live.length;
  field.userData.spawned = spawned;
});

Spatial.mount(scene);
```

**Expect:** blue cubes appearing every quarter-second, turning, and vanishing
after three seconds, with a steady population of about a dozen.

**Confirm in the dump:** `objects` never grows past `field` plus ~12 cubes;
`field.userData.live` tracks the array; `field.userData.spawned` keeps
increasing. `Spatial.find("cube-0")` returns `null` once it has been destroyed,
and re-adding a destroyed object would throw `SpatialUnsupportedError` with
`feature: "destroyed-object"`.

---

## 15. Nested hierarchies with attach

`add` preserves the **local** transform; `attach` preserves the **world**
transform. Call `updateMatrixWorld` first so the world matrices are current.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, Vector3,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const sun = new DirectionalLight(0xffffff, 2.3);
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

// A two-level rig: turntable -> arm -> hand.
const turntable = new Group();
turntable.name = "turntable";
scene.add(turntable);

const arm = new Group();
arm.name = "arm";
arm.position.set(0.18, 0, 0);
turntable.add(arm);

const hand = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), new MeshStandardMaterial({ color: 0x44dd99 }));
hand.name = "hand";
hand.position.set(0.1, 0, 0);
arm.add(hand);

// A loose ball, positioned in world space.
const ball = new Mesh(new SphereGeometry(0.035, 20, 14), new MeshStandardMaterial({ color: 0xffcc33 }));
ball.name = "ball";
ball.position.set(0, 0.25, 0);
scene.add(ball);

Spatial.onFrame((deltaTime) => {
  turntable.rotation.y += deltaTime * 0.6;
  arm.rotation.z = Math.sin(Spatial.time.elapsed) * 0.4;

  // Pick the ball up at 1 s: attach keeps it exactly where it looks, then it
  // rides the rig. add() would have snapped it to the hand's local origin.
  if (Spatial.time.frame === 60) {
    scene.updateMatrixWorld(true);
    hand.attach(ball);
    ball.userData.attachedLocal = ball.position.toArray();
  }

  // Put it back into world space at 3 s, again without it jumping.
  if (Spatial.time.frame === 180) {
    scene.updateMatrixWorld(true);
    scene.attach(ball);
    ball.userData.releasedWorld = ball.getWorldPosition(new Vector3()).toArray();
  }
});

Spatial.mount(scene);
```

**Expect:** a rotating arm sweeping past a floating ball; at one second the
ball is grabbed without visibly moving and then rides the arm; at three seconds
it is released, again without a jump, and hangs in place.

**Confirm in the dump:** before the grab `ball.parent` is `0` (the scene root);
after it, `ball.parent` is the `hand`'s id and `ball.position` is a small
non-zero local offset while `worldPosition` is unchanged across that frame.
After the release `ball.parent` is `0` again with `worldPosition` continuous.

---

## 16. Reading the scene back with dump and find

`Spatial.dump()` gives the whole scene as a plain object; `Spatial.find(name)`
gives one object by name. Use `userData` to publish anything you want to assert
on from outside.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, DirectionalLight,
} = Spatial;

const scene = new Scene();
scene.name = "inventory";
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.name = "sun";
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

const shelf = new Group();
shelf.name = "shelf";
scene.add(shelf);

const geometry = new BoxGeometry(0.07, 0.07, 0.07);
["red", "green", "blue"].forEach((label, index) => {
  const cube = new Mesh(geometry, new MeshStandardMaterial({ color: [0xff4444, 0x44dd66, 0x4477ff][index] }));
  cube.name = label;
  cube.position.x = (index - 1) * 0.11;
  cube.userData.slot = index;
  shelf.add(cube);
});

Spatial.mount(scene);

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 5) return;

  // find() is scene.getObjectByName on the mounted scene, normalised to null.
  const green = Spatial.find("green");
  const missing = Spatial.find("purple");

  const dump = Spatial.dump();
  const names = dump.objects.map((entry) => entry.name).filter(Boolean);
  const greenEntry = dump.objects.find((entry) => entry.name === "green");

  shelf.userData.report = {
    foundGreen: green !== null,
    foundMissing: missing !== null,          // false
    objectCount: dump.objects.length,
    names,
    greenParentIsShelf: greenEntry.parent === dump.objects.find((e) => e.name === "shelf").id,
    greenSlot: greenEntry.userData.slot,
    sharedGeometry: dump.objects
      .filter((entry) => entry.geometry && entry.geometry.type === "BoxGeometry")
      .every((entry, _index, all) => entry.geometry.uuid === all[0].geometry.uuid),
    warnings: dump.warnings.length,
    errors: dump.errors.length,
  };
  console.log("report", shelf.userData.report);
});
```

**Expect:** three cubes in a row. The interesting output is in the log and in
`userData`.

**Confirm in the dump:** `shelf.userData.report.foundGreen === true`,
`foundMissing === false`, `sharedGeometry === true` (all three cubes share one
geometry `uuid`, so they are one native mesh resource), and `errors === 0`.
From outside the app: `curl -s http://127.0.0.1:8787/dump | jq '.objects[] | select(.name=="shelf") | .userData.report'`.

---

## 17. Verifying a scene with inject and the dump

`Spatial.inject` synthesises exactly the events a consumer would produce, on
every backend, with no real input. Injected events are delivered at the **start
of the next tick**, so read the result on a later frame.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, DirectionalLight, Vector3,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

const box = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial({ color: 0x3366ff }));
box.name = "box";
box.userData.taps = 0;
box.userData.hovering = false;
scene.add(box);

box.addEventListener("tap", (event) => {
  box.userData.taps += 1;
  box.userData.tapPoint = event.point.toArray();
});
box.addEventListener("hoverenter", () => { box.userData.hovering = true; });
box.addEventListener("hoverexit", () => { box.userData.hovering = false; });

const dragOrigin = new Vector3();
box.addEventListener("dragstart", () => dragOrigin.copy(box.position));
box.addEventListener("drag", (event) => box.position.copy(dragOrigin).add(event.translation));
box.addEventListener("dragend", (event) => { box.userData.dragged = event.translation.toArray(); });

Spatial.mount(scene);

// A self-verifying script: it drives its own input and records the outcome.
Spatial.onFrame(() => {
  const frame = Spatial.time.frame;
  if (frame === 5) Spatial.inject.tap("box");
  if (frame === 15) Spatial.inject.hover("box", true);
  if (frame === 25) Spatial.inject.hover("box", false);
  // steps: 5 produces dragstart, five drag events, dragend.
  if (frame === 35) Spatial.inject.drag("box", new Vector3(0.12, 0, 0), { steps: 5 });
  if (frame === 45) Spatial.inject.key("KeyW", true);
  if (frame === 55) Spatial.inject.key("KeyW", false);

  if (frame === 46) box.userData.keyDown = Spatial.input.keyboard.isDown("KeyW");
  if (frame === 60) {
    box.userData.verified =
      box.userData.taps === 1 &&
      box.userData.hovering === false &&
      Math.abs(box.position.x - 0.12) < 1e-6 &&
      box.userData.keyDown === true;
  }
});
```

**Expect:** the box recolours nothing but slides 0.12 m to the right on its
own, roughly half a second in.

**Confirm in the dump:** `box.userData.taps === 1`;
`box.userData.tapPoint` is the box's world position;
`box.userData.dragged === [0.12, 0, 0]`; `box.position[0] === 0.12`;
`box.userData.keyDown === true`; and finally `box.userData.verified === true`.

From outside the macOS host, the same thing without touching the script:

```
curl -s -X POST http://127.0.0.1:8787/inject -d '{"type":"tap","target":"box"}'
curl -s http://127.0.0.1:8787/dump | jq '.objects[] | select(.name=="box") | .userData'
```

**Caution:** injection bypasses hit testing — it dispatches straight at the
named object. A successful injected tap proves your listener works; it does not
prove the object is reachable by a real pointer. For that, check
`dump().objects[i].interactive` (now `{ tap, hover, drag, manipulation,
collision }`), check the object is a `Mesh`, and do a real click.

**When the screenshot has to match the dump**, use `POST /parity` instead: it
runs the same step plan with a fixed `dt` and then holds the final frame until
the next push, so a `screencapture` corresponds exactly to the returned dump.
`parity/run-parity.mjs` does that on the Mac and in headless Chromium at once
and diffs both dumps, both native dumps and the console:

```bash
node parity/run-parity.mjs scene.js --steps parity/steps/basics.json --label mine
```

Put the same steps in a file and the two backends are running the identical
plan — see [the parity gate](../README.md#the-parity-gate).

---

## 18. Anchoring to a hand or plane, with a macOS fallback

Only visionOS actually anchors. Branch on `Spatial.env` and give the content a
sensible local transform so the scene is still usable everywhere else.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Anchor, Group, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, Vector2,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

// Branch on the capability, not the platform string: a host may override it.
const canAnchor = Spatial.env.capabilities.anchors;   // false on macOS and web

// The content is built once and re-parented depending on the platform.
const widget = new Group();
widget.name = "widget";

const body = new Mesh(new BoxGeometry(0.06, 0.02, 0.06), new MeshStandardMaterial({ color: 0x3366ff }));
body.name = "widgetBody";
widget.add(body);

const pip = new Mesh(new SphereGeometry(0.012, 16, 12), new MeshStandardMaterial({ color: 0xffcc33 }));
pip.name = "widgetPip";
pip.position.y = 0.03;
widget.add(pip);

let host;
if (canAnchor && Spatial.env.capabilities.hands) {
  // Riding the left palm.
  host = new Anchor({ hand: "left", location: "palm" });
  host.name = "handAnchor";
} else {
  // A table anchor still exists on macOS: the entity is created but never
  // resolves, so give it a transform that puts it somewhere sensible.
  host = new Anchor({ plane: "horizontal", minimumBounds: new Vector2(0.3, 0.3) });
  host.name = "planeAnchor";
  host.position.set(0, -0.15, -0.35);
}

host.add(widget);
scene.add(host);

host.addEventListener("anchored", () => {
  host.userData.anchored = true;
  widget.visible = true;
});
host.addEventListener("unanchored", () => {
  host.userData.anchored = false;
});

host.userData.anchored = false;
host.userData.mode = canAnchor ? "hand" : "plane-fallback";

Spatial.onFrame((deltaTime) => { pip.rotation.y += deltaTime; });

Spatial.mount(scene);
```

**Expect:** on visionOS, the widget rides your left palm once hand tracking
picks it up. On macOS and web, it sits 0.35 m ahead and 0.15 m down and never
anchors — which is the intended fallback, not a failure.

**Confirm in the dump:** the anchor entry has `type: "Anchor"` and an `anchor`
object — `{ kind: "hand", hand: "left", location: "palm" }` on visionOS, or
`{ kind: "plane", plane: "horizontal", minimumBounds: [0.3, 0.3] }` elsewhere.
`isAnchored` becomes `true` only on visionOS; `userData.mode` records which
branch ran. `Spatial.env.capabilities.anchors` is **`false`** on macOS and on
the web, which is exactly what the branch above tests: on macOS the
`AnchorEntity` is created but sits at the **world origin** and never resolves,
and each anchor kind warns once (`Plane anchors never resolve on macOS; the
anchor stays at the world origin`). That is why the fallback branch sets a
`position` — without one the widget would be inside the viewer.

---

## 19. Swapping and releasing a texture

`texture.dispose()` does not free anything on its own: the release is held back
until no live material or emitter still names the texture. Repoint first, then
dispose.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, PlaneGeometry, MeshStandardMaterial, AmbientLight, DirectionalLight,
  TextureLoader, RepeatWrapping,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.6));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

const loader = new TextureLoader();

function tiled(url, repeat) {
  const texture = loader.load(
    url,
    undefined,
    undefined,
    (error) => console.warn("texture failed:", url, error.message),
  );
  // Tiling needs BOTH a repeat and a repeating wrap mode; the default
  // ClampToEdgeWrapping stretches the edge pixels instead.
  texture.repeat.set(repeat, repeat);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  return texture;
}

const grid = tiled("asset://grid.png", 2);
const wood = tiled("asset://wood.png", 4);

const material = new MeshStandardMaterial({ map: grid, roughness: 0.7 });
const panel = new Mesh(new PlaneGeometry(0.4, 0.4), material);
panel.name = "panel";
panel.userData.map = "grid";
scene.add(panel);

Spatial.mount(scene);

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 60) return;

  // 1. repoint every material that used the old texture
  material.map = wood;
  material.needsUpdate = true;

  // 2. only then dispose: the release command is emitted on the frame after
  //    nothing references it any more, and the native resource is freed then.
  grid.dispose();

  panel.userData.map = "wood";
  panel.userData.released = true;
});
```

**Expect:** a grid-tiled panel that becomes wood-tiled one second in, with the
grid texture's GPU memory returned rather than held for the life of the scene.

**Confirm in the dump:** `panel.material.maps.map` changes from the grid
texture's id to the wood texture's, and `panel.userData.map === "wood"`. In the
command stream the swap is a `material` command followed by
`["texture", <gridId>, null]` — the release. Disposing **before** repointing is
not an error but frees nothing, and the web consumer warns once
(`texture N was released while a material still references it; it is kept until
the material changes`).

On RealityKit the sampler state travels with the texture: `repeat` and `offset`
become a texture transform, `wrapS`/`wrapT` become the sampler address modes,
and `flipY: false` flips the decoded image.

---

## 20. Static scenery with the `matrixAutoUpdate` hint

Most of a scene never moves. `matrixAutoUpdate = false` tells the core so: the
matrix becomes authoritative and the object costs sixteen array compares per
frame instead of a full transform read. Measured on the development Mac in the
interpreter (the visionOS execution mode), 8000 static objects cost 22 ms per
frame without the hint and 8.4 ms with it.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, BoxGeometry, PlaneGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, MathUtils,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.4));
const sun = new DirectionalLight(0xffffff, 2.4);
sun.position.set(0.6, 1.2, 0.8);
sun.castShadow = true;
scene.add(sun);

const floor = new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ color: 0x24272c }));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.2;
floor.receiveShadow = true;
floor.updateMatrix();
floor.matrixAutoUpdate = false;      // the floor never moves either
scene.add(floor);

// ---------------------------------------------------------- static scenery

const city = new Group();
city.name = "city";
scene.add(city);

// One geometry and one material for the whole field: both consumers cache
// native resources by uuid, so this is one native mesh and one material.
const block = new BoxGeometry(0.02, 0.02, 0.02);
const stone = new MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9 });

for (let i = 0; i < 400; i += 1) {
  const tower = new Mesh(block, stone);
  tower.name = `tower-${i}`;
  tower.position.set((i % 20) * 0.03 - 0.28, -0.18, Math.floor(i / 20) * 0.03 - 0.28);
  tower.scale.y = MathUtils.randFloat(1, 6);
  tower.castShadow = true;

  // The order matters: set the transform, bake it, then turn the flag off.
  tower.updateMatrix();
  tower.matrixAutoUpdate = false;

  city.add(tower);
}

// The parent group is NOT static: moving it moves the whole field, and a
// static child's local matrix is unaffected by its parent's motion.
Spatial.onFrame((deltaTime) => {
  city.rotation.y += deltaTime * 0.15;
});

// ------------------------------------------------------- moving a static one

Spatial.onFrame(() => {
  if (Spatial.time.frame !== 60) return;
  const tower = Spatial.find("tower-0");
  // Writing position alone would do nothing: the matrix is authoritative now.
  tower.position.y += 0.05;
  tower.updateMatrix();
  city.userData.raised = true;
});

Spatial.mount(scene);
```

**Expect:** a field of 400 grey towers turning slowly as one group, with one
tower stepping up a second in. The per-frame cost is the group's single
transform, not four hundred.

**Confirm in the dump:** every `tower-*` entry has a stable `position` and a
`worldPosition` that changes as the group rotates; `city.userData.raised`
becomes `true` and `tower-0.position[1]` has moved. In `GET /stats` the steady
state stays at one command per frame.

**The trap:** after `matrixAutoUpdate = false`, writing `position`, `rotation`
or `scale` has no effect until you call `updateMatrix()` — or write `matrix`
directly. `Object.freeze` is *not* a way to say "static": a frozen object is
skipped for the rest of the session with a recorded error.

---

## 21. Polling a scene cheaply with a compact dump

A full dump of a large scene is expensive to build and to serialise. When a
script or a host is watching state rather than asserting once, ask for less.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, SphereGeometry, MeshStandardMaterial, AmbientLight, DirectionalLight,
} = Spatial;

const scene = new Scene();
scene.name = "swarm";
scene.add(new AmbientLight(0xffffff, 0.5));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.5, 1, 0.7);
scene.add(sun);

const swarm = new Group();
swarm.name = "swarm";
scene.add(swarm);

const ball = new SphereGeometry(0.02, 12, 8);
const shell = new MeshStandardMaterial({ color: 0x66aaff });

for (let i = 0; i < 60; i += 1) {
  const mote = new Mesh(ball, shell);
  mote.name = `mote-${i}`;
  mote.position.set((i % 10) * 0.06 - 0.27, Math.floor(i / 10) * 0.06 - 0.15, 0);
  swarm.add(mote);
}

const tracked = Spatial.find("mote-0");

Spatial.mount(scene);

Spatial.onFrame((deltaTime, elapsed) => {
  swarm.rotation.y += deltaTime * 0.4;

  if (Spatial.time.frame % 30 !== 0) return;

  // The cheapest health check there is: no object list at all, but every
  // top-level field, so errors and warnings still come through.
  const health = Spatial.dump({ objects: false });

  // One object, two fields: what to poll when you are watching a thing move.
  const watched = Spatial.dump({ names: ["mote-0"], fields: ["worldPosition"] });

  // The whole scene, cheaply: transforms only, rounded to four decimals.
  const compact = Spatial.dump({ compact: true });

  swarm.userData.poll = {
    frame: health.frame,
    errors: health.errors.length,
    droppedErrors: health.droppedErrors,
    watchedPosition: watched.objects[0].worldPosition,
    compactCount: compact.objects.length,
    // A compact dump of this scene is a fraction of the full one.
    fullBytes: JSON.stringify(Spatial.dump()).length,
    compactBytes: JSON.stringify(compact).length,
  };
});
```

**Expect:** a rotating grid of 60 blue motes. The interesting output is in
`userData`.

**Confirm in the dump:** `swarm.userData.poll.compactCount === 63` (the two
lights, the group and its 60 motes), `compactBytes` is a small fraction of
`fullBytes` — about 11 KB against 74 KB for this scene — and `watchedPosition`
tracks the rotation. A compact object entry has exactly
`id`, `name`, `type`, `parent`, `visible`, `position`, `quaternion`, `scale`,
`worldPosition` — no geometry, material, light, rigid body, flags or
`userData`.

From outside the macOS host the same narrowing is available as query parameters,
answered from a 100 ms cache:

```bash
curl -s 'http://127.0.0.1:8787/dump?objects=0' | jq '{frame, errors, droppedErrors}'
curl -s 'http://127.0.0.1:8787/dump?names=mote-0&fields=worldPosition' | jq '.objects[0]'
curl -s 'http://127.0.0.1:8787/dump?compact=1' | jq '.objects | length'
```

---

## 22. A tapped sound with a positional source and mix groups

`Spatial.audio` is the listener and the bus. A `PositionalAudio` parented to an
object rides its transform, so moving the mesh moves the sound.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, SphereGeometry, PlaneGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, AudioLoader, PositionalAudio, AmbientAudio,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.4));
const sun = new DirectionalLight(0xfff2e0, 2.4);
sun.position.set(0.6, 1.1, 0.8);
sun.castShadow = true;
scene.add(sun);

const floor = new Mesh(new PlaneGeometry(0.9, 0.9), new MeshStandardMaterial({ color: 0x22262c }));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.24;
floor.receiveShadow = true;
scene.add(floor);

// The mixer: a master volume every source passes through, plus named groups.
Spatial.audio.masterVolume = 0.85;
Spatial.audio.setGroupVolume("effects", 0.9);
Spatial.audio.setGroupVolume("ambience", 0.35);
// Web audio needs a user gesture; this records the intent and reports "running".
Spatial.audio.resume();

const bell = new Mesh(new SphereGeometry(0.055, 24, 16), new MeshStandardMaterial({ color: 0x4488ff, metalness: 0.4 }));
bell.name = "bell";
bell.position.set(-0.2, 0, 0);
bell.castShadow = true;
scene.add(bell);

// A source is a child of the object it belongs to.
const chime = new PositionalAudio();
chime.name = "chime";
chime.group = "effects";           // joins a mix group by name alone
chime.setVolume(0.9);
chime.setRefDistance(0.3);         // the 1 m default never attenuates in a 0.4 m scene
chime.setRolloffFactor(1.4);
chime.setDistanceModel("inverse");
chime.setDirectionalCone(60, 140, 0.25);   // degrees, aimed down the object's -Z
chime.reverbLevel = -8;                    // decibels, not a 0..1 mix
bell.add(chime);

const bed = new AmbientAudio();     // arrives from every direction
bed.name = "bed";
bed.group = "ambience";
bed.setLoop(true);
bed.setVolume(0.6);
scene.add(bed);

const loader = new AudioLoader();
loader.load(
  "asset://spatial-tone.wav",
  (buffer) => { chime.setBuffer(buffer); bed.setBuffer(buffer); bed.play(); scene.userData.loaded = buffer.url; },
  undefined,
  (error) => console.warn("tone failed:", error.message),
);

bell.addEventListener("tap", () => {
  scene.userData.taps = (scene.userData.taps || 0) + 1;
  chime.stop();
  chime.play();
});

chime.addEventListener("ended", () => { scene.userData.chimeEnded = true; });

Spatial.onFrame((deltaTime, elapsed) => {
  bell.position.x = Math.cos(elapsed * 0.7) * 0.2;
  bell.position.z = Math.sin(elapsed * 0.7) * 0.2;
  bell.lookAt(0, 0, 0);
  // Duck the bed while the effect is sounding: one call moves the whole group.
  Spatial.audio.setGroupVolume("ambience", chime.isPlaying ? 0.12 : 0.35);
});

Spatial.mount(scene);
```

**Expect:** a blue ball orbiting the origin with a looping room tone under it;
tapping the ball restarts a directional chime that pans as the ball moves, and
ducks the bed while it sounds.

**Confirm in the dump:** `audioMixer` is
`{ masterVolume: 0.85, groups: { effects: 0.9, ambience: … }, state: "running" }`;
the `chime` entry has `audio.spatial === true`, `audio.group === "effects"`,
`audio.cone === [60, 140, 0.25]`, `audio.refDistance === 0.3`; the `bed` entry
has `audio.ambient === true`. `audio.playing` and `audio.currentTime` come from
the consumer, so they stay `false`/`0` in a headless run — that is expected, not
a failure.

**The trap:** `isPlaying` is native-driven, so it is **still `false` on the frame
you call `play()`**. Toggle against it a frame later, or track your own intent.

---

## 23. A video screen that plays and pauses on tap

A `VideoScreen` is a mesh, so it hit-tests like anything else. Supply both
encodings and each backend takes the one it can decode.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, DirectionalLight, VideoScreen,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.4));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

const screen = new VideoScreen({
  url: { mp4: "asset://spatial-bars.mp4", webm: "asset://spatial-bars.webm" },
  width: 0.34,        // height follows the video's aspect once the consumer reports it
  loop: true,
  muted: false,
  autoplay: false,
});
screen.name = "screen";
screen.position.set(0, 0.05, 0);
screen.volume = 0.7;
scene.add(screen);

// A bezel, so the panel reads as a panel before the first frame arrives.
const bezel = new Mesh(new BoxGeometry(0.37, 0.23, 0.012), new MeshStandardMaterial({ color: 0x15181d }));
bezel.name = "bezel";
bezel.position.copy(screen.position);
bezel.position.z -= 0.01;
bezel.castShadow = true;
scene.add(bezel);

screen.addEventListener("loaded", (event) => {
  scene.userData.pixels = [event.width, event.height];
  scene.userData.metres = [screen.width, screen.height];
});

screen.addEventListener("error", (event) => {
  scene.userData.videoError = event.message;
  bezel.material.color.set(0x552222);
});

screen.addEventListener("tap", () => {
  // Toggle against the transport the consumer reports, not a local guess.
  if (screen.isPlaying) screen.pause();
  else screen.play();
  scene.userData.taps = (scene.userData.taps || 0) + 1;
});

screen.addEventListener("hoverenter", () => { screen.hoverEffect = "highlight"; });
screen.addEventListener("hoverexit", () => { screen.hoverEffect = null; });

Spatial.mount(scene);
```

**Expect:** a dark panel that fills with colour bars once the file loads, and
toggles between playing and paused on each tap.

**Confirm in the dump:** the `screen` entry has `type: "VideoScreen"`,
`interactive.tap === true`, and
`video: { url: { mp4, webm }, width: 0.34, height, loop: true, volume: 0.7, playing, currentTime, duration, error }`.
After the `loaded` event `userData.metres[1]` is `width × (pixelHeight /
pixelWidth)`.

**The trap:** a screen whose surviving urls the backend cannot play dispatches
`error`. Giving **only** a `webm` is a blank panel on RealityKit and vice versa.

---

## 24. A scripted camera orbit and the pointer's scene position

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 0.4));
const sun = new S.DirectionalLight(0xffffff, 2.6);
sun.position.set(0.5, 1.2, 0.7);
sun.castShadow = true;
scene.add(sun);

const floor = new S.Mesh(new S.PlaneGeometry(0.9, 0.9), new S.MeshStandardMaterial({ color: 0x23262b }));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.22;
floor.receiveShadow = true;
scene.add(floor);

const ball = new S.Mesh(new S.SphereGeometry(0.07, 28, 20), new S.MeshStandardMaterial({ color: 0xffaa33, metalness: 0.5 }));
ball.name = "ball";
ball.position.set(0.16, -0.08, 0.04);
ball.castShadow = true;
scene.add(ball);

const ring = new S.Mesh(new S.TorusGeometry(0.07, 0.014, 14, 36), new S.MeshStandardMaterial({ color: 0x44dd99 }));
ring.name = "ring";
ring.position.set(0, 0.06, -0.12);
scene.add(ring);

// Start where the consumer's own camera is, so taking over is not a jump cut.
const eye = new S.PerspectiveCamera(55, 1, 0.01, 20);
eye.name = "eye";
eye.position.set(0, 0.25, 1);
eye.lookAt(0, 0, 0);
Spatial.camera = eye;

const flat = new S.OrthographicCamera(-0.3, 0.3, 0.3, -0.3, 0.01, 20);
flat.name = "flat";
flat.position.set(0, 0.6, 0.001);
flat.lookAt(0, 0, 0);

let orthographic = false;
ring.addEventListener("tap", () => {
  orthographic = !orthographic;
  // null would hand the view back to the consumer's built-in camera.
  Spatial.camera = orthographic ? flat : eye;
  scene.userData.mode = orthographic ? "orthographic" : "perspective";
});

// A marker for where the pointer meets the scene.
const cursor = new S.Mesh(new S.SphereGeometry(0.014, 16, 12), new S.MeshBasicMaterial({ color: 0xff4477 }));
cursor.name = "cursor";
cursor.visible = false;
scene.add(cursor);

const target = new S.Vector3();

Spatial.onFrame((deltaTime, elapsed) => {
  ring.rotation.z += deltaTime * 0.9;
  ball.position.y = -0.08 + Math.sin(elapsed * 1.6) * 0.03;

  // The camera is an Object3D: move it, parent it, lookAt with it.
  const angle = elapsed * 0.25;
  eye.position.set(Math.sin(angle), 0.25 + Math.sin(elapsed * 0.4) * 0.12, Math.cos(angle));
  ball.getWorldPosition(target);
  eye.lookAt(target);

  // null on a headset, and whenever the pointer has left the window.
  const under = Spatial.input.mouse.scenePosition;
  cursor.visible = under !== null;
  if (under !== null) cursor.position.copy(under);
  scene.userData.hasPointer = under !== null;

  // Also null on visionOS and without the consumer's hook.
  const pointer = Spatial.input.mouse.position;
  const ray = pointer === null ? null : Spatial.rayFromPoint(pointer.x, pointer.y);
  scene.userData.hasRay = ray !== null;
});

Spatial.mount(scene);
```

**Expect:** the view orbits the props and keeps the ball centred; tapping the
green ring cuts to a top-down orthographic view and back; a pink dot follows the
pointer over the floor.

**Confirm in the dump:** top-level `camera` is
`{ kind: "perspective", fov: 55, near: 0.01, far: 20, … }` and becomes
`kind: "orthographic"` after the tap; the `eye` object appears in `objects` with
its own transform (the pose is **not** in the `camera` field). On visionOS
`warnings` contains `On visionOS the user is the camera…` and nothing moves.

---

## 25. A character walking over a floor with force fields

```js runnable
const Spatial = require("spatial");
const S = require("spatial");

const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 0.4));
const sun = new S.DirectionalLight(0xfff6ec, 2.6);
sun.position.set(0.5, 1.2, 0.6);
sun.castShadow = true;
scene.add(sun);

Spatial.physics.gravity.set(0, -9.81, 0);

const ground = new S.Mesh(new S.BoxGeometry(0.8, 0.02, 0.8), new S.MeshStandardMaterial({ color: 0x2c3138 }));
ground.name = "ground";
ground.position.y = -0.26;
ground.receiveShadow = true;
ground.rigidBody = new S.RigidBody({ type: "static", shape: "box", friction: 0.9 });
scene.add(ground);

// A low step, so stepLimit has something to prove.
const step = new S.Mesh(new S.BoxGeometry(0.26, 0.05, 0.14), new S.MeshStandardMaterial({ color: 0x3a4049 }));
step.name = "step";
step.position.set(0.22, -0.225, -0.2);
step.castShadow = true;
step.rigidBody = new S.RigidBody({ type: "static", shape: "box", friction: 0.9 });
scene.add(step);

const walker = new S.Mesh(new S.CapsuleGeometry(0.035, 0.09, 6, 14), new S.MeshStandardMaterial({ color: 0x5aa9ff }));
walker.name = "walker";
walker.position.set(-0.2, -0.16, 0.18);
walker.castShadow = true;
// The capsule the consumer collides with, sized to match what is drawn.
walker.characterController = new S.CharacterController({
  radius: 0.035,
  height: 0.16,
  slopeLimit: 0.7,     // radians, like every other angle
  stepLimit: 0.06,
  gravity: true,
});
scene.add(walker);

// Loose bodies for the fields to act on.
const debris = new S.Group();
debris.name = "debris";
scene.add(debris);
const pebble = new S.SphereGeometry(0.03, 18, 12);
[[0.08, -0.02, 0.06], [-0.06, 0.04, -0.05], [0.02, 0.1, 0.12]].forEach((at, i) => {
  const mesh = new S.Mesh(pebble, new S.MeshStandardMaterial({ color: [0xff8855, 0xffd166, 0x9b7bff][i] }));
  mesh.name = `pebble-${i}`;
  mesh.position.set(at[0], at[1], at[2]);
  mesh.castShadow = true;
  mesh.rigidBody = new S.RigidBody({ type: "dynamic", shape: "sphere", mass: 0.25, restitution: 0.4 });
  debris.add(mesh);
});

// Fields act on dynamic bodies within `radius` of their own world position.
const repeller = new S.RadialForceField({
  strength: 0.6,
  minimumDistance: 0.04,     // stops the force going to infinity at the centre
  falloff: "inverseSquare",
  radius: 0.3,
});
repeller.name = "repeller";
repeller.position.y = -0.1;
scene.add(repeller);

const molasses = new S.DragForceField({ coefficient: 1.6, radius: 0.45 });
molasses.name = "molasses";
molasses.position.y = -0.1;
scene.add(molasses);

const HOME = new S.Vector3(-0.2, -0.16, 0.18);
const displacement = new S.Vector3();
let verticalSpeed = 0;

Spatial.onFrame((deltaTime, elapsed) => {
  const keyboard = Spatial.input.keyboard;
  const controller = walker.characterController;

  displacement.set(0, 0, 0);
  if (keyboard.isDown("KeyW")) displacement.z -= 1;
  if (keyboard.isDown("KeyS")) displacement.z += 1;
  if (keyboard.isDown("KeyA")) displacement.x -= 1;
  if (keyboard.isDown("KeyD")) displacement.x += 1;
  if (displacement.lengthSq() > 0) {
    displacement.normalize().multiplyScalar(0.5 * deltaTime);
    walker.rotation.y = Math.atan2(displacement.x, displacement.z);
  }

  // isOnGround is the consumer's answer after it resolved the last move.
  if (controller.isOnGround) verticalSpeed = keyboard.wasPressed("Space") ? 1.4 : 0;
  else verticalSpeed -= 9.81 * deltaTime;
  displacement.y = verticalSpeed * deltaTime;

  controller.move(displacement);          // one move per frame, applied next frame

  if (keyboard.wasPressed("KeyR")) {
    controller.teleport(HOME);            // ignores collision: a respawn, not a walk
    verticalSpeed = 0;
  }
  if (keyboard.wasPressed("KeyF")) molasses.enabled = !molasses.enabled;

  repeller.strength = 0.6 + Math.sin(elapsed * 1.2) * 0.35;
  scene.userData.onGround = controller.isOnGround;
});

Spatial.mount(scene);
```

**Expect:** WASD walks the blue capsule around the slab, sliding along the step
and climbing it; Space jumps; R teleports home; F toggles the drag field. The
pebbles drift outward from the middle and settle.

**Confirm in the dump:** the `walker` entry has
`characterController: { radius: 0.035, height: 0.16, slopeLimit: 0.7, stepLimit: 0.06, gravity: true }`
and a sibling `isOnGround`; `repeller.forceField.kind === "RadialForceField"`
with `falloff: "inverseSquare"`, and `molasses.forceField.enabled` flips with F.

**The trap:** a character controller is **native-driven**. Writing
`walker.position` fights the consumer; use `move` for walking and `teleport` for
placement. The controller never rotates anything — the facing above is the
script's own `rotation.y`.

---

## 26. Posing a loaded rig's joint and blend shape

```js runnable
const Spatial = require("spatial");
const {
  Scene, Group, Mesh, BoxGeometry, PlaneGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, Quaternion, Euler,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const sun = new DirectionalLight(0xfff4e8, 2.5);
sun.position.set(0.5, 1.2, 0.7);
sun.castShadow = true;
scene.add(sun);

const floor = new Mesh(new PlaneGeometry(0.9, 0.9), new MeshStandardMaterial({ color: 0x23262b }));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.22;
floor.receiveShadow = true;
scene.add(floor);

const holder = new Group();
holder.name = "holder";
holder.position.y = -0.22;
scene.add(holder);

const plinth = new Mesh(new BoxGeometry(0.3, 0.02, 0.3), new MeshStandardMaterial({ color: 0x333a44 }));
plinth.name = "plinth";
plinth.position.y = -0.23;
plinth.receiveShadow = true;
scene.add(plinth);

// Mount before awaiting, so the scene is on screen while the model loads.
Spatial.mount(scene);

let rig = null;
let shapes = null;
let animations = [];
let animationIndex = 0;
let model = null;

// The rig pair in the shared asset root: same skeleton, one file per backend.
try {
  model = await Spatial.loadAsset({ usdz: "asset://rig.usdz", glb: "asset://rig.glb" });
  model.name = "figure";
  holder.add(model);

  // Fit whatever came out of the file into a 0.3 m box.
  const size = model.boundingBox.max.clone().sub(model.boundingBox.min);
  const largest = Math.max(size.x, size.y, size.z);
  if (largest > 0) model.scale.setScalar(0.3 / largest);

  animations = model.animations.slice();
  if (animations.length > 0) model.playAnimation(animations[0], { loop: true });

  // Both are null for an asset with no rig and no shapes.
  if (model.skeleton !== null) {
    rig = model.skeleton;
    rig.track(true);        // ask for the real transforms back while an animation runs
    holder.userData.joints = rig.joints.slice();
  }
  if (model.blendShapes !== null) {
    shapes = model.blendShapes;
    holder.userData.shapes = shapes.names.slice();
  }
} catch (error) {
  console.warn("figure could not be loaded:", error.message);
  holder.userData.assetError = error.message;
}

plinth.addEventListener("tap", () => {
  if (model === null || animations.length === 0) return;
  animationIndex = (animationIndex + 1) % (animations.length + 1);
  if (animationIndex === animations.length) {
    // Past the end: stop, which hands the pose back to the script's joint edits.
    model.stopAnimation();
    holder.userData.playing = null;
    return;
  }
  model.playAnimation(animations[animationIndex], { loop: true });
  holder.userData.playing = animations[animationIndex];
});

const rotation = new Quaternion();
const euler = new Euler();

Spatial.onFrame((deltaTime, elapsed) => {
  holder.rotation.y += deltaTime * 0.25;

  if (rig !== null && rig.joints.indexOf("head") !== -1) {
    euler.set(0, Math.sin(elapsed * 0.9) * 0.35, Math.sin(elapsed * 1.7) * 0.12);
    rig.setJointRotation("head", rotation.setFromEuler(euler));
    // Where the joint really ended up, reported because tracking is on.
    const actual = rig.getJointTransform("head");
    if (actual !== null) holder.userData.headY = actual.position.y;
  }

  if (shapes !== null && shapes.names.indexOf("widen") !== -1) {
    shapes.set("widen", (Math.sin(elapsed * 1.3) + 1) / 2);   // clamped to 0..1
  }
});
```

**Expect:** a small figure on a plinth, turning slowly, its head swaying and its
body widening and narrowing. Tapping the plinth cycles its animations and then
stops them, at which point the script's own head pose takes over again.

**Confirm in the dump:** the `figure` entry has
`skeleton: { joints: { head: [px,py,pz,qx,qy,qz,qw] }, track: true }` and
`blendShapes: { widen: 0..1 }`; `holder.userData.joints` lists what the file
actually names. An asset with no rig leaves both `null` and the recipe still
runs.

**The trap:** a playing native animation **overrides** script joint poses.
`track(true)` is the only way to read where a joint actually is while one runs,
and `stopAnimation()` is what hands the pose back.

---

## 27. A shader graph material with a fallback

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial, ShaderGraphMaterial,
  AmbientLight, DirectionalLight, Color,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const sun = new DirectionalLight(0xffffff, 2.3);
sun.position.set(0.5, 1.1, 0.7);
sun.castShadow = true;
scene.add(sun);

// The fallback is what every consumer without a shader graph renders, so it
// should approximate the graph rather than being an obvious placeholder.
const fallback = new MeshStandardMaterial({
  color: 0xff5522,
  emissive: 0x331100,
  emissiveIntensity: 1.5,
  roughness: 0.35,
});

const glow = new ShaderGraphMaterial({
  source: "asset://spatial-materials.usda",   // a bundled, pre-authored USD graph
  name: "Glow",                               // the graph's name inside that file
  parameters: { glowAmount: 1 },
  fallback,                                    // required: omitting it throws
});

const cube = new Mesh(new BoxGeometry(0.15, 0.15, 0.15), glow);
cube.name = "cube";
cube.position.x = -0.12;
cube.castShadow = true;
scene.add(cube);

// A second mesh sharing the same material instance: one native material, and
// both update when a parameter changes.
const orb = new Mesh(new SphereGeometry(0.075, 24, 16), glow);
orb.name = "orb";
orb.position.x = 0.14;
orb.castShadow = true;
scene.add(orb);

cube.addEventListener("tap", () => {
  glow.setParameter("glowColor", new Color().setHSL(Math.random(), 0.85, 0.5));
  scene.userData.generation = glow.generation;
});

Spatial.onFrame((deltaTime, elapsed) => {
  cube.rotation.y += deltaTime * 0.6;
  orb.position.y = Math.sin(elapsed * 1.4) * 0.04;
  // Numbers, booleans, strings, Colors, Vector2/3/4, small float arrays, Textures.
  glow.setParameter("glowAmount", 1 + Math.sin(elapsed * 2) * 0.5);
  scene.userData.shaderGraph = Spatial.env.capabilities.shaderGraph;
});

Spatial.mount(scene);
```

**Expect:** on RealityKit, a cube and orb rendered by the `Glow` graph, pulsing
with `glowAmount` and recolouring on tap. In the browser the same objects in the
orange fallback material, with one warning.

**Confirm in the dump:** the `cube` entry has
`material.type === "ShaderGraphMaterial"` with `source`, `name: "Glow"`,
`parameters: { glowAmount, glowColor }`, a `generation` that increases with every
`setParameter`, and the full `fallback` snapshot. On the web `warnings` contains
`ShaderGraphMaterial has no shader graph on this consumer; the fallback material
is rendered` and `capabilities.shaderGraph` is `false`.

**The trap:** a value the command stream cannot carry — a NaN, a plain object, an
array of the wrong length — is refused with a warning naming the parameter, not
sent as null.

---

## 28. Game controller polling with injected state

No test rig has hardware attached, so `Spatial.inject.controller` is how a
controller scene is verified.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, ConeGeometry, PlaneGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, Vector3,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const sun = new DirectionalLight(0xffffff, 2.4);
sun.position.set(0.5, 1.1, 0.7);
sun.castShadow = true;
scene.add(sun);

const floor = new Mesh(new PlaneGeometry(0.9, 0.9), new MeshStandardMaterial({ color: 0x23262b }));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.2;
floor.receiveShadow = true;
scene.add(floor);

const ship = new Mesh(new ConeGeometry(0.045, 0.11, 16), new MeshStandardMaterial({ color: 0x44dd99 }));
ship.name = "ship";
ship.rotation.x = Math.PI / 2;
ship.castShadow = true;
scene.add(ship);

scene.addEventListener("controllerconnected", (event) => {
  scene.userData.padName = event.controller ? event.controller.name : null;
});
scene.addEventListener("controllerdisconnected", () => { scene.userData.padName = null; });

const velocity = new Vector3();
const BOUND = 0.35;

Spatial.onFrame((deltaTime) => {
  scene.userData.pads = Spatial.input.controllers.connected;
  // `current` is the pad whose input changed most recently, not the first one.
  const pad = Spatial.input.controllers.current;
  if (pad === null) return;

  velocity.set(pad.leftThumbstick.x, 0, -pad.leftThumbstick.y);
  if (velocity.lengthSq() > 0) {
    ship.position.addScaledVector(velocity, 0.5 * deltaTime);
    ship.position.x = Math.max(-BOUND, Math.min(BOUND, ship.position.x));
    ship.position.z = Math.max(-BOUND, Math.min(BOUND, ship.position.z));
  }

  // Triggers report their travel; plain buttons report 0 or 1.
  ship.scale.setScalar(1 + pad.rightTrigger * 0.4);

  // pressed and released are one frame each; down is the level.
  if (pad.a.pressed) {
    scene.userData.boosts = (scene.userData.boosts || 0) + 1;
    pad.rumble(0.6, 0.15);          // warns once where there are no haptics
  }
  if (pad.b.down) ship.rotation.z += deltaTime * 2;
  if (pad.menu.pressCount === 2) scene.userData.menuDoubleTap = true;
});

// Drive it without hardware. Every field is optional; what is missing is zero.
Spatial.onFrame(() => {
  const frame = Spatial.time.frame;
  if (frame === 5) {
    Spatial.inject.controller({
      id: "pad-1",
      name: "Test Pad",
      leftThumbstick: [0.6, 0.2],
      rightTrigger: 0.5,
      buttons: { a: true },
      current: true,
    });
  }
  if (frame === 20) Spatial.inject.controller({ id: "pad-1", buttons: { a: false } });
  if (frame === 60) Spatial.inject.controller(null);      // disconnect them all
});

Spatial.mount(scene);
```

**Expect:** with a real pad, the left stick flies the cone around the floor, the
right trigger swells it, A counts boosts and rumbles, B rolls it. Headless, the
injections do the same on cue.

**Confirm in the dump:** top-level `controllers` is
`[{ id: "pad-1", name: "Test Pad", leftThumbstick: [0.6, 0.2], rightTrigger: 0.5, buttons: { a: 1, … } }]`
while the pad is connected, and `[]` after the `null`; `scene.userData.boosts`
is **1**, not one per frame — proof that `pressed` is an edge — and
`scene.userData.padName` goes from `"Test Pad"` to `null`.

---

## 29. Preserving state across a hot reload

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, Color,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const sun = new DirectionalLight(0xffffff, 2.4);
sun.position.set(0.5, 1.1, 0.7);
scene.add(sun);

const button = new Mesh(new BoxGeometry(0.14, 0.05, 0.14), new MeshStandardMaterial({ color: 0x3a6fd8 }));
button.name = "button";
button.position.x = -0.14;
button.castShadow = true;
scene.add(button);

const lamp = new Mesh(new SphereGeometry(0.06, 24, 16), new MeshStandardMaterial({ color: 0x445066 }));
lamp.name = "lamp";
lamp.position.x = 0.14;
scene.add(lamp);

// The one thing the runtime reads out of a script before replacing it.
// Keep it plain JSON: it is copied, and what the copy cannot carry is dropped.
this.state = { presses: 0, hue: 0.58, activations: 0 };
const state = this.state;

function applyHue() {
  lamp.material.color.copy(new Color().setHSL(state.hue, 0.65, 0.55));
  lamp.material.emissive.copy(new Color().setHSL(state.hue, 0.7, 0.12));
}
applyHue();

// Called after this script loaded and before its first frame, with the previous
// script's `this.state` — only when the reload asked to preserve it.
this.scriptChanged = (previous) => {
  if (!previous) return;
  if (typeof previous.presses === "number") state.presses = previous.presses;
  if (typeof previous.hue === "number") state.hue = previous.hue;
  if (typeof previous.activations === "number") state.activations = previous.activations;
  applyHue();
  scene.userData.carried = state.presses;
};

// Ticks pause between these two, so there is nothing to unwind.
this.didActivate = () => { state.activations += 1; };
this.willDeactivate = () => { Spatial.host.send("sceneInactive", { presses: state.presses }); };

button.addEventListener("tap", () => {
  state.presses += 1;
  state.hue = (state.hue + 0.07) % 1;
  applyHue();
  button.scale.setScalar(0.92);
});

Spatial.onFrame((deltaTime) => {
  const scale = button.scale.x + (1 - button.scale.x) * Math.min(1, deltaTime * 8);
  button.scale.setScalar(scale);
  scene.userData.presses = state.presses;
  scene.userData.active = Spatial.isActive;
});

Spatial.mount(scene);
```

**Expect:** each tap on the blue button advances the lamp's hue. Push an edited
copy of the script with `preserveState` and the count and hue survive the swap.

Drive it from outside:

```bash
jq -n --rawfile source scene.js '{ source: $source, preserveState: true }' \
  | curl -s -X POST --data-binary @- http://127.0.0.1:8787/script
curl -s 'http://127.0.0.1:8787/dump?names=&objects=0' | jq '.loadGeneration'
```

**Confirm in the dump:** `loadGeneration` increments on every load, and after a
preserving reload `scene.userData.carried` equals the pre-reload
`scene.userData.presses`. Without `preserveState`, `scriptChanged` is not called
at all and `carried` is absent.

**The trap:** `this.state` is copied to JSON. A `Vector3`, a `Map`, a function or
a scene object does not survive — store numbers, strings, booleans, arrays and
plain objects, and rebuild the rest in `scriptChanged`.

---

## 30. Calling a host function and exchanging host events

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, Color,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const sun = new DirectionalLight(0xffffff, 2.4);
sun.position.set(0.5, 1.1, 0.7);
scene.add(sun);

const dial = new Mesh(new BoxGeometry(0.12, 0.04, 0.12), new MeshStandardMaterial({ color: 0x3a6fd8 }));
dial.name = "dial";
dial.position.x = -0.14;
dial.castShadow = true;
scene.add(dial);

const lamp = new Mesh(new SphereGeometry(0.06, 24, 16), new MeshStandardMaterial({ color: 0x445066 }));
lamp.name = "lamp";
lamp.position.x = 0.14;
scene.add(lamp);

let hue = 0.58;
function applyHue() { lamp.material.color.copy(new Color().setHSL(hue, 0.65, 0.55)); }
applyHue();

// --- events from the app. `this.on` is the same channel as Spatial.host.on.
this.on("setHue", (payload) => {
  if (!payload || typeof payload.hue !== "number") return;
  hue = Math.min(1, Math.max(0, payload.hue));
  applyHue();
  scene.userData.hue = hue;
});

// There is no reply channel: answering an event is another send.
const onPing = (payload) => {
  Spatial.host.send("pong", { at: Spatial.time.elapsed, echo: payload || null });
};
Spatial.host.on("ping", onPing);

// --- events to the app. Fire and forget; the app may have no listener.
dial.addEventListener("tap", () => {
  hue = (hue + 0.1) % 1;
  applyHue();
  Spatial.host.send("hueChanged", { hue });
  scene.userData.sends = (scene.userData.sends || 0) + 1;
});

// --- host functions. An unregistered name rejects immediately, so the guard is
// a try/catch and not a timeout.
scene.userData.functions = Spatial.host.functions.slice();
if (Spatial.host.functions.indexOf("Preferences.read") !== -1) {
  Spatial.host.call("Preferences.read", { key: "lampHue" })
    .then((preferences) => {
      if (preferences && typeof preferences.hue === "number") { hue = preferences.hue; applyHue(); }
    })
    .catch((error) => { scene.userData.callError = error.message; });
} else {
  scene.userData.usingDefaults = true;
}

// --- a consumer-performed fetch. Never awaited at the top level: a host with
// no network never answers.
Spatial.fetchJSON("asset://layout.json")
  .then((layout) => { scene.userData.layout = layout && layout.name; })
  .catch((error) => { scene.userData.fetchError = error.message; });

// Handlers can be dropped again; a reload clears them all anyway.
let listening = true;
Spatial.onFrame((deltaTime, elapsed) => {
  lamp.position.y = Math.sin(elapsed * 1.4) * 0.02;
  if (listening && (scene.userData.sends || 0) >= 5) {
    Spatial.host.off("ping", onPing);
    listening = false;
  }
});

Spatial.mount(scene);
```

**Expect:** tapping the dial recolours the lamp and sends `hueChanged` to the
app; the app can push `setHue` back the other way.

Drive both directions from outside:

```bash
curl -s -X POST http://127.0.0.1:8787/event -d '{"name":"setHue","payload":{"hue":0.12}}'
curl -s http://127.0.0.1:8787/events | jq '.events'
```

**Confirm in the dump:** `hostFunctions` lists what the app registered;
`scene.userData.functions` is the same list as the script saw at load;
`scene.userData.hue` changes after a `POST /event`; and `GET /events` drains the
`hueChanged` sends once each.

**The trap:** `Spatial.host.call` on an unregistered name rejects at once with
`SpatialUnsupportedError` (`feature: "host-function"`). Check
`Spatial.host.functions` first, or catch — never wait.

---

## 31. A multi-material mesh

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, CylinderGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.45));
const sun = new DirectionalLight(0xffffff, 2.4);
sun.position.set(0.5, 1.1, 0.7);
sun.castShadow = true;
scene.add(sun);

// A BoxGeometry already carries one group per face. Replace them with two
// bands so a single mesh shows two materials.
const geometry = new BoxGeometry(0.16, 0.16, 0.16);
geometry.groups.length = 0;
geometry.addGroup(0, 18, 0);        // start, count, materialIndex
geometry.addGroup(18, 18, 1);

const shell = new MeshStandardMaterial({ color: 0xff4455, roughness: 0.45 });
const trim = new MeshStandardMaterial({ color: 0x44dd99, metalness: 0.7, roughness: 0.2 });

const cube = new Mesh(geometry, [shell, trim]);
cube.name = "cube";
cube.position.x = -0.14;
cube.castShadow = true;
cube.accessibility = { label: "Two-tone cube", hint: "Tap to recolour", isButton: true };
scene.add(cube);

// A single material is still the common case and still just works.
const post = new Mesh(new CylinderGeometry(0.03, 0.03, 0.18, 20), shell);
post.name = "post";
post.position.x = 0.14;
post.castShadow = true;
scene.add(post);

cube.addEventListener("tap", () => {
  // Mutating a shared material moves every mesh that uses it: the post too.
  shell.color.setHSL(Math.random(), 0.7, 0.55);
  scene.userData.recolours = (scene.userData.recolours || 0) + 1;
});

Spatial.onFrame((deltaTime) => {
  cube.rotation.y += deltaTime * 0.7;
  scene.userData.materialCount = Array.isArray(cube.material) ? cube.material.length : 1;
});

Spatial.mount(scene);
```

**Expect:** a cube split into a red band and a green metallic band, next to a
red post. Tapping the cube recolours both the cube's red band and the post,
because they share one material instance.

**Confirm in the dump:** the `cube` entry's `material` is an **array** of two
material snapshots and its `geometry` descriptor carries
`groups: [{ start: 0, count: 18, materialIndex: 0 }, { start: 18, count: 18, materialIndex: 1 }]`;
`post.material` is a single snapshot with the same `uuid` as the cube's first —
that shared `uuid` is why one tap moves both. `scene.userData.materialCount` is
`2`.

**The trap:** fewer materials than the groups ask for is not an error — the last
one is repeated, with a warning naming the mesh. Count them yourself if it
matters.
