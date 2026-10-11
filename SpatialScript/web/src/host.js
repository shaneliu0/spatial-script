// The host channel and fetch bridge (SPEC 14.10). The page owns the registry;
// the consumer forwards `hostEvent`, `hostCall` and `fetch` to it and answers
// with `hostResult` and `fetchResult`.

/** How many undrained script-to-host events are kept. */
const MAX_OUTBOX = 1000;

export class HostBridge {
  /** @param {object} deps `dispatch`, `resolveUrl`, `warnOnce` */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, Function>} "Module.function" -> handler */
    this.functions = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    /** Events the script sent, drained by the page and the dev transport. */
    this.outbox = [];
    this.onFunctionsChanged = null;
  }

  /** `window.spatialHost.register(module, name, fn)`. */
  register(moduleName, name, fn) {
    if (typeof fn !== 'function') throw new TypeError('a host function must be a function');
    this.functions.set(`${moduleName}.${name}`, fn);
    if (this.onFunctionsChanged) this.onFunctionsChanged(this.names());
  }

  unregister(moduleName, name) {
    this.functions.delete(`${moduleName}.${name}`);
    if (this.onFunctionsChanged) this.onFunctionsChanged(this.names());
  }

  names() {
    return [...this.functions.keys()].sort();
  }

  /** `window.spatialHost.on(name, handler)` for events the script sends. */
  on(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
    return () => this.off(name, handler);
  }

  off(name, handler) {
    const set = this.listeners.get(name);
    if (set) set.delete(handler);
  }

  /** `hostEvent`: script to host. */
  emit(name, payload) {
    // P2-B-49: a script that sends events no host drains must not grow for ever.
    if (this.outbox.length >= MAX_OUTBOX) this.outbox.shift();
    this.outbox.push({ name, payload });
    const set = this.listeners.get(name);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        this.deps.warnOnce(`hostListener:${name}`, `a host listener for "${name}" threw: ${err.message}`);
      }
    }
  }

  drain() {
    const events = this.outbox;
    this.outbox = [];
    return events;
  }

  /** `hostCall`: the script awaits a registered native function. */
  async call(callId, name, args) {
    const fn = this.functions.get(name);
    if (!fn) {
      this.deps.dispatch('hostResult', callId, { error: `no host function named "${name}"` });
      return;
    }
    try {
      const value = await fn(args);
      this.deps.dispatch('hostResult', callId, { value: value === undefined ? null : value });
    } catch (err) {
      this.deps.dispatch('hostResult', callId, { error: err && err.message ? err.message : String(err) });
    }
  }

  /** `fetch`: the consumer performs it under the URL rules of SPEC 3.5. */
  async fetch(requestId, spec) {
    const url = this.deps.resolveUrl(spec && spec.url);
    if (!url) {
      this.deps.dispatch('fetchResult', requestId, {
        error: `"${spec && spec.url}" resolves outside the asset root`,
      });
      return;
    }
    if (typeof fetch !== 'function') {
      this.deps.dispatch('fetchResult', requestId, { error: 'this consumer cannot fetch' });
      return;
    }
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      if (spec.kind === 'json') {
        this.deps.dispatch('fetchResult', requestId, { json: await response.json() });
      } else {
        this.deps.dispatch('fetchResult', requestId, { text: await response.text() });
      }
    } catch (err) {
      this.deps.dispatch('fetchResult', requestId, { error: err && err.message ? err.message : String(err) });
    }
  }

  reset() {
    this.outbox.length = 0;
  }
}
