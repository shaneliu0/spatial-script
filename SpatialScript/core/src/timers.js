// Frame-driven timers (SPEC 3.13). setTimeout / setInterval /
// requestAnimationFrame are installed as globals and advance with tick(), so a
// script behaves the same in JavaScriptCore and in the browser.
//
// Due times are bucketed by a fixed slice of wall time, and the pending bucket
// indices sit in a tiny min-heap. A frame therefore touches only the timers
// that are actually due, sorts nothing, and allocates nothing per timer
// (PERF-09). Registrations and per-tick callback counts are capped so a
// self-spawning callback cannot wedge the host (ROBUST-02).

import { MAX_LIVE_TIMERS, MAX_LIVE_FRAME_CALLBACKS, MAX_CALLBACKS_PER_TICK } from "./limits.js";
import { push } from "./builtins.js";

// One bucket is a quarter of a 60 Hz frame, so a frame usually drains one or
// two buckets however many timers they hold.
const BUCKET_SECONDS = 1 / 240;

export class TimerQueue {
  constructor(onLimit) {
    this.onLimit = typeof onLimit === "function" ? onLimit : () => {};
    this.reset();
  }

  reset() {
    this.timers = new Map();
    /** bucket index -> array of timer ids due in that slice. */
    this.buckets = new Map();
    /** Min-heap of the bucket indices that hold something. */
    this.pending = new Int32Array(64);
    this.pendingSize = 0;
    this.nextTimerId = 1;
    this.frameCallbacks = new Map();
    this.nextFrameId = 1;
    this.elapsed = 0;
  }

  setTimeout(callback, delayMs = 0, ...args) {
    return this.#schedule(callback, delayMs, args, false);
  }

  setInterval(callback, delayMs = 0, ...args) {
    return this.#schedule(callback, delayMs, args, true);
  }

  #schedule(callback, delayMs, args, repeating) {
    if (typeof callback !== "function") throw new TypeError("Timer callback must be a function");
    if (this.timers.size >= MAX_LIVE_TIMERS) {
      this.onLimit(
        "timer-limit",
        `More than ${MAX_LIVE_TIMERS} live timers; the registration was dropped`,
      );
      return 0;
    }
    const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs / 1000 : 0;
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    const timer = {
      id,
      callback,
      args,
      repeating,
      interval: delay,
      dueAt: this.elapsed + delay,
    };
    this.timers.set(id, timer);
    this.#bucket(timer);
    return id;
  }

  clearTimeout(id) {
    // The bucket entry is left behind and skipped when it surfaces: removing it
    // would be a linear scan, and a stale id is one map lookup.
    this.timers.delete(id);
  }

  clearInterval(id) {
    this.timers.delete(id);
  }

  requestAnimationFrame(callback) {
    if (typeof callback !== "function") throw new TypeError("requestAnimationFrame callback must be a function");
    if (this.frameCallbacks.size >= MAX_LIVE_FRAME_CALLBACKS) {
      this.onLimit(
        "frame-callback-limit",
        `More than ${MAX_LIVE_FRAME_CALLBACKS} live animation-frame callbacks; the registration was dropped`,
      );
      return 0;
    }
    const id = this.nextFrameId;
    this.nextFrameId += 1;
    this.frameCallbacks.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id) {
    this.frameCallbacks.delete(id);
  }

  // --------------------------------------------------------------- buckets

  #bucket(timer) {
    // Ceil, so a timer never fires before its due time.
    const index = Math.ceil(timer.dueAt / BUCKET_SECONDS);
    const bucket = this.buckets.get(index);
    if (bucket === undefined) {
      this.buckets.set(index, [timer.id]);
      this.#pendingPush(index);
    } else {
      push(bucket, timer.id);
    }
  }

  #pendingPush(index) {
    if (this.pendingSize === this.pending.length) {
      const grown = new Int32Array(this.pendingSize * 2);
      grown.set(this.pending);
      this.pending = grown;
    }
    const heap = this.pending;
    let at = this.pendingSize;
    this.pendingSize += 1;
    heap[at] = index;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (heap[parent] <= heap[at]) break;
      const swap = heap[parent];
      heap[parent] = heap[at];
      heap[at] = swap;
      at = parent;
    }
  }

  #pendingPop() {
    const heap = this.pending;
    const top = heap[0];
    this.pendingSize -= 1;
    const size = this.pendingSize;
    if (size > 0) {
      heap[0] = heap[size];
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let smallest = at;
        if (left < size && heap[left] < heap[smallest]) smallest = left;
        if (right < size && heap[right] < heap[smallest]) smallest = right;
        if (smallest === at) break;
        const swap = heap[smallest];
        heap[smallest] = heap[at];
        heap[at] = swap;
        at = smallest;
      }
    }
    return top;
  }

  /**
   * Runs every timer due at `elapsed`, then the pending animation-frame
   * callbacks. At most MAX_CALLBACKS_PER_TICK run in one tick; the rest are
   * left for the next one and reported once.
   */
  run(elapsed, reportError) {
    this.elapsed = elapsed;
    let budget = MAX_CALLBACKS_PER_TICK;
    const now = Math.floor(elapsed / BUCKET_SECONDS);

    while (this.pendingSize > 0 && this.pending[0] <= now && budget > 0) {
      const index = this.#pendingPop();
      const bucket = this.buckets.get(index);
      this.buckets.delete(index);
      if (bucket === undefined) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        const timer = this.timers.get(bucket[i]);
        // A cleared timer leaves a stale id behind; skip it.
        if (timer === undefined) continue;
        if (budget <= 0) {
          // Out of budget mid-bucket: the rest keep their place for next frame.
          this.#bucket(timer);
          continue;
        }
        budget -= 1;
        if (timer.repeating) {
          timer.dueAt = elapsed + timer.interval;
          this.#bucket(timer);
        } else {
          this.timers.delete(timer.id);
        }
        try {
          timer.callback(...timer.args);
        } catch (error) {
          reportError(error);
        }
      }
    }

    if (this.frameCallbacks.size > 0 && budget > 0) {
      // Callbacks registered during the drain land in the fresh map and run on
      // the next tick, which is what keeps a rAF storm from spinning forever.
      const pending = this.frameCallbacks;
      this.frameCallbacks = new Map();
      const timestamp = elapsed * 1000;
      for (const callback of pending.values()) {
        if (budget <= 0) {
          // Put the rest back for the next tick rather than dropping them.
          this.frameCallbacks.set(this.nextFrameId, callback);
          this.nextFrameId += 1;
          continue;
        }
        budget -= 1;
        try {
          callback(timestamp);
        } catch (error) {
          reportError(error);
        }
      }
    }

    if (budget <= 0) {
      this.onLimit(
        "callback-budget",
        `More than ${MAX_CALLBACKS_PER_TICK} timer and animation-frame callbacks came due in one ` +
          "frame; the rest were deferred to the next frame",
      );
    }
  }
}
