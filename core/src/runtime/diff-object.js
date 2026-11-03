// The per-object diff (SPEC section 5).
//
// Five self-contained aspects run in a fixed order for every visited object:
// hierarchy, transform, contents (geometry, material, light), display flags,
// and kind-specific state. Each appends to the frame's named command batch.
// This is the hot path, so it keeps plain locals and captured builtins.

import { SpatialUnsupportedError } from "../util/errors.js";
import { hasShear, takeRawMatrix, markRawMatrix } from "../scene/object-extensions.js";
import {
  DIRTY,
  DIRTY_NAME,
  DIRTY_VISIBLE,
  DIRTY_SHADOW,
  DIRTY_FLAGS,
  DIRTY_GEOMETRY,
  DIRTY_LISTENERS,
  DIRTY_RIGIDBODY,
  DIRTY_MATERIAL,
  DIRTY_LIGHT,
  DIRTY_FEATURE,
} from "../scene/object-extensions.js";
import { createSnapshot, lightSnapshot, lightSnapshotEquals, geometryPayload } from "../util/diff.js";
import { kindFor, entryForKind } from "../util/kinds.js";
import { GEOMETRY_REVISION } from "../util/diff.js";
import { SUBSTITUTED } from "../scene/scene-classes.js";
import { rigidBodyJSONEquals } from "../physics/physics.js";
import {
  MATERIAL_FRAME,
  MATERIAL_PAYLOAD,
  materialForSlot,
  materialSlotCount,
} from "../materials/materials.js";
import { labelFor } from "../util/sanitize.js";
import { MAX_PARAMETER_STRING } from "../util/limits.js";
import { push } from "../util/builtins.js";
import { SNAPSHOT, TRANSFORM_RECORD } from "./state.js";
import { featuresFor, diffFeatures } from "./features.js";
import { shallowJSONEquals, copyLightSnapshot } from "./payloads.js";

/**
 * Diffs one object against its last-flushed snapshot and appends whatever
 * changed to the frame's command batch. Returns the snapshot, or null when the
 * object was already visited this frame.
 *
 * The five aspects below are each a self-contained step; `out` is the named
 * command batch (see CommandBatch) rather than six positional lanes.
 */
export function diffObject(runtime, object, parentId, parentDirty, frame, out) {
    if (runtime.brokenObjects.size > 0 && runtime.brokenObjects.has(object)) return null;
    let snapshot = object[SNAPSHOT];
    if (snapshot === undefined) {
      snapshot = runtime.createSnapshotFor(object);
      // The id space is exhausted: this object is not tracked, and neither is
      // anything under it (SPEC 2, FA-47).
      if (snapshot === null) return null;
      push(out.create, ["create", snapshot.id, snapshot.kind, runtime.wireName(object)]);
    } else if (snapshot.liveFrame === frame) {
      return null;
    }
    snapshot.liveFrame = frame;
    const id = snapshot.id;

    if (snapshot.parentId !== parentId) {
      if (snapshot.parentId === -1) runtime.detachedCount -= 1;
      snapshot.parentId = parentId;
      push(out.hierarchy, ["parent", id, parentId]);
    }
    const dirty = object[DIRTY] | 0;
    if (dirty !== 0) {
      object[DIRTY] = 0;
      if ((dirty & DIRTY_NAME) !== 0 && snapshot.name !== object.name) {
        snapshot.name = object.name;
        push(out.hierarchy, ["name", id, runtime.wireName(object)]);
      }
    }

    // ---- transform: compare, recompose, emit -------------------------------

    const p = object.position;
    const q = object.quaternion;
    const sc = object.scale;
    const trs = runtime.trs;
    const base = snapshot.slot * 10;

    const autoUpdate = object.matrixAutoUpdate;
    let px = 0;
    let py = 0;
    let pz = 0;
    let qx = 0;
    let qy = 0;
    let qz = 0;
    let qw = 1;
    let sx = 1;
    let sy = 1;
    let sz = 1;
    let changed;

    if (autoUpdate === false) {
      // `matrixAutoUpdate = false` is the static hint, with three.js
      // semantics: the matrix is authoritative and the core watches only it.
      // An object whose matrix has not moved costs sixteen array compares and
      // no property reads at all, which is what makes large static scenery
      // free per frame (PERF-04).
      changed = runtime.matrixWasWritten(snapshot, object);
      if (changed) {
        object.matrix.decompose(p, q, sc);
        px = p.x;
        py = p.y;
        pz = p.z;
        qx = q.x;
        qy = q.y;
        qz = q.z;
        qw = q.w;
        sx = sc.x;
        sy = sc.y;
        sz = sc.z;
      }
    } else {
      px = p.x;
      py = p.y;
      pz = p.z;
      qx = q.x;
      qy = q.y;
      qz = q.z;
      qw = q.w;
      sx = sc.x;
      sy = sc.y;
      sz = sc.z;
      changed =
        trs[base] !== px ||
        trs[base + 1] !== py ||
        trs[base + 2] !== pz ||
        trs[base + 3] !== qx ||
        trs[base + 4] !== qy ||
        trs[base + 5] !== qz ||
        trs[base + 6] !== qw ||
        trs[base + 7] !== sx ||
        trs[base + 8] !== sy ||
        trs[base + 9] !== sz;

      // SPEC 3.2 allows a direct `matrix` write. With matrixAutoUpdate on,
      // three would silently recompose over it, so a matrix that differs from
      // the one the core last recorded is decomposed back into TRS.
      if (!changed && runtime.matrixWasWritten(snapshot, object)) {
        object.matrix.decompose(p, q, sc);
        px = p.x;
        py = p.y;
        pz = p.z;
        qx = q.x;
        qy = q.y;
        qz = q.z;
        qw = q.w;
        sx = sc.x;
        sy = sc.y;
        sz = sc.z;
        markRawMatrix(object);
        changed = true;
      }
    }

    // Matrices are only needed by whoever reads matrixWorld, and the command
    // stream carries local TRS, not matrices. So an object with no children
    // defers both its local compose and its world multiply; every three.js
    // world accessor (getWorldPosition, localToWorld, updateWorldMatrix, ...)
    // recomputes from the root on demand, so they stay correct.
    if (changed) snapshot.matrixStale = true;
    let worldDirty = changed || parentDirty === true || object.matrixWorldNeedsUpdate === true;

    const children = object.children;
    if (children.length > 0) {
      if (snapshot.matrixStale) {
        if (autoUpdate) {
          object.updateMatrix();
          runtime.storeMatrix(snapshot, object);
        }
        snapshot.matrixStale = false;
      }
      if (worldDirty || snapshot.worldStale) {
        if (object.matrixWorldAutoUpdate !== false) {
          const parent = object.parent;
          if (parent === null) object.matrixWorld.copy(object.matrix);
          else object.matrixWorld.multiplyMatrices(parent.matrixWorld, object.matrix);
        }
        object.matrixWorldNeedsUpdate = false;
        snapshot.worldStale = false;
        worldDirty = true;
      }
    } else if (worldDirty) {
      snapshot.worldStale = true;
    }
    snapshot.worldDirty = worldDirty;

    if (changed) {
      // A matrix written directly or through applyMatrix4 may carry shear,
      // which three's decompose silently drops (SPEC 3.2).
      const rawMatrix = takeRawMatrix(object);
      const candidate = rawMatrix !== null ? rawMatrix : autoUpdate === false ? object.matrix : null;
      const sheared = candidate !== null ? hasShear(candidate) : false;
      snapshot.sheared = sheared;
      if (sheared) {
        // Recorded as flushed without emitting, so the consumer keeps the last
        // valid transform and the shear-stripped decomposition is never sent
        // on a later frame once the raw matrix has been consumed.
        trs[base] = px;
        trs[base + 1] = py;
        trs[base + 2] = pz;
        trs[base + 3] = qx;
        trs[base + 4] = qy;
        trs[base + 5] = qz;
        trs[base + 6] = qw;
        trs[base + 7] = sx;
        trs[base + 8] = sy;
        trs[base + 9] = sz;
        runtime.storeMatrix(snapshot, object);
        if (!runtime.shearedObjects.has(object)) {
          runtime.shearedObjects.add(object);
          const label = object.name ? `"${object.name}"` : object.type;
          runtime.reportOnce(
            new SpatialUnsupportedError(
              `Matrix on ${label} contains shear, which cannot be represented as a transform`,
              "Object3D.matrix shear",
              object,
            ),
          );
        }
      } else {
        runtime.shearedObjects.delete(object);
        // `sum - sum === 0` holds only when every term is finite: a NaN or an
        // infinity anywhere makes the difference NaN. One pass instead of
        // twenty-two comparisons.
        const sum = px + py + pz + qx + qy + qz + qw + sx + sy + sz;
        const finite = sum - sum === 0 && qx * qx + qy * qy + qz * qz + qw * qw > 1e-12;

        if (finite) {
          runtime.invalidTransforms.delete(object);
          trs[base] = px;
          trs[base + 1] = py;
          trs[base + 2] = pz;
          trs[base + 3] = qx;
          trs[base + 4] = qy;
          trs[base + 5] = qz;
          trs[base + 6] = qw;
          trs[base + 7] = sx;
          trs[base + 8] = sy;
          trs[base + 9] = sz;

          let out = runtime.transformBuffer;
          const offset = runtime.transformCount * TRANSFORM_RECORD;
          if (offset + TRANSFORM_RECORD > out.length) {
            const grown = new Float32Array(Math.max(out.length * 2, offset + TRANSFORM_RECORD));
            grown.set(out);
            out = grown;
            runtime.transformBuffer = grown;
          }
          out[offset] = id;
          out[offset + 1] = px;
          out[offset + 2] = py;
          out[offset + 3] = pz;
          out[offset + 4] = qx;
          out[offset + 5] = qy;
          out[offset + 6] = qz;
          out[offset + 7] = qw;
          out[offset + 8] = sx;
          out[offset + 9] = sy;
          out[offset + 10] = sz;
          runtime.transformCount += 1;
          runtime.storeMatrix(snapshot, object);
        } else if (!runtime.invalidTransforms.has(object)) {
          runtime.invalidTransforms.add(object);
          const label = object.name ? `"${object.name}"` : object.type;
          runtime.reportOnce(
            new SpatialUnsupportedError(
              `Transform on ${label} is not finite; the last valid transform is kept`,
              "Object3D.transform non-finite",
              object,
            ),
          );
        }
      }
    }

    // ---- contents and flags, only when a setter raised a bit ---------------

    if (snapshot.isMesh) {
      // Geometry replacement raises a bit; an in-place attribute edit only
      // bumps the attribute version, so that stays a two-read check.
      if ((dirty & DIRTY_GEOMETRY) !== 0 || snapshot.geometryObject === null) {
        const geometry = object.geometry;
        if (geometry !== undefined && geometry !== null && geometry !== snapshot.geometryObject) {
          snapshot.geometryObject = geometry;
          snapshot.geometryRevision = -1;
        }
      }
      // Structural edits (setAttribute, setIndex, computeVertexNormals) bump a
      // revision; in-place edits bump the attribute's own version.
      let geometryChanged = false;
      const tracked = snapshot.geometryObject;
      if (tracked !== null) {
        const revision = tracked[GEOMETRY_REVISION] | 0;
        if (snapshot.geometryRevision !== revision) {
          snapshot.geometryRevision = revision;
          const attributes = tracked.attributes;
          snapshot.positionAttribute = attributes === undefined ? null : attributes.position || null;
          snapshot.normalAttribute = attributes === undefined ? null : attributes.normal || null;
          snapshot.uvAttribute = attributes === undefined ? null : attributes.uv || null;
          snapshot.indexAttribute = tracked.index || null;
          geometryChanged = true;
        }
        const positionAttribute = snapshot.positionAttribute;
        const version = positionAttribute === null ? -1 : positionAttribute.version;
        const normalVersion = snapshot.normalAttribute === null ? -1 : snapshot.normalAttribute.version;
        const uvVersion = snapshot.uvAttribute === null ? -1 : snapshot.uvAttribute.version;
        const indexVersion = snapshot.indexAttribute === null ? -1 : snapshot.indexAttribute.version;
        if (
          snapshot.geometryVersion !== version ||
          snapshot.normalVersion !== normalVersion ||
          snapshot.uvVersion !== uvVersion ||
          snapshot.indexVersion !== indexVersion
        ) {
          snapshot.geometryVersion = version;
          snapshot.normalVersion = normalVersion;
          snapshot.uvVersion = uvVersion;
          snapshot.indexVersion = indexVersion;
          geometryChanged = true;
        }
      }
      if (geometryChanged) {
        const geometry = snapshot.geometryObject;
        if (geometry !== null) {
          if (geometry[SUBSTITUTED] === "geometry") {
            const label = object.name ? `"${object.name}"` : object.type;
            runtime.warnOnce(
              `substituted-geometry:${object.uuid}`,
              `Mesh ${label} was created without a geometry; an empty BufferGeometry was substituted`,
            );
          }
          // A geometry with no vertices draws nothing on either backend; the
          // core says so once here so neither consumer has to (SPEC 12).
          const positions = snapshot.positionAttribute;
          if (geometry[SUBSTITUTED] !== "geometry" && (positions === null || positions.count === 0)) {
            const label = object.name ? `"${object.name}"` : object.type;
            runtime.warnOnce(
              `empty-geometry:${geometry.uuid}`,
              `Mesh ${label} has a ${geometry.type} with no vertices and draws nothing`,
            );
          }
          const dropped = [];
          const truncated = [];
          const payload = geometryPayload(geometry, dropped, truncated);
          if (truncated.length > 0) {
            runtime.warnOnce(
              `geometry-parameter-length:${geometry.uuid}`,
              `${geometry.type} parameter ${truncated.join(", ")} was longer than ` +
                `${MAX_PARAMETER_STRING} characters and was truncated on the wire`,
            );
          }
          if (dropped.length > 0) {
            runtime.warnOnce(
              `geometry-parameters:${geometry.uuid}`,
              `${geometry.type} parameters ${dropped.join(", ")} are not a value the command ` +
                "stream can carry and were dropped",
            );
          }
          // A geometry the consumer has already been given at this uuid and
          // revision needs no buffers again — a hand-built BufferGeometry as
          // much as a parametric one, which is what makes 1500 meshes sharing
          // one 20,000-vertex geometry one upload instead of 1500 (SPEC 5).
          // A new revision carries its buffers, and the delivered record is
          // refcounted by live users, so a geometry whose last user goes away
          // is described in full again.
          const descriptor = payload.descriptor;
          runtime.noteGeometryUse(snapshot, descriptor.uuid);
          const reusable = runtime.sentGeometry.get(descriptor.uuid) === descriptor.revision;
          if (reusable) {
            push(out.object, ["geometry", id, descriptor, null, null, null, null]);
          } else {
            runtime.sentGeometry.set(descriptor.uuid, descriptor.revision);
            push(out.object, [
              "geometry",
              id,
              descriptor,
              payload.position,
              payload.normal,
              payload.uv,
              payload.indices,
            ]);
          }
        }
      }

      // A material instance is shared by many meshes, so its own state is
      // compared once per frame and each mesh only checks payload identity.
      // The reference itself only changes through the setter, so reading it is
      // behind a dirty bit: `material` is an accessor, and an accessor call per
      // object per frame is measurable in an interpreter.
      if ((dirty & DIRTY_MATERIAL) !== 0 || snapshot.materialObject === null) {
        snapshot.materialObject = object.material;
      }
      const material = snapshot.materialObject;
      if (Array.isArray(material)) {
        // One material per geometry group (SPEC 14.12). The payload is an
        // array; each element is the same per-material payload a single
        // material would produce, so consumers share native materials the
        // same way. A group whose materialIndex has no material would be a
        // per-consumer guess, so the array is padded to cover every index and
        // the mismatch is reported once (P2-B-17).
        const wanted = materialSlotsWanted(runtime, object, material);
        const previous = snapshot.material;
        let changed = !Array.isArray(previous) || previous.length !== wanted;
        const next = [];
        for (let i = 0; i < wanted; i += 1) {
          const entry = materialForSlot(material, i);
          if (entry === null || entry === undefined) {
            next[i] = null;
          } else {
            next[i] =
              entry[MATERIAL_FRAME] === frame
                ? entry[MATERIAL_PAYLOAD]
                : runtime.materialPayload(entry, frame);
            runtime.warnMaterial(entry);
          }
          if (!changed && previous[i] !== next[i]) changed = true;
        }
        if (changed) {
          snapshot.material = next;
          push(out.object, ["material", id, next]);
        }
      } else if (material !== undefined && material !== null) {
        const next =
          material[MATERIAL_FRAME] === frame
            ? material[MATERIAL_PAYLOAD]
            : runtime.materialPayload(material, frame);
        if (next !== snapshot.material) {
          if (material[SUBSTITUTED] === "material") {
            const label = object.name ? `"${object.name}"` : object.type;
            runtime.warnOnce(
              `substituted-material:${object.uuid}`,
              `Mesh ${label} was created without a material; a MeshStandardMaterial was substituted ` +
                "(three.js would use MeshBasicMaterial, which is unlit)",
            );
          }
          runtime.warnMaterial(material);
          snapshot.material = next;
          push(out.object, ["material", id, next]);
        }
      }
    } else if (snapshot.isLight) {
      // A light is only re-derived when a tracked setter fired, its colour
      // channels moved, or the walk saw its world matrix change (PERF-03).
      const color = object.color;
      const colorMoved =
        color !== undefined &&
        (snapshot.lightColorR !== color.r ||
          snapshot.lightColorG !== color.g ||
          snapshot.lightColorB !== color.b);
      if ((dirty & DIRTY_LIGHT) !== 0 || colorMoved || worldDirty || snapshot.light === null) {
        if (color !== undefined) {
          snapshot.lightColorR = color.r;
          snapshot.lightColorG = color.g;
          snapshot.lightColorB = color.b;
        }
        const next = lightSnapshot(object, runtime.boundWarnOnce, runtime.lightScratch);
        if (next !== null && !lightSnapshotEquals(snapshot.light, next)) {
          snapshot.light = copyLightSnapshot(next);
          // RealityKit has no point-light shadow; three.js renders one, so
          // the warning belongs to that backend only (FA-21).
          if (object.isPointLight && object.castShadow && runtime.env.backend === "realitykit") {
            runtime.warnOnce(
              "pointlight-shadow",
              "PointLight shadows are unsupported in RealityKit; castShadow is ignored",
            );
          }
          push(out.object, ["light", id, snapshot.light]);
        }
      }
    }

    if (dirty !== 0) {
      if ((dirty & DIRTY_VISIBLE) !== 0) {
        const visible = object.visible;
        if (snapshot.visible !== visible) {
          snapshot.visible = visible;
          push(out.object, ["visible", id, visible]);
        }
      }

      if ((dirty & DIRTY_SHADOW) !== 0 && snapshot.isMesh) {
        const castShadow = object.castShadow;
        const receiveShadow = object.receiveShadow;
        if (snapshot.castShadow !== castShadow || snapshot.receiveShadow !== receiveShadow) {
          snapshot.castShadow = castShadow;
          snapshot.receiveShadow = receiveShadow;
          push(out.object, ["shadow", id, castShadow, receiveShadow]);
        }
      }

      if ((dirty & DIRTY_FLAGS) !== 0) {
        // ParticleEmitter.opacity is the particle start opacity (SPEC 3.10),
        // not the OpacityComponent value, so it emits no `opacity` command.
        if (snapshot.kind !== "particles") {
          const opacity = object.opacity;
          if (snapshot.opacity !== opacity) {
            snapshot.opacity = opacity;
            push(out.object, ["opacity", id, opacity]);
          }
        }

        const billboard = object.billboard;
        if (snapshot.billboard !== billboard) {
          snapshot.billboard = billboard;
          push(out.object, ["billboard", id, billboard]);
        }

        const groundingShadow = object.groundingShadow;
        if (snapshot.groundingShadow !== groundingShadow) {
          snapshot.groundingShadow = groundingShadow;
          // SPEC 3.2: meshes only. On anything else it is kept in the dump and
          // reported, but never sent (FA-48).
          if (groundingShadow && !snapshot.isMesh) {
            runtime.warnOnce(
              `grounding-shadow-nonmesh:${object.uuid}`,
              `Object3D.groundingShadow applies to a Mesh; ${labelFor(object)} is a ${object.type} ` +
                "and it was ignored",
            );
          } else if (groundingShadow && runtime.env.backend === "three") {
            runtime.warnOnce(
              "groundingShadow-web",
              "Object3D.groundingShadow is unsupported on the three.js backend",
            );
          }
          if (snapshot.isMesh) push(out.object, ["groundingShadow", id, groundingShadow]);
        }

        const hoverEffect = object.hoverEffect;
        if (snapshot.hoverEffect !== hoverEffect) {
          snapshot.hoverEffect = hoverEffect;
          push(out.object, ["hoverEffect", id, hoverEffect]);
        }

        const manipulable = object.manipulable;
        if (snapshot.manipulable !== manipulable) {
          snapshot.manipulable = manipulable;
          push(out.object, ["manipulable", id, manipulable]);
        }

        const renderOrder = object.renderOrder;
        if (snapshot.renderOrder !== renderOrder) {
          snapshot.renderOrder = renderOrder;
          push(out.object, ["renderOrder", id, renderOrder]);
        }
      }

      if ((dirty & DIRTY_LISTENERS) !== 0) {
        // Input targets, read straight off three's listener table.
        let tap = false;
        let hover = false;
        let drag = false;
        let manipulation = false;
        let collision = false;
        const listeners = object._listeners;
        if (listeners !== undefined && listeners !== null) {
          const has = (name) => {
            const list = listeners[name];
            return list !== undefined && list.length > 0;
          };
          tap = has("tap");
          hover = has("hoverenter") || has("hoverexit");
          drag = has("dragstart") || has("drag") || has("dragend");
          manipulation =
            has("manipulationstart") || has("manipulation") || has("manipulationend");
          collision = has("collisionstart") || has("collisionend");
        }
        if (
          snapshot.tap !== tap ||
          snapshot.hover !== hover ||
          snapshot.drag !== drag ||
          snapshot.manipulation !== manipulation ||
          snapshot.collision !== collision
        ) {
          snapshot.tap = tap;
          snapshot.hover = hover;
          snapshot.drag = drag;
          snapshot.manipulation = manipulation;
          snapshot.collision = collision;
          push(out.object, ["interactive", id, { tap, hover, drag, manipulation, collision }]);
        }
      }
    }

    // ---- kind specific -----------------------------------------------------

    // Kind-specific state, driven by the registry rather than a chain of
    // `else if (kind === ...)` branches (MAINT-05).
    const kindEntry = entryForKind(snapshot.kind);
    if (kindEntry !== null) {
      if (kindEntry.opcode === null) {
        // The payload references another object, so it waits for the walk to
        // finish; the portal is only recorded here.
        push(out.portals, object);
      } else {
        const next = kindEntry.toJSON(object, runtime);
        const previous = snapshot[kindEntry.snapshotKey];
        if (previous === null || !shallowJSONEquals(previous, next)) {
          snapshot[kindEntry.snapshotKey] = next;
          push(out[kindEntry.lane], [kindEntry.opcode, id, next]);
        }
      }
    }

    // ---- phase 2 state ------------------------------------------------------

    // One gate for every feature of SPEC 14, holding what the object has and
    // what is still on the wire, so a retraction survives the last feature
    // being cleared (P2-B-02) and an object with none of them pays a single
    // field read.
    if (snapshot.featureGate !== 0 || (dirty & (DIRTY_FEATURE | DIRTY_MATERIAL)) !== 0) {
      snapshot.features = featuresFor(object);
      snapshot.featureGate = snapshot.features | snapshot.emittedFeatures;
      if (snapshot.featureGate !== 0) diffFeatures(runtime, object, snapshot, id, out);
    }

    // A body's own properties can be reassigned without a setter, so a body
    // that exists is compared every frame; an object that has never had one
    // costs a single snapshot field read.
    if (snapshot.hasBody || (dirty & DIRTY_RIGIDBODY) !== 0) {
      const body = object.rigidBody;
      snapshot.hasBody = body !== null;
      const bodyJSON = body === null ? null : body.toJSON();
      if (
        (snapshot.rigidBody === null) !== (bodyJSON === null) ||
        !rigidBodyJSONEquals(snapshot.rigidBody, bodyJSON)
      ) {
        snapshot.rigidBody = bodyJSON;
        push(out.body, ["rigidBody", id, bodyJSON]);
      }
    }

    return snapshot;
  }

  /**
   * True when `object.matrix` differs from the one recorded at the last flush,
   * which means a script wrote it directly rather than through TRS.
   */

/**
 * The slot count the wire carries, and the one-time diagnostic when the mesh
 * and its geometry disagree about how many materials there are (P2-B-17,
 * FA-09). The count itself is shared with the dump so both describe the same
 * mesh.
 */
function materialSlotsWanted(runtime, object, materials) {
  const wanted = materialSlotCount(object, materials);
  if (wanted === materials.length) return wanted;

  const groups = object.geometry === null || object.geometry === undefined ? [] : object.geometry.groups;
  if (materials.length === 0) {
    runtime.warnOnce(
      `material-groups:${object.uuid}`,
      `${labelFor(object)} has ${groups.length} geometry groups and no materials; ` +
        "nothing can be drawn for them",
    );
    return 0;
  }
  if (wanted > materials.length) {
    runtime.warnOnce(
      `material-groups:${object.uuid}`,
      `${labelFor(object)} has geometry groups asking for ${wanted} materials but carries ` +
        `${materials.length}; the last material was repeated for the rest`,
    );
    return wanted;
  }
  runtime.warnOnce(
    `material-groups:${object.uuid}`,
    `${labelFor(object)} carries ${materials.length} materials but its geometry groups ask for ` +
      `${wanted}; the extra materials were ignored`,
  );
  return wanted;
}
