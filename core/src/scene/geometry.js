// Parametric geometries with normalized constructor arguments (SPEC 2
// robustness rule). three.js happily builds a degenerate or NaN-filled buffer
// from a negative size or a zero segment count; the core clamps first and warns
// once per geometry so an agent can see what it wrote.

import {
  BoxGeometry as ThreeBoxGeometry,
  SphereGeometry as ThreeSphereGeometry,
  PlaneGeometry as ThreePlaneGeometry,
  CylinderGeometry as ThreeCylinderGeometry,
  ConeGeometry as ThreeConeGeometry,
  TorusGeometry as ThreeTorusGeometry,
  CapsuleGeometry as ThreeCapsuleGeometry,
  CircleGeometry as ThreeCircleGeometry,
  RingGeometry as ThreeRingGeometry,
} from "../util/three-exports.js";
import { extent, intAtLeast, finite } from "../util/sanitize.js";
import { host } from "../host/host.js";

// A size or radius: absolute value, and 0.001 instead of zero.
const SIZE = 0;
// A segment count: an integer of at least `min`.
const SEGMENTS = 1;
// An angle or other free scalar: finite only.
const SCALAR = 2;

/**
 * Normalizes one constructor's arguments into a fresh array. Everything lives
 * in the returned object, so a throw inside three's constructor cannot leak a
 * pending note into the next geometry that is built.
 *
 * Each spec entry is `[kind, name, given, fallback, min]`.
 */
function normalize(specs) {
  const values = new Array(specs.length);
  const notes = [];
  for (let i = 0; i < specs.length; i += 1) {
    const [kind, name, given, fallback, min] = specs[i];
    if (given === undefined) {
      values[i] = fallback;
      continue;
    }
    let used;
    if (kind === SIZE) used = extent(given, fallback);
    else if (kind === SEGMENTS) used = intAtLeast(given, min, fallback);
    else used = finite(given, fallback);
    values[i] = used;
    if (used !== given) notes.push(`${name} ${format(given)} -> ${used}`);
  }
  values.notes = notes;
  return values;
}

function format(value) {
  if (value === undefined) return "undefined";
  return String(value);
}

/** Reports whatever the constructor had to change, once per geometry instance. */
function report(geometry, notes) {
  if (notes.length === 0) return;
  const runtime = host();
  if (!runtime) return;
  runtime.warnOnce(
    `geometry:${geometry.uuid}`,
    `${geometry.type} arguments were normalized: ${notes.join(", ")}`,
  );
}

export class BoxGeometry extends ThreeBoxGeometry {
  constructor(width, height, depth, widthSegments, heightSegments, depthSegments) {
    const a = normalize([
      [SIZE, "width", width, 1],
      [SIZE, "height", height, 1],
      [SIZE, "depth", depth, 1],
      [SEGMENTS, "widthSegments", widthSegments, 1, 1],
      [SEGMENTS, "heightSegments", heightSegments, 1, 1],
      [SEGMENTS, "depthSegments", depthSegments, 1, 1],
    ]);
    super(a[0], a[1], a[2], a[3], a[4], a[5]);
    report(this, a.notes);
  }
}

export class SphereGeometry extends ThreeSphereGeometry {
  constructor(radius, widthSegments, heightSegments, phiStart, phiLength, thetaStart, thetaLength) {
    const a = normalize([
      [SIZE, "radius", radius, 1],
      [SEGMENTS, "widthSegments", widthSegments, 32, 3],
      [SEGMENTS, "heightSegments", heightSegments, 16, 2],
      [SCALAR, "phiStart", phiStart, 0],
      [SCALAR, "phiLength", phiLength, Math.PI * 2],
      [SCALAR, "thetaStart", thetaStart, 0],
      [SCALAR, "thetaLength", thetaLength, Math.PI],
    ]);
    super(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
    report(this, a.notes);
  }
}

export class PlaneGeometry extends ThreePlaneGeometry {
  constructor(width, height, widthSegments, heightSegments) {
    const a = normalize([
      [SIZE, "width", width, 1],
      [SIZE, "height", height, 1],
      [SEGMENTS, "widthSegments", widthSegments, 1, 1],
      [SEGMENTS, "heightSegments", heightSegments, 1, 1],
    ]);
    super(a[0], a[1], a[2], a[3]);
    report(this, a.notes);
  }
}

export class CylinderGeometry extends ThreeCylinderGeometry {
  constructor(radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength) {
    const a = normalize([
      [SIZE, "radiusTop", radiusTop, 1],
      [SIZE, "radiusBottom", radiusBottom, 1],
      [SIZE, "height", height, 1],
      [SEGMENTS, "radialSegments", radialSegments, 32, 3],
      [SEGMENTS, "heightSegments", heightSegments, 1, 1],
      [SCALAR, "thetaStart", thetaStart, 0],
      [SCALAR, "thetaLength", thetaLength, Math.PI * 2],
    ]);
    super(a[0], a[1], a[2], a[3], a[4], openEnded, a[5], a[6]);
    report(this, a.notes);
  }
}

export class ConeGeometry extends ThreeConeGeometry {
  constructor(radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength) {
    const a = normalize([
      [SIZE, "radius", radius, 1],
      [SIZE, "height", height, 1],
      [SEGMENTS, "radialSegments", radialSegments, 32, 3],
      [SEGMENTS, "heightSegments", heightSegments, 1, 1],
      [SCALAR, "thetaStart", thetaStart, 0],
      [SCALAR, "thetaLength", thetaLength, Math.PI * 2],
    ]);
    super(a[0], a[1], a[2], a[3], openEnded, a[4], a[5]);
    report(this, a.notes);
  }
}

export class TorusGeometry extends ThreeTorusGeometry {
  constructor(radius, tube, radialSegments, tubularSegments, arc) {
    const a = normalize([
      [SIZE, "radius", radius, 1],
      [SIZE, "tube", tube, 0.4],
      [SEGMENTS, "radialSegments", radialSegments, 12, 3],
      [SEGMENTS, "tubularSegments", tubularSegments, 48, 3],
      [SCALAR, "arc", arc, Math.PI * 2],
    ]);
    super(a[0], a[1], a[2], a[3], a[4]);
    report(this, a.notes);
  }
}

export class CapsuleGeometry extends ThreeCapsuleGeometry {
  constructor(radius, height, capSegments, radialSegments, heightSegments) {
    const a = normalize([
      [SIZE, "radius", radius, 1],
      [SIZE, "height", height, 1],
      [SEGMENTS, "capSegments", capSegments, 4, 1],
      [SEGMENTS, "radialSegments", radialSegments, 8, 3],
      [SEGMENTS, "heightSegments", heightSegments, 1, 1],
    ]);
    super(a[0], a[1], a[2], a[3], a[4]);
    report(this, a.notes);
  }
}

export class CircleGeometry extends ThreeCircleGeometry {
  constructor(radius, segmentCount, thetaStart, thetaLength) {
    const a = normalize([
      [SIZE, "radius", radius, 1],
      [SEGMENTS, "segments", segmentCount, 32, 3],
      [SCALAR, "thetaStart", thetaStart, 0],
      [SCALAR, "thetaLength", thetaLength, Math.PI * 2],
    ]);
    super(a[0], a[1], a[2], a[3]);
    report(this, a.notes);
  }
}

export class RingGeometry extends ThreeRingGeometry {
  constructor(innerRadius, outerRadius, thetaSegments, phiSegments, thetaStart, thetaLength) {
    const a = normalize([
      [SIZE, "innerRadius", innerRadius, 0.5],
      [SIZE, "outerRadius", outerRadius, 1],
      [SEGMENTS, "thetaSegments", thetaSegments, 32, 3],
      [SEGMENTS, "phiSegments", phiSegments, 1, 1],
      [SCALAR, "thetaStart", thetaStart, 0],
      [SCALAR, "thetaLength", thetaLength, Math.PI * 2],
    ]);
    super(a[0], a[1], a[2], a[3], a[4], a[5]);
    report(this, a.notes);
  }
}
