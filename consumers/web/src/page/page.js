// Browser entry point: wires the SpatialScript core to the three.js consumer and
// exposes the small window API the Playwright harness drives.

import RAPIER from '@dimforge/rapier3d-compat';
import { SpatialConsumer, DEFAULT_CAMERA, CAMERA_PRESETS } from '../consumer/consumer.js';

// SPEC 14.14: true only where this consumer implements the feature with effect.
const CAPABILITIES = {
  hands: false,
  anchors: false,
  portals: true,
  particles: true,
  manipulation: true,
  hoverEffect: false,
  shadows: true,
  audio: true,
  video: true,
  camera: true,
  characterController: true,
  forceFields: true,
  skeleton: true,
  blendShapes: true,
  // The graph itself is RealityKit only; the web renders the fallback.
  shaderGraph: false,
  sceneUnderstanding: false,
  controllers: true,
  hostFunctions: true,
  accessibility: true,
};

// The core installs its own frame-driven requestAnimationFrame over the global
// one (SPEC 3.13), so the render loop keeps a reference to the browser's.
const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const nativeConsole = {};
for (const level of ['log', 'warn', 'error', 'info', 'debug']) nativeConsole[level] = console[level].bind(console);
const pageConsole = console;

const params = new URLSearchParams(location.search);
const state = {
  consumer: null,
  core: null,
  coreSource: null,
  mode: params.get('mode') === 'manual' ? 'manual' : 'auto',
  loaded: false,
  scriptPath: params.get('script') || null,
  hostFunctions: [],
  scriptRoot: '/',
  rafHandle: 0,
  lastTime: 0,
  tornDown: false,
};

// PERF-10: a script that logs every frame must not retain everything it ever
// printed. Both lists are bounded and what falls off is counted.
const MAX_CONSOLE_LINES = 5000;
const MAX_CONSOLE_LINES_PER_FRAME = 200;
window.spatialConsole = [];
window.spatialErrors = [];
window.spatialConsoleDropped = 0;
window.spatialState = state;
let consoleLinesThisFrame = 0;

function record(level, args) {
  consoleLinesThisFrame += 1;
  if (consoleLinesThisFrame > MAX_CONSOLE_LINES_PER_FRAME) {
    window.spatialConsoleDropped += 1;
    if (consoleLinesThisFrame === MAX_CONSOLE_LINES_PER_FRAME + 1) {
      push('warn', `... more console lines this frame were suppressed after ${MAX_CONSOLE_LINES_PER_FRAME}`);
    }
    return;
  }
  push(level, args.map((a) => (typeof a === 'string' ? a : safeString(a))).join(' '));
}

function push(level, message) {
  if (window.spatialConsole.length >= MAX_CONSOLE_LINES) {
    window.spatialConsole.shift();
    window.spatialConsoleDropped += 1;
  }
  window.spatialConsole.push({ level, message });
  if (level !== 'error') return;
  if (window.spatialErrors.length >= MAX_CONSOLE_LINES) window.spatialErrors.shift();
  window.spatialErrors.push(message);
}

function safeString(value) {
  if (value instanceof Error) return `${value.message}\n${value.stack || ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Everything the page and the consumer print is recorded for the harness.
for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
  const original = nativeConsole[level];
  nativeConsole[level] = (...args) => {
    record(level, args);
    original(...args);
  };
  pageConsole[level] = nativeConsole[level];
}
// FA-17: the page is going away, so the consumer's renderer, audio graph,
// listeners and DOM go with it. `pagehide` fires where `unload` does not (bfcache).
window.addEventListener('pagehide', () => spatialTeardown());
window.addEventListener('error', (e) => record('error', [e.message]));
window.addEventListener('unhandledrejection', (e) => record('error', [`unhandled rejection: ${safeString(e.reason)}`]));

/** `?preset=mac` selects the macOS host's RealityView camera; explicit params win. */
function cameraPreset() {
  const name = params.get('preset');
  return (name && CAMERA_PRESETS[name]) || {};
}

function parseCamera(preset) {
  const raw = params.get('camera');
  if (!raw) return preset.camera || DEFAULT_CAMERA;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return preset.camera || DEFAULT_CAMERA;
  return parts;
}

function loadScriptTag(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(tag);
  });
}

/** Loads the shared core bundle. Missing or malformed, this fails loudly. */
async function loadCore() {
  await loadScriptTag('/core/dist/spatial-core.js');
  if (!globalThis.__spatial) {
    throw new Error('/core/dist/spatial-core.js loaded but did not define globalThis.__spatial');
  }
  state.coreSource = 'core/dist/spatial-core.js';
  return globalThis.__spatial;
}

async function boot() {
  const canvas = document.getElementById('view');
  // The capture size must equal the canvas size and the camera aspect, so a
  // headless run hides the editor panel and takes the full viewport.
  if (params.get('ui') === 'off') document.body.classList.add('no-ui');
  const preset = cameraPreset();
  const width = Number(params.get('w')) || preset.width || canvas.clientWidth || 800;
  const height = Number(params.get('h')) || preset.height || canvas.clientHeight || 600;
  canvas.width = width;
  canvas.height = height;
  // Pin the CSS box to the backing store so nothing is stretched.
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  await RAPIER.init();

  const consumer = new SpatialConsumer({
    canvas,
    camera: parseCamera(preset),
    fov: preset.fov,
    background: preset.background,
    rapier: RAPIER,
    // SPEC 3.5: one shared asset root for every backend.
    assetRoot: '/assets',
    coreAssetRoot: 'assets',
    scriptRoot: state.scriptRoot,
    console: nativeConsole,
  });
  await consumer.init();
  state.consumer = consumer;
  window.spatialConsumer = consumer;

  // SPEC section 6: these must exist before the core evaluates a script.
  globalThis.__spatialNative = {
    raycast: (ox, oy, oz, dx, dy, dz, maxDistance, recursive) =>
      consumer.raycast(ox, oy, oz, dx, dy, dz, maxDistance, recursive),
    // SPEC 14.3: a world ray for a view pixel.
    rayFromPoint: (x, y) => consumer.rayFromPoint(x, y),
    log: (level, message) => consumer.handleLog(level, message),
    now: () => performance.now(),
  };

  // SPEC 14.10: the bidirectional host channel the embedding page owns.
  // The macOS host registers this demo function in DEBUG builds, so the page
  // registers the same one and both backends report the same `hostFunctions`.
  // An embedding page can replace or remove it with `window.spatialHost.register`
  // or `unregister` before a script is loaded.
  // `?demoHost=off` starts with an empty registry, which is what the conformance
  // runner wants: a case declares the functions its app registered.
  if (params.get('demoHost') !== 'off') {
    consumer.host.register('Preferences', 'read', (args) => (
      args && args.key === 'lampHue' ? { hue: 0.58 } : null
    ));
  }
  consumer.host.onFunctionsChanged = (names) => {
    if (state.core && typeof state.core.setHostFunctions === 'function') state.core.setHostFunctions(names);
  };
  window.spatialHost = {
    send: (name, payload) => {
      if (state.core && typeof state.core.hostEvent === 'function') state.core.hostEvent(name, payload);
    },
    on: (name, handler) => consumer.host.on(name, handler),
    off: (name, handler) => consumer.host.off(name, handler),
    register: (moduleName, name, fn) => consumer.host.register(moduleName, name, fn),
    unregister: (moduleName, name) => consumer.host.unregister(moduleName, name),
    functions: () => consumer.host.names(),
    drain: () => consumer.host.drain(),
  };

  // SPEC 14.10: ticks pause while the page is hidden.
  document.addEventListener('visibilitychange', () => {
    consumer.setActive(document.visibilityState !== 'hidden');
  });

  state.core = await loadCore();
  consumer.setCore(state.core);

  // The embedding app declares what it registered before the script loads, so
  // `Spatial.host.call` knows which names exist (SPEC 14.10).
  const declared = params.get('hostFunctions');
  if (declared) state.hostFunctions = declared.split(',').filter(Boolean);

  if (state.scriptPath) {
    const source = await fetchScript(state.scriptPath);
    spatialLoad(source);
  }
  if (state.mode === 'auto') {
    startLoop();
    // Keep the projection matched to the element while the window is resized.
    window.addEventListener('resize', () => {
      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      if (width > 0 && height > 0) consumer.resize(width, height);
    });
  }
  window.spatialBooted = true;
}

async function fetchScript(path) {
  const url = path.startsWith('/') ? path : `/${path}`;
  state.scriptRoot = url.slice(0, url.lastIndexOf('/'));
  if (state.consumer) state.consumer.options.scriptRoot = state.scriptRoot;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to fetch script ${url}: ${response.status}`);
  return response.text();
}

/** Loads (or replaces) the running script. Returns `{ ok, error }`. */
function loadOptions(consumer) {
  return {
    backend: 'three',
    platform: 'web',
    capabilities: CAPABILITIES,
    // SPEC 3.5: the core joins relative urls onto this root and reports the
    // result in the dump, so it is the contract's root, not the page's path.
    // The consumer resolves the same url again for the network.
    assetRoot: 'assets',
    hostFunctions: [...new Set([...(state.hostFunctions || []), ...consumer.host.names()])],
  };
}

/**
 * SPEC 14.10: a hot reload on the same host. The outgoing script's `this.state`
 * is captured and handed to the new script's `scriptChanged`; without
 * `preserveState` the hook is not called at all.
 */
function spatialReload(source, preserveState = true) {
  const { core, consumer } = state;
  if (!core || !consumer) return { ok: false, error: { message: 'consumer is not booted yet' } };
  // Called with no source, a reload means "this script again".
  if (source === undefined || source === null) source = state.lastSource;
  window.spatialLoadError = null;
  let previousState;
  if (preserveState && state.loaded && typeof core.captureState === 'function') {
    try {
      previousState = core.captureState();
    } catch (err) {
      console.warn(`captureState failed: ${err.message}`);
    }
  }
  // FA-17: the outgoing script is torn down before the incoming one loads, so
  // its `willRemove` runs and its scene-level state is retracted, exactly as a
  // plain load does. The core's load then resets its own scene and the consumer
  // clears the one it drew.
  if (state.loaded) {
    try {
      consumer.apply(core.dispose() || []);
    } catch (err) {
      console.warn(`dispose before reload failed: ${err.message}`);
    }
  }
  consumer.reset();
  const options = loadOptions(consumer);
  if (preserveState) options.previousState = previousState;
  try {
    core.load(source, options);
    state.loaded = true;
    state.lastSource = source;
    return { ok: true, error: null };
  } catch (err) {
    state.loaded = false;
    const error = {
      name: err.name || 'Error',
      message: err.message,
      line: err.line ?? null,
      column: err.column ?? null,
    };
    window.spatialLoadError = error;
    record('error', [`load error: ${error.message}`]);
    return { ok: false, error };
  }
}

function spatialLoad(source, options = {}) {
  const { core, consumer } = state;
  if (!core || !consumer) return { ok: false, error: { message: 'consumer is not booted yet' } };
  if (state.loaded && options.preserveState) return spatialReload(source, true);
  window.spatialLoadError = null;
  if (state.loaded) {
    try {
      consumer.apply(core.dispose() || []);
    } catch (err) {
      console.warn(`core.dispose failed: ${err.message}`);
    }
    consumer.reset();
  }
  try {
    core.load(source, loadOptions(consumer));
    state.loaded = true;
    state.lastSource = source;
    return { ok: true, error: null };
  } catch (err) {
    state.loaded = false;
    const error = {
      name: err.name || 'Error',
      message: err.message,
      line: err.line ?? null,
      column: err.column ?? null,
    };
    window.spatialLoadError = error;
    record('error', [`load error: ${error.message}`]);
    return { ok: false, error };
  }
}

function spatialTick(dt = 1 / 60) {
  const { consumer } = state;
  if (!consumer || !state.loaded) return { ok: false, errors: ['nothing loaded'] };
  consoleLinesThisFrame = 0;
  try {
    consumer.tick(dt);
    consumer.render();
    return { ok: true, errors: [] };
  } catch (err) {
    record('error', [`tick error: ${err.message}`]);
    return { ok: false, errors: [err.message] };
  }
}

function startLoop() {
  stopLoop();
  state.lastTime = performance.now();
  const frame = (now) => {
    state.rafHandle = nativeRequestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - state.lastTime) / 1000);
    state.lastTime = now;
    if (state.loaded) spatialTick(dt);
  };
  state.rafHandle = nativeRequestAnimationFrame(frame);
}

function stopLoop() {
  if (state.rafHandle) nativeCancelAnimationFrame(state.rafHandle);
  state.rafHandle = 0;
}

function resolveId(target) {
  if (typeof target === 'number') return target;
  const dump = state.core.dump();
  const found = (dump.objects || []).find((o) => o.name === target);
  return found ? found.id : undefined;
}

/**
 * Synthesises the events the consumer would produce, mirroring `Spatial.inject`.
 * Uses the core's own inject entry point when the bundle exposes one.
 */
function spatialInject(type, target, options = {}) {
  const { core, consumer } = state;
  // The core's own Spatial.inject is always present, so the web runner
  // synthesises exactly the events the node and Swift runners do (SPEC 3.8).
  const inject = core && core.Spatial && core.Spatial.inject;
  if (type === 'controller' && inject && typeof inject.controller === 'function') {
    inject.controller(target);
    return true;
  }
  if (!inject || typeof inject[type] !== 'function') {
    if (type === 'key' && consumer) {
      consumer.input.injectKey(target, options.down !== false);
      return true;
    }
    record('error', [`inject: the core exposes no "${type}" injector`]);
    return false;
  }
  const Vector3 = core.Spatial.Vector3;
  try {
    if (type === 'tap') inject.tap(target, options.point ? new Vector3(...options.point) : undefined);
    else if (type === 'hover') inject.hover(target, options.entering !== false);
    else if (type === 'drag') inject.drag(target, new Vector3(...(options.translation || [0, 0, 0])), { steps: options.steps || 1 });
    else if (type === 'key') inject.key(target, options.down !== false);
    else throw new Error(`unknown inject type "${type}"`);
    return true;
  } catch (err) {
    record('error', [`inject failed: ${err.message}`]);
    return false;
  }
}

/** The three.js scene as the parity gate reads it (mirrors Swift nativeDump). */
function spatialNativeDump() {
  return state.consumer ? state.consumer.nativeDump({ platform: 'web' }) : null;
}

function spatialDump() {
  if (!state.consumer) return null;
  const dump = state.consumer.dump();
  dump.coreSource = state.coreSource;
  return dump;
}

/** Teardown used by the `{ "dispose": true }` conformance step. */
function spatialDispose() {
  const { core, consumer } = state;
  if (!core || !consumer || !state.loaded) return false;
  consumer.apply(core.dispose() || []);
  state.loaded = false;
  stopLoop();
  return true;
}

/**
 * FA-17, SPEC 2: page teardown. The script is disposed and then the consumer
 * itself, so the renderer, the audio graph, the input listeners and the
 * accessibility container go with the page rather than outliving it.
 */
function spatialTeardown() {
  if (state.tornDown) return false;
  state.tornDown = true;
  spatialDispose();
  stopLoop();
  try {
    if (state.consumer) state.consumer.dispose();
  } catch (err) {
    console.warn(`consumer dispose failed: ${err.message}`);
  }
  return true;
}

/** Conformance-step plumbing: the case drives the consumer-to-core channel itself. */
function spatialBridge(manual) {
  state.consumer.setManualBridge(manual);
}

function spatialSetInput(inputState) {
  state.consumer.overrideInput(inputState);
}

function spatialSync(records) {
  state.core.sync(Float32Array.from(records));
}

function spatialSyncBodies(records) {
  state.core.syncBodies(Float32Array.from(records));
}

function spatialDispatch(type, id, payload) {
  // The host is answering for the consumer, so the consumer stays quiet about it.
  if (state.consumer) state.consumer.noteHostDispatch(type, id);
  state.core.dispatch(type, id, payload || {});
}

function spatialTextureIdForUrl(url) {
  return state.consumer.textureIdForUrl(url);
}

function spatialAssetIdForUrl(url) {
  return state.consumer.assetIdForUrl(url);
}

function spatialPendingLoads() {
  return state.consumer ? state.consumer.pendingLoads : 0;
}

/** WebGLRenderer counters, so a run can tell "rendered nothing" from "rendered". */
function spatialRenderInfo() {
  const renderer = state.consumer && state.consumer.renderer;
  if (!renderer) return null;
  return {
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs ? renderer.info.programs.length : 0,
  };
}

/** The last 120 frames of core tick time, apply time, command counts and intervals. */
function spatialStats() {
  return state.consumer ? state.consumer.stats.slice() : [];
}

window.spatialDump = spatialDump;
window.spatialNativeDump = spatialNativeDump;
window.spatialDispose = spatialDispose;
window.spatialTeardown = spatialTeardown;
window.spatialBridge = spatialBridge;
window.spatialSetInput = spatialSetInput;
window.spatialSync = spatialSync;
window.spatialSyncBodies = spatialSyncBodies;
window.spatialDispatch = spatialDispatch;
window.spatialResolveId = resolveId;
window.spatialTextureIdForUrl = spatialTextureIdForUrl;
window.spatialAssetIdForUrl = spatialAssetIdForUrl;
window.spatialPendingLoads = spatialPendingLoads;
/** SPEC 14.13a: the urls still loading, for a plan that will not settle. */
window.spatialPendingLoadUrls = () => (state.consumer ? state.consumer.inFlightLoads() : []);
window.spatialStats = spatialStats;
window.spatialSetActive = (active) => state.consumer.setActive(active);
window.spatialHostEvent = (name, payload) => {
  if (state.core && typeof state.core.hostEvent === 'function') state.core.hostEvent(name, payload);
};
window.spatialSetHostFunctions = (names) => {
  if (state.core && typeof state.core.setHostFunctions === 'function') state.core.setHostFunctions(names);
};
window.spatialSyncAudio = (records) => state.core.syncAudio(Float32Array.from(records));
window.spatialSyncVideo = (records) => state.core.syncVideo(Float32Array.from(records));
window.spatialSyncCharacter = (records) => state.core.syncCharacter(Float32Array.from(records));
window.spatialSyncSkeleton = (id, joints) => state.core.syncSkeleton(id, joints);
window.spatialResumeAudio = () => state.consumer.audio.resume();
/** Command ids the harness resolves for a `dispatch` step by call or fetch. */
window.spatialPendingCallId = (name) => state.consumer.pendingCallId(name);
window.spatialPendingFetchId = (url) => state.consumer.pendingFetchId(url);
window.spatialRenderInfo = spatialRenderInfo;
window.spatialTick = spatialTick;
window.spatialInject = spatialInject;
window.spatialLoad = spatialLoad;
window.spatialReload = spatialReload;
window.spatialStart = startLoop;
window.spatialStop = stopLoop;

window.spatialReady = boot().catch((err) => {
  record('error', [`boot failed: ${err.message}`]);
  window.spatialBootError = err.message;
  throw err;
});

// ------------------------------------------------------------------ dev UI

window.addEventListener('DOMContentLoaded', () => {
  const editor = document.getElementById('editor');
  const run = document.getElementById('run');
  const status = document.getElementById('status');
  if (!editor || !run) return;
  if (state.scriptPath) {
    fetch(state.scriptPath.startsWith('/') ? state.scriptPath : `/${state.scriptPath}`)
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => { if (text) editor.value = text; })
      .catch(() => {});
  }
  run.addEventListener('click', async () => {
    await window.spatialReady;
    const result = spatialLoad(editor.value);
    status.textContent = result.ok ? 'running' : `load error: ${result.error.message}`;
    status.className = result.ok ? 'ok' : 'bad';
    if (result.ok && state.mode === 'auto') startLoop();
  });
});
