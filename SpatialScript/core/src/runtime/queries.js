// Queries and resources the script asks for outside the frame diff: url
// containment, the environment payload, hit testing and asset loading.
//
// Each takes the runtime explicitly; `Runtime` keeps a thin facade over them.

import { Vector3 } from "../three-exports.js";
import { SpatialUnsupportedError } from "../errors.js";
import { AssetGroup } from "../asset.js";
import { refreshWorldMatrices } from "../object-extensions.js";
import { worldNormal } from "../diff.js";
import { resolveUrl as containUrl } from "../urls.js";
import { push } from "../builtins.js";

/** The asset url keys SPEC 3.12 defines, in the order loadAsset reports them. */
const ASSET_KEYS = ["usdz", "reality", "glb", "gltf"];

export function resolveUrl(runtime, url) {
  const result = containUrl(url, runtime.assetRoot);
  if (result.warning !== null) runtime.warnOnce(`url:${url}`, result.warning);
  return result.url;
}

/**
 * The environment payload the command stream carries, with its url contained
 * the same way a texture url is. A refused url means no environment at all
 * rather than one the consumer would resolve against its own file system.
 */
export function environmentPayload(runtime) {
  const environment = runtime.environment;
  if (!environment || typeof environment.toJSON !== "function") return null;
  const json = environment.toJSON();
  if (json === null || json === undefined) return null;
  const url = runtime.resolveUrl(json.url);
  if (url === null) {
    runtime.warnOnce(
      `environment-url:${json.url}`,
      "Spatial.environment was dropped because its url was refused",
    );
    return null;
  }
  if (url === json.url) return json;
  json.url = url;
  return json;
}

export function raycast(runtime, origin, direction, options = {}) {
  const maxDistance = options.maxDistance === undefined ? Infinity : options.maxDistance;
  const recursive = options.recursive !== false;
  const native = globalThis.__spatialNative;

  if (native && typeof native.raycast === "function") {
    const flat = native.raycast(
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      Number.isFinite(maxDistance) ? maxDistance : -1,
      recursive,
    );
    const hits = [];
    if (flat && flat.length) {
      for (let i = 0; i + 8 <= flat.length; i += 8) {
        // Id 0 is the real-world mesh: a hit on scene understanding has no
        // object of its own (SPEC 14.7).
        const understanding = flat[i] === 0;
        const object = understanding ? null : runtime.objectForId(flat[i]);
        if (!understanding && !object) continue;
        push(hits, {
          object,
          point: new Vector3(flat[i + 1], flat[i + 2], flat[i + 3]),
          normal: new Vector3(flat[i + 4], flat[i + 5], flat[i + 6]),
          distance: flat[i + 7],
          sceneUnderstanding: understanding,
        });
      }
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  if (!runtime.scene) return [];
  // Leaf objects defer their world matrix, so refresh before hit testing.
  refreshWorldMatrices(runtime.scene, (object, error) => runtime.skipObject(object, error));
  runtime.raycaster.set(origin, direction.clone().normalize());
  runtime.raycaster.near = 0;
  runtime.raycaster.far = Number.isFinite(maxDistance) ? maxDistance : Infinity;

  // SPEC 3.7: visible meshes only, at most one hit per object, sorted by
  // distance. `recursive: false` limits hits to direct children of the scene.
  const targets = [];
  if (recursive) {
    runtime.scene.traverseVisible((object) => {
      if (object.isMesh === true) push(targets, object);
    });
  } else {
    const children = runtime.scene.children;
    for (let i = 0; i < children.length; i += 1) {
      if (children[i].isMesh === true && children[i].visible !== false) push(targets, children[i]);
    }
  }

  const intersections = runtime.raycaster.intersectObjects(targets, false);
  const results = [];
  const seen = new Set();
  for (const hit of intersections) {
    if (seen.has(hit.object)) continue;
    seen.add(hit.object);
    const normal = new Vector3(0, 0, 1);
    if (hit.normal) normal.copy(hit.normal);
    else if (hit.face) worldNormal(hit.object, hit.face.normal, normal);
    push(results, {
      object: hit.object,
      point: hit.point.clone(),
      normal,
      distance: hit.distance,
      sceneUnderstanding: false,
    });
  }
  results.sort((a, b) => a.distance - b.distance);
  return results;
}

export function loadAsset(runtime, urls = {}) {
  // Every asset url is contained the same way a texture url is: the file
  // system on the other side of the command stream is reached through one
  // gate, not four (SPEC 3.5 url forms).
  const contained = {};
  const refused = [];
  for (let i = 0; i < ASSET_KEYS.length; i += 1) {
    const key = ASSET_KEYS[i];
    const raw = urls[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const url = runtime.resolveUrl(raw);
    if (url === null) push(refused, key);
    else contained[key] = url;
  }

  const group = new AssetGroup(contained);
  const backend = runtime.env.backend;
  const needed = backend === "realitykit" ? ["usdz", "reality"] : ["glb", "gltf"];
  if (!needed.some((key) => group.urls[key])) {
    // A refused url is a load failure, not a silent asset with no source.
    const reason =
      refused.length > 0
        ? `loadAsset refused ${refused.join(" and ")}: the url leaves the asset root or uses a scheme ` +
          "that is not allowed"
        : `loadAsset needs one of ${needed.join(" or ")} for the ${backend} backend`;
    return Promise.reject(new SpatialUnsupportedError(reason, "loadAsset", group));
  }
  runtime.extraRoots.add(group);
  const promise = new Promise((resolve, reject) => {
    group._resolve = resolve;
    group._reject = reject;
  });
  group.promise = promise;
  return promise;
}
