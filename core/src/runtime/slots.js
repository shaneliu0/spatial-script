// Slot and snapshot bookkeeping for the runtime: where a tracked object lives in
// the packed transform arrays, which geometry it currently draws, and how both
// are handed back when the object leaves the scene. Split out of runtime.js so
// the runtime stays a thin facade over its modules.

import { createSnapshot } from "../util/diff.js";
import { kindFor } from "../util/kinds.js";
import { push } from "../util/builtins.js";
import { SNAPSHOT } from "./state.js";

export function createSnapshotFor(runtime, object) {
  const id = runtime.idForObject(object);
  // No id, no tracking: the object and its subtree stay out of the command
  // stream rather than being described as the native root (FA-47).
  if (id === 0) return null;
  const snapshot = createSnapshot(id, runtime.allocateSlot(), kindFor(object), object.isLight === true);
  // `create` already carries the name, so record it as flushed.
  snapshot.name = object.name;
  object[SNAPSHOT] = snapshot;
  runtime.snapshots.set(object, snapshot);
  snapshot.index = runtime.trackedSnapshots.length;
  push(runtime.trackedSnapshots, snapshot);
  return snapshot;
}

export function allocateSlot(runtime) {
  let slot;
  if (runtime.freeSlots.length > 0) {
    slot = runtime.freeSlots.pop();
  } else {
    slot = runtime.slotCount;
    runtime.slotCount += 1;
    const needed = (slot + 1) * 10;
    if (needed > runtime.trs.length) {
      const grown = new Float64Array(Math.max(runtime.trs.length * 2, needed));
      grown.set(runtime.trs);
      runtime.trs = grown;
    }
    const matrixNeeded = (slot + 1) * 16;
    if (matrixNeeded > runtime.mtx.length) {
      const grownMatrix = new Float64Array(Math.max(runtime.mtx.length * 2, matrixNeeded));
      grownMatrix.set(runtime.mtx);
      runtime.mtx = grownMatrix;
    }
  }
  // NaN never equals anything, so a fresh slot always reads as changed.
  const base = slot * 10;
  for (let i = 0; i < 10; i += 1) runtime.trs[base + i] = NaN;
  const matrixBase = slot * 16;
  for (let i = 0; i < 16; i += 1) runtime.mtx[matrixBase + i] = NaN;
  return slot;
}

/**
 * Records that this object is one of the live users of `uuid`. Moving to a
 * different geometry releases the previous one first.
 */
export function noteGeometryUse(runtime, snapshot, uuid) {
  const previous = snapshot.geometryUuid;
  if (previous === uuid) return;
  if (previous !== null) runtime.dropGeometryUser(previous);
  snapshot.geometryUuid = uuid;
  const users = runtime.geometryUsers.get(uuid);
  runtime.geometryUsers.set(uuid, users === undefined ? 1 : users + 1);
}

/** Drops one user of `uuid`, forgetting the delivery when the last one goes. */
export function dropGeometryUser(runtime, uuid) {
  const users = runtime.geometryUsers.get(uuid);
  if (users === undefined) return;
  if (users > 1) {
    runtime.geometryUsers.set(uuid, users - 1);
    return;
  }
  runtime.geometryUsers.delete(uuid);
  runtime.sentGeometry.delete(uuid);
}

export function releaseSnapshot(runtime, object, snapshot) {
  if (snapshot.geometryUuid !== null) {
    runtime.dropGeometryUser(snapshot.geometryUuid);
    snapshot.geometryUuid = null;
  }
  runtime.snapshots.delete(object);
  object[SNAPSHOT] = undefined;
  push(runtime.freeSlots, snapshot.slot);
  if (snapshot.parentId === -1) runtime.detachedCount -= 1;
  // Swap-remove keeps the tracked array compact without shifting.
  const tracked = runtime.trackedSnapshots;
  const last = tracked.pop();
  if (last !== snapshot) {
    tracked[snapshot.index] = last;
    last.index = snapshot.index;
  }
}
