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
