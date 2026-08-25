// Entry point. Defines globalThis.__spatial with the SPEC section 7 surface.

import { Runtime } from "./runtime.js";
import { createNamespace } from "./namespace.js";
import { installGlobals } from "./globals.js";
import { setHost } from "./host.js";
import { SpatialLoadError, SpatialUnsupportedError } from "./errors.js";

const runtime = new Runtime();
setHost(runtime);

const namespace = createNamespace(runtime);
runtime.namespace = namespace;

const api = {
  get version() {
    return runtime.version;
  },
  get Spatial() {
    return namespace;
  },
  get runtime() {
    return runtime;
  },
  SpatialLoadError,
  SpatialUnsupportedError,

  installGlobals() {
    installGlobals(runtime, namespace);
  },

  load(source, options) {
    installGlobals(runtime, namespace);
    return runtime.load(source, options);
  },

  /**
   * Resolves once an async script body has settled and the auto-mount check
   * has run. A body without top-level await is already finished when load()
   * returns, so this resolves immediately.
   */
  whenLoaded() {
    return runtime.loadPromise;
  },

  tick(deltaTime) {
    return runtime.tick(deltaTime);
  },

  sync(records) {
    runtime.sync(records);
  },

  syncBodies(records) {
    runtime.syncBodies(records);
  },

  dispatch(type, id, payload) {
    runtime.dispatch(type, id, payload);
  },

  setInput(state) {
    runtime.setInput(state);
  },

  dump(options) {
    return runtime.dump(options);
  },

  dispose() {
    return runtime.dispose();
  },

  objectForId(id) {
    return runtime.objectForId(id);
  },

  idForObject(object) {
    return runtime.idForObject(object);
  },
};

globalThis.__spatial = api;
