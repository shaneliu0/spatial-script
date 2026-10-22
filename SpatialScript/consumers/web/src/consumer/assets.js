// Loaded assets and the image based environment.
//
// SPEC 3.12: a glTF subtree loads under the object the core created for it, with
// its clips, bones and morph targets. SPEC 3.6: an equirectangular image becomes
// the scene's environment through a PMREM.

import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import {
  KNOWN_KEYS,
  MAX_LOGS,
  MAX_LOGS_PER_FRAME,
  MEDIA_EVENTS,
  describeRig,
  disposeSubtree,
  now,
} from './internals.js';

/**
 * FA-57: a mixin over the consumer class, so these methods keep `this` and every
 * call site unchanged while living in a file of their own.
 */
export function withAssets(Base) {
  return class extends Base {
    // ---------------------------------------------------------------- assets

    loadAsset(id, spec) {
      const object = this.objects.get(id);
      if (!object || !spec) return;
      this.checkPayloadKeys('asset', spec, KNOWN_KEYS.asset);
      this.assetSpecs.set(id, spec);
      const url = spec.glb || spec.gltf;
      if (!url) {
        const message = 'no glb or gltf source for this asset';
        this.warnOnce(`asset:${id}`, message);
        this.dispatch('assetError', id, { message });
        return;
      }
      // WEB-05/07: the load is tied to this object and this generation. A result
      // that lands after the object was destroyed, or after a hot swap, is thrown
      // away rather than resurrecting the entry or dispatching to a reused id.
      if (this.manualBridge) {
        // The caller is standing in for the loader and will dispatch the result.
        return;
      }
      const resolved = this.resolveUrl(url);
      if (resolved === null) {
        const message = `asset url "${url}" resolves outside the asset root`;
        this.dispatch('assetError', id, { message });
        return;
      }
      const generation = this.generation;
      const token = this.beginLoad(url);
      this.gltfLoader.load(
        resolved,
        (gltf) => {
          this.endLoad(token);
          if (generation !== this.generation || this.objects.get(id) !== object) {
            disposeSubtree(gltf.scene);
            return;
          }
          object.add(gltf.scene);
          const clips = gltf.animations || [];
          const mixer = new THREE.AnimationMixer(gltf.scene);
          const { bones, morphs } = describeRig(gltf.scene);
          this.assets.set(id, { mixer, clips, action: null, root: gltf.scene, bones, morphs });
          const box = new THREE.Box3().setFromObject(gltf.scene);
          this.dispatch('assetLoaded', id, {
            animations: clips.map((clip) => clip.name),
            joints: [...bones.keys()],
            blendShapes: [...morphs.keys()],
            boundingBox: [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z],
          });
          // Poses the script set before the file arrived are applied now.
          const pending = this.skeletons.get(id);
          if (pending) this.setSkeleton(id, { joints: pending.joints, track: pending.track });
          const weights = this.blendShapes.get(id);
          if (weights) this.setBlendShapes(id, weights);
          this.opacityDirty = true;
        },
        undefined,
        (err) => {
          this.endLoad(token);
          if (generation !== this.generation || this.objects.get(id) !== object) return;
          // SPEC 3.5: the core warns once with the backend-neutral line; the
          // platform's message travels in the event payload.
          const message = `asset failed to load: ${url} (${err && err.message ? err.message : err})`;
          this.dispatch('assetError', id, { message });
        },
      );
    }

    setAssetAnimation(id, name, loop, speed) {
      const entry = this.assets.get(id);
      if (!entry) return;
      if (entry.action) {
        entry.action.stop();
        entry.action = null;
        entry.animating = false;
        // FA-26: stopping a clip hands the rig back to the script's own poses.
        this.replayHeldSkeletonEdits(id);
      }
      if (name === null || name === undefined) return;
      const clip = entry.clips.find((c) => c.name === name);
      if (!clip) {
        this.warnOnce(`clip:${id}:${name}`, `asset animation "${name}" not found`);
        return;
      }
      const action = entry.mixer.clipAction(clip);
      action.setLoop(loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = loop === false;
      action.timeScale = speed ?? 1;
      action.reset().play();
      entry.action = action;
      entry.animating = true;
    }

    /**
     * FA-26, SPEC 14.5: re-applies the joint poses and blend shape weights the
     * script set while a native animation was overriding them. Mirrors the
     * RealityKit consumer's `replayHeldSkeletonEdits`.
     */
    replayHeldSkeletonEdits(id) {
      const entry = this.assets.get(id);
      if (!entry) return;
      const skeleton = this.skeletons.get(id);
      if (skeleton && Object.keys(skeleton.joints).length) {
        this.setSkeleton(id, { joints: skeleton.joints, track: skeleton.track });
      }
      const weights = this.blendShapes.get(id);
      if (weights && Object.keys(weights).length) this.setBlendShapes(id, weights);
    }

    // ----------------------------------------------------------- environment

    setEnvironment(spec) {
      if (!spec) {
        this._disposeEnvironment();
        return;
      }
      this.checkPayloadKeys('environment', spec, KNOWN_KEYS.environment);
      const url = this.resolveUrl(spec.url);
      // FA-34: the dump reports the url the scene is lit by, as the script gave it.
      this.environmentSource = spec.url ?? null;
      this._environmentBaseIntensity = spec.intensity ?? 1;
      this.scene.environmentIntensity = this._environmentBaseIntensity ** (this.environmentIntensity ?? 1);
      if (url === null) {
        this._disposeEnvironment();
        return;
      }
      // SPEC 3.6: equirectangular .hdr, .png and .jpg load on both backends;
      // .exr is RealityKit only and warns once here.
      if (/\.exr(\?|#|$)/i.test(spec.url || '')) {
        this.warnOnce(
          'environmentFormat',
          `.exr environments are unsupported in the three.js consumer (${spec.url})`,
        );
        this._disposeEnvironment();
        this.scene.environmentIntensity = spec.intensity ?? 1;
        return;
      }
      if (/\.hdr(\?|#|$)/i.test(spec.url || '')) {
        this._loadRadianceEnvironment(url);
        return;
      }
      const texture = new THREE.Texture();
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      this._setEnvironmentTexture(texture);
      this._loadImageInto({ texture, views: new Map() }, url, null);
    }

    /** Owns the environment texture so a replacement or a reset frees it (WEB-11). */
    _setEnvironmentTexture(texture) {
      if (this._environmentTexture && this._environmentTexture !== texture) {
        this._environmentTexture.dispose();
      }
      this._environmentTexture = texture;
      this.scene.environment = texture;
    }

    _disposeEnvironment() {
      this.environmentSource = null;
      if (this._environmentTexture) {
        this._environmentTexture.dispose();
        this._environmentTexture = null;
      }
      if (this._environmentTarget) {
        this._environmentTarget.dispose();
        this._environmentTarget = null;
      }
      this.scene.environment = null;
    }

    /**
     * Radiance .hdr equirectangular maps, through three's HDRLoader. The float data
     * is prefiltered here rather than left to the renderer's automatic conversion,
     * which does not pick up a half-float DataTexture.
     */
    _loadRadianceEnvironment(url) {
      if (!this.hdrLoader) this.hdrLoader = new HDRLoader();
      const generation = this.generation;
      const token = this.beginLoad(url);
      this.hdrLoader.load(
        url,
        (texture) => {
          this.endLoad(token);
          if (generation !== this.generation) {
            texture.dispose();
            return;
          }
          texture.mapping = THREE.EquirectangularReflectionMapping;
          this._setEnvironmentTexture(this._prefilterEnvironment(texture));
        },
        undefined,
        () => {
          this.endLoad(token);
          if (generation !== this.generation) return;
          // SPEC 3.5: the core warns for a failed load; nothing is added here.
        },
      );
    }

    /** Builds the prefiltered radiance map, keeping the source texture disposed. */
    _prefilterEnvironment(texture) {
      if (!this.renderer) return texture;
      if (this._environmentTarget) this._environmentTarget.dispose();
      // The prefiltered target owns the result; the source is freed below.
      const generator = new THREE.PMREMGenerator(this.renderer);
      generator.compileEquirectangularShader();
      this._environmentTarget = generator.fromEquirectangular(texture);
      generator.dispose();
      texture.dispose();
      return this._environmentTarget.texture;
    }

    /** The oldest unanswered call id for a name, for a `dispatch` conformance step. */
    pendingCallId(name) {
      for (const [id, called] of this.pendingCalls) if (called === name) return id;
      return undefined;
    }

    pendingFetchId(url) {
      for (const [id, requested] of this.pendingFetches) if (requested === url) return id;
      return undefined;
    }

    /** A host dispatched this event itself (SPEC 9): the consumer must not repeat it. */
    noteHostDispatch(type, id) {
      if (!MEDIA_EVENTS.has(type) || id === undefined || id === null) return;
      const key = `${type}:${id}`;
      this.hostAnswered.add(key);
      // The element got there first; its answer is still waiting, so drop it.
      this._deferredMedia.delete(key);
    }

    /** Drops a correlation id once its answer has been dispatched. */
    settleCorrelation(id) {
      this.pendingCalls.delete(id);
      this.pendingFetches.delete(id);
    }

    /** Texture id for the url the script used, for `dispatch` conformance steps. */
    textureIdForUrl(url) {
      for (const [id, entry] of this.textures) {
        if (entry.sourceUrl === url || entry.url === url) return id;
      }
      return undefined;
    }

    /** Asset id for any of the urls in its `asset` command. */
    assetIdForUrl(url) {
      for (const [id, spec] of this.assetSpecs) {
        for (const key of Object.keys(spec || {})) if (spec[key] === url) return id;
      }
      return undefined;
    }

    /**
     * Console output from the script. A script's own `console.error` is a log line,
     * not a scene error, so it never lands in `dump().errors`.
     */
    handleLog(level, message) {
      // PERF-10: a noisy script must not retain unbounded console output. At most
      // MAX_LOGS_PER_FRAME lines are kept per frame and MAX_LOGS in total; the rest
      // are counted so the drop is visible rather than silent.
      this._logsThisFrame += 1;
      if (this._logsThisFrame > MAX_LOGS_PER_FRAME) {
        if (this._logsThisFrame === MAX_LOGS_PER_FRAME + 1) {
          this._pushLog('warn', `... more log lines this frame were suppressed after ${MAX_LOGS_PER_FRAME}`);
        }
        this.droppedLogs += 1;
        return;
      }
      this._pushLog(level, message);
      this.write(level, message);
    }

    _pushLog(level, message) {
      if (this.logs.length >= MAX_LOGS) {
        this.logs.shift();
        this.droppedLogs += 1;
      }
      this.logs.push({ level, message });
    }
  };
}
