// The log, warning and error channel (SPEC 3.13).
//
// Everything a script can produce without bound is capped here: message
// length, messages per frame, and the retained warning and error lists.

import { cleanMessage, extractLocation } from "../errors.js";
import {
  MAX_LOG_MESSAGE,
  MAX_LOGS_PER_FRAME,
  MAX_RECORDED_WARNINGS,
  MAX_RECORDED_ERRORS,
} from "../limits.js";
import { push, cut, safeString, safeStringify } from "../builtins.js";
import { labelFor } from "../sanitize.js";

export function log(runtime, level, args) {
    // Budgeted per frame: a noisy loop pays for one summary line, not for a
    // command per call across the engine boundary (PERF-10).
    if (runtime.logQueue.length >= MAX_LOGS_PER_FRAME) {
      runtime.suppressedLogs += 1;
      return "";
    }
    let message = formatLogArguments(args);
    if (message.length > MAX_LOG_MESSAGE) {
      message = `${cut(message, MAX_LOG_MESSAGE)}… (truncated, ${message.length} characters)`;
    }
    push(runtime.logQueue, ["log", 0, level, message]);
    return message;
  }

export function warnOnce(runtime, key, message) {
    if (runtime.warned.has(key)) return;
    runtime.warned.add(key);
    runtime.recordWarning(message);
    if (runtime.logQueue.length < MAX_LOGS_PER_FRAME) push(runtime.logQueue, ["log", 0, "warn", message]);
    else runtime.suppressedLogs += 1;
  }

  /** Keeps the most recent errors and counts the rest, so a noisy script cannot grow without bound. */
export function recordError(runtime, message) {
    push(runtime.errors, message);
    if (runtime.errors.length > MAX_RECORDED_ERRORS) {
      runtime.errors.splice(0, runtime.errors.length - MAX_RECORDED_ERRORS);
      runtime.droppedErrors += 1;
    }
    // The throttle map is keyed by message text, which a script can vary.
    if (runtime.errorTimes.size > MAX_RECORDED_ERRORS * 4) runtime.errorTimes.clear();
  }

  /** Adds a line to dump().warnings, with a cap so a loop cannot exhaust memory. */
export function recordWarning(runtime, message) {
    if (runtime.warnings.length >= MAX_RECORDED_WARNINGS) return;
    push(runtime.warnings, message);
  }

  /** Records an error without the per-second throttle; the caller owns the once-only rule. */
export function reportOnce(runtime, error) {
    // Core-raised errors describe an object, not a source line, so no location.
    const message = describe(runtime, error, false);
    recordError(runtime, message);
    if (runtime.logQueue.length < MAX_LOGS_PER_FRAME) push(runtime.logQueue, ["log", 0, "error", message]);
    else runtime.suppressedLogs += 1;
    const native = globalThis.__spatialNative;
    if (native && typeof native.log === "function") native.log("error", message);
  }

  /**
   * Reports an error raised by script code. The message is the engine's own
   * one-line description plus the script location when the engine gives one;
   * it never contains frames from the core bundle.
   */
export function reportError(runtime, error) {
    const message = describe(runtime, error, true);
    // Throttle on a shape, not on the text: a message carrying a frame number
    // or a coordinate would otherwise never repeat and never be throttled.
    const key = throttleKey(message);
    const now = runtime.now();
    const previous = runtime.errorTimes.get(key);
    if (previous !== undefined && now - previous < 1000) return;
    runtime.errorTimes.set(key, now);
    recordError(runtime, message);
    if (runtime.logQueue.length < MAX_LOGS_PER_FRAME) push(runtime.logQueue, ["log", 0, "error", message]);
    else runtime.suppressedLogs += 1;
    const native = globalThis.__spatialNative;
    if (native && typeof native.log === "function") native.log("error", message);
  }

  /**
   * One clean line for the error channel. A location is only appended when the
   * engine reported one that falls inside the script, which keeps locations
   * from inside the core bundle out.
   */
export function describe(runtime, error, withLocation) {
    const message = cleanMessage(error);
    if (!withLocation) return message;
    const { line, column } = extractLocation(error, runtime.lineOffset);
    if (line === null || line < 1 || line > runtime.scriptLineCount) return message;
    return column === null ? `${message} (line ${line})` : `${message} (line ${line}, column ${column})`;
  }

  // ------------------------------------------------------------------- load


/** Digits and float literals collapse so "frame 12" and "frame 13" share a key. */
function throttleKey(message) {
  return cut(message.replace(/[0-9]+(\.[0-9]+)?/g, "#"), 80);
}

export function formatLogArguments(args) {
  const parts = [];
  for (const value of args) {
    if (typeof value === "string") {
      push(parts, value);
    } else if (value instanceof Error) {
      push(parts, `${safeString(value.name)}: ${safeString(value.message)}`);
    } else if (value && value.isObject3D === true) {
      push(parts, labelFor(value));
    } else if (value && typeof value === "object") {
      // Both stringifiers are guarded: a hostile toJSON or toString must not
      // turn console.log into a throwing call (ROBUST-08).
      const text = safeStringify(value);
      push(parts, text === "[unserializable]" ? safeString(value) : text);
    } else {
      push(parts, safeString(value));
    }
  }
  return parts.join(" ");
}
