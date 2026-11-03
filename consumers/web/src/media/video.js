// VideoScreen rendering (SPEC 14.2). The core creates the screen as a mesh with a
// plane and a basic material; the consumer puts a VideoTexture on it, sizes the
// plane from the loaded metadata when only one dimension was given, and reports
// playback state back through `syncVideo`.

import * as THREE from 'three';

export class VideoScreens {
  /** @param {object} deps `resolveUrl`, `dispatch`, `warnOnce`, `beginLoad`, `endLoad` */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<number, object>} */
    this.screens = new Map();
    this._records = new Float32Array(0);
  }

  /** `video`: full state, or null to remove the screen. */
  set(id, mesh, spec) {
    if (!spec) {
      this.remove(id);
      return;
    }
    let entry = this.screens.get(id);
    if (!entry) {
      if (typeof document === 'undefined') {
        // Headless (node) consumer: keep the state without an element.
        this.screens.set(id, { spec, mesh, element: null, texture: null });
        return;
      }
      const element = document.createElement('video');
      element.playsInline = true;
      element.crossOrigin = 'anonymous';
      element.preload = 'auto';
      const texture = new THREE.VideoTexture(element);
      texture.colorSpace = THREE.SRGBColorSpace;
      entry = { spec, mesh, element, texture, url: null, sized: false };
      this.screens.set(id, entry);

      element.addEventListener('loadedmetadata', () => {
        // SPEC 14.13a: the metadata is the load; a plan waits for it.
        this._settleLoad(entry);
        if (this.screens.get(id) !== entry) return;
        this._applySize(entry);
        this.deps.dispatch('loaded', id, {
          width: element.videoWidth,
          height: element.videoHeight,
          duration: Number.isFinite(element.duration) ? element.duration : 0,
        });
      });
      element.addEventListener('ended', () => {
        // AR-32: the element has the last word once it really stops.
        entry.intentPlaying = false;
        if (this.screens.get(id) === entry) this.deps.dispatch('ended', id, {});
      });
      element.addEventListener('pause', () => { entry.intentPlaying = false; });
      element.addEventListener('error', () => {
        this._settleLoad(entry);
        entry.intentPlaying = false;
        const message = `video failed to load: ${entry.url}`;
        entry.error = message;
        if (this.screens.get(id) !== entry) return;
        // SPEC 3.5: no consumer warning for a load failure.
        this.deps.dispatch('error', id, { message });
      });
    }

    entry.spec = spec;
    entry.mesh = mesh;
    const { element } = entry;
    if (!element) return;

    element.loop = spec.loop === true;
    element.muted = spec.muted === true;
    element.volume = Math.max(0, Math.min(1, spec.volume ?? 1));
    element.playbackRate = spec.rate ?? 1;
    // AR-36: the core warns that docking is visionOS only; one fact, one warning.

    const chosen = this._chooseSource(id, entry, spec.url);
    if (chosen && entry.url !== chosen) {
      const resolved = this.deps.resolveUrl(chosen);
      if (resolved === null) return;
      entry.url = chosen;
      // A new source is a new load: it is in flight until the metadata or an
      // error arrives (SPEC 14.13a).
      this._settleLoad(entry);
      entry.loadToken = this.deps.beginLoad(resolved);
      element.src = resolved;
      element.load();
    }
    if (spec.autoplay && !entry.autoplayed) {
      entry.autoplayed = true;
      this.control(id, 'play', null);
    }
    if (mesh && entry.texture && mesh.material && !Array.isArray(mesh.material)) {
      if (mesh.material.map !== entry.texture) {
        mesh.material.map = entry.texture;
        mesh.material.needsUpdate = true;
      }
    }
    this._applySize(entry);
  }

  /**
   * SPEC 14.2: `url` is a string or `{ mp4, hls, webm }`. WebM is preferred, then
   * MP4, and only where this browser says it can decode the container. When no
   * key is usable the screen reports `error` instead of loading nothing.
   */
  _chooseSource(id, entry, url) {
    if (!url) return null;
    if (typeof url === 'string') return url;
    if (typeof url !== 'object') return null;

    const element = entry.element;
    const canPlay = (type) => {
      if (!element || typeof element.canPlayType !== 'function') return true;
      return element.canPlayType(type) !== '';
    };
    const candidates = [
      ['webm', url.webm, 'video/webm'],
      ['mp4', url.mp4, 'video/mp4'],
      ['hls', url.hls, 'application/vnd.apple.mpegurl'],
    ];
    for (const [, candidate, type] of candidates) {
      if (candidate && canPlay(type)) return candidate;
    }
    if (entry.sourceRefused) return null;
    entry.sourceRefused = true;
    const offered = candidates.filter(([, value]) => value).map(([key]) => key);
    const message = offered.length
      ? `no usable video source: this browser cannot decode ${offered.join(' or ')}`
      : 'the video carries no mp4, webm or hls source';
    // SPEC 3.5: a source this browser cannot decode is a load failure, and a
    // load failure is reported through the event, not through a warning.
    this.deps.dispatch('error', id, { message });
    return null;
  }

  /** Ends the entry's in-flight load, once, whatever settled it. */
  _settleLoad(entry) {
    if (entry.loadToken === undefined || entry.loadToken === null) return;
    const token = entry.loadToken;
    entry.loadToken = null;
    this.deps.endLoad(token);
  }

  /** The plane follows the video's aspect when the script gave only one side. */
  _applySize(entry) {
    const { spec, mesh, element } = entry;
    if (!mesh || !element) return;
    let width = spec.width;
    let height = spec.height;
    if (element.videoWidth && element.videoHeight) {
      const aspect = element.videoWidth / element.videoHeight;
      if (width && !height) height = width / aspect;
      else if (height && !width) width = height * aspect;
    }
    if (!width || !height) return;
    const parameters = mesh.geometry && mesh.geometry.parameters;
    if (parameters && Math.abs(parameters.width - width) < 1e-6 && Math.abs(parameters.height - height) < 1e-6) {
      return;
    }
    // P2-B-33: the plane may be a geometry shared by uuid with other meshes, so
    // only a plane this screen owns is freed.
    if (mesh.geometry && entry.ownsGeometry) mesh.geometry.dispose();
    mesh.geometry = new THREE.PlaneGeometry(width, height);
    entry.ownsGeometry = true;
    entry.sized = true;
  }

  /** `videoControl`: play, pause or seek. */
  control(id, action, value) {
    const entry = this.screens.get(id);
    if (!entry || !entry.element) return;
    const { element } = entry;
    if (action === 'play') {
      // AR-32: `play()` is an intent. The element takes a moment to start, and
      // reporting `playing: false` in between would flip the script's own
      // `isPlaying` back off on the frame after it asked to play. The intent
      // stands until the element ends, errors, or is paused.
      entry.intentPlaying = true;
      const promise = element.play();
      if (promise && promise.catch) {
        promise.catch(() => {
          entry.intentPlaying = false;
          this.deps.warnOnce('videoAutoplay', 'the browser refused to start video playback without a gesture');
        });
      }
    } else if (action === 'pause') {
      entry.intentPlaying = false;
      element.pause();
    } else if (action === 'seek') {
      element.currentTime = Math.max(0, value || 0);
    }
  }

  /**
   * AR-32: what the consumer reports for `VideoScreen.isPlaying` — the script's
   * intent while it stands, and the element's own state once it takes over.
   */
  static playingOf(entry) {
    const element = entry && entry.element;
    if (!element) return !!(entry && entry.intentPlaying);
    if (element.ended) return false;
    if (entry.intentPlaying) return true;
    return !element.paused;
  }

  /** Flat `[id, playing, currentTime, duration]` records for `syncVideo`. */
  syncRecords() {
    // A screen whose metadata never loaded reports nothing, leaving the core's
    // own state in place.
    const ids = [...this.screens.keys()].filter((id) => {
      const element = this.screens.get(id).element;
      return element && element.readyState > 0;
    });
    if (this._records.length !== ids.length * 4) this._records = new Float32Array(ids.length * 4);
    let o = 0;
    for (const id of ids) {
      const element = this.screens.get(id).element;
      this._records[o++] = id;
      this._records[o++] = VideoScreens.playingOf(this.screens.get(id)) ? 1 : 0;
      this._records[o++] = element ? element.currentTime : 0;
      this._records[o++] = element && Number.isFinite(element.duration) ? element.duration : 0;
    }
    return this._records;
  }

  describe(id) {
    const entry = this.screens.get(id);
    if (!entry) return null;
    const { spec, element } = entry;
    return {
      // SPEC 8: the url the script gave, in the shape it gave it (a string or
      // the `{ mp4, hls, webm }` object), not the source this browser picked.
      url: spec.url ?? null,
      width: spec.width ?? null,
      height: spec.height ?? null,
      loop: spec.loop === true,
      muted: spec.muted === true,
      autoplay: spec.autoplay === true,
      docking: spec.docking === true,
      volume: spec.volume ?? 1,
      rate: spec.rate ?? 1,
      playing: VideoScreens.playingOf(entry),
      currentTime: element ? element.currentTime : 0,
      duration: element && Number.isFinite(element.duration) ? element.duration : 0,
      error: entry.error ?? null,
    };
  }

  remove(id) {
    const entry = this.screens.get(id);
    if (!entry) return;
    this.screens.delete(id);
    // A screen removed mid-load must not leave the plan waiting for it.
    this._settleLoad(entry);
    if (entry.element) {
      entry.element.pause();
      entry.element.removeAttribute('src');
      entry.element.load();
    }
    // P2-B-33: the material must let go of the texture before it is freed, or
    // three keeps re-uploading a disposed one every frame.
    const material = entry.mesh && entry.mesh.material;
    for (const one of Array.isArray(material) ? material : [material]) {
      if (one && one.map === entry.texture) {
        one.map = null;
        one.needsUpdate = true;
      }
    }
    if (entry.texture) entry.texture.dispose();
  }

  reset() {
    for (const id of [...this.screens.keys()]) this.remove(id);
  }
}
