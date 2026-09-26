// Audio (SPEC 14.1): the mixer, an opaque URL-backed buffer handle, and the
// three.js-shaped Audio / PositionalAudio / AmbientAudio objects.
//
// Nothing here decodes or plays anything: the consumer owns playback, so the
// core carries state (an `audio` command), intent (`audioControl`) and mixes
// (`audioMixer`), and takes playback state back through `syncAudio`.

import { Object3D } from "./three-exports.js";
import { host } from "./host.js";
import { clamp, finite } from "./sanitize.js";
import { MAX_NAME_LENGTH } from "./limits.js";
import { cut } from "./builtins.js";
import { DIRTY, DIRTY_FEATURE, isDestroyed } from "./object-extensions.js";

const DISTANCE_MODELS = ["inverse", "linear", "exponential"];

/** A mix group name that reaches the wire: capped, never empty. */
function groupName(value) {
  if (typeof value !== "string" || value.length === 0) return "master";
  return value.length > MAX_NAME_LENGTH ? cut(value, MAX_NAME_LENGTH) : value;
}

/**
 * An opaque handle to an audio file. The consumer loads the url; the core only
 * ever forwards it, so `duration` stays 0 until a `syncAudio` record fills it
 * in on the object that plays the buffer.
 */
export class AudioBuffer {
  constructor(url, error = null) {
    this.url = url;
    this.error = error;
    this.duration = 0;
  }
}

export class AudioLoader {
  constructor() {
    this.path = "";
  }

  setPath(path) {
    this.path = typeof path === "string" ? path : "";
    return this;
  }

  /**
   * Returns the handle synchronously (the consumer does the loading) and calls
   * `onLoad` on the next microtask so a script written either way works. A url
   * the containment of 3.5 refuses never becomes a buffer.
   */
  load(url, onLoad, onProgress, onError) {
    const runtime = host();
    const raw = `${this.path}${typeof url === "string" ? url : ""}`;
    const resolved = runtime === null ? raw : runtime.resolveUrl(raw);
    const buffer = new AudioBuffer(resolved, resolved === null ? "the url was refused" : null);
    Promise.resolve().then(() => {
      if (resolved === null) {
        const error = new Error(`AudioLoader could not load "${raw}": the url was refused`);
        if (typeof onError === "function") onError(error);
        return;
      }
      if (typeof onProgress === "function") onProgress({ loaded: 0, total: 0 });
      if (typeof onLoad === "function") onLoad(buffer);
    });
    return buffer;
  }

  loadAsync(url) {
    return new Promise((resolve, reject) => {
      this.load(url, resolve, undefined, reject);
    });
  }
}

/**
 * The listener and mixer. Group volumes are a flat name -> volume map so the
 * payload stays JSON and the consumer can apply them to whatever bus it has.
 */
export class AudioMixer {
  constructor() {
    this.reset();
  }

  reset() {
    this._masterVolume = 1;
    this._groups = new Map();
    this._state = "suspended";
    this._revision = 0;
  }

  get masterVolume() {
    return this._masterVolume;
  }

  set masterVolume(value) {
    const next = clamp(finite(value, this._masterVolume), 0, 1);
    if (next === this._masterVolume) return;
    this._masterVolume = next;
    this._revision += 1;
  }

  setGroupVolume(name, volume) {
    const key = groupName(name);
    const next = clamp(finite(volume, 1), 0, 1);
    if (this._groups.get(key) === next) return this;
    this._groups.set(key, next);
    this._revision += 1;
    return this;
  }

  /** Read-only view: the group names that have a volume set. */
  get groups() {
    const names = [];
    for (const name of this._groups.keys()) names[names.length] = name;
    return names;
  }

  get state() {
    return this._state;
  }

  /** Web audio needs a gesture; the consumer confirms through `audioState`. */
  resume() {
    if (this._state === "running") return this;
    this._state = "running";
    this._revision += 1;
    return this;
  }

  toJSON() {
    const groups = {};
    for (const [name, volume] of this._groups) groups[name] = volume;
    return { masterVolume: this._masterVolume, groups, state: this._state };
  }
}

/**
 * Non-spatial audio. three.js makes `Audio` an Object3D and so does this: it
 * needs a place in the graph to own an id, and `PositionalAudio` extends it.
 */
export class Audio extends Object3D {
  constructor() {
    super();
    this.type = "Audio";
    this.isAudio = true;
    this.isSpatialAudio = false;
    this.isAmbientAudio = false;
    this.buffer = null;
    this.onEnded = null;
    this._loop = false;
    this._volume = 1;
    this._rate = 1;
    this._group = "master";
    this._playing = false;
    this._currentTime = 0;
    this._duration = 0;
    this._refDistance = 1;
    this._rolloff = 1;
    this._distanceModel = "inverse";
    this._cone = null;
    this._reverbLevel = 0;
  }

  // ---------------------------------------------------------------- contents

  setBuffer(buffer) {
    if (buffer !== null && buffer !== undefined && !(buffer instanceof AudioBuffer)) {
      throw new TypeError("Audio.setBuffer expects an AudioBuffer from AudioLoader");
    }
    this.buffer = buffer === undefined ? null : buffer;
    if (this.buffer !== null && this.buffer.url === null) {
      const runtime = host();
      if (runtime) {
        runtime.warnOnce(
          `audio-url:${this.uuid}`,
          `${this.type} was given a buffer whose url was refused; it stays silent`,
        );
      }
    }
    this._touch();
    return this;
  }

  setLoop(value) {
    this._loop = value === true;
    this._touch();
    return this;
  }

  get loop() {
    return this._loop;
  }

  set loop(value) {
    this.setLoop(value);
  }

  setVolume(value) {
    this._volume = clamp(finite(value, this._volume), 0, 1);
    this._touch();
    return this;
  }

  getVolume() {
    return this._volume;
  }

  get volume() {
    return this._volume;
  }

  set volume(value) {
    this.setVolume(value);
  }

  setPlaybackRate(value) {
    this._rate = clamp(finite(value, this._rate), 0.01, 8);
    this._touch();
    return this;
  }

  get playbackRate() {
    return this._rate;
  }

  set playbackRate(value) {
    this.setPlaybackRate(value);
  }

  get group() {
    return this._group;
  }

  set group(value) {
    this._group = groupName(value);
    this._touch();
  }

  // --------------------------------------------------------------- transport

  play() {
    if (this._dropIfDestroyed("play")) return this;
    if (!this._canPlay("play")) return this;
    this._playing = true;
    this._control("play", null);
    return this;
  }

  pause() {
    if (this._dropIfDestroyed("pause")) return this;
    this._playing = false;
    this._control("pause", null);
    return this;
  }

  stop() {
    if (this._dropIfDestroyed("stop")) return this;
    this._playing = false;
    this._currentTime = 0;
    this._control("stop", null);
    return this;
  }

  get isPlaying() {
    return this._playing;
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(value) {
    if (this._dropIfDestroyed("seek")) return;
    const next = Math.max(0, finite(value, 0));
    this._currentTime = next;
    this._control("seek", next);
  }

  get duration() {
    return this._duration;
  }

  // ----------------------------------------------------------------- payload

  toJSON() {
    return {
      url: this.buffer === null ? null : this.buffer.url,
      spatial: this.isSpatialAudio === true,
      ambient: this.isAmbientAudio === true,
      loop: this._loop,
      volume: this._volume,
      rate: this._rate,
      group: this._group,
      refDistance: this._refDistance,
      rolloff: this._rolloff,
      distanceModel: this._distanceModel,
      cone: this._cone,
      reverbLevel: this._reverbLevel,
    };
  }

  // ------------------------------------------------------------------ inside

  /** Raises the feature bit so the diff re-reads this object's payload. */
  _touch() {
    this[DIRTY] = (this[DIRTY] | 0) | DIRTY_FEATURE;
  }

  _canPlay(what) {
    const runtime = host();
    if (this.buffer === null || this.buffer.url === null) {
      if (runtime) {
        runtime.warnOnce(
          `audio-nobuffer:${this.uuid}`,
          `${this.type}.${what}() was called without a playable buffer; nothing was started`,
        );
      }
      return false;
    }
    return true;
  }

  /**
   * Stops the sound, tells the consumer to drop it (`audio id null`) and frees
   * the object (SPEC 14.1). Equivalent to `Spatial.destroy(sound)`.
   */
  dispose() {
    const runtime = host();
    if (runtime === null || isDestroyed(this)) return this;
    this._playing = false;
    runtime.destroy(this);
    return this;
  }

  /**
   * A destroyed sound is gone for good: nothing about it changes again, and
   * adopting it as a root would resurrect it behind Spatial.destroy's back
   * (P2-B-04).
   */
  _dropIfDestroyed(action) {
    if (!isDestroyed(this)) return false;
    const runtime = host();
    if (runtime !== null) {
      runtime.warnOnce(
        `uncreated:${this.type}.${action}`,
        `${this.type}.${action} on ${this.name ? `"${this.name}"` : this.type} was dropped: ` +
          "the object was destroyed",
      );
    }
    return true;
  }

  _control(action, value) {
    const runtime = host();
    if (runtime === null) return;
    if (this._dropIfDestroyed(action)) return;
    // An object the consumer has never seen has no id to command yet; the
    // `audio` payload it gets on creation carries the state instead.
    runtime.registerAudio(this);
    if (!runtime.canCommand(this, `${this.type}.${action}`)) return;
    runtime.queueCommand(["audioControl", runtime.idForObject(this), action, value], this);
  }

  /** Applied by syncAudio: the consumer owns playback state. */
  _sync(playing, currentTime, duration) {
    this._playing = playing;
    this._currentTime = currentTime;
    this._duration = duration;
    if (this.buffer !== null) this.buffer.duration = duration;
  }
}

/** Spatial audio: a source at the object's world position. */
export class PositionalAudio extends Audio {
  constructor() {
    super();
    this.type = "PositionalAudio";
    this.isSpatialAudio = true;
  }

  setRefDistance(value) {
    this._refDistance = Math.max(0.0001, finite(value, this._refDistance));
    this._touch();
    return this;
  }

  getRefDistance() {
    return this._refDistance;
  }

  setRolloffFactor(value) {
    this._rolloff = Math.max(0, finite(value, this._rolloff));
    this._touch();
    return this;
  }

  getRolloffFactor() {
    return this._rolloff;
  }

  setDistanceModel(model) {
    if (DISTANCE_MODELS.indexOf(model) === -1) {
      throw new TypeError(
        `PositionalAudio.setDistanceModel expects one of ${DISTANCE_MODELS.join(", ")} (got ${String(model)})`,
      );
    }
    this._distanceModel = model;
    this._touch();
    return this;
  }

  getDistanceModel() {
    return this._distanceModel;
  }

  setDirectionalCone(innerAngle, outerAngle, outerGain) {
    const inner = clamp(finite(innerAngle, 360), 0, 360);
    const outer = clamp(finite(outerAngle, 360), inner, 360);
    const gain = clamp(finite(outerGain, 0), 0, 1);
    this._cone = [inner, outer, gain];
    this._touch();
    return this;
  }

  get reverbLevel() {
    return this._reverbLevel;
  }

  set reverbLevel(value) {
    this._reverbLevel = clamp(finite(value, this._reverbLevel), -80, 20);
    this._touch();
  }
}

/** Sound that arrives from every direction at the object's position. */
export class AmbientAudio extends Audio {
  constructor() {
    super();
    this.type = "AmbientAudio";
    this.isAmbientAudio = true;
  }
}

/** Payload equality for the audio command (the cone is the only array). */
export function audioJSONEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.url !== b.url ||
    a.spatial !== b.spatial ||
    a.ambient !== b.ambient ||
    a.loop !== b.loop ||
    a.volume !== b.volume ||
    a.rate !== b.rate ||
    a.group !== b.group ||
    a.refDistance !== b.refDistance ||
    a.rolloff !== b.rolloff ||
    a.distanceModel !== b.distanceModel ||
    a.reverbLevel !== b.reverbLevel
  ) {
    return false;
  }
  const ac = a.cone;
  const bc = b.cone;
  if (ac === bc) return true;
  if (ac === null || bc === null) return false;
  return ac[0] === bc[0] && ac[1] === bc[1] && ac[2] === bc[2];
}
