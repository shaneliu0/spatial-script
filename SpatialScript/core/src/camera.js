// Cameras (SPEC 14.3). The camera itself is three's; the core only reports the
// active one to the consumer as a `camera` command and answers pointer queries
// against it.

import { host } from "./host.js";
import { finite } from "./sanitize.js";

let installed = false;

/**
 * `aspect` is the consumer's business: it owns the viewport, so a script-set
 * value is kept (three needs it for its own projection matrix) but reported as
 * ignored. three's constructor assigns it too, and the constructor argument is
 * as much the script's value as a later write is, so anything other than
 * three's default warns as well (P2-B-20).
 */
export function installCameraTracking(PerspectiveCamera) {
  if (installed) return;
  installed = true;
  const proto = PerspectiveCamera.prototype;
  const backing = Symbol("spatial.aspect");

  Object.defineProperty(proto, "aspect", {
    configurable: true,
    enumerable: true,
    get() {
      const value = this[backing];
      return value === undefined ? 1 : value;
    },
    set(value) {
      if (value !== 1) {
        const runtime = host();
        if (runtime) {
          runtime.warnOnce(
            "camera-aspect",
            "PerspectiveCamera.aspect is managed by the consumer from the viewport; the script value is ignored",
          );
        }
      }
      this[backing] = value;
    },
  });
}

/** True for the two camera classes SPEC 14.3 exposes. */
export function isCamera(object) {
  return object !== null && object !== undefined && object.isCamera === true;
}

/**
 * The `camera` payload: the kind and the projection parameters that kind uses
 * (SPEC 14.13). The pose is not in it — the camera is an Object3D, so its
 * transform travels through `transforms` like any other object. Written into
 * `out` so the steady state allocates nothing.
 */
export function cameraPayload(camera, out) {
  if (camera === null) {
    out.kind = null;
  } else if (camera.isPerspectiveCamera === true) {
    out.kind = "perspective";
  } else if (camera.isOrthographicCamera === true) {
    out.kind = "orthographic";
  } else {
    out.kind = null;
  }

  out.fov = camera !== null && camera.isPerspectiveCamera === true ? finite(camera.fov, 60) : null;
  out.near = camera === null ? null : finite(camera.near, 0.01);
  out.far = camera === null ? null : finite(camera.far, 1000);
  const ortho = camera !== null && camera.isOrthographicCamera === true;
  out.left = ortho ? finite(camera.left, -1) : null;
  out.right = ortho ? finite(camera.right, 1) : null;
  out.top = ortho ? finite(camera.top, 1) : null;
  out.bottom = ortho ? finite(camera.bottom, -1) : null;
  return out;
}

export function createCameraScratch() {
  return { kind: null, fov: null, near: null, far: null, left: null, right: null, top: null, bottom: null };
}

export function cameraPayloadEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.fov === b.fov &&
    a.near === b.near &&
    a.far === b.far &&
    a.left === b.left &&
    a.right === b.right &&
    a.top === b.top &&
    a.bottom === b.bottom
  );
}

/** A copy the command stream owns, taken from the reused scratch. */
export function copyCameraPayload(source) {
  return {
    kind: source.kind,
    fov: source.fov,
    near: source.near,
    far: source.far,
    left: source.left,
    right: source.right,
    top: source.top,
    bottom: source.bottom,
  };
}
