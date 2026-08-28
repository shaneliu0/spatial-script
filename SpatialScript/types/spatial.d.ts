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
    /** Mesh only. Unsupported on the three.js backend: warns once. */
    groundingShadow: boolean;
    /** visionOS only; accepted with no visual elsewhere. */
    hoverEffect: HoverEffect;
    /** Enables the system grab/move/rotate/scale interaction. */
    manipulable: boolean;
    /** Attaching a body makes the object participate in physics. */
    rigidBody: RigidBody | null;

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
    constructor(geometry?: BufferGeometry, material?: Material);
    geometry: BufferGeometry;
    /**
     * Exactly one material; assigning an array throws. `null` and `undefined`
     * are replaced with a MeshStandardMaterial and warned about, so this only
     * reads as null on a mesh whose material was cleared by the runtime.
     */
    material: Material | null;
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
    url: string | null;
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
    isTrigger: boolean;
    gravity: boolean;
    /** Updated by the consumer each frame. */
    readonly linearVelocity: Vector3;
    readonly angularVelocity: Vector3;
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
    object: Object3D;
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
  }

  interface Mouse {
    /** View pixels, or null when the pointer is absent. */
    readonly position: Vector2 | null;
    readonly buttons: { left: boolean; right: boolean; middle: boolean };
    readonly delta: Vector2;
  }

  interface InputState {
    readonly keyboard: Keyboard;
    readonly mouse: Mouse;
    /** null on macOS and the web. */
    readonly hands: { left: Hand | null; right: Hand | null };
  }

  /** Synthesises the events a consumer would produce, for verification. */
  interface Inject {
    tap(objectOrName: Object3D | string, point?: Vector3): void;
    drag(objectOrName: Object3D | string, translation: Vector3, options?: { steps?: number }): void;
    hover(objectOrName: Object3D | string, entering: boolean): void;
    key(code: string, down: boolean): void;
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
    playAnimation(name: string, options?: { loop?: boolean; speed?: number }): this;
    stopAnimation(): this;
  }

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
    material: Record<string, any> | null;
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
     * Positions rounded to four decimals, and no geometry parameters,
     * material, light, particle or userData payloads. Much cheaper to build
     * and to serialise, for a host that polls.
     */
    compact?: boolean;
    /** `false` omits the object list entirely, leaving the scene summary. */
    objects?: boolean;
  }

  function dump(options?: DumpOptions): Dump;
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

/** Legacy lifecycle members a script may set on `this`. */
interface SpatialScriptThis {
  didAdd?(): void;
  update?(deltaTime: number): void;
  willRemove?(): void;
  [key: string]: any;
}
