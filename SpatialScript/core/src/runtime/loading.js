// Script loading and the scene lifecycle (SPEC section 2).
//
// Everything here takes the runtime explicitly, so the file is readable on its
// own and the class below stays a thin facade over the phases.

import { SpatialLoadError, SpatialUnsupportedError, cleanMessage, extractLocation, probeLineOffset } from "../errors.js";
import { markDestroyed } from "../object-extensions.js";
import { constructedScenes } from "../scene-classes.js";
import { labelFor } from "../sanitize.js";
import { push } from "../builtins.js";
import { SNAPSHOT } from "./state.js";

// `Spatial` and `console` are installed as globals rather than passed as
// parameters: a script is free to write `const Spatial = require("spatial")`
// and a parameter of the same name would be a redeclaration error.
// SPEC 3.13: capabilities are honest per platform when the host supplies none.
export const DEFAULT_CAPABILITIES = {
  realitykit: {
    macos: { hands: false, anchors: false, portals: true, particles: true, manipulation: false, hoverEffect: false, shadows: true },
    visionos: { hands: true, anchors: true, portals: true, particles: true, manipulation: true, hoverEffect: true, shadows: true },
  },
  three: {
    web: { hands: false, anchors: false, portals: true, particles: true, manipulation: true, hoverEffect: false, shadows: true },
  },
};

const SCRIPT_PARAMETERS = ["require", "module", "exports"];

// The script body is evaluated as an async function so top-level await works
// (SPEC section 2). AsyncFunction is not a global, so it is reached through the
// prototype of an async function expression.
const AsyncFunction = Object.getPrototypeOf(async function asyncProbe() {}).constructor;

export function load(runtime, source, options = {}) {
    const generation = runtime.loadGeneration + 1;
    runtime.reset();
    runtime.loadGeneration = generation;
    const backend = options.backend === undefined ? "three" : options.backend;
    const platform = options.platform === undefined ? (backend === "realitykit" ? "macos" : "web") : options.platform;
    const defaults = (DEFAULT_CAPABILITIES[backend] && DEFAULT_CAPABILITIES[backend][platform]) || DEFAULT_CAPABILITIES.three.web;
    runtime.env = {
      backend,
      platform,
      capabilities: { ...defaults, ...(options.capabilities || {}) },
    };
    runtime.assetRoot = options.assetRoot === undefined ? "" : String(options.assetRoot);

    const namespace = runtime.namespace;
    const moduleObject = { exports: {} };
    const scriptThis = {};
    runtime.script = scriptThis;

    const requireFn = (name) => {
      if (name === "spatial" || name === "Spatial") return namespace;
      throw new Error(`require("${name}") is not available; only require("spatial") is provided`);
    };

    const lineOffset = probeLineOffset(SCRIPT_PARAMETERS);
    runtime.lineOffset = lineOffset;
    runtime.scriptLineCount = String(source).split("\n").length;
    const args = [requireFn, moduleObject, moduleObject.exports];

    // A body without top-level await compiles as a plain function and runs to
    // completion synchronously, so load() keeps its synchronous error contract.
    // A body with top-level await only compiles as an async function; load()
    // then returns after the synchronous prefix and the rest settles later.
    let scriptFunction = null;
    let isAsync = false;
    try {
      // eslint-disable-next-line no-new-func
      scriptFunction = new Function(...SCRIPT_PARAMETERS, source);
    } catch (syntaxError) {
      try {
        scriptFunction = new AsyncFunction(...SCRIPT_PARAMETERS, source);
        isAsync = true;
      } catch {
        // A SyntaxError from the Function constructor carries no script frame
        // in V8; JavaScriptCore does populate `line`, so only the engine
        // provided fields are trusted here.
        throw toLoadError(runtime, syntaxError, lineOffset, false);
      }
    }

    if (!isAsync) {
      try {
        scriptFunction.call(scriptThis, ...args);
      } catch (error) {
        throw toLoadError(runtime, error, lineOffset);
      }
      finishLoad(runtime, lineOffset);
      runtime.loadPromise = Promise.resolve();
      return;
    }

    let bodyPromise;
    try {
      bodyPromise = scriptFunction.call(scriptThis, ...args);
    } catch (error) {
      throw toLoadError(runtime, error, lineOffset);
    }

    // Classifying "threw before the first await" needs the microtask order: a
    // body that threw synchronously has already rejected, so its reaction job
    // is queued here and runs before the sentinel queued on the next line.
    let sentinelRan = false;
    const outcome = bodyPromise.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error, beforeFirstAwait: !sentinelRan }),
    );
    Promise.resolve().then(() => {
      sentinelRan = true;
    });

    runtime.loadPromise = outcome.then((result) => {
      if (!result.ok) {
        if (result.beforeFirstAwait) {
          // Same class of failure as a synchronous load error, but load() has
          // already returned, so it travels through the error channel.
          reportLoadFailure(runtime, toLoadError(runtime, result.error, lineOffset));
          return;
        }
        runtime.reportError(result.error);
      }
      try {
        finishLoad(runtime, lineOffset);
      } catch (error) {
        reportLoadFailure(runtime, error);
      }
    });
  }

  /** The auto-mount rule and didAdd, run once the script body has settled. */
export function finishLoad(runtime, lineOffset) {
    if (runtime.scene === null) {
      if (constructedScenes.length === 1) {
        runtime.mount(constructedScenes[0]);
        runtime.warnOnce(
          "auto-mount",
          "No scene was mounted; auto-mounting the single Scene that was constructed",
        );
      } else if (constructedScenes.length === 0) {
        throw new SpatialLoadError(
          "The script finished without mounting a scene and constructed no Scene; call Spatial.mount(scene)",
        );
      } else {
        throw new SpatialLoadError(
          `The script finished without mounting a scene and constructed ${constructedScenes.length} Scenes; call Spatial.mount(scene)`,
        );
      }
    }

    if (typeof runtime.script.didAdd === "function") {
      try {
        runtime.script.didAdd();
      } catch (error) {
        throw toLoadError(runtime, error, lineOffset);
      }
    }

    runtime.loaded = true;
  }

  /** A load failure that surfaced after load() returned. */
export function reportLoadFailure(runtime, error) {
    const where =
      error.line === null || error.line === undefined ? "" : ` (line ${error.line}, column ${error.column})`;
    runtime.reportOnce({ name: error.name || "SpatialLoadError", message: `${cleanMessage(error.cause || error)}${where}` });
  }

export function toLoadError(runtime, error, lineOffset, allowStack = true) {
    if (error instanceof SpatialLoadError) return error;
    const { line, column } = extractLocation(error, lineOffset, allowStack);
    const message = cleanMessage(error);
    const loadError = new SpatialLoadError(message, line, column, error);
    const native = globalThis.__spatialNative;
    if (native && typeof native.log === "function") native.log("error", message);
    return loadError;
  }

export function mount(runtime, scene) {
    if (!scene || scene.type !== "Scene") {
      throw new TypeError("Spatial.mount expects a Scene");
    }
    if (runtime.scene === scene) return scene;
    if (runtime.scene !== null) {
      // Two mounts between flushes must not discard the first scene's list.
      const previous = runtime.pendingDestroyCandidates === null ? [] : runtime.pendingDestroyCandidates;
      runtime.scene.traverse((object) => {
        if (object === runtime.scene) return;
        push(previous, object);
        // The outgoing scene stops holding its geometry deliveries here rather
        // than when the destroys are emitted, so a mesh the new scene creates
        // on the same geometry is described with its buffers. An object that
        // survives into the new scene re-registers when it next describes its
        // geometry; until then the core re-sends buffers, which is always safe.
        const snapshot = object[SNAPSHOT];
        if (snapshot !== undefined && snapshot.geometryUuid !== null) {
          runtime.dropGeometryUser(snapshot.geometryUuid);
          snapshot.geometryUuid = null;
        }
      });
      runtime.pendingDestroyCandidates = previous;
    }
    runtime.scene = scene;
    return scene;
  }

  /**
   * Frees an object and its descendants: `destroy` commands descendants first,
   * detached from its parent, ids released, and the objects marked so that
   * adding them back throws (SPEC 3.13).
   */
export function destroy(runtime, object) {
    if (!object || object.isObject3D !== true) {
      throw new TypeError("Spatial.destroy expects an Object3D");
    }
    if (object === runtime.scene) {
      throw new SpatialUnsupportedError(
        "Spatial.destroy cannot destroy the mounted scene; mount another scene instead",
        "destroy-scene",
        object,
      );
    }

    const subtree = [];
    object.traverse((node) => push(subtree, node));
    object.removeFromParent();
    const destroyedNodes = new Set();

    for (let i = subtree.length - 1; i >= 0; i -= 1) {
      const node = subtree[i];
      const id = runtime.objectIds.get(node);
      const snapshot = node[SNAPSHOT];
      // Only objects the consumer has seen need a destroy command.
      if (id !== undefined && snapshot !== undefined) {
        push(runtime.pendingDestroys, ["destroy", id]);
      }
      if (id !== undefined) {
        runtime.objectIds.delete(node);
        runtime.idObjects.delete(id);
      }
      if (snapshot !== undefined) runtime.releaseSnapshot(node, snapshot);
      if (id !== undefined) runtime.releaseId(id);
      runtime.extraRoots.delete(node);
      runtime.worldFlagged.delete(node);
      runtime.shearedObjects.delete(node);
      runtime.invalidTransforms.delete(node);
      runtime.syncedObjects.delete(node);
      if (node.rigidBody) node.rigidBody.object = null;
      markDestroyed(node);
      destroyedNodes.add(node);
    }

    // A joint pinned to a destroyed body is removed, so #diffJoints emits
    // ["joint", id, null] rather than a payload with a null body (SPEC 5).
    const joints = runtime.physics.joints;
    for (let i = joints.length - 1; i >= 0; i -= 1) {
      const joint = joints[i];
      if (destroyedNodes.has(joint.bodyA) || destroyedNodes.has(joint.bodyB)) joints.splice(i, 1);
    }

    return object;
  }

