// The consumer channels while the scene is inactive (SPEC 14.10).
//
// `tick` drains nothing while the view is away, so the backlog is bounded
// here instead: the latest sync record per object is kept and the event queue
// is capped, rather than growing for as long as the app is backgrounded and
// then flooding one frame (P2-B-05).

import { push } from "../builtins.js";
import { MAX_INACTIVE_SYNC_OBJECTS } from "../limits.js";

/** Which pending list each sync channel drains into. */
const INACTIVE_CHANNELS = {
  sync: "pendingSync",
  syncBodies: "pendingBodySync",
  syncAudio: "pendingAudioSync",
  syncVideo: "pendingVideoSync",
  syncCharacter: "pendingCharacterSync",
};

/**
 * A sync batch from the consumer. While the scene is inactive the frame loop
 * is not draining anything, so the backlog is collapsed to the latest record
 * per object instead of growing without bound (SPEC 14.10, P2-B-05).
 */
export function acceptSync(runtime, channel, pending, records, stride) {
  if (!records || !records.length) return;
  if (runtime.active !== false) {
    push(pending, records);
    return;
  }
  let latest = runtime.inactiveSync.get(channel);
  if (latest === undefined) {
    latest = { stride, byId: new Map() };
    runtime.inactiveSync.set(channel, latest);
  }
  for (let i = 0; i + stride <= records.length; i += stride) {
    const id = records[i];
    let slot = latest.byId.get(id);
    if (slot === undefined) {
      if (latest.byId.size >= MAX_INACTIVE_SYNC_OBJECTS) {
        runtime.warnOnce(
          `inactive-sync:${channel}`,
          `More than ${MAX_INACTIVE_SYNC_OBJECTS} objects were synced while the scene was ` +
            `inactive; further ${channel} records were dropped`,
        );
        break;
      }
      slot = new Float64Array(stride);
      latest.byId.set(id, slot);
    }
    for (let k = 0; k < stride; k += 1) slot[k] = records[i + k];
  }
}

/** Rebuilds one batch per channel from what arrived while inactive. */
export function drainInactiveSync(runtime) {
  if (runtime.inactiveSync.size === 0) return;
  for (const [channel, latest] of runtime.inactiveSync) {
    const stride = latest.stride;
    const flat = new Float32Array(latest.byId.size * stride);
    let at = 0;
    for (const slot of latest.byId.values()) {
      for (let k = 0; k < stride; k += 1) flat[at + k] = slot[k];
      at += stride;
    }
    if (flat.length === 0) continue;
    push(runtime[INACTIVE_CHANNELS[channel]], flat);
  }
  runtime.inactiveSync.clear();
}
