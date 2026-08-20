// Per-object last-flushed snapshots and the helpers the flush diff compares
// against (SPEC section 5).

import { push } from "./builtins.js";
import { Vector3, Matrix3 } from "./three-exports.js";
import { finite, clamp, colorArray, sanitizeParameters, vector2Array } from "./sanitize.js";

export const GEOMETRY_REVISION = Symbol("spatial.geometryRevision");
const GEOMETRY_PAYLOAD = Symbol("spatial.geometryPayload");
const GEOMETRY_PAYLOAD_KEY = Symbol("spatial.geometryPayloadKey");

// three.js does not report structural geometry edits, so the mutators named in
// the SPEC 3.3 BufferGeometry contract bump a revision the diff can watch.
let geometryTrackingInstalled = false;

export function installGeometryTracking(BufferGeometry) {
  if (geometryTrackingInstalled) return;
  geometryTrackingInstalled = true;
  const proto = BufferGeometry.prototype;
  proto[GEOMETRY_REVISION] = 0;
  for (const name of ["setAttribute", "deleteAttribute", "setIndex", "computeVertexNormals", "applyMatrix4"]) {
    const base = proto[name];
    if (typeof base !== "function") continue;
    proto[name] = function tracked(...args) {
      this[GEOMETRY_REVISION] = (this[GEOMETRY_REVISION] | 0) + 1;
      return base.apply(this, args);
    };
  }
}

export function createSnapshot(id, slot, kind, isLight) {
  return {
    id,
    // Index into the runtime's contiguous last-flushed TRS array.
    slot,
    // Position in the runtime's tracked-snapshot array.
    index: -1,
    kind,
    isLight,
    isMesh: kind === "mesh" || kind === "portal",
    // Frame number of the last flush that reached this object.
    liveFrame: -1,
    worldDirty: true,
    // Local matrix and world matrix are computed lazily for leaf objects.
    matrixStale: true,
    worldStale: true,
    // Set while the object's matrix carries shear the core cannot represent.
    sheared: false,
    // null forces the first emission for each of these.
    parentId: null,
    name: "",
    visible: true,
    geometryObject: null,
    geometryRevision: -1,
    // uuid this snapshot currently counts against in the delivered-geometry
    // refcount, so the last user leaving clears the uuid's delivered record.
    geometryUuid: null,
    positionAttribute: null,
    normalAttribute: null,
    uvAttribute: null,
    indexAttribute: null,
    geometryVersion: NaN,
    normalVersion: NaN,
    uvVersion: NaN,
    indexVersion: NaN,
    hasBody: false,
    materialObject: null,
    material: null,
    light: null,
    lightColorR: NaN,
    lightColorG: NaN,
    lightColorB: NaN,
    castShadow: false,
    receiveShadow: false,
    opacity: 1,
    billboard: false,
    groundingShadow: false,
    hoverEffect: null,
    manipulable: false,
    renderOrder: 0,
    tap: false,
    hover: false,
    drag: false,
    manipulation: false,
    collision: false,
    rigidBody: null,
    particles: null,
    anchor: null,
    portal: null,
    asset: null,
    world: false,
  };
}




const directionVector = new Vector3();
const lightWorld = new Vector3();
const targetWorld = new Vector3();

// Property, range, and three.js default for every clamped light scalar.
const LIGHT_RANGES = [
  ["intensity", 0, Infinity, 1],
  ["distance", 0, Infinity, 0],
  ["decay", 0, Infinity, 2],
  ["angle", 0, Math.PI / 2, Math.PI / 3],
  ["penumbra", 0, 1, 0],
];

/** Full light state for the `light` command, with the resolved world direction. */
export function lightSnapshot(light, warn, out) {
  let type = null;
  let direction = null;
  if (light.isAmbientLight) type = "ambient";
  else if (light.isDirectionalLight) type = "directional";
  else if (light.isPointLight) type = "point";
  else if (light.isSpotLight) type = "spot";
  else return null;

  if (type === "directional" || type === "spot") {
    const target = light.target;
    light.updateWorldMatrix(true, false);
    lightWorld.setFromMatrixPosition(light.matrixWorld);
    if (target) {
      target.updateWorldMatrix(true, false);
      targetWorld.setFromMatrixPosition(target.matrixWorld);
    } else {
      targetWorld.set(0, 0, 0);
    }
    directionVector.subVectors(targetWorld, lightWorld);
    if (directionVector.lengthSq() < 1e-12) directionVector.set(0, -1, 0);
    else directionVector.normalize();
    direction = [directionVector.x, directionVector.y, directionVector.z];
  }

  let adjusted = null;
  const ranged = rangeScratch;
  for (let i = 0; i < LIGHT_RANGES.length; i += 1) {
    const entry = LIGHT_RANGES[i];
    const given = light[entry[0]];
    const used = given === undefined ? entry[3] : clamp(given, entry[1], entry[2], entry[3]);
    if (given !== undefined && given !== used) {
      if (adjusted === null) adjusted = [];
      push(adjusted, `${entry[0]} ${given} -> ${used}`);
    }
    ranged[i] = used;
  }
  // Only spot lights carry a cone; every other type reports zero.
  const angle = type === "spot" ? ranged[3] : 0;

  if (adjusted !== null && warn) {
    warn(`light:${light.uuid}`, `${light.type} properties were clamped: ${adjusted.join(", ")}`);
  }

  // Written into the caller's object so a static light allocates nothing.
  const target = out === undefined || out === null ? {} : out;
  target.type = type;
  target.color = colorArray(light.color, 1);
  target.intensity = ranged[0];
  target.distance = ranged[1];
  target.decay = ranged[2];
  target.angle = angle;
  target.penumbra = ranged[4];
  target.castShadow = light.castShadow === true;
  target.direction = direction;
  return target;
}

const rangeScratch = new Array(5);

export function lightSnapshotEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.type !== b.type ||
    a.intensity !== b.intensity ||
    a.distance !== b.distance ||
    a.decay !== b.decay ||
    a.angle !== b.angle ||
    a.penumbra !== b.penumbra ||
    a.castShadow !== b.castShadow
  ) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) if (a.color[i] !== b.color[i]) return false;
  if ((a.direction === null) !== (b.direction === null)) return false;
  if (a.direction) {
    for (let i = 0; i < 3; i += 1) if (a.direction[i] !== b.direction[i]) return false;
  }
  return true;
}


export function textureSnapshot(texture, resolveUrl) {
  return {
    url: texture.url === null || texture.url === undefined ? null : resolveUrl(texture.url),
    repeat: vector2Array(texture.repeat, 1, 1),
    offset: vector2Array(texture.offset, 0, 0),
    wrapS: finite(texture.wrapS, 1001),
    wrapT: finite(texture.wrapT, 1001),
    flipY: texture.flipY === true,
  };
}

export function textureSnapshotEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.url === b.url &&
    a.repeat[0] === b.repeat[0] &&
    a.repeat[1] === b.repeat[1] &&
    a.offset[0] === b.offset[0] &&
    a.offset[1] === b.offset[1] &&
    a.wrapS === b.wrapS &&
    a.wrapT === b.wrapT &&
    a.flipY === b.flipY
  );
}

/**
 * Typed-array payload for the `geometry` command. Indices are widened to
 * Uint32Array so consumers always read one element width.
 */
/**
 * Typed-array payload for the `geometry` command. The arrays are copies, never
 * the live attribute arrays, so a consumer may hold them and a later in-place
 * edit cannot change them underneath it. One copy is built per geometry per
 * revision and shared by every mesh using that geometry, which is the same
 * identity the `uuid` field promises.
 */
export function geometryPayload(geometry, dropped) {
  const key = geometryPayloadKey(geometry);
  if (geometry[GEOMETRY_PAYLOAD_KEY] === key) return geometry[GEOMETRY_PAYLOAD];
  const payload = buildGeometryPayload(geometry, dropped);
  geometry[GEOMETRY_PAYLOAD_KEY] = key;
  geometry[GEOMETRY_PAYLOAD] = payload;
  return payload;
}

function geometryPayloadKey(geometry) {
  const attributes = geometry.attributes || {};
  const position = attributes.position;
  const normal = attributes.normal;
  const uv = attributes.uv;
  const index = geometry.index;
  return (
    `${geometry[GEOMETRY_REVISION] | 0}:` +
    `${position === undefined ? -1 : position.version}:` +
    `${normal === undefined ? -1 : normal.version}:` +
    `${uv === undefined ? -1 : uv.version}:` +
    `${index === null || index === undefined ? -1 : index.version}`
  );
}

/** Combined structural revision and attribute versions. */
export function geometryRevisionOf(geometry) {
  return geometryPayloadKey(geometry);
}

function buildGeometryPayload(geometry, dropped) {
  const attributes = geometry.attributes || {};
  // Copies, never the live arrays: a consumer is entitled to hold the payload,
  // and an in-place edit afterwards must not change it under them.
  const position = attributes.position ? toFloat32(attributes.position.array) : new Float32Array(0);
  const normal = attributes.normal ? toFloat32(attributes.normal.array) : null;
  const uv = attributes.uv ? toFloat32(attributes.uv.array) : null;
  let indices = null;
  if (geometry.index) {
    indices = Uint32Array.from(geometry.index.array);
  }
  return {
    descriptor: {
      type: geometry.type,
      // Stable for the life of the geometry object and shared by every mesh
      // using it, so consumers cache one native mesh resource per uuid.
      uuid: geometry.uuid,
      // Bumps on every structural or in-place edit, so a consumer can tell
      // "the same geometry again" from "the same geometry, changed".
      revision: geometryRevisionOf(geometry),
      parameters: sanitizeParameters(geometry.parameters, dropped),
    },
    position,
    normal,
    uv,
    indices,
  };
}

function toFloat32(array) {
  return array instanceof Float32Array ? array.slice() : Float32Array.from(array);
}


const normalMatrix = new Matrix3();

/** Transforms an object-space face normal into world space. */
export function worldNormal(object, faceNormal, out) {
  normalMatrix.getNormalMatrix(object.matrixWorld);
  return out.copy(faceNormal).applyMatrix3(normalMatrix).normalize();
}
