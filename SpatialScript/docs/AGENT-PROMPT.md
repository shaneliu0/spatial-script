# Writing a SpatialScript scene

You are writing a **SpatialScript** scene. SpatialScript is a three.js-shaped JavaScript
scene API. Everything you need is in this document; you have no other reference and you
should not go looking for one.

## What you produce

**Exactly one JavaScript file.** Not a module, not a project, not a build. The file is
evaluated as a function body, so:

- The only import you may write is `require("spatial")`. There is no other module.
  `import` and `export` are a `SyntaxError` here. `require("three")` does not exist.
- The last thing the file does is `Spatial.mount(scene)`.

The skeleton every script has:

```js
const Spatial = require("spatial");
const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, AmbientLight, DirectionalLight } = Spatial;

const scene = new Scene();

// ... build the scene ...

Spatial.onFrame((deltaTime, elapsed) => {
  // ... per-frame work ...
});

Spatial.mount(scene);
```

## Where it runs

The same unchanged file runs on two backends:

| Backend | Where | Renderer | Physics |
| --- | --- | --- | --- |
| `realitykit` | A visionOS or macOS app, in JavaScriptCore | RealityKit | RealityKit physics |
| `three` | A browser | real three.js | Rapier |

The core — the scene graph, transforms, materials, keyframe animation — is the same
JavaScript on both. The **consumer** (the app or the web page) owns rendering, physics
simulation, native asset animation, manipulation and input, and pushes results back each
frame. Read which one you are on with `Spatial.env.backend` and `Spatial.env.platform`,
but prefer `Spatial.env.capabilities` (see *Backend differences* below).

---

# Hard rules

These are not style preferences. Break one and the scene fails to load, renders black, or
renders nothing.

1. **`Spatial.mount(scene)` is mandatory and singular.** One `Scene` is mounted at a time;
   mounting a second one destroys the first. If the script finishes having mounted
   nothing and having constructed exactly one `Scene`, the core auto-mounts it and warns
   (`No scene was mounted; auto-mounting the single Scene that was constructed`). If it
   constructed **zero or two or more** `Scene`s and mounted none, that is a **load error**
   and nothing runs: `The script finished without mounting a scene and constructed 2
   Scenes; call Spatial.mount(scene)`. So: build one `Scene`, mount it, and mount it
   **before** any top-level `await` — a throw after the first `await` is no longer a load
   error, and an unmounted scene at that point is not recoverable.

2. **Units are metres. Angles are radians. Time is seconds. Mass is kilograms.**
   The coordinate system is right-handed: **+y is up**, **-z is away from the viewer**,
   +x is to the right.

3. **Author at tabletop scale.** The content appears inside a bounded volumetric window
   (on visionOS) or a ~900x640 window with the camera at `(0, 0.25, 1.4)` (on macOS).
   Keep object sizes around **0.05–0.3 m** and every position within about **0.5 m of the
   origin**; the viewer sits about 1 m away. Every parametric geometry **defaults to one
   metre**, so `new BoxGeometry()` is a one-metre cube and you are standing inside it, and
   `position.set(0, 0, -5)` is five metres behind the wall of the volume — off-screen, not
   small. Always pass explicit sizes. If you write at game-engine scale (a 10 m ground
   plane, a camera 20 m back), the scene does not "look zoomed in": most of it is outside
   the volume and invisible, and what is left is a flat wall of one surface.

4. **There is no DOM and no browser.** `window`, `document`, `fetch`, `Image`,
   `localStorage`, `XMLHttpRequest`, `navigator`, `performance`, `URL`, `TextDecoder`,
   `queueMicrotask` and `WebSocket` are all **undefined**. `Math`, `JSON`, `Promise`,
   `Date` and the rest of the ECMAScript standard library are there. To fetch something,
   use `Spatial.fetchText(url)` / `Spatial.fetchJSON(url)` — and never `await` one at the
   top level, because it would hold up the rest of the script body; use `.then()`.

5. **`console.log` works** and goes to the app console (`console.warn`, `error`, `info`,
   `debug` too). One message truncates at 16 KB; past 200 log lines in one frame the rest
   are counted in a single suppression line.

6. **Top-level `await` is allowed.** The body is compiled as an async function body.
   Timers (`setTimeout`, `setInterval`, `requestAnimationFrame`) and asset loads are
   driven by **frame ticks**, not by a host event loop — a timer never fires during load,
   and `setInterval` fires at most once per frame.

7. **`Spatial.onFrame(cb)` is the per-frame hook.** `cb(deltaTime, elapsedTime)` runs
   every frame before the scene is flushed to the consumer. **`deltaTime` is in seconds**
   (about `0.0167`), not milliseconds. Multiply rates by it; never assume a fixed
   framerate. `Spatial.offFrame(cb)` removes it.

8. **Light the scene.** `MeshStandardMaterial` and `MeshPhysicalMaterial` are physically
   based: with no light in the scene they render **black** on both backends, and both warn
   `the scene has no lights; meshes with lit materials render black`. See *Lighting a
   scene that is not flat or black*.

---

# The complete API

**This is the exhaustive API surface.** These declarations are held to the shipped core by
an automated test in both directions, so:

- **Anything not declared below does not exist.** There is no `ShaderMaterial`, no
  `onBeforeCompile`, no custom GLSL or Metal, no post-processing or `EffectComposer`, no
  `HemisphereLight`, no `RectAreaLight`, no `Sprite`, `Points`, `Line` or `LineSegments`,
  no `WebGLRenderer`, no `OrbitControls`, no animation graphs. Calling one is a plain
  `ReferenceError` or `TypeError` at load.
- The classes marked `(three)` in the comments are the real three.js classes, so their
  full three.js API is present at runtime even where these declarations describe only the
  contracted members. Everything else is exactly what is written here.
- Read it as a namespace: `limits` is nested, so the caps are reached as
  **`Spatial.limits.MAX_DEPTH`**, `Spatial.limits.MAX_NAME_LENGTH` and so on — not as
  `Spatial.MAX_DEPTH`.

```ts
// TypeScript declarations for SpatialScript (SPEC sections 3 and 3.13).
//
// A script is evaluated as an async function body with `require` in scope and
// `Spatial` as a global, so top-level `await` is allowed:
//
//   /// <reference path="../types/spatial.d.ts" />
//   const Spatial = require("spatial");
//
// The classes marked (three) below are the real three.js classes. These
// declarations describe the members the SpatialScript contract covers; the
// full three.js API of those classes is also available at runtime. Install the
// `three` package if you want the complete typings for them:
//
//   import type { Vector3 } from "three";

declare module "spatial" {
  export = Spatial;
}

declare namespace Spatial {
  /**
   * The bounds the core enforces on script-supplied work. Crossing one is
   * reported through `dump().warnings` or `dump().errors`, never silently.
   */
  namespace limits {
    /** Object and material names are truncated past 256 characters. */
    const MAX_NAME_LENGTH: 256;
    /** One console message is truncated past 16 KB. */
    const MAX_LOG_MESSAGE: number;
    /** Log commands per frame; the rest are counted in one summary line. */
    const MAX_LOGS_PER_FRAME: 200;
    /** Live setTimeout/setInterval registrations. */
    const MAX_LIVE_TIMERS: 10000;
    /** Live requestAnimationFrame registrations. */
    const MAX_LIVE_FRAME_CALLBACKS: 10000;
    /** Timer and animation-frame callbacks run in one tick; the rest defer. */
    const MAX_CALLBACKS_PER_TICK: 10000;
    /** Listeners on one object for one event type. */
    const MAX_LISTENERS_PER_EVENT: 1000;
    /** Scene graph depth; an edit that would exceed it is refused. */
    const MAX_DEPTH: 1024;
    /** Object ids stay exact in the float32 `transforms` records up to here. */
    const MAX_ID: number;
    /** Entries kept in `dump().errors`; older ones are counted, not kept. */
    const MAX_RECORDED_ERRORS: 200;
    /** Entries kept in `dump().warnings`. */
    const MAX_RECORDED_WARNINGS: 500;
    /**
     * Distinct error messages reported in one second. Each unique message is
     * reported at most once per second; past this many distinct messages the
     * rest of that second is dropped and one line says how many.
     */
    const MAX_ERROR_MESSAGES_PER_SECOND: 20;
  }

  // ------------------------------------------------------------- 3.1 math

  interface Vector2Like {
    x: number;
    y: number;
  }

  class Vector2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
    readonly isVector2: true;
    set(x: number, y: number): this;
    copy(v: Vector2Like): this;
    clone(): Vector2;
    add(v: Vector2Like): this;
    sub(v: Vector2Like): this;
    multiplyScalar(scalar: number): this;
    divideScalar(scalar: number): this;
    length(): number;
    lengthSq(): number;
    normalize(): this;
    dot(v: Vector2Like): number;
    distanceTo(v: Vector2Like): number;
    lerp(v: Vector2Like, alpha: number): this;
    equals(v: Vector2Like): boolean;
    toArray(): [number, number];
    fromArray(array: ArrayLike<number>, offset?: number): this;
  }

  interface Vector3Like {
    x: number;
    y: number;
    z: number;
  }

  class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    readonly isVector3: true;
    set(x: number, y: number, z: number): this;
    setScalar(scalar: number): this;
    copy(v: Vector3Like): this;
    clone(): Vector3;
    add(v: Vector3Like): this;
    addScaledVector(v: Vector3Like, scale: number): this;
    sub(v: Vector3Like): this;
    subVectors(a: Vector3Like, b: Vector3Like): this;
    multiply(v: Vector3Like): this;
    multiplyScalar(scalar: number): this;
    divideScalar(scalar: number): this;
    applyQuaternion(q: Quaternion): this;
    applyMatrix4(m: Matrix4): this;
    negate(): this;
    dot(v: Vector3Like): number;
    cross(v: Vector3Like): this;
    crossVectors(a: Vector3Like, b: Vector3Like): this;
    length(): number;
    lengthSq(): number;
    normalize(): this;
    setLength(length: number): this;
    distanceTo(v: Vector3Like): number;
    distanceToSquared(v: Vector3Like): number;
    lerp(v: Vector3Like, alpha: number): this;
    equals(v: Vector3Like): boolean;
    setFromMatrixPosition(m: Matrix4): this;
    toArray(): [number, number, number];
    fromArray(array: ArrayLike<number>, offset?: number): this;
  }

  class Vector4 {
    constructor(x?: number, y?: number, z?: number, w?: number);
    x: number;
    y: number;
    z: number;
    w: number;
    set(x: number, y: number, z: number, w: number): this;
    copy(v: Vector4): this;
    clone(): Vector4;
    applyMatrix4(m: Matrix4): this;
    length(): number;
    normalize(): this;
    toArray(): [number, number, number, number];
  }

  class Quaternion {
    constructor(x?: number, y?: number, z?: number, w?: number);
    x: number;
    y: number;
    z: number;
    w: number;
    readonly isQuaternion: true;
    set(x: number, y: number, z: number, w: number): this;
    copy(q: Quaternion): this;
    clone(): Quaternion;
    identity(): this;
    invert(): this;
    setFromEuler(euler: Euler, update?: boolean): this;
    setFromAxisAngle(axis: Vector3, angle: number): this;
    setFromRotationMatrix(m: Matrix4): this;
    setFromUnitVectors(from: Vector3, to: Vector3): this;
    multiply(q: Quaternion): this;
    multiplyQuaternions(a: Quaternion, b: Quaternion): this;
    premultiply(q: Quaternion): this;
    slerp(q: Quaternion, t: number): this;
    angleTo(q: Quaternion): number;
    normalize(): this;
    equals(q: Quaternion): boolean;
    toArray(): [number, number, number, number];
    fromArray(array: ArrayLike<number>, offset?: number): this;
  }

  type EulerOrder = "XYZ" | "YZX" | "ZXY" | "XZY" | "YXZ" | "ZYX";

  class Euler {
    constructor(x?: number, y?: number, z?: number, order?: EulerOrder);
    x: number;
    y: number;
    z: number;
    order: EulerOrder;
    readonly isEuler: true;
    set(x: number, y: number, z: number, order?: EulerOrder): this;
    copy(euler: Euler): this;
    clone(): Euler;
    setFromQuaternion(q: Quaternion, order?: EulerOrder, update?: boolean): this;
    setFromRotationMatrix(m: Matrix4, order?: EulerOrder): this;
    reorder(order: EulerOrder): this;
    toArray(): [number, number, number, EulerOrder];
  }

  class Matrix3 {
    constructor();
    elements: number[];
    set(
      n11: number, n12: number, n13: number,
      n21: number, n22: number, n23: number,
      n31: number, n32: number, n33: number,
    ): this;
    identity(): this;
    copy(m: Matrix3): this;
    clone(): Matrix3;
    invert(): this;
    transpose(): this;
    multiply(m: Matrix3): this;
    determinant(): number;
    getNormalMatrix(m: Matrix4): this;
  }

  class Matrix4 {
    constructor();
    elements: number[];
    set(
      n11: number, n12: number, n13: number, n14: number,
      n21: number, n22: number, n23: number, n24: number,
      n31: number, n32: number, n33: number, n34: number,
      n41: number, n42: number, n43: number, n44: number,
    ): this;
    identity(): this;
    copy(m: Matrix4): this;
    clone(): Matrix4;
    invert(): this;
    transpose(): this;
    multiply(m: Matrix4): this;
    premultiply(m: Matrix4): this;
    multiplyMatrices(a: Matrix4, b: Matrix4): this;
    determinant(): number;
    compose(position: Vector3, quaternion: Quaternion, scale: Vector3): this;
    decompose(position: Vector3, quaternion: Quaternion, scale: Vector3): this;
    makeTranslation(x: number, y: number, z: number): this;
    makeRotationFromQuaternion(q: Quaternion): this;
    makeRotationX(theta: number): this;
    makeRotationY(theta: number): this;
    makeRotationZ(theta: number): this;
    makeRotationAxis(axis: Vector3, angle: number): this;
    makeScale(x: number, y: number, z: number): this;
    lookAt(eye: Vector3, target: Vector3, up: Vector3): this;
    setPosition(x: number | Vector3, y?: number, z?: number): this;
    extractRotation(m: Matrix4): this;
  }

  type ColorRepresentation = Color | string | number;

  /**
   * Channels are stored in the linear working space, matching three.js with
   * ColorManagement enabled. `new Color(0x3366ff)` treats the hex as sRGB and
   * converts. Command-stream colors carry these linear channels.
   */
  class Color {
    constructor(color?: ColorRepresentation);
    constructor(r: number, g: number, b: number);
    r: number;
    g: number;
    b: number;
    readonly isColor: true;
    set(color: ColorRepresentation): this;
    setHex(hex: number): this;
    setRGB(r: number, g: number, b: number): this;
    setHSL(h: number, s: number, l: number): this;
    setStyle(style: string): this;
    copy(color: Color): this;
    clone(): Color;
    getHex(): number;
    getHexString(): string;
    lerp(color: Color, alpha: number): this;
    multiplyScalar(scalar: number): this;
    equals(color: Color): boolean;
    toArray(): [number, number, number];
  }

  class Box3 {
    constructor(min?: Vector3, max?: Vector3);
    min: Vector3;
    max: Vector3;
    set(min: Vector3, max: Vector3): this;
    copy(box: Box3): this;
    clone(): Box3;
    makeEmpty(): this;
    isEmpty(): boolean;
    expandByPoint(point: Vector3): this;
    expandByObject(object: Object3D): this;
    setFromObject(object: Object3D): this;
    setFromPoints(points: Vector3[]): this;
    getCenter(target: Vector3): Vector3;
    getSize(target: Vector3): Vector3;
    containsPoint(point: Vector3): boolean;
    intersectsBox(box: Box3): boolean;
    union(box: Box3): this;
    applyMatrix4(m: Matrix4): this;
  }

  class Sphere {
    constructor(center?: Vector3, radius?: number);
    center: Vector3;
    radius: number;
    set(center: Vector3, radius: number): this;
    copy(sphere: Sphere): this;
    clone(): Sphere;
    containsPoint(point: Vector3): boolean;
    intersectsSphere(sphere: Sphere): boolean;
    applyMatrix4(m: Matrix4): this;
  }

  class Plane {
    constructor(normal?: Vector3, constant?: number);
    normal: Vector3;
    constant: number;
    set(normal: Vector3, constant: number): this;
    setFromNormalAndCoplanarPoint(normal: Vector3, point: Vector3): this;
    copy(plane: Plane): this;
    clone(): Plane;
    normalize(): this;
    distanceToPoint(point: Vector3): number;
    projectPoint(point: Vector3, target: Vector3): Vector3;
    intersectLine(line: unknown, target: Vector3): Vector3 | null;
  }

  class Ray {
    constructor(origin?: Vector3, direction?: Vector3);
    origin: Vector3;
    direction: Vector3;
    set(origin: Vector3, direction: Vector3): this;
    copy(ray: Ray): this;
    clone(): Ray;
    at(t: number, target: Vector3): Vector3;
    lookAt(v: Vector3): this;
    distanceToPoint(point: Vector3): number;
    intersectSphere(sphere: Sphere, target: Vector3): Vector3 | null;
    intersectPlane(plane: Plane, target: Vector3): Vector3 | null;
    intersectBox(box: Box3, target: Vector3): Vector3 | null;
    applyMatrix4(m: Matrix4): this;
  }

  class Spherical {
    constructor(radius?: number, phi?: number, theta?: number);
    radius: number;
    phi: number;
    theta: number;
    set(radius: number, phi: number, theta: number): this;
    copy(other: Spherical): this;
    clone(): Spherical;
    makeSafe(): this;
    setFromVector3(v: Vector3): this;
    setFromCartesianCoords(x: number, y: number, z: number): this;
  }

  const MathUtils: {
    DEG2RAD: number;
    RAD2DEG: number;
    generateUUID(): string;
    clamp(value: number, min: number, max: number): number;
    euclideanModulo(n: number, m: number): number;
    mapLinear(x: number, a1: number, a2: number, b1: number, b2: number): number;
    inverseLerp(x: number, y: number, value: number): number;
    lerp(x: number, y: number, t: number): number;
    damp(x: number, y: number, lambda: number, dt: number): number;
    pingpong(x: number, length?: number): number;
    smoothstep(x: number, min: number, max: number): number;
    smootherstep(x: number, min: number, max: number): number;
    randInt(low: number, high: number): number;
    randFloat(low: number, high: number): number;
    randFloatSpread(range: number): number;
    seededRandom(s?: number): number;
    degToRad(degrees: number): number;
    radToDeg(radians: number): number;
    isPowerOfTwo(value: number): boolean;
  };

  // ------------------------------------------------------ 3.2 scene graph

  type HoverEffect = "highlight" | "lift" | "spotlight" | null;

  interface SpatialEvent {
    type: string;
    /** The object the event originated on; unchanged while the event bubbles. */
    target: Object3D;
    /** The object whose listener is running right now. */
    currentTarget: Object3D;
    /** Stops the event from reaching further ancestors. */
    stopPropagation(): void;
  }

  interface TapEvent extends SpatialEvent {
    type: "tap";
    point: Vector3;
  }

  interface HoverEvent extends SpatialEvent {
    type: "hoverenter" | "hoverexit";
  }

  interface DragEvent extends SpatialEvent {
    type: "dragstart" | "drag" | "dragend";
    /** World-space displacement since dragstart. */
    translation: Vector3;
    point: Vector3;
  }

  interface ManipulationEvent extends SpatialEvent {
    type: "manipulationstart" | "manipulation" | "manipulationend";
  }

  interface CollisionEvent extends SpatialEvent {
    type: "collisionstart" | "collisionend";
    other: Object3D | null;
    point: Vector3;
    normal: Vector3;
    impulse: number;
  }

  interface AnchorEvent extends SpatialEvent {
    type: "anchored" | "unanchored";
  }

  interface AssetEvent extends SpatialEvent {
    type: "assetLoaded" | "assetError";
    animations?: string[];
    message?: string;
  }

  interface ObjectEventMap {
    tap: TapEvent;
    hoverenter: HoverEvent;
    hoverexit: HoverEvent;
    dragstart: DragEvent;
    drag: DragEvent;
    dragend: DragEvent;
    manipulationstart: ManipulationEvent;
    manipulation: ManipulationEvent;
    manipulationend: ManipulationEvent;
    collisionstart: CollisionEvent;
    collisionend: CollisionEvent;
    anchored: AnchorEvent;
    unanchored: AnchorEvent;
    assetLoaded: AssetEvent;
    assetError: AssetEvent;
  }

  class Object3D {
    constructor();
    readonly id: number;
    readonly uuid: string;
    name: string;
    type: string;
    readonly parent: Object3D | null;
    readonly children: Object3D[];
    visible: boolean;
    userData: Record<string, any>;
    readonly position: Vector3;
    readonly rotation: Euler;
    readonly quaternion: Quaternion;
    readonly scale: Vector3;
    readonly up: Vector3;
    readonly matrix: Matrix4;
    readonly matrixWorld: Matrix4;
    /**
     * three.js semantics, and the core's static hint. Left `true` (the
     * default) the object's position, rotation and scale drive its matrix.
     * Set to `false` after calling `updateMatrix()`, the matrix is
     * authoritative and the diff watches only it, which makes a large piece of
     * static scenery cost about a third of a moving object per frame.
     */
    matrixAutoUpdate: boolean;
    castShadow: boolean;
    receiveShadow: boolean;
    renderOrder: number;
    readonly isObject3D: true;

    /** Applies to this object and its descendants. Default 1. */
    opacity: number;
    /** Faces the viewer. Default false. */
    billboard: boolean;
    /** visionOS only; accepted with no visual elsewhere. */
    hoverEffect: HoverEffect;
    /** Enables the system grab/move/rotate/scale interaction. */
    manipulable: boolean;
    /** Attaching a body makes the object participate in physics. */
    rigidBody: RigidBody | null;
    /**
     * Attaching a controller makes the object native-driven (14.4): the
     * consumer resolves its movement and reports the result.
     */
    characterController: CharacterController | null;
    /** RealityKit AccessibilityComponent; the web mirrors it onto ARIA (14.11). */
    accessibility: Accessibility | null;

    add(...objects: Object3D[]): this;
    remove(...objects: Object3D[]): this;
    removeFromParent(): this;
    clear(): this;
    attach(object: Object3D): this;
    traverse(callback: (object: Object3D) => void): void;
    traverseVisible(callback: (object: Object3D) => void): void;
    traverseAncestors(callback: (object: Object3D) => void): void;
    getObjectByName(name: string): Object3D | undefined;
    getObjectById(id: number): Object3D | undefined;
    getObjectByProperty(name: string, value: unknown): Object3D | undefined;
    lookAt(target: Vector3): void;
    lookAt(x: number, y: number, z: number): void;
    localToWorld(vector: Vector3): Vector3;
    worldToLocal(vector: Vector3): Vector3;
    getWorldPosition(target: Vector3): Vector3;
    getWorldQuaternion(target: Quaternion): Quaternion;
    getWorldScale(target: Vector3): Vector3;
    getWorldDirection(target: Vector3): Vector3;
    /**
     * Decomposed into translate, rotate, scale. A matrix carrying shear is
     * refused: the object keeps its last valid transform and the core records
     * a SpatialUnsupportedError in `dump().errors`. It is not thrown, so the
     * frame loop keeps running. Writing `matrix` directly is honoured too.
     */
    applyMatrix4(matrix: Matrix4): this;
    applyQuaternion(quaternion: Quaternion): this;
    setRotationFromAxisAngle(axis: Vector3, angle: number): void;
    setRotationFromEuler(euler: Euler): void;
    setRotationFromQuaternion(quaternion: Quaternion): void;
    rotateX(angle: number): this;
    rotateY(angle: number): this;
    rotateZ(angle: number): this;
    rotateOnAxis(axis: Vector3, angle: number): this;
    rotateOnWorldAxis(axis: Vector3, angle: number): this;
    translateX(distance: number): this;
    translateY(distance: number): this;
    translateZ(distance: number): this;
    translateOnAxis(axis: Vector3, distance: number): this;
    updateMatrix(): void;
    updateMatrixWorld(force?: boolean): void;
    updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
    /** Carries the SpatialScript display flags, but never `rigidBody`. */
    clone(recursive?: boolean): this;
    copy(source: this, recursive?: boolean): this;

    addEventListener<K extends keyof ObjectEventMap>(
      type: K,
      listener: (event: ObjectEventMap[K]) => void,
    ): void;
    addEventListener(type: string, listener: (event: SpatialEvent) => void): void;
    hasEventListener(type: string, listener: (event: any) => void): boolean;
    removeEventListener(type: string, listener: (event: any) => void): void;
    dispatchEvent(event: { type: string; [key: string]: any }): void;
  }

  class Group extends Object3D {
    readonly isGroup: true;
  }

  /** `background`, `environment` and `fog` are out of scope and throw. */
  class Scene extends Object3D {
    readonly isScene: true;
  }

  class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material | Material[]);
    geometry: BufferGeometry;
    /**
     * One material, or one per `geometry.groups` entry (14.12). `null` and
     * `undefined` are replaced with a MeshStandardMaterial and warned about,
     * so this only reads as null on a mesh whose material was cleared.
     */
    material: Material | Material[] | null;
    /**
     * A grounding shadow under this mesh (SPEC 3.2). Meshes only: set on any
     * other Object3D it is kept in the dump, reported once, and never sent.
     * Unsupported on the three.js backend, which warns once.
     */
    groundingShadow: boolean;
    readonly isMesh: true;
  }

  // --------------------------------------------------------- 3.3 geometry

  class BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number, normalized?: boolean);
    array: ArrayLike<number>;
    itemSize: number;
    count: number;
    normalized: boolean;
    needsUpdate: boolean;
    getX(index: number): number;
    getY(index: number): number;
    getZ(index: number): number;
    setXY(index: number, x: number, y: number): this;
    setXYZ(index: number, x: number, y: number, z: number): this;
  }

  class Float32BufferAttribute extends BufferAttribute {
    constructor(array: ArrayLike<number> | number, itemSize: number, normalized?: boolean);
  }

  class BufferGeometry {
    constructor();
    readonly uuid: string;
    type: string;
    readonly attributes: Record<string, BufferAttribute>;
    index: BufferAttribute | null;
    boundingBox: Box3 | null;
    boundingSphere: Sphere | null;
    /** Present on the parametric geometries and on TextGeometry. */
    readonly parameters?: Record<string, any>;
    setAttribute(name: "position" | "normal" | "uv" | string, attribute: BufferAttribute): this;
    getAttribute(name: string): BufferAttribute | undefined;
    deleteAttribute(name: string): this;
    setIndex(index: BufferAttribute | number[] | null): this;
    computeVertexNormals(): void;
    computeBoundingBox(): void;
    computeBoundingSphere(): void;
    applyMatrix4(matrix: Matrix4): this;
    translate(x: number, y: number, z: number): this;
    rotateX(angle: number): this;
    rotateY(angle: number): this;
    rotateZ(angle: number): this;
    scale(x: number, y: number, z: number): this;
    center(): this;
    clone(): BufferGeometry;
    dispose(): void;
  }

  class BoxGeometry extends BufferGeometry {
    constructor(
      width?: number,
      height?: number,
      depth?: number,
      widthSegments?: number,
      heightSegments?: number,
      depthSegments?: number,
    );
  }

  class SphereGeometry extends BufferGeometry {
    constructor(
      radius?: number,
      widthSegments?: number,
      heightSegments?: number,
      phiStart?: number,
      phiLength?: number,
      thetaStart?: number,
      thetaLength?: number,
    );
  }

  class PlaneGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, widthSegments?: number, heightSegments?: number);
  }

  class CylinderGeometry extends BufferGeometry {
    constructor(
      radiusTop?: number,
      radiusBottom?: number,
      height?: number,
      radialSegments?: number,
      heightSegments?: number,
      openEnded?: boolean,
      thetaStart?: number,
      thetaLength?: number,
    );
  }

  class ConeGeometry extends BufferGeometry {
    constructor(
      radius?: number,
      height?: number,
      radialSegments?: number,
      heightSegments?: number,
      openEnded?: boolean,
      thetaStart?: number,
      thetaLength?: number,
    );
  }

  class TorusGeometry extends BufferGeometry {
    constructor(radius?: number, tube?: number, radialSegments?: number, tubularSegments?: number, arc?: number);
  }

  class CapsuleGeometry extends BufferGeometry {
    constructor(radius?: number, height?: number, capSegments?: number, radialSegments?: number, heightSegments?: number);
  }

  class CircleGeometry extends BufferGeometry {
    constructor(radius?: number, segments?: number, thetaStart?: number, thetaLength?: number);
  }

  class RingGeometry extends BufferGeometry {
    constructor(
      innerRadius?: number,
      outerRadius?: number,
      thetaSegments?: number,
      phiSegments?: number,
      thetaStart?: number,
      thetaLength?: number,
    );
  }

  interface TextGeometryOptions {
    /** Metres. Default 0.1. */
    size?: number;
    /** Extrusion depth in metres. Default 0.01. */
    depth?: number;
    /** Only "default" is bundled; anything else throws. */
    font?: "default";
  }

  class TextGeometry extends BufferGeometry {
    constructor(text: string, options?: TextGeometryOptions);
  }

  // -------------------------------------------------------- 3.4 materials

  type Side = 0 | 1 | 2;
  type Blending = number;

  interface MaterialParameters {
    color?: ColorRepresentation;
    map?: Texture | null;
    opacity?: number;
    transparent?: boolean;
    side?: Side;
    wireframe?: boolean;
    depthWrite?: boolean;
    depthTest?: boolean;
    blending?: Blending;
  }

  class Material {
    readonly uuid: string;
    type: string;
    name: string;
    color: Color;
    map: Texture | null;
    opacity: number;
    transparent: boolean;
    side: Side;
    /** Unsupported in RealityKit: warns once. */
    wireframe: boolean;
    depthWrite: boolean;
    depthTest: boolean;
    /** AdditiveBlending is web-only; RealityKit renders it as transparent. */
    blending: Blending;
    needsUpdate: boolean;
    dispose(): void;
    clone(): this;
  }

  /** Maps to RealityKit UnlitMaterial. */
  class MeshBasicMaterial extends Material {
    constructor(parameters?: MaterialParameters);
  }

  interface MeshStandardMaterialParameters extends MaterialParameters {
    emissive?: ColorRepresentation;
    emissiveIntensity?: number;
    emissiveMap?: Texture | null;
    metalness?: number;
    metalnessMap?: Texture | null;
    roughness?: number;
    roughnessMap?: Texture | null;
    normalMap?: Texture | null;
  }

  /** Maps to RealityKit PhysicallyBasedMaterial. */
  class MeshStandardMaterial extends Material {
    constructor(parameters?: MeshStandardMaterialParameters);
    emissive: Color;
    emissiveIntensity: number;
    emissiveMap: Texture | null;
    metalness: number;
    metalnessMap: Texture | null;
    roughness: number;
    roughnessMap: Texture | null;
    normalMap: Texture | null;
  }

  interface MeshPhysicalMaterialParameters extends MeshStandardMaterialParameters {
    clearcoat?: number;
    clearcoatRoughness?: number;
  }

  class MeshPhysicalMaterial extends MeshStandardMaterial {
    constructor(parameters?: MeshPhysicalMaterialParameters);
    clearcoat: number;
    clearcoatRoughness: number;
  }

  /** RealityKit OcclusionMaterial; depth-only on the web. */
  class OcclusionMaterial extends Material {
    constructor(parameters?: MaterialParameters);
  }

  const FrontSide: 0;
  const BackSide: 1;
  const DoubleSide: 2;
  const NormalBlending: number;
  const AdditiveBlending: number;
  const RepeatWrapping: number;
  const ClampToEdgeWrapping: number;
  const MirroredRepeatWrapping: number;
  const LoopOnce: number;
  const LoopRepeat: number;
  const LoopPingPong: number;

  // --------------------------------------------------------- 3.5 textures

  /**
   * Decoding happens in the consumer. `url` accepts `https://...`,
   * `file:///...`, `asset://name`, or a path relative to the script's asset
   * root.
   */
  class Texture {
    constructor(url?: string | null);
    /**
     * The url the consumer was given, or `null` when containment refused it —
     * so `if (texture.url === null)` actually fires (3.5). What the script
     * asked for is kept in `requestedUrl`.
     */
    url: string | null;
    /** What the script asked for when the url was refused, else `null`. */
    readonly requestedUrl: string | null;
    readonly repeat: Vector2;
    readonly offset: Vector2;
    wrapS: number;
    wrapT: number;
    flipY: boolean;
    needsUpdate: boolean;
    readonly loaded: boolean;
    readonly error: string | null;
    addEventListener(type: "load" | "error", listener: (event: any) => void): void;
    removeEventListener(type: "load" | "error", listener: (event: any) => void): void;
    clone(): Texture;
    /**
     * Marks the texture for release. The consumer is told to free it once no
     * material or emitter references it any more, and the texture's id stays
     * reserved until then.
     */
    dispose(): void;
  }

  class TextureLoader {
    constructor();
    setPath(path: string): this;
    /** Returns immediately; the texture resolves asynchronously. */
    load(
      url: string,
      onLoad?: (texture: Texture) => void,
      onProgress?: (event: unknown) => void,
      onError?: (error: Error) => void,
    ): Texture;
    loadAsync(url: string, onProgress?: (event: unknown) => void): Promise<Texture>;
  }

  // ----------------------------------------------------------- 3.6 lights

  class Light extends Object3D {
    color: Color;
    intensity: number;
    readonly isLight: true;
  }

  /** Unitless multiplier; consumers map it to an even environment light. */
  class AmbientLight extends Light {
    constructor(color?: ColorRepresentation, intensity?: number);
  }

  /** Intensity in lux-equivalents; the RealityKit consumer multiplies by 1000. */
  class DirectionalLight extends Light {
    constructor(color?: ColorRepresentation, intensity?: number);
    /** The light points from its world position toward the target's. */
    target: Object3D;
    castShadow: boolean;
  }

  /** Intensity in candela; the RealityKit consumer converts to lumens. */
  class PointLight extends Light {
    constructor(color?: ColorRepresentation, intensity?: number, distance?: number, decay?: number);
    distance: number;
    decay: number;
  }

  class SpotLight extends Light {
    constructor(
      color?: ColorRepresentation,
      intensity?: number,
      distance?: number,
      angle?: number,
      penumbra?: number,
      decay?: number,
    );
    distance: number;
    angle: number;
    penumbra: number;
    decay: number;
    target: Object3D;
    castShadow: boolean;
  }

  /** Scene-level environment lighting. Assign to Spatial.environment. */
  class ImageBasedLight {
    constructor(url: string, intensity?: number);
    url: string;
    intensity: number;
  }

  // ---------------------------------------------------------- 3.7 physics

  type RigidBodyType = "dynamic" | "static" | "kinematic";
  type RigidBodyShape = "auto" | "box" | "sphere" | "capsule" | "convex" | "mesh";

  interface RigidBodyOptions {
    type?: RigidBodyType;
    /** Kilograms; dynamic bodies only. */
    mass?: number;
    /** "mesh" is static only; using it on a dynamic body throws. */
    shape?: RigidBodyShape;
    friction?: number;
    restitution?: number;
    linearDamping?: number;
    angularDamping?: number;
    /** Triggers report collisions without pushing. */
    isTrigger?: boolean;
    gravity?: boolean;
  }

  class RigidBody {
    constructor(options?: RigidBodyOptions);
    type: RigidBodyType;
    mass: number;
    shape: RigidBodyShape;
    friction: number;
    restitution: number;
    linearDamping: number;
    angularDamping: number;
    /**
     * A trigger is never simulated: the core emits `type: "static"` with no
     * mass and keeps the authored value as `requestedType` (3.7).
     */
    isTrigger: boolean;
    gravity: boolean;
    /**
     * Updated by the consumer each frame. Read-only: assign through
     * `setLinearVelocity`; a write is ignored and warns once.
     */
    readonly linearVelocity: Vector3;
    /** Read-only: assign through `setAngularVelocity`; a write warns once. */
    readonly angularVelocity: Vector3;
    /** Read-only: reported by the consumer through `syncBodies`. */
    readonly isSleeping: boolean;
    /**
     * The object this body is attached to. Assigned by the runtime when the
     * body is set on an object; scripts should treat it as read-only. One
     * RigidBody belongs to one object: assigning the same instance to a second
     * object throws a SpatialUnsupportedError with feature "rigidbody-shared".
     */
    readonly object: Object3D | null;
    applyImpulse(impulse: Vector3, atWorldPoint?: Vector3): this;
    applyForce(force: Vector3): this;
    applyTorque(torque: Vector3): this;
    setLinearVelocity(velocity: Vector3): this;
    setAngularVelocity(velocity: Vector3): this;
  }

  type JointType = "fixed" | "revolute" | "spherical" | "prismatic" | "distance";

  interface JointOptions {
    type: JointType;
    /** Object3Ds that carry a rigidBody. */
    bodyA: Object3D;
    bodyB: Object3D;
    anchorA?: Vector3;
    anchorB?: Vector3;
    /** Revolute and prismatic joints. */
    axis?: Vector3;
    /** Radians for revolute, metres for prismatic and distance. */
    limits?: [number, number] | null;
  }

  /**
   * Destroying either body removes the joint: the core emits `joint id null`
   * and drops it from `Spatial.physics.joints` and `dump().joints`.
   */
  class Joint {
    constructor(options: JointOptions);
    type: JointType;
    bodyA: Object3D | null;
    bodyB: Object3D | null;
    anchorA: Vector3;
    anchorB: Vector3;
    axis: Vector3;
    limits: [number, number] | null;
  }

  interface PhysicsWorld {
    /** Default (0, -9.81, 0). Assignment and .set() are both detected. */
    gravity: Vector3;
    readonly joints: Joint[];
    add(joint: Joint): Joint;
    remove(joint: Joint): Joint;
  }

  interface RaycastOptions {
    maxDistance?: number;
    recursive?: boolean;
  }

  interface RaycastHit {
    /** null for a hit on the real-world mesh (14.7). */
    object: Object3D | null;
    /** True when this hit is the real-world mesh rather than an object. */
    sceneUnderstanding: boolean;
    point: Vector3;
    normal: Vector3;
    distance: number;
  }

  // ------------------------------------------------------------ 3.8 input

  type HandJointName =
    | "wrist"
    | "forearmWrist"
    | "forearmArm"
    | "thumbKnuckle"
    | "thumbIntermediateBase"
    | "thumbIntermediateTip"
    | "thumbTip"
    | "indexFingerMetacarpal"
    | "indexFingerKnuckle"
    | "indexFingerIntermediateBase"
    | "indexFingerIntermediateTip"
    | "indexFingerTip"
    | "middleFingerMetacarpal"
    | "middleFingerKnuckle"
    | "middleFingerIntermediateBase"
    | "middleFingerIntermediateTip"
    | "middleFingerTip"
    | "ringFingerMetacarpal"
    | "ringFingerKnuckle"
    | "ringFingerIntermediateBase"
    | "ringFingerIntermediateTip"
    | "ringFingerTip"
    | "littleFingerMetacarpal"
    | "littleFingerKnuckle"
    | "littleFingerIntermediateBase"
    | "littleFingerIntermediateTip"
    | "littleFingerTip";

  interface HandJoint {
    position: Vector3;
    quaternion: Quaternion;
  }

  interface Hand {
    readonly isTracked: boolean;
    readonly isPinching: boolean;
    joint(name: HandJointName): HandJoint | null;
  }

  interface Keyboard {
    /** KeyboardEvent.code names, e.g. "KeyW", "Space", "ArrowLeft". */
    isDown(code: string): boolean;
    /** True for the single frame the key went down. */
    wasPressed(code: string): boolean;
    readonly connected: boolean;
  }

  /** One button for a frame: level, both edges, and a click count (14.9). */
  interface ButtonState {
    readonly down: boolean;
    /** True for the single frame the button went down. */
    readonly pressed: boolean;
    /** True for the single frame it came up. */
    readonly released: boolean;
    /** 0..1; a trigger reports its travel, a plain button 0 or 1. */
    readonly value: number;
    /** Presses inside 400 ms of each other: 2 is a double click. */
    readonly pressCount: number;
  }

  interface Mouse {
    /** View pixels, or null when the pointer is absent. */
    readonly position: Vector2 | null;
    /**
     * The world point under the pointer on the first hit mesh, or on the plane
     * through the origin facing the camera when nothing is hit; null when the
     * consumer reports none (14.3).
     */
    readonly scenePosition: Vector3 | null;
    readonly buttons: { left: boolean; right: boolean; middle: boolean };
    readonly delta: Vector2;
    /** Wheel or trackpad movement for this frame only. */
    readonly scroll: Vector2;
    readonly connected: boolean;
    readonly left: ButtonState;
    readonly right: ButtonState;
    readonly middle: ButtonState;
  }

  /** A game controller (14.8). Every button is a ButtonState. */
  interface Controller {
    readonly id: string;
    readonly name: string;
    readonly leftThumbstick: Vector2;
    readonly rightThumbstick: Vector2;
    /** 0..1. */
    readonly leftTrigger: number;
    readonly rightTrigger: number;
    readonly a: ButtonState;
    readonly b: ButtonState;
    readonly x: ButtonState;
    readonly y: ButtonState;
    readonly leftShoulder: ButtonState;
    readonly rightShoulder: ButtonState;
    readonly dpadUp: ButtonState;
    readonly dpadDown: ButtonState;
    readonly dpadLeft: ButtonState;
    readonly dpadRight: ButtonState;
    readonly menu: ButtonState;
    readonly options: ButtonState;
    /**
     * Always reaches the consumer as a `controllerRumble` command; where the
     * consumer has no haptics the script is warned once that it has no effect.
     */
    rumble(intensity: number, duration: number): this;
  }

  interface ControllerSet {
    readonly all: Controller[];
    /**
     * The controller whose input changed most recently, or null. Connecting
     * alone does not make a controller current (14.8).
     */
    readonly current: Controller | null;
    readonly connected: number;
    get(id: string): Controller | null;
  }

  interface InputState {
    readonly keyboard: Keyboard;
    readonly mouse: Mouse;
    /** null on macOS and the web. */
    readonly hands: { left: Hand | null; right: Hand | null };
    readonly controllers: ControllerSet;
  }

  /** Synthesises the events a consumer would produce, for verification. */
  interface Inject {
    tap(objectOrName: Object3D | string, point?: Vector3): void;
    drag(objectOrName: Object3D | string, translation: Vector3, options?: { steps?: number }): void;
    hover(objectOrName: Object3D | string, entering: boolean): void;
    key(code: string, down: boolean): void;
    /**
     * Controller state for the coming frame, in the `setInput.controllers`
     * shape. Every field is optional; what is missing reads as zero (14.8).
     */
    controller(state: ControllerStateJSON | ControllerStateJSON[] | null): void;
  }

  /** What a consumer (or `inject.controller`) reports for one controller. */
  interface ControllerStateJSON {
    id?: string;
    name?: string;
    leftThumbstick?: [number, number];
    rightThumbstick?: [number, number];
    leftTrigger?: number;
    rightTrigger?: number;
    buttons?: Partial<Record<
      | "a" | "b" | "x" | "y"
      | "leftShoulder" | "rightShoulder"
      | "dpadUp" | "dpadDown" | "dpadLeft" | "dpadRight"
      | "menu" | "options",
      boolean | number
    >>;
    /** Marks this one as the most recently used. */
    current?: boolean;
  }

  // -------------------------------------------------------- 3.9 animation

  class KeyframeTrack {
    constructor(name: string, times: ArrayLike<number>, values: ArrayLike<number>);
    name: string;
    times: Float32Array;
    values: Float32Array;
  }

  class VectorKeyframeTrack extends KeyframeTrack {}
  class QuaternionKeyframeTrack extends KeyframeTrack {}
  class NumberKeyframeTrack extends KeyframeTrack {}
  class ColorKeyframeTrack extends KeyframeTrack {}

  class AnimationClip {
    constructor(name?: string, duration?: number, tracks?: KeyframeTrack[]);
    name: string;
    duration: number;
    tracks: KeyframeTrack[];
    resetDuration(): this;
  }

  class AnimationAction {
    play(): this;
    stop(): this;
    reset(): this;
    setLoop(mode: number, repetitions: number): this;
    setEffectiveWeight(weight: number): this;
    setEffectiveTimeScale(timeScale: number): this;
    fadeIn(duration: number): this;
    fadeOut(duration: number): this;
    crossFadeTo(action: AnimationAction, duration: number, warp?: boolean): this;
    isRunning(): boolean;
    paused: boolean;
    enabled: boolean;
    time: number;
    timeScale: number;
    weight: number;
    clampWhenFinished: boolean;
    loop: number;
    repetitions: number;
  }

  /** Drive it from onFrame: `mixer.update(deltaTime)`. */
  class AnimationMixer {
    constructor(root: Object3D);
    time: number;
    timeScale: number;
    clipAction(clip: AnimationClip, root?: Object3D): AnimationAction;
    existingAction(clip: AnimationClip, root?: Object3D): AnimationAction | null;
    stopAllAction(): this;
    update(deltaTime: number): this;
    setTime(time: number): this;
    uncacheClip(clip: AnimationClip): void;
    uncacheRoot(root: Object3D): void;
    uncacheAction(clip: AnimationClip, root?: Object3D): void;
    addEventListener(type: "loop" | "finished", listener: (event: any) => void): void;
    removeEventListener(type: "loop" | "finished", listener: (event: any) => void): void;
  }

  const AnimationUtils: {
    arraySlice<T>(array: T, from: number, to: number): T;
    subclip(clip: AnimationClip, name: string, startFrame: number, endFrame: number, fps?: number): AnimationClip;
    makeClipAdditive(targetClip: AnimationClip, referenceFrame?: number, referenceClip?: AnimationClip, fps?: number): AnimationClip;
  };

  // -------------------------------------------------------- 3.10 particles

  type ParticlePreset = "fireworks" | "impact" | "magic" | "rain" | "snow" | "sparks" | "smoke";
  type ParticleShape = "point" | "sphere" | "box" | "cone" | "plane";

  interface ParticleEmitterOptions {
    /** A preset overrides every other field except isEmitting. */
    preset?: ParticlePreset | null;
    shape?: ParticleShape;
    shapeSize?: Vector3;
    birthRate?: number;
    lifetime?: number;
    lifetimeVariation?: number;
    speed?: number;
    speedVariation?: number;
    size?: number;
    sizeVariation?: number;
    color?: ColorRepresentation;
    colorEnd?: ColorRepresentation | null;
    opacity?: number;
    opacityEnd?: number;
    /** Cone half-angle in radians. */
    spreadAngle?: number;
    acceleration?: Vector3;
    isEmitting?: boolean;
    burstCount?: number;
    loops?: boolean;
    texture?: Texture | null;
  }

  /**
   * A preset overrides every authored field except `isEmitting`, and the core
   * resolves it at construction (3.10): reading `birthRate` back, the
   * `particles` payload and `dump()` all report what is rendered.
   */
  class ParticleEmitter extends Object3D {
    constructor(options?: ParticleEmitterOptions);
    preset: ParticlePreset | null;
    shape: ParticleShape;
    shapeSize: Vector3;
    birthRate: number;
    lifetime: number;
    lifetimeVariation: number;
    speed: number;
    speedVariation: number;
    size: number;
    sizeVariation: number;
    color: Color;
    colorEnd: Color | null;
    /** Particle start opacity, not the Object3D OpacityComponent value. */
    opacity: number;
    opacityEnd: number;
    spreadAngle: number;
    acceleration: Vector3;
    isEmitting: boolean;
    burstCount: number;
    loops: boolean;
    texture: Texture | null;
    burst(): this;
  }

  // ------------------------------------------------- 3.11 anchors, portals

  type AnchorPlane = "horizontal" | "vertical" | "any";
  type AnchorHandLocation = "palm" | "wrist" | "indexFingerTip" | "thumbTip" | "aboveHand";

  type AnchorTarget =
    | "head"
    | { plane: AnchorPlane; minimumBounds?: Vector2 }
    | { hand: "left" | "right"; location?: AnchorHandLocation }
    | { image: string }
    | { world: Matrix4 };

  class Anchor extends Group {
    constructor(target?: AnchorTarget);
    /** Stays false on macOS and the web. */
    readonly isAnchored: boolean;
  }

  interface PortalOptions {
    width?: number;
    height?: number;
    /** The Group rendered inside the portal. Add it to the scene too. */
    world: Object3D;
    crossing?: boolean;
  }

  class Portal extends Mesh {
    constructor(options: PortalOptions);
    width: number;
    height: number;
    crossing: boolean;
    world: Object3D | null;
  }

  // ---------------------------------------------------------- 3.12 assets

  interface AssetUrls {
    /** RealityKit loads usdz or reality. */
    usdz?: string;
    reality?: string;
    /** The web consumer loads glb or gltf. */
    glb?: string;
    gltf?: string;
  }

  class AssetGroup extends Group {
    /** Names discovered by the consumer after load. */
    readonly animations: string[];
    /** Reported by the consumer after load. */
    readonly boundingBox: Box3;
    readonly loaded: boolean;
    /** null unless the consumer reported a rig for this asset (14.5). */
    readonly skeleton: Skeleton | null;
    /** null unless the consumer reported blend shapes (14.5). */
    readonly blendShapes: BlendShapes | null;
    playAnimation(name: string, options?: { loop?: boolean; speed?: number }): this;
    stopAnimation(): this;
  }

  /**
   * A loaded asset's rig (14.5). Script poses are overridden by a native
   * animation while it plays, which is what `track(true)` is for: it asks the
   * consumer to report the real joint transforms back.
   */
  interface Skeleton {
    readonly joints: string[];
    readonly tracking: boolean;
    /** What the consumer last reported, else the script's own pose. */
    getJointTransform(name: string): { position: Vector3; quaternion: Quaternion } | null;
    setJointRotation(name: string, quaternion: Quaternion): this;
    setJointPosition(name: string, position: Vector3): this;
    /** Drops every script pose. */
    reset(): this;
    track(enabled: boolean): this;
  }

  interface BlendShapes {
    readonly names: string[];
    get(name: string): number;
    /** Weight is clamped to 0..1; an unknown name warns and is ignored. */
    set(name: string, weight: number): this;
  }


  // ============================================================ 14. phase 2

  // ------------------------------------------------------------- 14.1 audio

  /** An opaque, url-backed handle; the consumer loads the file. */
  class AudioBuffer {
    readonly url: string | null;
    /** The error, when the url was refused. */
    readonly error: string | null;
    /** Filled in from the object that plays it, through `syncAudio`. */
    readonly duration: number;
  }

  class AudioLoader {
    setPath(path: string): this;
    /**
     * Returns the handle immediately; `onLoad` runs on the next microtask. A
     * url the containment of 3.5 refuses never becomes a playable buffer.
     */
    load(
      url: string,
      onLoad?: (buffer: AudioBuffer) => void,
      onProgress?: (event: { loaded: number; total: number }) => void,
      onError?: (error: Error) => void,
    ): AudioBuffer;
    loadAsync(url: string): Promise<AudioBuffer>;
  }

  /** The listener and mixer, `Spatial.audio`. */
  interface AudioMixer {
    /** 0..1. */
    masterVolume: number;
    setGroupVolume(name: string, volume: number): this;
    /** The group names that have a volume set. */
    readonly groups: string[];
    /** Web audio starts suspended until a gesture; the harness resumes it. */
    readonly state: "running" | "suspended";
    resume(): this;
  }

  type DistanceModel = "inverse" | "linear" | "exponential";

  /**
   * Non-spatial audio (14.1). Playing a sound that is not in the graph adopts
   * it as an extra root so it still reaches the consumer. Playback state is
   * native-driven: the consumer owns `isPlaying`, `currentTime` and
   * `duration` and reports them through `syncAudio`.
   */
  class Audio extends Object3D {
    setBuffer(buffer: AudioBuffer | null): this;
    setLoop(loop: boolean): this;
    setVolume(volume: number): this;
    getVolume(): number;
    setPlaybackRate(rate: number): this;
    play(): this;
    pause(): this;
    stop(): this;
    readonly buffer: AudioBuffer | null;
    readonly isPlaying: boolean;
    /** Assigning seeks. */
    currentTime: number;
    readonly duration: number;
    loop: boolean;
    volume: number;
    playbackRate: number;
    /** The mix group this sound belongs to; "master" by default. */
    group: string;
    /** Called when the consumer reports the sound finished. */
    onEnded: (() => void) | null;
    /**
     * Stops the sound, releases it on the consumer (`audio id null`) and frees
     * the object (14.1). The same as `Spatial.destroy(sound)`; a playback call
     * afterwards is dropped with a warning and never brings it back.
     */
    dispose(): this;
  }

  class PositionalAudio extends Audio {
    setRefDistance(distance: number): this;
    getRefDistance(): number;
    setRolloffFactor(factor: number): this;
    getRolloffFactor(): number;
    setDistanceModel(model: DistanceModel): this;
    getDistanceModel(): DistanceModel;
    /**
     * Cone angles in **degrees** (0..360), keeping three.js's `PannerNode`
     * units — the one angle in the namespace that is not radians — and an
     * `outerGain` of 0..1. The `audio` payload's `cone: [inner, outer, gain]`
     * carries the same degrees.
     */
    setDirectionalCone(innerAngle: number, outerAngle: number, outerGain: number): this;
    /** dB; RealityKit's SpatialAudioComponent.reverbLevel. */
    reverbLevel: number;
  }

  /** Sound arriving from every direction at the object's position. */
  class AmbientAudio extends Audio {}

  // ------------------------------------------------------------- 14.2 video

  /** Alternative encodings of one video (14.2). */
  interface VideoSources {
    mp4?: string;
    hls?: string;
    webm?: string;
  }

  interface VideoScreenOptions {
    /**
     * One url, or one per encoding. Each goes through the containment of 3.5;
     * a refused key is dropped with a warning, and a screen left with no
     * source reports `url: null` and dispatches `error`.
     */
    url?: string | VideoSources;
    /** Metres. With only one given, the other follows the video's aspect. */
    width?: number;
    height?: number;
    loop?: boolean;
    muted?: boolean;
    autoplay?: boolean;
    /** visionOS only: adds a DockingRegionComponent. */
    docking?: boolean;
  }

  /**
   * A video on a plane (14.2). It is a mesh, so raycast and hit testing treat
   * it like any other mesh. Playback state comes from the consumer through
   * `syncVideo`; `loaded`, `ended` and `error` events are dispatched on it.
   */
  class VideoScreen extends Mesh {
    constructor(options?: VideoScreenOptions);
    /** What the consumer was given: the string, the surviving sources, or null. */
    readonly url: string | VideoSources | null;
    readonly width: number;
    readonly height: number;
    readonly docking: boolean;
    play(): this;
    pause(): this;
    readonly isPlaying: boolean;
    currentTime: number;
    readonly duration: number;
    volume: number;
    muted: boolean;
    loop: boolean;
    playbackRate: number;
    /** The message from an `error` event, else null. */
    readonly error: string | null;
  }

  // ----------------------------------------------------------- 14.3 cameras

  class Camera extends Object3D {
    near: number;
    far: number;
    readonly isCamera: true;
    updateProjectionMatrix(): void;
  }

  class PerspectiveCamera extends Camera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    fov: number;
    /**
     * Managed by the consumer from the viewport. A value the script sets — in
     * the constructor or later — is kept for three's own projection matrix but
     * reported as ignored.
     */
    aspect: number;
    readonly isPerspectiveCamera: true;
  }

  class OrthographicCamera extends Camera {
    constructor(left?: number, right?: number, top?: number, bottom?: number, near?: number, far?: number);
    left: number;
    right: number;
    top: number;
    bottom: number;
    readonly isOrthographicCamera: true;
  }

  interface Ray3 {
    origin: Vector3;
    direction: Vector3;
  }

  // -------------------------------------- 14.4 character and force effects

  interface CharacterControllerOptions {
    /** Metres. */
    radius?: number;
    height?: number;
    /** Radians; the steepest slope the character climbs. */
    slopeLimit?: number;
    stepLimit?: number;
    gravity?: boolean;
  }

  /**
   * Assign to `object.characterController`. The object becomes native-driven
   * like a dynamic body: the consumer resolves each `move` against the world
   * and reports the result through `syncCharacter`.
   */
  class CharacterController {
    constructor(options?: CharacterControllerOptions);
    readonly radius: number;
    readonly height: number;
    readonly slopeLimit: number;
    readonly stepLimit: number;
    readonly gravity: boolean;
    /** The object this controller is attached to, or null. */
    readonly object: Object3D | null;
    readonly isOnGround: boolean;
    /** Read-only: the consumer owns it. */
    readonly velocity: Vector3;
    /**
     * Applied next frame, sliding along obstacles. A move made before the
     * consumer has seen the object waits for the frame after its `create`.
     */
    move(displacement: Vector3): this;
    /** Unconditional placement, ignoring collision. */
    teleport(position: Vector3): this;
  }

  type ForceFalloff = "none" | "linear" | "inverseSquare";

  /**
   * Acts on dynamic bodies within `radius` of its world position (14.4).
   * Units: `force` is newtons, `strength` is newtons at one metre from the
   * effect (falloff applies beyond that), `coefficient` is a dimensionless
   * drag factor on velocity, `noiseScale` and `radius` are metres. Both
   * consumers clamp the acceleration a field imparts to 1000 m/s² per step and
   * warn once naming the field, so a mis-scaled recipe cannot launch a body.
   */
  class ForceField extends Object3D {
    enabled: boolean;
    radius: number;
    /** A collision mask, forwarded to the consumer unchanged. */
    mask: number;
    readonly isForceField: true;
    readonly kind: string;
  }

  class ConstantForceField extends ForceField {
    constructor(options?: { force?: Vector3; radius?: number; mask?: number; enabled?: boolean });
    readonly force: Vector3;
  }

  class RadialForceField extends ForceField {
    constructor(options?: {
      strength?: number;
      minimumDistance?: number;
      falloff?: ForceFalloff;
      radius?: number;
      mask?: number;
      enabled?: boolean;
    });
    strength: number;
    minimumDistance: number;
    falloff: ForceFalloff;
  }

  class VortexForceField extends ForceField {
    constructor(options?: { strength?: number; axis?: Vector3; radius?: number; mask?: number; enabled?: boolean });
    strength: number;
    readonly axis: Vector3;
  }

  class DragForceField extends ForceField {
    constructor(options?: { coefficient?: number; radius?: number; mask?: number; enabled?: boolean });
    coefficient: number;
  }

  class TurbulenceForceField extends ForceField {
    constructor(options?: {
      strength?: number;
      noiseScale?: number;
      radius?: number;
      mask?: number;
      enabled?: boolean;
    });
    strength: number;
    noiseScale: number;
  }

  // ------------------------------------------- 14.6 shader graph materials

  type ShaderParameterValue = number | boolean | string | Vector2 | Vector3 | Vector4 | Color | Texture;

  /**
   * A pre-authored RealityKit shader graph, with the fallback every other
   * consumer renders. `fallback` is required.
   */
  class ShaderGraphMaterial extends Material {
    constructor(options: {
      source?: string;
      name?: string;
      parameters?: Record<string, ShaderParameterValue>;
      fallback: Material;
    });
    /** The USD file, after url containment. */
    readonly source: string | null;
    /** The graph's name inside that file (`name` is three's Material.name). */
    readonly graphName: string;
    readonly fallback: Material;
    readonly parameters: Record<string, ShaderParameterValue>;
    /** Bumps on every setParameter, so consumers can order edits. */
    readonly generation: number;
    /**
     * Also updates the same-named property of the fallback where the fallback
     * has one, except its identity fields — `uuid`, `id`, `type`, `name` and
     * `version` are never written and warn once, though the shader graph still
     * receives the parameter. A name the fallback does not have warns once
     * too. A value the command stream cannot carry — a NaN, an object, a
     * string past 256 characters, an array of other than two to four finite
     * numbers — is refused with a warning rather than sent as null or cut.
     */
    setParameter(name: string, value: ShaderParameterValue): this;
    getParameter(name: string): ShaderParameterValue | undefined;
  }

  // ------------------------------------------------ 14.7 scene understanding

  interface SceneUnderstanding {
    collision: boolean;
    occlusion: boolean;
    physics: boolean;
    shadows: boolean;
  }

  // ------------------------------------------------------ 14.10 host channel

  interface HostChannel {
    /** The `Module.function` names the app registered. */
    readonly functions: string[];
    on(name: string, handler: (payload: any) => void): (payload: any) => void;
    off(name: string, handler?: (payload: any) => void): void;
    /** Script to host. The payload is copied to JSON before it leaves. */
    send(name: string, payload?: any): this;
    /**
     * Script to host, with an answer. An unregistered name rejects
     * immediately with a SpatialUnsupportedError of feature "host-function".
     */
    call(name: string, args?: any): Promise<any>;
  }

  // ----------------------------------------------------- 14.11 small parts

  interface Accessibility {
    label?: string;
    value?: string;
    hint?: string;
    isButton?: boolean;
  }

  type DebugModelView =
    | null
    | "normal"
    | "uv"
    | "baseColor"
    | "roughness"
    | "metallic"
    | "occlusion"
    | "emissive";

  // --------------------------------------------------------- 3.13 runtime

  type Backend = "realitykit" | "three";
  type Platform = "macos" | "visionos" | "web";

  interface Capabilities {
    hands: boolean;
    anchors: boolean;
    portals: boolean;
    particles: boolean;
    manipulation: boolean;
    hoverEffect: boolean;
    shadows: boolean;
    // 14.14: true only where the consumer implements the feature with effect.
    audio: boolean;
    video: boolean;
    camera: boolean;
    characterController: boolean;
    forceFields: boolean;
    skeleton: boolean;
    blendShapes: boolean;
    shaderGraph: boolean;
    sceneUnderstanding: boolean;
    controllers: boolean;
    hostFunctions: boolean;
    accessibility: boolean;
  }

  interface Env {
    readonly backend: Backend;
    readonly platform: Platform;
    readonly capabilities: Capabilities;
  }

  interface Time {
    /** Seconds since the previous frame. */
    readonly delta: number;
    /** Seconds since load. */
    readonly elapsed: number;
    /** Frames since load, starting at 1. */
    readonly frame: number;
  }

  interface DumpObject {
    id: number;
    name: string;
    type: string;
    parent: number;
    visible: boolean;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    scale: [number, number, number];
    worldPosition: [number, number, number];
    geometry: { type: string; uuid: string; parameters: Record<string, any> | null } | null;
    material: Record<string, any> | Array<Record<string, any> | null> | null;
    light: Record<string, any> | null;
    rigidBody: Record<string, any> | null;
    opacity: number;
    billboard: boolean;
    groundingShadow: boolean;
    hoverEffect: HoverEffect;
    manipulable: boolean;
    castShadow: boolean;
    receiveShadow: boolean;
    renderOrder: number;
    world: boolean;
    interactive: {
      tap: boolean;
      hover: boolean;
      drag: boolean;
      manipulation: boolean;
      collision: boolean;
    };
    /** Present only on objects with a rigid body, from the last syncBodies. */
    velocity?: [number, number, number];
    isSleeping?: boolean;
    // Phase 2 (SPEC 14), present only on the objects that carry the feature.
    audio?: Record<string, any>;
    video?: Record<string, any>;
    characterController?: Record<string, any>;
    isOnGround?: boolean;
    forceField?: Record<string, any>;
    accessibility?: Accessibility | null;
    skeleton?: { joints: Record<string, number[]>; track: boolean } | null;
    blendShapes?: Record<string, number> | null;
    userData: Record<string, any>;
    [key: string]: any;
  }

  /** One entry of the command stream: an opcode, a target id, then arguments. */
  type Command = [string, number, ...any[]];

  interface Dump {
    backend: Backend;
    platform: Platform;
    frame: number;
    elapsed: number;
    /** Increments on every `load`, so a consumer can tell scripts apart. */
    loadGeneration: number;
    /** The mounted scene's own name and userData, or null before mount. */
    scene: { name: string; userData: Record<string, any> } | null;
    objects: DumpObject[];
    joints: Array<Record<string, any>>;
    gravity: [number, number, number];
    environment: { url: string; intensity: number } | null;
    // Phase 2 scene-level state (SPEC 14).
    isActive: boolean;
    audioMixer: { masterVolume: number; groups: Record<string, number>; state: string };
    /**
     * The live camera's parameters, or null for the consumer's built-in
     * camera. The pose is not in it: the camera is an Object3D, so it appears
     * in `objects` and its transform travels with every other object's.
     */
    camera: Record<string, any> | null;
    sceneUnderstanding: SceneUnderstanding;
    render: { adaptiveResolution: boolean };
    environmentLighting: { intensityExponent: number };
    debug: { modelView: DebugModelView };
    hostFunctions: string[];
    controllers: Array<Record<string, any>>;
    warnings: string[];
    /** The most recent errors; older ones are dropped once the cap is reached. */
    errors: string[];
    /** How many times the `errors` cap dropped older entries. */
    droppedErrors: number;
  }

  class SpatialUnsupportedError extends Error {
    readonly feature: string | null;
    readonly object: Object3D | null;
  }

  /** Makes `scene` the displayed scene. Only one scene is mounted at a time. */
  function mount(scene: Scene): Scene;
  /** The mounted scene, or null before mount. */
  const scene: Scene | null;
  type FrameCallback = (deltaTime: number, elapsedTime: number) => void;
  /** Runs `callback(deltaTime, elapsedTime)` every frame before flush. */
  function onFrame(callback: FrameCallback): FrameCallback;
  function offFrame(callback: FrameCallback): void;
  const time: Time;
  const env: Env;
  const physics: PhysicsWorld;
  const input: InputState;
  const inject: Inject;
  /**
   * Scene-level image based light. Assign null to clear. The url is contained
   * the same way a texture url is; a refused url leaves the scene with no
   * environment and is reported through `dump().warnings`.
   */
  let environment: ImageBasedLight | null;
  /**
   * Synchronous hit test over visible meshes, sorted by distance, at most one
   * hit per object. `recursive: false` limits hits to direct children of the
   * mounted scene.
   */
  function raycast(origin: Vector3, direction: Vector3, options?: RaycastOptions): RaycastHit[];
  /**
   * Rejects with SpatialUnsupportedError when the backend's key is missing, or
   * when containment refused it: every url is resolved against the asset root,
   * kept inside it, limited to the documented schemes and stripped of any
   * credentials before it reaches the consumer.
   */
  function loadAsset(urls: AssetUrls): Promise<AssetGroup>;
  /** Shorthand for `Spatial.scene.getObjectByName(name)`. */
  function find(name: string): Object3D | null;
  /**
   * Frees `object` and its descendants: the consumer destroys the entities
   * descendants first, the object is detached from its parent, and its ids are
   * released. Adding a destroyed object back throws a SpatialUnsupportedError
   * with feature "destroyed-object". `scene.remove()` only detaches.
   */
  function destroy(object: Object3D): Object3D;
  interface DumpOptions {
    /** Only these objects, by name. */
    names?: string[];
    /** Only these per-object keys; `id` and `name` are always present. */
    fields?: string[];
    /**
     * Every number rounded to four decimals, with only the geometry
     * parameters and `userData` omitted (SPEC 3.13). Material, light, body,
     * interactive and flag payloads all stay, so a polling host still sees the
     * whole object — it is smaller on the wire, not narrower.
     */
    compact?: boolean;
    /** `false` omits the object list entirely, leaving the scene summary. */
    objects?: boolean;
  }

  function dump(options?: DumpOptions): Dump;

  // ---------------------------------------------------------------- 14 API

  /** The listener and mixer (14.1). */
  const audio: AudioMixer;
  /**
   * The active camera (14.3). null means the consumer's built-in camera. The
   * `camera` command names the camera object's own id, so a camera that was
   * never added to the scene becomes an extra root: it is created and its
   * transform is flushed like any other object's. On visionOS the user is the
   * camera: an assignment is kept and reported, and warns once.
   */
  let camera: Camera | null;
  /**
   * A world-space ray for a view pixel (14.3). null on visionOS, and null
   * without the consumer's `rayFromPoint` hook.
   */
  function rayFromPoint(x: number, y: number): Ray3 | null;
  /** visionOS only; the state is kept and reported elsewhere (14.7). */
  let sceneUnderstanding: SceneUnderstanding;
  /** The bidirectional channel with the embedding app (14.10). */
  const host: HostChannel;
  /** False between `willDeactivate` and `didActivate`; ticks pause (14.10). */
  const isActive: boolean;
  /** visionOS only (14.11). */
  const render: { adaptiveResolution: boolean };
  /** Scales the environment lighting (14.11). */
  const environmentLighting: { intensityExponent: number };
  /** Substitutes a debug material where the consumer has one (14.11). */
  const debug: { modelView: DebugModelView };
  /** The consumer performs the request; url rules of 3.5 apply (14.11). */
  function fetchText(url: string): Promise<string>;
  function fetchJSON(url: string): Promise<any>;
  /** Runs teardown and returns the final command array (the destroys). */
  function dispose(): Command[];
  const version: string;
}

// Globals the core installs for a script. `Spatial` is already a value through
// the namespace declaration above; `require("spatial")` returns the same thing.
declare function require(name: "spatial"): typeof Spatial;
declare function setTimeout(callback: (...args: any[]) => void, delayMs?: number, ...args: any[]): number;
declare function clearTimeout(id: number): void;
declare function setInterval(callback: (...args: any[]) => void, delayMs?: number, ...args: any[]): number;
declare function clearInterval(id: number): void;
declare function requestAnimationFrame(callback: (timestamp: number) => void): number;
declare function cancelAnimationFrame(id: number): void;
declare const console: {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
};

/** Lifecycle members a script may set on `this`. */
interface SpatialScriptThis {
  didAdd?(): void;
  update?(deltaTime: number): void;
  willRemove?(): void;
  /** The view appeared or went away (14.10); ticks pause while inactive. */
  didActivate?(): void;
  willDeactivate?(): void;
  /**
   * A hot reload that preserved state hands the previous script's `this.state`
   * here, after load and before the first frame (14.10). Not called at all
   * without a preserved state.
   */
  scriptChanged?(previousState: any): void;
  /** JSON-serialisable state a reload can carry across (14.10). */
  state?: any;
  /** Alias for `Spatial.host.on`. */
  on?(name: string, handler: (payload: any) => void): (payload: any) => void;
  [key: string]: any;
}
```

---

# What each part of the API is for

The declarations above give you every signature. This section tells you what the pieces
are *for*, so you pick the right one.

## Scene graph and transforms

| Name | Purpose |
| --- | --- |
| `Scene` | The one mounted root. `background`, `environment` and `fog` **throw** on assignment — use `Spatial.environment` instead. |
| `Group` | An invisible container. Use it to move, rotate or hide a set of objects together. |
| `Mesh` | Geometry plus material. **Only meshes are rendered and only meshes are hit-tested.** |
| `Object3D` | The base of all of the above. |

Transform: `position` (`Vector3`), `rotation` (`Euler`, radians), `quaternion`, `scale`,
`up`. Write them directly (`mesh.position.set(x, y, z)`, `mesh.rotation.y += dt`) — they
are read-only *references*, so `.set()`, `.copy()`, `.add()` on them all work; you cannot
assign a new vector over `position` itself.

Hierarchy: `add(...)`, `remove(...)`, `removeFromParent()`, `clear()`, `attach(object)`
(reparents keeping world transform), `traverse(cb)`, `getObjectByName(name)`,
`Spatial.find(name)`. `add(null)` is ignored with a warning; `add(notAnObject3D)` throws a
`TypeError`. Depth is capped at `Spatial.limits.MAX_DEPTH` (1024). Re-parenting an
ancestor under its own descendant is ignored and recorded as a `cyclic-parent` error.

Helpers: `lookAt`, `localToWorld` / `worldToLocal`, `getWorldPosition`,
`getWorldQuaternion`, `getWorldScale`, `getWorldDirection`, `rotateX/Y/Z`,
`rotateOnAxis`, `rotateOnWorldAxis`, `translateX/Y/Z`, `translateOnAxis`,
`applyMatrix4` (a matrix carrying **shear** is refused and recorded in `dump().errors`).

Per-object display flags:

| Flag | Meaning |
| --- | --- |
| `visible` | Hides the object and its subtree. |
| `opacity` | 0..1, applies to the object **and its descendants**. Cheaper than tweening a material. |
| `billboard` | The object turns to face the viewer. The portable answer to "always face me". |
| `castShadow` / `receiveShadow` | Shadow participation. |
| `renderOrder` | Draw order override (visionOS and web; macOS warns once and ignores it). |
| `hoverEffect` | `"highlight"`, `"lift"`, `"spotlight"` or `null`. visionOS only (see below). |
| `manipulable` | Enables the system grab / move / rotate / scale gesture. visionOS only. |
| `groundingShadow` | A contact shadow under a **mesh**. RealityKit only; web warns once. |
| `userData` | Your own bag of state. It travels into `dump()`, which makes it the right place to put anything you want to inspect. |
| `accessibility` | `{ label, value, hint, isButton }` — a RealityKit `AccessibilityComponent`, mirrored to ARIA on web. |

`matrixAutoUpdate` (default `true`) means position/rotation/scale drive the matrix. Set it
to `false` **after** calling `updateMatrix()` and the matrix becomes authoritative — this
is also the static-scenery performance hint (about a third the per-frame cost of a moving
object).

`clone(recursive)` and `copy()` carry the display flags but **not** event listeners and
**not** `rigidBody`.

`Spatial.destroy(object)` frees the object *and its whole subtree* and recycles its ids;
`scene.remove(object)` only detaches and leaves the native entity alive. Adding a
destroyed object back throws `SpatialUnsupportedError` with `feature: "destroyed-object"`.
Destroying the mounted scene throws.

## Geometry

Every parametric geometry keeps its three.js constructor signature and its `parameters`
object. **Every one of them defaults to one metre — always pass explicit sizes.**

| Geometry | Arguments | Use for |
| --- | --- | --- |
| `BoxGeometry` | `width, height, depth, widthSegments, heightSegments, depthSegments` | Cubes, slabs, crates, walls. |
| `SphereGeometry` | `radius, widthSegments, heightSegments, phiStart, phiLength, thetaStart, thetaLength` | Balls, domes (with the partial angles). |
| `PlaneGeometry` | `width, height, widthSegments, heightSegments` | Floors, backdrops, panels. Faces **+z**; rotate `-Math.PI / 2` on x for a floor. |
| `CylinderGeometry` | `radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength` | Pillars, tubes; a truncated cone with differing radii. |
| `ConeGeometry` | `radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength` | Cones, spikes, arrowheads. |
| `TorusGeometry` | `radius, tube, radialSegments, tubularSegments, arc` | Rings, donuts, halos. |
| `CapsuleGeometry` | `radius, height, capSegments, radialSegments, heightSegments` | Pills; the natural body for a capsule rigid body. |
| `CircleGeometry` | `radius, segments, thetaStart, thetaLength` | Discs, pie wedges. |
| `RingGeometry` | `innerRadius, outerRadius, thetaSegments, phiSegments, thetaStart, thetaLength` | Annuli, dials, progress arcs. |
| `TextGeometry` | `text, { size, depth, font }` | Extruded 3-D text. `size` defaults 0.1 m, `depth` 0.01 m; `font` must be `"default"` — anything else throws. |
| `BufferGeometry` | — | Your own vertices. |

`BufferGeometry` carries `attributes`, `index`, `boundingBox`, `boundingSphere`, and
`setAttribute` / `getAttribute` / `deleteAttribute` / `setIndex` /
`computeVertexNormals` / `computeBoundingBox` / `computeBoundingSphere` /
`applyMatrix4` / `translate` / `rotateX|Y|Z` / `scale` / `center` / `clone` / `dispose`.
Only the `position`, `normal` and `uv` attributes are transmitted. Build attributes with
`new Float32BufferAttribute(arrayOrCount, itemSize)`.

**`TextGeometry` is left-aligned and starts at the origin on every backend.** To centre a
label, `geometry.computeBoundingBox()` then `geometry.center()` or translate by half its
width yourself.

## Materials

| Material | What it is for |
| --- | --- |
| `MeshBasicMaterial` | **Unlit** flat colour. RealityKit `UnlitMaterial`. Use it for UI-ish panels, emissive-looking accents, and as a diagnostic (if a black mesh appears when you swap to it, you are missing lights). |
| `MeshStandardMaterial` | The default workhorse: physically based metal/rough. RealityKit `PhysicallyBasedMaterial`. Needs lights. |
| `MeshPhysicalMaterial` | `MeshStandardMaterial` plus `clearcoat` and `clearcoatRoughness` — car paint, lacquer, varnished wood. |
| `OcclusionMaterial` | Invisible, but writes depth: it **hides what is behind it**. Use it to cut a hole into real-world geometry or to mask a portal. Depth-only on web. |
| `ShaderGraphMaterial` | A pre-authored RealityKit shader graph from a USD file (see below). |

Shared properties: `color`, `map`, `opacity`, `transparent`, `side` (`FrontSide`,
`BackSide`, `DoubleSide`), `wireframe`, `depthWrite`, `depthTest`, `blending`
(`NormalBlending`, `AdditiveBlending`), `needsUpdate`, `dispose()`, `clone()`.
`MeshStandardMaterial` adds `emissive`, `emissiveIntensity`, `emissiveMap`, `metalness`,
`metalnessMap`, `roughness`, `roughnessMap`, `normalMap`.

Setting a property outside that list (`aoMap`, `sheen`, …) does nothing. Out-of-range
scalars are clamped with one warning per material. You do **not** need `needsUpdate` for
an ordinary material property write.

A `Mesh` takes one material, or an array with one entry per `geometry.groups` entry. A
mesh built with no material gets a `MeshStandardMaterial` (a **lit** one — note three.js
would substitute an unlit `MeshBasicMaterial`) and warns.

Good-looking defaults to reach for: a matte surface is `roughness: 0.8–0.95, metalness: 0`;
a plastic is `roughness: 0.3, metalness: 0.1`; a metal is `roughness: 0.15–0.3,
metalness: 0.7–1` **and needs a `DirectionalLight` or an environment** (see below).

## Textures and asset urls

`new Texture(url)` or `new TextureLoader().load(url, onLoad)` / `.loadAsync(url)`.
Decoding happens in the consumer, so `load` returns immediately and the texture fills in
later; `texture.loaded` and `texture.error` and the `"load"` / `"error"` events tell you
when. `repeat`, `offset`, `wrapS`, `wrapT`, `flipY` are the usual three.js controls —
**`repeat` does nothing useful unless you also set `wrapS`/`wrapT` to `RepeatWrapping`**,
because the default is `ClampToEdgeWrapping` and you get stretched edge pixels.

Every url — texture, asset, environment, audio, video — goes through the same containment:
allowed schemes are `https:`, `http:`, `file:`, `asset:` and `data:`; the path is
normalised against the script's asset root and **refused if it escapes it**; credentials
are stripped. A refused url leaves `texture.url === null` with the original in
`texture.requestedUrl`, and a warning in `dump().warnings`. Write `asset://name` or a
plain relative path for bundled files.

`texture.dispose()` marks it for release; the consumer frees it once no material or
emitter still points at it. **Repoint the material first, then dispose.**

## Lighting a scene that is not flat or black

Four light types, and one scene-level environment:

| Light | Units / arguments | Role |
| --- | --- | --- |
| `AmbientLight(color, intensity)` | unitless multiplier | Fill. Lifts the shadow side so nothing is pure black. It casts no shadows and gives no shape on its own. |
| `DirectionalLight(color, intensity)` | lux-equivalent (RealityKit multiplies by 1000) | The key light — a sun. Has a `target` object and `castShadow`. Direction is from its world position toward `target`'s. |
| `PointLight(color, intensity, distance, decay)` | candela | Local glow, rim light, a lamp inside the scene. **Point-light shadows are unsupported on RealityKit** (warns once, ignored). |
| `SpotLight(color, intensity, distance, angle, penumbra, decay)` | candela | A cone of light; `angle` in radians, `penumbra` 0..1 softens the edge. Has `target` and `castShadow`. |
| `ImageBasedLight(url, intensity)` | — | Assign to `Spatial.environment`. Lights everything from an equirectangular image and is what makes metals read as metal. |

A reliable three-light setup at tabletop scale, and the minimum you should ship:

```js
scene.add(new Spatial.AmbientLight(0xffffff, 0.4));

const key = new Spatial.DirectionalLight(0xfff4e6, 2.5);
key.position.set(0.6, 1.2, 0.8);
key.castShadow = true;
scene.add(key);

const rim = new Spatial.PointLight(0x88bbff, 3, 2, 2);
rim.position.set(-0.5, 0.3, -0.4);
scene.add(rim);
```

Warm key, cool rim, low ambient: that is the difference between a scene that looks lit and
one that looks like flat clip art. Notes that actually bite:

- **A metal lit only by an `AmbientLight` is black on the web** (three.js's ambient
  contributes diffuse only) while RealityKit renders it. Give any metallic object a real
  `DirectionalLight`, or set `Spatial.environment`.
- On RealityKit, if you set `Spatial.environment` **and** add an `AmbientLight`, the
  environment wins and the ambient intensity is ignored with one warning.
- Environment images: `.hdr`, `.png` and `.jpg` equirectangular work on both backends;
  `.exr` is RealityKit-only and the web warns and installs nothing. **Ship `.hdr`.**
- `Spatial.environmentLighting.intensityExponent` scales the environment contribution.
- Light scalars out of range are clamped with one warning per light.

## Physics

Attach a body to a mesh: `mesh.rigidBody = new RigidBody({ ... })`.

| Option | Meaning |
| --- | --- |
| `type` | `"dynamic"` (simulated), `"static"` (immovable), `"kinematic"` (you drive it). |
| `mass` | kg, dynamic bodies only. |
| `shape` | `"auto"`, `"box"`, `"sphere"`, `"capsule"`, `"convex"`, `"mesh"`. **`"mesh"` is static-only** — using it on a dynamic body throws. |
| `friction`, `restitution` | 0..1-ish; restitution is bounciness. Negative values clamp to 0. |
| `linearDamping`, `angularDamping` | Velocity bleed. |
| `isTrigger` | Reports collisions without pushing. |
| `gravity` | Whether world gravity applies. |

Rules you must author around:

- **A dynamic body's transform is not yours.** Writing `position` / `quaternion` /
  `scale` on a dynamic body is a **teleport**: it moves there and its velocity is zeroed.
  To push it, use `applyImpulse(vec, atWorldPoint?)`, `applyForce(vec)`,
  `applyTorque(vec)`, `setLinearVelocity(vec)`, `setAngularVelocity(vec)`.
- `linearVelocity`, `angularVelocity` and `isSleeping` are **read-only** state the consumer
  pushes in; assigning them is ignored with a warning.
- **Things fall forever without a static floor.** A bare mesh is hit-testable but not
  collidable — the floor needs its own `new RigidBody({ type: "static" })`.
- A `RigidBody` on a `Group` is ignored (no geometry to build a shape from). Bodies go on
  meshes. One `RigidBody` instance belongs to one object: assigning it to a second throws
  `SpatialUnsupportedError` with `feature: "rigidbody-shared"`.
- **A trigger is never simulated.** With `isTrigger: true` the `type`, `mass` and
  `gravity` you wrote are ignored (`dump()` still echoes what you asked for). Use it for
  "the ball entered the goal": listen for `collisionstart` / `collisionend`.

`Spatial.physics` is the world: `gravity` (default `(0, -9.81, 0)`; both assignment and
`.set()` are detected), `joints`, `add(joint)`, `remove(joint)`.

Joints — `new Joint({ type, bodyA, bodyB, anchorA, anchorB, axis, limits })`, then
`Spatial.physics.add(joint)`. `bodyA`/`bodyB` are `Object3D`s that carry a `rigidBody`.

| Type | What it constrains | `limits` |
| --- | --- | --- |
| `fixed` | Welds two bodies. | — |
| `revolute` | A hinge about `axis`. | radians |
| `spherical` | A ball joint. | — |
| `prismatic` | A slider along `axis`. | metres |
| `distance` | Holds a separation. | metres |

Destroying either body removes the joint silently.

`Spatial.raycast(origin, direction, { maxDistance, recursive })` is a synchronous hit test
over **visible meshes** (a rigid body is not required), sorted by distance, at most one
hit per object; `recursive: false` limits it to direct children of the mounted scene. Each
hit is `{ object, sceneUnderstanding, point, normal, distance }`, and `object` is `null`
with `sceneUnderstanding: true` for a hit on the real-world mesh.

## Input events

Attach with `object.addEventListener(type, handler)`. **Registering the listener is what
makes the object an input target**, and only meshes are hit-tested — a listener on a
`Group` receives events that *bubble* from its children, but the group itself is never
hit. Events bubble to ancestors with `target` unchanged while `currentTarget` follows;
the mounted `Scene` sees everything last; `event.stopPropagation()` halts the climb.

| Event | Payload beyond the base | When |
| --- | --- | --- |
| `tap` | `point` (world `Vector3`) | A pinch or a click on the object. |
| `hoverenter` / `hoverexit` | — | Gaze or pointer entering/leaving. Fires on every backend even where `hoverEffect` has no visual. |
| `dragstart` / `drag` / `dragend` | `translation` (world `Vector3`), `point` | A drag gesture. |
| `manipulationstart` / `manipulation` / `manipulationend` | — | The system grab gesture on a `manipulable` object. visionOS only. |
| `collisionstart` / `collisionend` | `other`, `point`, `normal`, `impulse` | Two bodies touched. Needs rigid bodies (or a trigger). |
| `anchored` / `unanchored` | — | An `Anchor` found or lost its target. visionOS only. |
| `assetLoaded` / `assetError` | `animations`, `message` | Fired on an `AssetGroup`. |

**Drag is the one people get wrong.** `event.translation` is the world-space displacement
since `dragstart` — not since the previous event — and **the consumer never moves the
object for you**. Capture the origin on `dragstart` and add to *that*:

```js
const origin = new Spatial.Vector3();
mesh.addEventListener("dragstart", () => origin.copy(mesh.position));
mesh.addEventListener("drag", (event) => mesh.position.copy(origin).add(event.translation));
```

Under a rotated or scaled parent, convert: `translation` is world space, `position` is
local, so go through `mesh.parent.worldToLocal(...)`.

Polled input is on `Spatial.input`:

- `keyboard.isDown(code)`, `keyboard.wasPressed(code)` (true for one frame), `connected`.
  Codes are `KeyboardEvent.code` names: `"KeyW"`, `"Space"`, `"ArrowLeft"`.
- `mouse.position` (view pixels or `null`), `mouse.scenePosition` (the world point under
  the pointer), `delta`, `scroll`, and `left` / `right` / `middle` as `ButtonState`
  (`down`, `pressed`, `released`, `value`, `pressCount` — 2 is a double click).
- `hands.left` / `hands.right` — `isTracked`, `isPinching`, `joint(name)`. **`null`
  everywhere but visionOS; always null-check.**
- `controllers.all` / `.current` / `.connected` / `.get(id)` — thumbsticks, triggers,
  face buttons, d-pad, `menu`, `options`, and `rumble(intensity, duration)`.

`Spatial.inject` synthesises `tap`, `drag`, `hover`, `key` and `controller` state on every
backend, for testing. Injected events are delivered at the **start of the next tick**, so
tick once before asserting.

## Keyframe animation

Everything here is the real three.js animation system, running inside the core, so both
backends see the result with no extra plumbing.

Build tracks — `VectorKeyframeTrack`, `QuaternionKeyframeTrack`, `NumberKeyframeTrack`,
`ColorKeyframeTrack`, each `new Track(name, times, values)` where `name` is
`"objectName.property"`. Group them into `new AnimationClip(name, duration, tracks)`.
Play them through a mixer:

```js
const mixer = new Spatial.AnimationMixer(root);
const action = mixer.clipAction(clip);
action.setLoop(Spatial.LoopRepeat, Infinity);
action.play();
Spatial.onFrame((dt) => mixer.update(dt));   // nothing calls this for you
```

`AnimationAction` gives you `play`, `stop`, `reset`, `setLoop(LoopOnce | LoopRepeat |
LoopPingPong, repetitions)`, `setEffectiveWeight`, `setEffectiveTimeScale`, `fadeIn`,
`fadeOut`, `crossFadeTo`, `clampWhenFinished`, `paused`, `time`, `timeScale`, `weight`.
The mixer dispatches `"loop"` and `"finished"`. `AnimationUtils` has `subclip`,
`makeClipAdditive`, `arraySlice`.

Two traps: animate rotation through **`.quaternion`**, not `.rotation`; and a
`.material.opacity` track needs `material.transparent = true` to show.

For simple motion you do not need a mixer at all — `Spatial.onFrame` and some
trigonometry is usually clearer.

## Particles

`new ParticleEmitter(options)` is an `Object3D`: position it, add it to the scene,
`emitter.isEmitting = false` to stop, `emitter.burst()` for a one-shot.

Presets: **`"fireworks"`, `"impact"`, `"magic"`, `"rain"`, `"snow"`, `"sparks"`,
`"smoke"`**. A preset resolves at construction and **overrides every other field except
`isEmitting`**, so do not pass a preset and then expect your `birthRate` to survive — read
the properties back and you will see what is actually rendering.

Hand-tuned fields: `shape` (`"point" | "sphere" | "box" | "cone" | "plane"`), `shapeSize`,
`birthRate`, `lifetime` + `lifetimeVariation`, `speed` + `speedVariation`, `size` +
`sizeVariation`, `color` → `colorEnd`, `opacity` → `opacityEnd`, `spreadAngle` (cone half
angle, radians), `acceleration`, `burstCount`, `loops`, `texture`.

## Anchors

`new Anchor(target)` is a `Group` that the system pins to the real world. Targets:
`"head"`, `{ plane: "horizontal" | "vertical" | "any", minimumBounds }`,
`{ hand: "left" | "right", location: "palm" | "wrist" | "indexFingerTip" | "thumbTip" | "aboveHand" }`,
`{ image: url }`, `{ world: matrix4 }`. It dispatches `anchored` / `unanchored` and
exposes `isAnchored`.

**visionOS only.** Everywhere else the anchor sits at the world origin, never resolves,
`isAnchored` stays `false`, and you get one warning per anchor kind — so always give
anchored content a sensible local transform that also reads correctly at the origin.

## Portals

`new Portal({ width, height, world, crossing })` is a `Mesh` that shows another world
through its surface. `world` is the `Object3D` rendered inside it — **add that group to
the scene as well**, or it renders nowhere. `crossing: true` lets the viewer pass through.

## Loading assets

```js
Spatial.loadAsset({ usdz: "rig.usdz", glb: "rig.glb" }).then((asset) => {
  asset.scale.setScalar(0.2);
  scene.add(asset);
  asset.playAnimation(asset.animations[0], { loop: true });
});
```

RealityKit loads `usdz` or `reality`; the web loads `glb` or `gltf`. **Supply both keys**
or the promise rejects with a `SpatialUnsupportedError` on the backend whose key is
missing. The resolved `AssetGroup` carries `animations` (names), `boundingBox`, `loaded`,
and optionally `skeleton` and `blendShapes`; it has `playAnimation(name, { loop, speed })`
and `stopAnimation()`.

Loaded assets arrive at **their authored scale**, which is frequently metres-to-centimetres
off for a tabletop scene — set `asset.scale` and check `asset.boundingBox` after load.

`skeleton` gives `joints`, `getJointTransform`, `setJointRotation`, `setJointPosition`,
`reset()` and `track(enabled)` (ask the consumer to report real joint transforms back,
which is what you need while a native animation is playing). `blendShapes` gives `names`,
`get(name)` and `set(name, weight)` with weight clamped to 0..1.

## Audio and video

```js
new Spatial.AudioLoader().load("tone.wav", (buffer) => {
  const sound = new Spatial.PositionalAudio();
  sound.setBuffer(buffer);
  sound.setRefDistance(0.3);
  sound.setRolloffFactor(1.4);
  mesh.add(sound);
  sound.play();
});
```

| Class | Use |
| --- | --- |
| `Audio` | Non-spatial: music, UI clicks. |
| `PositionalAudio` | Attenuates with distance; `setRefDistance`, `setRolloffFactor`, `setDistanceModel("inverse" \| "linear" \| "exponential")`, `setDirectionalCone(inner, outer, gain)` **in degrees**, `reverbLevel` in dB. |
| `AmbientAudio` | Arrives from every direction at the object's position. |
| `AudioLoader` / `AudioBuffer` | A url-backed handle; the consumer does the loading. |

All of them are `Object3D`s, so add them to a mesh to place them. Controls: `play`,
`pause`, `stop`, `setLoop`, `setVolume`, `setPlaybackRate`, `currentTime` (assigning
seeks), `group` (a mix group name), `onEnded`, `dispose()` (**final** — a later `play()`
is dropped with a warning).

`Spatial.audio` is the mixer: `masterVolume`, `setGroupVolume(name, volume)`, `groups`,
`state` (`"suspended"` until a gesture resumes it), `resume()`.

Audio defaults are metre-scale. In a 0.4 m scene the default `refDistance` of 1 m means
full volume everywhere — `setRefDistance(0.3)` with `setRolloffFactor(1.4)` is a sane
start.

`new VideoScreen({ url, width, height, loop, muted, autoplay, docking })` is a `Mesh`
playing video on a plane, hit-testable like any other mesh. `url` may be one string or
`{ mp4, hls, webm }` — RealityKit wants `mp4` or `hls`, the web wants `webm` or `mp4`, so
supply both. Give only `width` **or** only `height` and the other follows the real aspect
once the consumer reports `loaded` (until then it is 16:9). It dispatches `loaded`,
`ended` and `error`. `docking: true` is visionOS only.

## Cameras

`Spatial.camera` is `null` by default, meaning the consumer's own camera (on macOS and the
web that is a view at `(0, 0.25, 1.4)` looking at the origin). Assign a
`PerspectiveCamera(fov, aspect, near, far)` or an `OrthographicCamera(l, r, t, b, n, f)`
to take the view over on macOS and the web.

**On visionOS the viewer is the camera**: an assignment is kept and reported but does
nothing, and warns once. `aspect` always belongs to the consumer — setting it is ignored
with a warning. `Spatial.rayFromPoint(x, y)` turns a view pixel into a world ray and
returns `null` on visionOS.

Design the composition so it reads from the front without moving the camera. That is the
portable choice.

## Character controller

`object.characterController = new CharacterController({ radius, height, slopeLimit,
stepLimit, gravity })` makes the object native-driven: `move(displacement)` is resolved
against the world next frame, sliding along obstacles, and `teleport(position)` places it
unconditionally. Read `isOnGround` and `velocity` — both are reported *by* the consumer,
so they are `false` / zero until the first sync arrives.

## Force fields

Each is an `Object3D` acting on **dynamic bodies** within `radius` of its world position,
with `enabled`, `radius` and a collision `mask`. Both consumers clamp the acceleration a
field imparts to 1000 m/s² per step and warn naming the field, so a mis-scaled field
cannot launch a body into space.

| Field | Options | Effect |
| --- | --- | --- |
| `ConstantForceField` | `force` (newtons) | A steady push — wind, a conveyor, reversed gravity. |
| `RadialForceField` | `strength` (newtons at 1 m), `minimumDistance`, `falloff` (`"none" \| "linear" \| "inverseSquare"`) | Attract (negative) or repel (positive) — a magnet, an explosion. |
| `VortexForceField` | `strength`, `axis` | Swirl around an axis — a whirlpool, a tornado. |
| `DragForceField` | `coefficient` (dimensionless) | Slows bodies down — water, treacle. |
| `TurbulenceForceField` | `strength`, `noiseScale` (metres) | Noisy jitter — embers, dust. |

## Shader graph materials

`new ShaderGraphMaterial({ source, name, parameters, fallback })` binds a pre-authored
RealityKit shader graph inside a USD file. **`fallback` is required** and is what every
other consumer renders. `setParameter(name, value)` takes numbers, booleans, short
strings, `Vector2/3/4`, `Color` and `Texture`, and also writes the same-named property of
the fallback where it has one (never its identity fields). A value the command stream
cannot carry — a NaN, an object, a string past 256 characters — is refused with a warning.

Use this only when you have been given a real USD graph. Otherwise author with
`MeshStandardMaterial`.

## The host channel

`Spatial.host` is the two-way channel with the embedding app.

| Member | Purpose |
| --- | --- |
| `functions` | The `Module.function` names the app registered. Check before calling. |
| `on(name, handler)` / `off(name, handler?)` | Receive messages the app sends. |
| `send(name, payload)` | Fire-and-forget to the app. The payload is copied to JSON. |
| `call(name, args)` | Ask and await an answer. An unregistered name rejects immediately with `SpatialUnsupportedError` of feature `"host-function"`. |

`Spatial.isActive` is `false` while the view is away, and ticks pause. Lifecycle members
you may set on `this`: `didAdd()`, `update(dt)`, `willRemove()`, `didActivate()`,
`willDeactivate()`, `scriptChanged(previousState)`, and `this.state` for JSON state a hot
reload carries across.

## `Spatial.dump()` — check your own work

`dump()` returns the whole scene as inspectable JSON, and it is how you verify a scene
without eyes on it.

- **`dump({ objects: false })` is the health poll.** A few hundred bytes whatever the
  scene, and it has every top-level field — most importantly `errors`.
- **`errors` is the answer to most problems.** Non-empty means something was refused.
  `droppedErrors > 0` means the *first* failure has already aged out of the 200-entry list.
- `warnings` (capped at 500, once per key per scene) is where "no lights", url refusals,
  clamping and ignored-feature messages land.
- `scene === null` with an empty `objects` means **nothing is mounted**.
- `frame` confirms the scene is ticking. `loadGeneration` increments on every load.
- Per object: `worldPosition` (your scale check — every visible thing should be a small
  number), `visible`, `opacity`, `material`, `light`, `rigidBody`, `interactive`
  (`{ tap, hover, drag, manipulation, collision }` — proof a listener registered),
  `velocity`, `isSleeping`, `userData`.
- Narrow it with `{ names: [...] }`, `{ fields: [...] }`, `{ compact: true }`. Never call
  an unfiltered dump every frame on a large scene.
- Colours in the dump are **linear sRGB in 0..1**, so they will not equal the hex you
  passed. That is not a bug.

Two things the dump is *not* a witness for: with `matrixAutoUpdate = false` it reports
your script-side `position` even though no transform was sent; and an object that was
skipped for the session still appears in it (`errors` is where you see that).

---

# Backend differences that change what you write

Branch on **`Spatial.env.capabilities`**, never on the platform string. The flags are
`hands`, `anchors`, `portals`, `particles`, `manipulation`, `hoverEffect`, `shadows`,
`audio`, `video`, `camera`, `characterController`, `forceFields`, `skeleton`,
`blendShapes`, `shaderGraph`, `sceneUnderstanding`, `controllers`, `hostFunctions`,
`accessibility`.

**visionOS only** — everywhere else these are stored, reported in `dump()`, and have no
effect:

| Feature | Elsewhere |
| --- | --- |
| `Anchor` and the `anchored` / `unanchored` events | Sits at the world origin, never resolves, `isAnchored` stays `false`, one warning per anchor kind. |
| `manipulable` and the `manipulation*` events | macOS warns once and ignores it and no `manipulation*` event ever fires; the web emulates it with a view-plane mouse drag. |
| `hoverEffect` | **Silently** no visual on macOS and web. `hoverenter` / `hoverexit` still fire. `"lift"` even on visionOS warns once and renders as `"highlight"`. |
| `Spatial.sceneUnderstanding` (`collision`, `occlusion`, `physics`, `shadows`) | Kept and reported only. |
| `Spatial.input.hands` | `null` on macOS and web. |
| `VideoScreen` `docking` | Ignored. |
| `Spatial.render.adaptiveResolution` | Ignored. |

**Only elsewhere** — these are the things visionOS does *not* have, because there the
viewer is the camera: assigning `Spatial.camera`, `PerspectiveCamera.aspect`,
`Spatial.rayFromPoint`, `Spatial.input.mouse.scenePosition`, and anything screen-space.

**Warns once and no-ops:**

| Write | Where |
| --- | --- |
| `groundingShadow` | ignored on web |
| `renderOrder` | ignored on macOS |
| `material.wireframe` | ignored on RealityKit (renders solid) |
| `AdditiveBlending` | RealityKit renders it as ordinary transparency |
| point-light `castShadow` | ignored on RealityKit |
| `.exr` environment | web installs nothing |
| `AmbientLight` alongside `Spatial.environment` | RealityKit uses the environment |
| `PerspectiveCamera.aspect` | every backend |

**Throws, rather than warning:** `Scene.background`, `Scene.environment` and `Scene.fog`
on assignment; re-adding a destroyed object (`"destroyed-object"`); destroying the mounted
scene; sharing one `RigidBody` between two objects (`"rigidbody-shared"`);
`shape: "mesh"` on a dynamic body; a `font` other than `"default"`.

**Physics is structurally, not numerically, identical.** Both backends give you bodies,
shapes, masses, joints and collision events, and a dropped body comes to rest on a floor.
Trajectories differ between RealityKit and Rapier — **never assert an exact position after
N frames**, and never build a design that depends on one. On a `distance` joint, a
positive `min` is honoured on the web only where Rapier can express it; otherwise `max` is
applied as a rope, with a warning.

**Prefer the portable subset.** `opacity`, `billboard`, `rigidBody`, `raycast`, the whole
math library, the `Object3D` hierarchy and transform methods, the parametric geometries,
the four material types within their contracted properties, the four light types, and the
entire keyframe animation system behave the same everywhere. Build the scene out of those,
then add a visionOS-only touch behind a capability check:

```js
if (Spatial.env.capabilities.hoverEffect) mesh.hoverEffect = "highlight";
```

---

# Mistakes that produce broken or ugly scenes

1. **No lights → black meshes.** The single most common cause of a "blank" scene that has
   objects in the dump. `MeshStandardMaterial` and `MeshPhysicalMaterial` are physically
   based; with no light they are black on both backends. Minimum: an
   `AmbientLight(0xffffff, 0.4)` plus a `DirectionalLight` of intensity 2–3. To confirm,
   swap one material for `MeshBasicMaterial` — if the object appears, you need lights.

2. **No `mount`.** With exactly one `Scene` constructed you get an auto-mount and a
   warning; with zero or two or more it is a **load error and nothing runs**. `dump().scene`
   is `null` and `objects` is empty. Mounting a `Group` is `TypeError: Spatial.mount
   expects a Scene`. Mount before any `await`.

3. **Wrong scale.** A default `new BoxGeometry()` is a one-metre cube, so at the usual
   viewing distance you are standing inside it; `position.set(0, 0, -5)` is five metres
   behind the wall. Sizes around `0.05`–`0.3`, positions within about `0.5` of the origin.
   Check `dump().objects[i].worldPosition`: every visible thing should be a small number.

4. **Editing a geometry's numbers without `needsUpdate`.** Calling a geometry *method*
   (`setAttribute`, `setIndex`, `computeVertexNormals`, `applyMatrix4`, `translate`,
   `rotate*`, `scale`, `center`) re-emits automatically. Editing the values **inside** an
   existing attribute array is the case the revision cannot see, and the edit never leaves
   the core. The missing line is `attribute.needsUpdate = true`. Related: writing
   `geometry.parameters.width` rebuilds nothing — construct a new geometry and assign
   `mesh.geometry`; and mutating a geometry shared by several meshes changes all of them,
   so `clone()` first.

5. **Assuming `position` still works after `matrixAutoUpdate = false`.** It does not — the
   matrix is authoritative and the core stops reading position/rotation/scale entirely.
   Either call `updateMatrix()` after each write, or write the matrix directly
   (`mesh.matrix.makeTranslation(x, y, z)`). Order matters at setup: **set the transform,
   `updateMatrix()` once, then turn the flag off.** Turning it off first bakes whatever
   the matrix held — usually the identity, so the object snaps to the origin.

6. **Disposing a texture a material still points at.** The release is held until nothing
   references it, and you get `texture N was released while a material still references
   it; it is kept until the material changes`. An untextured panel usually means you
   disposed *and* left the material pointing there, or repointed to an already-disposed
   texture. **Repoint first, then dispose.** (`Audio.dispose()` is different: it is final.)

7. **Reading `currentTime` / `duration` before the first sync.** Both are native-driven
   and are **`0`** until the consumer's first `syncAudio` / `syncVideo` — so a progress
   readout computed on frame one divides by zero. `isPlaying` is the exception: it is your
   intent, correct on the calling frame. The same shape applies to
   `characterController.isOnGround` (`false` until the first sync) and to a `VideoScreen`'s
   aspect (16:9 until `loaded`).

8. **Varying your error message text, and hiding the error.** The same exact message is
   reported at most once per second, and at most `Spatial.limits.MAX_ERROR_MESSAGES_PER_SECOND`
   (20) *distinct* messages get through in one second — past that you get one
   `More than 20 distinct errors in one second; the rest of this second was dropped` line
   instead. So `throw new Error("frame " + n)` trips the distinct-message cap and buries
   itself. **Throw a constant message and put the varying part in `userData`.**

Also worth not doing:

- Creating an object and never `add`ing it — invisible, and absent from `dump().objects`.
  A mesh added to a `Group` that was never added to the scene is the usual shape of this.
- A `PlaneGeometry` seen edge-on or from behind: planes face **+z**; use
  `side: DoubleSide`, or rotate it.
- Building a mixer and never calling `mixer.update(deltaTime)` from `onFrame`.
- Writing `position` on a dynamic rigid body each frame — it teleports and zeroes velocity.
- Forgetting the floor's own static `RigidBody`, so everything falls forever.
- Expecting a listener on an ancestor to make a child tappable. Each hit-testable object
  registers its own listener.
- Asserting on an injected event in the same tick — events land at the start of the next one.
- `repeat` without `RepeatWrapping`.
- Supplying only `glb` or only `usdz` to `loadAsset`, or only one video encoding.
- `remove()` without `destroy()` — `remove` detaches but keeps the native entity alive.
- Tweening a unique material per mesh every frame. Animate **one shared material**, or
  animate `Object3D.opacity`.
- `Object.freeze` / `seal` / a `Proxy` on a scene object: it is reported once and then
  **skipped for the rest of the session**, and unfreezing does not bring it back.

---

# Two worked examples

## A static, well-lit composition

```js runnable
// A small still life on a plinth: warm key, cool rim, one soft fill.
const Spatial = require("spatial");
const {
  Scene, Group, Mesh,
  BoxGeometry, SphereGeometry, CylinderGeometry, TorusGeometry, PlaneGeometry,
  MeshStandardMaterial, MeshPhysicalMaterial,
  AmbientLight, DirectionalLight, PointLight,
  DoubleSide,
} = Spatial;

const scene = new Scene();
scene.name = "still-life";

// ---------------------------------------------------------------- lighting
// Low ambient so the shadow side is dark but readable, a warm key that casts,
// and a cool rim behind to separate the objects from the backdrop.
const fill = new AmbientLight(0xdfe7ff, 0.35);
fill.name = "fill";
scene.add(fill);

const key = new DirectionalLight(0xfff1dd, 2.8);
key.name = "key";
key.position.set(0.55, 1.0, 0.7);
key.castShadow = true;
scene.add(key);

const rim = new PointLight(0x7fb4ff, 2.4, 1.6, 2);
rim.name = "rim";
rim.position.set(-0.42, 0.3, -0.34);
scene.add(rim);

// ---------------------------------------------------------------- backdrop
const backdrop = new Mesh(
  new PlaneGeometry(1.0, 0.62),
  new MeshStandardMaterial({ color: 0x1b1f27, roughness: 1, metalness: 0, side: DoubleSide }),
);
backdrop.name = "backdrop";
backdrop.position.set(0, 0.1, -0.32);
backdrop.receiveShadow = true;
scene.add(backdrop);

// ------------------------------------------------------------------ plinth
const plinth = new Mesh(
  new CylinderGeometry(0.24, 0.26, 0.05, 48),
  new MeshStandardMaterial({ color: 0x2f3540, roughness: 0.85, metalness: 0.05 }),
);
plinth.name = "plinth";
plinth.position.set(0, -0.2, 0);
plinth.receiveShadow = true;
scene.add(plinth);

// ---------------------------------------------------------------- the trio
const still = new Group();
still.name = "still";
still.position.set(0, -0.175, 0);
scene.add(still);

function place(name, mesh, x, z) {
  mesh.name = name;
  mesh.position.set(x, 0, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  still.add(mesh);
  return mesh;
}

// A brushed-metal sphere: metals need the directional key to read as metal.
const orb = place(
  "orb",
  new Mesh(
    new SphereGeometry(0.075, 48, 32),
    new MeshStandardMaterial({ color: 0xc8ccd4, roughness: 0.22, metalness: 0.95 }),
  ),
  -0.135,
  0.02,
);
orb.position.y = 0.075;

// A lacquered block: clearcoat is what MeshPhysicalMaterial is for.
place(
  "block",
  new Mesh(
    new BoxGeometry(0.13, 0.13, 0.13),
    new MeshPhysicalMaterial({
      color: 0x2d5bd7,
      roughness: 0.35,
      metalness: 0.05,
      clearcoat: 0.9,
      clearcoatRoughness: 0.12,
    }),
  ),
  0.055,
  -0.04,
).position.y = 0.065;

// A matte ring, tipped forward so its silhouette reads against the backdrop.
const ring = place(
  "ring",
  new Mesh(
    new TorusGeometry(0.062, 0.014, 20, 64),
    new MeshStandardMaterial({ color: 0xe4a33c, roughness: 0.55, metalness: 0.3 }),
  ),
  0.17,
  0.05,
);
ring.position.y = 0.062;
ring.rotation.set(-0.35, 0.5, 0);

Spatial.mount(scene);
```

## An interactive, animated, physical scene

```js runnable
// A pachinko tray: tap a peg to bounce the balls, drag the paddle, and the
// lantern above breathes. Everything is inside half a metre of the origin.
const Spatial = require("spatial");
const {
  Scene, Group, Mesh,
  BoxGeometry, SphereGeometry, CylinderGeometry,
  MeshStandardMaterial, MeshBasicMaterial,
  AmbientLight, DirectionalLight, PointLight,
  RigidBody, Vector3, Color,
} = Spatial;

const scene = new Scene();
scene.name = "pachinko";

// ---------------------------------------------------------------- lighting
scene.add(Object.assign(new AmbientLight(0xffffff, 0.38), { name: "fill" }));

const key = new DirectionalLight(0xfff3e0, 2.6);
key.name = "key";
key.position.set(0.5, 1.1, 0.6);
key.castShadow = true;
scene.add(key);

const glow = new PointLight(0xffc46b, 2.0, 1.2, 2);
glow.name = "glow";
glow.position.set(0, 0.26, 0.05);
scene.add(glow);

// ------------------------------------------------------------------- tray
// The floor and the two rails need their own static bodies: a bare mesh is
// hit-testable but not collidable, and the balls would fall forever.
const tray = new Mesh(
  new BoxGeometry(0.56, 0.02, 0.34),
  new MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.9, metalness: 0.05 }),
);
tray.name = "tray";
tray.position.set(0, -0.22, 0);
tray.receiveShadow = true;
tray.rigidBody = new RigidBody({ type: "static", shape: "box", friction: 0.7, restitution: 0.15 });
scene.add(tray);

for (const [name, x] of [["rail-left", -0.28], ["rail-right", 0.28]]) {
  const rail = new Mesh(
    new BoxGeometry(0.02, 0.14, 0.34),
    new MeshStandardMaterial({ color: 0x3a414c, roughness: 0.8 }),
  );
  rail.name = name;
  rail.position.set(x, -0.14, 0);
  rail.rigidBody = new RigidBody({ type: "static", shape: "box", friction: 0.5, restitution: 0.4 });
  scene.add(rail);
}

// ------------------------------------------------------------------- pegs
// Tapping a peg kicks every ball near it. The listener is what makes the peg
// an input target, and it has to be on the mesh itself.
const pegs = new Group();
pegs.name = "pegs";
scene.add(pegs);

const PEG_COLOURS = [0x4d7cff, 0xff6b6b, 0x37d39b, 0xffc857];
const kick = new Vector3();

for (let row = 0; row < 3; row += 1) {
  for (let column = 0; column < 4; column += 1) {
    const peg = new Mesh(
      new CylinderGeometry(0.012, 0.012, 0.05, 16),
      new MeshStandardMaterial({
        color: PEG_COLOURS[(row + column) % PEG_COLOURS.length],
        roughness: 0.35,
        metalness: 0.25,
        emissive: 0x000000,
      }),
    );
    peg.name = `peg-${row}-${column}`;
    peg.position.set(-0.165 + column * 0.11 + (row % 2) * 0.055, -0.185, -0.08 + row * 0.08);
    peg.castShadow = true;
    peg.rigidBody = new RigidBody({ type: "static", shape: "capsule", restitution: 0.6 });
    peg.userData.flash = 0;
    pegs.add(peg);

    peg.addEventListener("tap", () => {
      peg.userData.flash = 1;
      for (const ball of balls.children) {
        kick.copy(ball.position).sub(peg.position);
        kick.y = Math.abs(kick.y) + 0.6;
        kick.normalize().multiplyScalar(0.35);
        ball.rigidBody.applyImpulse(kick);
      }
      console.log("kicked from", peg.name);
    });
  }
}

// ------------------------------------------------------------------ balls
const balls = new Group();
balls.name = "balls";
scene.add(balls);

for (let index = 0; index < 5; index += 1) {
  const ball = new Mesh(
    new SphereGeometry(0.022, 24, 16),
    new MeshStandardMaterial({ color: 0xdfe4ee, roughness: 0.25, metalness: 0.7 }),
  );
  ball.name = `ball-${index}`;
  ball.position.set(-0.16 + index * 0.08, 0.18 + index * 0.03, -0.02);
  ball.castShadow = true;
  // The transform of a dynamic body belongs to the simulation from here on:
  // push it with impulses, never by writing position.
  ball.rigidBody = new RigidBody({
    type: "dynamic",
    mass: 0.08,
    shape: "sphere",
    restitution: 0.55,
    friction: 0.3,
    linearDamping: 0.05,
  });
  balls.add(ball);

  ball.addEventListener("collisionstart", (event) => {
    ball.userData.hits = (ball.userData.hits || 0) + 1;
    ball.userData.lastHit = event.other ? event.other.name : "world";
  });
}

// ----------------------------------------------------------------- paddle
// A kinematic paddle the viewer drags. `translation` is measured from
// dragstart, so the origin is captured once and added to.
const paddle = new Mesh(
  new BoxGeometry(0.14, 0.018, 0.05),
  new MeshStandardMaterial({ color: 0x8ad7ff, roughness: 0.3, metalness: 0.2 }),
);
paddle.name = "paddle";
paddle.position.set(0, -0.19, 0.12);
paddle.castShadow = true;
paddle.rigidBody = new RigidBody({ type: "kinematic", shape: "box", friction: 0.4, restitution: 0.5 });
scene.add(paddle);

const dragOrigin = new Vector3();
paddle.addEventListener("dragstart", () => {
  dragOrigin.copy(paddle.position);
  paddle.opacity = 0.75;
});
paddle.addEventListener("drag", (event) => {
  paddle.position.copy(dragOrigin).add(event.translation);
  paddle.position.x = Math.max(-0.22, Math.min(0.22, paddle.position.x));
  paddle.position.y = dragOrigin.y;
  paddle.position.z = dragOrigin.z;
});
paddle.addEventListener("dragend", () => {
  paddle.opacity = 1;
});
if (Spatial.env.capabilities.hoverEffect) {
  paddle.addEventListener("hoverenter", () => { paddle.hoverEffect = "highlight"; });
  paddle.addEventListener("hoverexit", () => { paddle.hoverEffect = null; });
}

// ---------------------------------------------------------------- lantern
// Unlit, so it reads as a light source rather than a lit object.
const lantern = new Mesh(
  new SphereGeometry(0.03, 24, 16),
  new MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0.9 }),
);
lantern.name = "lantern";
lantern.position.set(0, 0.3, 0.02);
scene.add(lantern);

// ------------------------------------------------------------------ frame
const flashColour = new Color();

Spatial.onFrame((deltaTime, elapsed) => {
  // deltaTime is seconds: every rate below is per second.
  const breath = 0.5 + 0.5 * Math.sin(elapsed * 1.6);
  lantern.position.y = 0.3 + breath * 0.02;
  lantern.scale.setScalar(0.9 + breath * 0.2);
  glow.intensity = 1.4 + breath * 1.2;

  pegs.rotation.y = Math.sin(elapsed * 0.4) * 0.04;

  for (const peg of pegs.children) {
    if (peg.userData.flash <= 0) continue;
    peg.userData.flash = Math.max(0, peg.userData.flash - deltaTime * 2.5);
    flashColour.setRGB(peg.userData.flash, peg.userData.flash * 0.6, 0);
    peg.material.emissive.copy(flashColour);
  }

  // A ball that escapes the tray is teleported home. Writing position on a
  // dynamic body is a teleport, so its velocity has to be zeroed too.
  for (const ball of balls.children) {
    if (ball.position.y > -0.9) continue;
    ball.position.set(0, 0.24, -0.02);
    ball.rigidBody.setLinearVelocity(new Vector3(0, 0, 0));
    ball.rigidBody.setAngularVelocity(new Vector3(0, 0, 0));
  }
});

Spatial.mount(scene);
```

---

# Before you hand the file over

- One `Scene`, mounted, before any `await`.
- At least one `AmbientLight` and one `DirectionalLight`.
- Every size between roughly 0.05 and 0.3 m; every position within about 0.5 m of the
  origin.
- Every hit-testable object has its own listener; every drag handler captures its origin
  at `dragstart`.
- Every floor that anything falls onto has a static `RigidBody`.
- `mixer.update(deltaTime)` is called from `onFrame` if you built a mixer.
- Nothing outside the declarations above is referenced.
