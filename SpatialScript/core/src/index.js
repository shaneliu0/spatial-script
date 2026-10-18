// Entry point. Defines globalThis.__spatial with the SPEC section 7 surface.

import { Runtime } from "./runtime.js";
import { createNamespace } from "./namespace.js";
import { installGlobals } from "./host/globals.js";
import { setHost } from "./host/host.js";
import { SpatialLoadError, SpatialUnsupportedError } from "./util/errors.js";

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

  /**
   * `load(source, options)`; a hot reload that preserves state passes it as
   * `options.previousState` or as a third argument (SPEC 14.10).
   */
  load(source, options, extra) {
    installGlobals(runtime, namespace);
    const merged =
      extra === undefined || extra === null ? options : { ...(options || {}), ...extra };
    return runtime.load(source, merged);
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

  // ---------------------------------------------------------------- phase 2

  syncAudio(records) {
    runtime.syncAudio(records);
  },

  syncVideo(records) {
    runtime.syncVideo(records);
  },

  syncCharacter(records) {
    runtime.syncCharacter(records);
  },

  syncSkeleton(id, joints) {
    runtime.syncSkeleton(id, joints);
  },

  /** The view appeared or went away; ticks pause while inactive. */
  setActive(active) {
    runtime.setActive(active);
  },

  /** Host to script: delivers to `Spatial.host.on(name)` handlers. */
  hostEvent(name, payload) {
    runtime.hostEvent(name, payload);
  },

  /** The functions the app registered, as `Module.function` names. */
  setHostFunctions(names) {
    runtime.hostChannel.setFunctions(names);
  },

  /** `this.state` as JSON, for a reload that preserves it. */
  captureState() {
    return runtime.captureState();
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
