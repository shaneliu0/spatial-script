// Video (SPEC 14.2). A VideoScreen is a mesh — a plane sized to the video —
// so raycast, hit testing and the transform path treat it like any other mesh,
// and its playback rides the `video` / `videoControl` commands.

import { PlaneGeometry } from "../scene/geometry.js";
import { MeshBasicMaterial } from "../util/three-exports.js";
import { Mesh } from "../scene/scene-classes.js";
import { host } from "../host/host.js";
import { clamp, finite } from "../util/sanitize.js";
import { DIRTY, DIRTY_FEATURE, DIRTY_GEOMETRY } from "../scene/object-extensions.js";
import { push } from "../util/builtins.js";

/** The alternative encodings SPEC 14.2 allows a screen to carry. */
const SOURCE_KEYS = ["mp4", "hls", "webm"];

/**
 * A url, or one url per encoding. Each goes through the containment of 3.5;
 * a refused key is dropped with a warning naming it, and a screen left with no
 * source at all reports `url: null` and dispatches `error`, the same way a
 * consumer reports a file it could not open.
 */
function resolveSources(screen, raw, runtime) {
  // No url at all is still a screen with nothing to play, and the protocol
  // promises an `error` for every null url (P2-C-11).
  if (raw === null || raw === undefined) {
    failSource(screen, "no url was given");
    return null;
  }

  if (typeof raw === "string") {
    const url = runtime === null ? raw : runtime.resolveUrl(raw);
    if (url === null && runtime !== null) {
      runtime.warnOnce(
        `video-url:${screen.uuid}`,
        "VideoScreen was given a url that was refused; the screen stays blank",
      );
      failSource(screen, "every url was refused");
    }
    return url;
  }

  if (typeof raw !== "object") {
    throw new TypeError("VideoScreen url expects a string or { mp4, hls, webm }");
  }

  const sources = {};
  const refused = [];
  let kept = 0;
  for (let i = 0; i < SOURCE_KEYS.length; i += 1) {
    const key = SOURCE_KEYS[i];
    const value = raw[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const url = runtime === null ? value : runtime.resolveUrl(value);
    if (url === null) {
      push(refused, key);
      continue;
    }
    sources[key] = url;
    kept += 1;
  }

  if (refused.length > 0 && runtime !== null) {
    runtime.warnOnce(
      `video-url:${screen.uuid}`,
      `VideoScreen ${refused.join(" and ")} url${refused.length > 1 ? "s were" : " was"} refused and dropped`,
    );
  }
  if (kept === 0) {
    failSource(screen, "no url survived containment");
    return null;
  }
  return sources;
}

/**
 * Records a screen with nothing to play. The `error` event waits for the
 * object's first flush: minting an id in the constructor would burn one (and
 * retain the screen forever) for a screen that is never added to a scene
 * (P2-B-16). The pending message is dispatched from the diff instead.
 */
function failSource(screen, reason) {
  screen.error = `VideoScreen has no playable source: ${reason}`;
  screen._pendingError = screen.error;
}

export class VideoScreen extends Mesh {
  constructor(options = {}) {
    const hasWidth = Number.isFinite(options.width);
    const hasHeight = Number.isFinite(options.height);
    // With neither size given the screen is one metre wide until the video's
    // own aspect arrives with the `loaded` event.
    const width = hasWidth ? Math.abs(options.width) : hasHeight ? Math.abs(options.height) * (16 / 9) : 1;
    const height = hasHeight ? Math.abs(options.height) : width * (9 / 16);
    super(new PlaneGeometry(width || 0.001, height || 0.001), new MeshBasicMaterial());

    this.type = "VideoScreen";
    this.isVideoScreen = true;
    this.error = null;
    // Set by resolveSources when there is nothing to play; dispatched once the
    // object has an id the consumer has seen.
    this._pendingError = null;
    this._width = width;
    this._height = height;
    this._fixedWidth = hasWidth;
    this._fixedHeight = hasHeight;
    this._aspect = null;

    const runtime = host();
    this._url = resolveSources(this, options.url, runtime);

    this._loop = options.loop === true;
    this._muted = options.muted === true;
    this._autoplay = options.autoplay === true;
    this._docking = options.docking === true;
    if (this._docking && runtime !== null && runtime.env.platform !== "visionos") {
      runtime.warnOnce(
        "video-docking",
        "VideoScreen docking is visionOS only; the state is kept and reported but has no effect",
      );
    }
    this._volume = 1;
    this._rate = 1;
    this._playing = options.autoplay === true;
    this._currentTime = 0;
    this._duration = 0;
  }

  // ---------------------------------------------------------------- geometry

  get width() {
    return this._width;
  }

  get height() {
    return this._height;
  }

  /**
   * The video's own aspect, once the consumer reports it. Whichever dimension
   * the script did not fix follows it; if it fixed both, the plane is left
   * alone (SPEC 14.2).
   */
  _applyAspect(aspect) {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this._aspect = aspect;
    if (this._fixedWidth && this._fixedHeight) return;
    if (this._fixedHeight) this._width = this._height * aspect;
    else this._height = this._width / aspect;
    // The plane is the screen's own, so replacing it releases the old one
    // rather than leaving it to the consumer's cache (P2-B-46).
    const previous = this.geometry;
    this.geometry = new PlaneGeometry(this._width || 0.001, this._height || 0.001);
    if (previous !== null && previous !== undefined && typeof previous.dispose === "function") {
      previous.dispose();
    }
    this[DIRTY] = (this[DIRTY] | 0) | DIRTY_GEOMETRY;
  }

  // --------------------------------------------------------------- transport

  play() {
    this._playing = true;
    this._control("play", null);
    return this;
  }

  pause() {
    this._playing = false;
    this._control("pause", null);
    return this;
  }

  get isPlaying() {
    return this._playing;
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(value) {
    const next = Math.max(0, finite(value, 0));
    this._currentTime = next;
    this._control("seek", next);
  }

  get duration() {
    return this._duration;
  }

  get url() {
    return this._url;
  }

  get volume() {
    return this._volume;
  }

  set volume(value) {
    this._volume = clamp(finite(value, this._volume), 0, 1);
    this._touch();
  }

  get muted() {
    return this._muted;
  }

  set muted(value) {
    this._muted = value === true;
    this._touch();
  }

  get loop() {
    return this._loop;
  }

  set loop(value) {
    this._loop = value === true;
    this._touch();
  }

  get playbackRate() {
    return this._rate;
  }

  set playbackRate(value) {
    this._rate = clamp(finite(value, this._rate), 0.01, 8);
    this._touch();
  }

  get docking() {
    return this._docking;
  }

  toJSON() {
    return {
      url: this._url,
      width: this._width,
      height: this._height,
      loop: this._loop,
      muted: this._muted,
      autoplay: this._autoplay,
      docking: this._docking,
      volume: this._volume,
      rate: this._rate,
    };
  }

  _touch() {
    this[DIRTY] = (this[DIRTY] | 0) | DIRTY_FEATURE;
  }

  _control(action, value) {
    const runtime = host();
    if (runtime === null) return;
    if (!runtime.canCommand(this, `VideoScreen.${action}`)) return;
    runtime.queueCommand(["videoControl", runtime.idForObject(this), action, value], this);
  }

  /** Applied by syncVideo: the consumer owns playback state. */
  _sync(playing, currentTime, duration) {
    this._playing = playing;
    this._currentTime = currentTime;
    this._duration = duration;
  }
}

export function videoJSONEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    urlEquals(a.url, b.url) &&
    a.width === b.width &&
    a.height === b.height &&
    a.loop === b.loop &&
    a.muted === b.muted &&
    a.autoplay === b.autoplay &&
    a.docking === b.docking &&
    a.volume === b.volume &&
    a.rate === b.rate
  );
}

/** A url is a string, one url per encoding, or nothing at all. */
function urlEquals(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  for (let i = 0; i < SOURCE_KEYS.length; i += 1) {
    if (a[SOURCE_KEYS[i]] !== b[SOURCE_KEYS[i]]) return false;
  }
  return true;
}
