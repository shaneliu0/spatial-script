// Command-stream identity and the resources keyed by it: object, texture and
// joint ids, the texture release queue, portal worlds, and the joint diff.
//
// Ids must stay exact in the float32 `transforms` records, so released ids are
// recycled and the space below 2^24 is guarded rather than overflowed.

import { SpatialUnsupportedError } from "../util/errors.js";
import { MAX_ID, MAX_DEPTH } from "../util/limits.js";
import { isDestroyed } from "../scene/object-extensions.js";
import { labelFor } from "../util/sanitize.js";
import { textureSnapshot, textureSnapshotEquals } from "../util/diff.js";
import { jointJSONEquals } from "../physics/physics.js";
import { MATERIAL_MAP_SLOTS } from "../materials/materials.js";
import { portalJSONEquals } from "../scene/portal.js";
import { push } from "../util/builtins.js";
import { SNAPSHOT } from "./state.js";

export function referenceIdFor(runtime, object) {
    if (!object || isDestroyed(object)) return null;
    return runtime.idForObject(object);
  }

  /**
   * Allocates the next command-stream id, reusing released ones first. Returns
   * 0 when the space below 2^24 is exhausted; ids must stay exact in the
   * float32 `transforms` records, so a colliding id is never issued.
   */
export function allocateId(runtime) {
    if (runtime.freeIds.length > 0) return runtime.freeIds.pop();
    if (runtime.nextId >= MAX_ID) {
      // SPEC 2: the error is recorded once and new objects stop being tracked
      // altogether — id 0 is the native root, so emitting commands for it
      // would rewrite the scene root every frame (FA-47).
      if (!runtime.idsExhausted) {
        runtime.idsExhausted = true;
        runtime.reportOnce({
          name: "SpatialUnsupportedError",
          message: `The scene has used every object id below ${MAX_ID}; new objects are not tracked`,
        });
      }
      return 0;
    }
    const id = runtime.nextId;
    runtime.nextId += 1;
    return id;
  }

export function releaseId(runtime, id) {
    if (id > 0 && id < MAX_ID) runtime.freeIds.push(id);
  }

export function idForObject(runtime, object) {
    let id = runtime.objectIds.get(object);
    if (id === undefined) {
      id = runtime.allocateId();
      if (id === 0) return 0;
      runtime.objectIds.set(object, id);
      runtime.idObjects.set(id, object);
    }
    return id;
  }

  /**
   * True when a command may name this object: the consumer has seen a `create`
   * for it and it has not been destroyed (SPEC 5 ordering).
   */
export function canCommand(runtime, object, feature) {
    if (!object) return false;
    if (isDestroyed(object)) {
      const label = object.name ? `"${object.name}"` : object.type;
      runtime.warnOnce(
        `uncreated:${feature}`,
        `${feature} on ${label} was dropped: the object is not in the mounted scene`,
      );
      return false;
    }
    // An object the consumer has already seen can be commanded straight away.
    if (object[SNAPSHOT] !== undefined) return true;
    // One that is in the graph but has not been flushed yet is not an error:
    // its command waits for the frame after its `create` (SPEC 5 ordering).
    if (isAttached(runtime, object)) return true;
    const label = object.name ? `"${object.name}"` : object.type;
    runtime.warnOnce(
      `uncreated:${feature}`,
      `${feature} on ${label} was dropped: the object is not in the mounted scene`,
    );
    return false;
  }

  /**
   * True when `object` hangs off the mounted scene, off a tracked root, or off
   * a Scene that is about to be mounted: a script that builds its scene, acts
   * on it, and calls `mount` last is the normal shape.
   */
export function isAttached(runtime, object) {
    let node = object;
    let depth = 0;
    while (node !== null && node !== undefined && depth <= MAX_DEPTH) {
      if (node === runtime.scene) return true;
      if (runtime.extraRoots.has(node)) return true;
      if (node.parent === null || node.parent === undefined) return node.isScene === true;
      node = node.parent;
      depth += 1;
    }
    return false;
  }

export function objectForId(runtime, id) {
    const object = runtime.idObjects.get(id);
    return object === undefined ? null : object;
  }

export function textureIdFor(runtime, texture) {
    // A texture that was disposed and is used again would otherwise resolve to
    // an id the consumer has already been told to free, and the material would
    // name a texture that no longer exists (FA-58). It comes back as a new
    // texture with a new id, and the script is told once.
    if (texture.disposed === true) {
      runtime.warnOnce(
        `texture-reused:${texture.url}`,
        `A disposed Texture ("${texture.url}") was used again; it was registered as a new texture. ` +
          "Load it again rather than reusing a disposed one",
      );
      texture.disposed = false;
      const stale = runtime.textureIds.get(texture);
      if (stale !== undefined) {
        runtime.textureIds.delete(texture);
        runtime.idTextures.delete(stale);
      }
      runtime.pendingTextureRelease.delete(texture);
      runtime.textureSnapshots.delete(texture);
    }

    let id = runtime.textureIds.get(texture);
    if (id === undefined) {
      id = runtime.allocateId();
      if (id === 0) return 0;
      runtime.textureIds.set(texture, id);
      runtime.idTextures.set(id, texture);
      runtime.textures.add(texture);
    }
    return id;
  }

export function registerTexture(runtime, texture) {
    runtime.textures.add(texture);
    runtime.textureIdFor(texture);
  }

  /** True while any live material or emitter still names `texture`. */
function textureIsReferenced(runtime, texture, frame) {
    for (const [object, snapshot] of runtime.snapshots) {
      if (snapshot.liveFrame !== frame) continue;
      const material = snapshot.materialObject;
      if (material !== null && material !== undefined) {
        // Driven by the one slot list, so a phase-2 slot cannot leak textures.
        for (let i = 0; i < MATERIAL_MAP_SLOTS.length; i += 1) {
          if (material[MATERIAL_MAP_SLOTS[i]] === texture) return true;
        }
      }
      if (object.texture === texture) return true;
    }
    return false;
  }

  /**
   * Emits the release form for every disposed texture nothing points at any
   * more. Placed after the material commands of the frame so a consumer never
   * frees a texture a material it has not yet replaced still names.
   */
export function diffTextureReleases(runtime, frame, cRelease) {
    if (runtime.pendingTextureRelease.size === 0) return;
    for (const texture of Array.from(runtime.pendingTextureRelease)) {
      if (textureIsReferenced(runtime, texture, frame)) continue;
      runtime.pendingTextureRelease.delete(texture);
      const id = runtime.textureIds.get(texture);
      // Released exactly once: the id registration is what guards a repeat.
      if (id === undefined) continue;
      runtime.textureIds.delete(texture);
      runtime.idTextures.delete(id);
      runtime.releaseId(id);
      cRelease.push(["texture", id, null]);
    }
  }

  /**
   * Queues a texture for release. The `["texture", id, null]` command is only
   * emitted once nothing references the texture any more, and the id stays
   * reserved until then so a live reference can never be repointed.
   */
export function disposeTexture(runtime, texture) {
    // Stops property re-emission, but the id stays registered so a material
    // that still names it keeps resolving to the same texture.
    runtime.textures.delete(texture);
    runtime.textureSnapshots.delete(texture);
    if (!runtime.textureIds.has(texture)) return;
    runtime.pendingTextureRelease.add(texture);
  }

export function jointIdFor(runtime, joint) {
    let id = runtime.jointIds.get(joint);
    if (id === undefined) {
      id = runtime.allocateId();
      if (id === 0) return 0;
      runtime.jointIds.set(joint, id);
    }
    return id;
  }

  // ------------------------------------------------------------------ output


export function diffTextures(runtime, cTexture) {
    for (const texture of runtime.textures) {
      const id = runtime.textureIdFor(texture);
      const next = textureSnapshot(texture, runtime.boundResolveUrl);
      const previous = runtime.textureSnapshots.get(texture);
      if (previous === undefined || !textureSnapshotEquals(previous, next) || texture.needsUpdate) {
        texture.needsUpdate = false;
        runtime.textureSnapshots.set(texture, next);
        cTexture.push(["texture", id, next]);
      }
    }
  }

export function diffWorlds(runtime, frame, framePortals, cWorld) {
    const next = runtime.worldScratch;
    next.clear();
    for (let i = 0; i < framePortals.length; i += 1) {
      const world = framePortals[i].world;
      if (world) next.add(world);
    }
    for (const world of next) {
      const snapshot = world[SNAPSHOT];
      if (snapshot === undefined || snapshot.liveFrame !== frame || snapshot.world) continue;
      snapshot.world = true;
      cWorld.push(["world", snapshot.id, true]);
    }
    for (const world of runtime.worldFlagged) {
      if (next.has(world)) continue;
      const snapshot = world[SNAPSHOT];
      if (snapshot === undefined || !snapshot.world) continue;
      snapshot.world = false;
      cWorld.push(["world", snapshot.id, false]);
    }
    runtime.worldScratch = runtime.worldFlagged;
    runtime.worldFlagged = next;
  }

  /** Portal payloads, after every world group of the frame has been created. */
export function diffPortals(runtime, frame, framePortals, cPortal) {
    for (let i = 0; i < framePortals.length; i += 1) {
      const portal = framePortals[i];
      const snapshot = portal[SNAPSHOT];
      const world = portal.world;
      // A world group that is not in the mounted scene has no `create`, so a
      // `portal` naming it would break SPEC 5's ordering guarantee.
      const worldMissing =
        world !== null && (world[SNAPSHOT] === undefined || world[SNAPSHOT].liveFrame !== frame);
      if (worldMissing) {
        runtime.warnOnce(
          `portal-world:${portal.uuid}`,
          `Portal ${portal.name ? `"${portal.name}"` : portal.type} has a world group that is not in ` +
            "the mounted scene; add it to the scene for the portal to render",
        );
      }
      // A world that left the scene is retracted rather than left named: the
      // consumer must stop rendering into a group it no longer has (AR-20).
      const next = worldMissing
        ? { worldId: null, width: portal.width, height: portal.height, crossing: portal.crossing }
        : portal.toJSON(runtime.boundReferenceIdFor);
      if (!portalJSONEquals(snapshot.portal, next)) {
        snapshot.portal = next;
        cPortal.push(["portal", snapshot.id, next]);
      }
    }
  }

export function diffJoints(runtime, cJoint) {
    const joints = runtime.physics.joints;
    if (joints.length === 0 && runtime.jointSnapshots.size === 0) return;
    const live = new Set(joints);
    for (const joint of live) {
      const id = runtime.jointIdFor(joint);
      const next = joint.toJSON();
      const previous = runtime.jointSnapshots.get(joint);
      if (previous === undefined || !jointJSONEquals(previous, next)) {
        runtime.jointSnapshots.set(joint, next);
        cJoint.push(["joint", id, next]);
      }
    }
    for (const joint of Array.from(runtime.jointSnapshots.keys())) {
      if (live.has(joint)) continue;
      runtime.jointSnapshots.delete(joint);
      cJoint.push(["joint", runtime.jointIdFor(joint), null]);
    }
  }

  // ------------------------------------------------------------------ misc

  /**
   * Resolves a script url and contains it: `.`/`..` collapsed, an escape from
   * the asset root refused, an unlisted scheme refused, credentials stripped.
   * A refused url becomes null and the reason is warned once (SPEC 3.5).
   */
