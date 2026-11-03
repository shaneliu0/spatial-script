// The bidirectional channel with the embedding app (SPEC 14.10) and the
// consumer-performed fetches of 14.11.
//
// Everything here is request/response over the command stream: the core never
// touches a network or a native function itself, it only carries intent out
// and resolves promises when the answer is dispatched back.

import { SpatialUnsupportedError } from "../util/errors.js";
import { jsonSafe } from "../util/sanitize.js";
import { push } from "../util/builtins.js";
import { MAX_LISTENERS_PER_EVENT, MAX_PENDING_HOST_CALLS } from "../util/limits.js";

/** A name a host event or function may carry. */
function checkName(name, what) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(`${what} expects a non-empty name`);
  }
  return name;
}

export class HostChannel {
  constructor(runtime) {
    this._runtime = runtime;
    this._handlers = new Map();
    this._functions = [];
    this._pending = new Map();
    this._nextCallId = 1;
  }

  /** The functions the app registered, as `Module.function` names. */
  get functions() {
    return this._functions.slice();
  }

  on(name, handler) {
    checkName(name, "Spatial.host.on");
    if (typeof handler !== "function") throw new TypeError("Spatial.host.on expects a function");
    let list = this._handlers.get(name);
    if (list === undefined) {
      list = [];
      this._handlers.set(name, list);
    }
    if (list.length >= MAX_LISTENERS_PER_EVENT) {
      this._runtime.warnOnce(
        `host-listener-limit:${name}`,
        `More than ${MAX_LISTENERS_PER_EVENT} handlers for the host event "${name}"; the registration was dropped`,
      );
      return handler;
    }
    push(list, handler);
    return handler;
  }

  off(name, handler) {
    const list = this._handlers.get(name);
    if (list === undefined) return;
    if (handler === undefined) {
      this._handlers.delete(name);
      return;
    }
    const index = list.indexOf(handler);
    if (index !== -1) list.splice(index, 1);
    if (list.length === 0) this._handlers.delete(name);
  }

  /** Script to host. The payload is copied into JSON before it leaves. */
  send(name, payload) {
    checkName(name, "Spatial.host.send");
    this._runtime.queueCommand(["hostEvent", 0, name, jsonSafe(payload === undefined ? null : payload)]);
    return this;
  }

  /**
   * Script to host, with an answer. An unknown function rejects immediately
   * rather than waiting for a host that will never reply.
   */
  call(name, args) {
    let checked;
    try {
      checked = checkName(name, "Spatial.host.call");
    } catch (error) {
      return Promise.reject(error);
    }
    if (this._functions.indexOf(checked) === -1) {
      return Promise.reject(
        new SpatialUnsupportedError(
          `The host function "${checked}" is not registered; Spatial.host.functions lists what is`,
          "host-function",
          null,
        ),
      );
    }
    if (this._pending.size >= MAX_PENDING_HOST_CALLS) {
      return Promise.reject(
        new SpatialUnsupportedError(
          `More than ${MAX_PENDING_HOST_CALLS} host calls are waiting for an answer; the call was refused`,
          "host-function",
          null,
        ),
      );
    }
    const callId = this._nextCallId;
    this._nextCallId += 1;
    const promise = new Promise((resolve, reject) => {
      this._pending.set(callId, { resolve, reject, name: checked });
    });
    this._runtime.queueCommand(["hostCall", callId, checked, jsonSafe(args === undefined ? null : args)]);
    return promise;
  }

  /** Host to script: `__spatial.hostEvent(name, payload)`. */
  deliver(name, payload) {
    const list = this._handlers.get(name);
    if (list === undefined || list.length === 0) return;
    const handlers = list.slice();
    for (let i = 0; i < handlers.length; i += 1) {
      try {
        handlers[i](payload);
      } catch (error) {
        this._runtime.reportError(error);
      }
    }
  }

  /** Host to script: `dispatch("hostResult", callId, { value } | { error })`. */
  settle(callId, payload) {
    const entry = this._pending.get(callId);
    if (entry === undefined) return;
    this._pending.delete(callId);
    if (payload && payload.error !== undefined && payload.error !== null) {
      const message = typeof payload.error === "string" ? payload.error : "the host function failed";
      entry.reject(new SpatialUnsupportedError(`${entry.name}: ${message}`, "host-function", null));
      return;
    }
    entry.resolve(payload === null || payload === undefined ? null : payload.value);
  }

  /**
   * A script reload clears handlers and in-flight calls but keeps what the app
   * registered: the functions belong to the app, not to the script.
   */
  reset() {
    this._handlers.clear();
    this.clearPending("the script was replaced");
  }

  /** The app declares what it registered, at load or later. */
  setFunctions(names) {
    const list = [];
    if (Array.isArray(names)) {
      for (let i = 0; i < names.length; i += 1) {
        if (typeof names[i] === "string" && names[i].length > 0) push(list, names[i]);
      }
    }
    this._functions = list;
  }

  /** Rejects everything still waiting; used by dispose and reload. */
  clearPending(reason) {
    for (const entry of this._pending.values()) {
      entry.reject(new SpatialUnsupportedError(`${entry.name}: ${reason}`, "host-function", null));
    }
    this._pending.clear();
  }

  get pendingCount() {
    return this._pending.size;
  }
}

/**
 * `Spatial.fetchText` / `Spatial.fetchJSON`: the consumer performs the request
 * and answers with `dispatch("fetchResult", requestId, …)`.
 */
export class FetchChannel {
  constructor(runtime) {
    this._runtime = runtime;
    this._pending = new Map();
    this._nextId = 1;
  }

  request(url, kind) {
    if (typeof url !== "string" || url.length === 0) {
      return Promise.reject(new TypeError(`Spatial.fetch${kind === "json" ? "JSON" : "Text"} expects a url`));
    }
    const resolved = this._runtime.resolveUrl(url);
    if (resolved === null) {
      return Promise.reject(
        new SpatialUnsupportedError(`The url "${url}" was refused`, "fetch", null),
      );
    }
    if (this._pending.size >= MAX_PENDING_HOST_CALLS) {
      return Promise.reject(
        new SpatialUnsupportedError(
          `More than ${MAX_PENDING_HOST_CALLS} fetches are waiting for an answer; the request was refused`,
          "fetch",
          null,
        ),
      );
    }
    const requestId = this._nextId;
    this._nextId += 1;
    const promise = new Promise((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject, url: resolved, kind });
    });
    this._runtime.queueCommand(["fetch", requestId, { url: resolved, kind }]);
    return promise;
  }

  settle(requestId, payload) {
    const entry = this._pending.get(requestId);
    if (entry === undefined) return;
    this._pending.delete(requestId);
    if (payload && payload.error !== undefined && payload.error !== null) {
      const message = typeof payload.error === "string" ? payload.error : "the request failed";
      entry.reject(new SpatialUnsupportedError(`${entry.url}: ${message}`, "fetch", null));
      return;
    }
    if (entry.kind === "json") {
      if (payload && payload.json !== undefined) {
        entry.resolve(payload.json);
        return;
      }
      // A host that answers with text for a JSON request still works.
      const text = payload === null || payload === undefined ? "" : payload.text;
      try {
        entry.resolve(JSON.parse(typeof text === "string" ? text : ""));
      } catch (error) {
        entry.reject(new SpatialUnsupportedError(`${entry.url}: the response was not JSON`, "fetch", null));
      }
      return;
    }
    const text = payload === null || payload === undefined ? null : payload.text;
    entry.resolve(typeof text === "string" ? text : "");
  }

  clearPending(reason) {
    for (const entry of this._pending.values()) {
      entry.reject(new SpatialUnsupportedError(`${entry.url}: ${reason}`, "fetch", null));
    }
    this._pending.clear();
  }

  reset() {
    this.clearPending("the script was replaced");
  }

  get pendingCount() {
    return this._pending.size;
  }
}
