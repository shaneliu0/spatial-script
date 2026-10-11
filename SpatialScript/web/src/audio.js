// Web Audio for the SpatialScript consumer (SPEC 14.1).
//
// The listener rides the camera. Every sound is a three.js Audio or
// PositionalAudio attached to the object the core created for it, routed through
// a per-group gain node into the listener, with an optional convolver send for
// `reverbLevel`. Playback state is native-driven: the engine reports it back
// through `syncAudio` and dispatches `ended`.

import * as THREE from 'three';

const REVERB_SECONDS = 1.6;

export class AudioEngine {
  /**
   * @param {THREE.Camera} camera
   * @param {object} deps `resolveUrl`, `dispatch`, `warnOnce`
   */
  constructor(camera, deps) {
    this.camera = camera;
    this.deps = deps;
    this.listener = null;
    /** @type {Map<number, object>} id -> { sound, spec, object, ambient } */
    this.sources = new Map();
    /** @type {Map<string, GainNode>} */
    this.groups = new Map();
    this.masterVolume = 1;
    this.groupVolumes = {};
    this.buffers = new Map();
    this.reverb = null;
    this.reportedState = null;
    this._records = new Float32Array(0);
  }

  /** Creates the listener on first use; without Web Audio the engine is inert. */
  ensureListener() {
    if (this.listener) {
      // P2-B-15: a reload clears the camera's children, and the camera itself
      // changes when a script assigns one, so the listener re-parents on demand.
      if (this.listener.parent !== this.camera) this.camera.add(this.listener);
      return this.listener;
    }
    if (typeof window === 'undefined' || !(window.AudioContext || window.webkitAudioContext)) {
      this.deps.warnOnce('noWebAudio', 'this browser has no Web Audio; sounds are tracked but silent');
      return null;
    }
    this.listener = new THREE.AudioListener();
    this.camera.add(this.listener);
    return this.listener;
  }

  get context() {
    return this.listener ? this.listener.context : null;
  }

  /** `audioMixer`: master volume, group volumes, and the requested engine state. */
  setMixer(spec) {
    if (!spec) return;
    this.masterVolume = spec.masterVolume ?? 1;
    this.groupVolumes = spec.groups || {};
    const listener = this.ensureListener();
    if (!listener) return;
    listener.setMasterVolume(this.masterVolume);
    for (const [name, volume] of Object.entries(this.groupVolumes)) {
      this.groupNode(name).gain.value = volume;
    }
    if (spec.state === 'running') this.resume();
    else if (spec.state === 'suspended' && this.context && this.context.state === 'running') {
      this.context.suspend().then(() => this.reportState());
    }
    this.reportState();
  }

  /** A gain node per mix group, between every sound in it and the listener. */
  groupNode(name) {
    const listener = this.ensureListener();
    if (!listener) return null;
    let node = this.groups.get(name);
    if (!node) {
      node = this.context.createGain();
      node.gain.value = this.groupVolumes[name] ?? 1;
      node.connect(listener.getInput());
      this.groups.set(name, node);
    }
    return node;
  }

  resume() {
    const listener = this.ensureListener();
    if (!listener) return;
    // Browsers start the context suspended until a gesture; the harness and the
    // page's Run button both call this.
    if (this.context.state !== 'running') {
      this.context.resume().then(() => this.reportState(), () => this.reportState());
    }
  }

  /** Tells the core what the engine is really doing (SPEC 14.13 `audioState`). */
  reportState() {
    const state = this.context ? this.context.state : 'suspended';
    const normalised = state === 'running' ? 'running' : 'suspended';
    if (normalised === this.reportedState) return;
    this.reportedState = normalised;
    this.deps.dispatch('audioState', 0, { state: normalised });
  }

  /** `audio`: full state for one sound, or null to remove it. */
  setSource(id, object, spec) {
    if (!spec) {
      this.remove(id);
      return;
    }
    const listener = this.ensureListener();
    let entry = this.sources.get(id);
    const spatial = spec.spatial === true && spec.ambient !== true;

    if (entry && (entry.spatial !== spatial || !listener)) {
      this.remove(id);
      entry = null;
    }
    if (!entry) {
      if (!listener) {
        // No Web Audio: keep the state so the dump stays truthful.
        this.sources.set(id, { sound: null, spec, object, spatial, ambient: spec.ambient === true });
        return;
      }
      const sound = spatial ? new THREE.PositionalAudio(listener) : new THREE.Audio(listener);
      sound.name = '__audio';
      // three connects a new Audio straight to the listener; the group gain sits
      // in between instead.
      object.add(sound);
      entry = { sound, spec, object, spatial, ambient: spec.ambient === true, url: null };
      this.sources.set(id, entry);
    }

    entry.spec = spec;
    entry.object = object;
    entry.ambient = spec.ambient === true;
    const { sound } = entry;
    if (!sound) return;

    sound.setLoop(spec.loop === true);
    sound.setVolume(spec.volume ?? 1);
    if (sound.isPlaying) sound.setPlaybackRate(spec.rate ?? 1);
    else sound.playbackRate = spec.rate ?? 1;
    this.route(entry, spec.group || 'master', spec.reverbLevel ?? 0);

    if (spatial) {
      sound.setRefDistance(spec.refDistance ?? 1);
      sound.setRolloffFactor(spec.rolloff ?? 1);
      sound.setDistanceModel(spec.distanceModel || 'inverse');
      if (spec.cone) sound.setDirectionalCone(spec.cone[0], spec.cone[1], spec.cone[2]);
    }

    if (spec.url && entry.url !== spec.url) {
      entry.url = spec.url;
      this.load(id, entry, spec.url);
    }
    sound.onEnded = () => {
      sound.isPlaying = false;
      this.deps.dispatch('ended', id, {});
    };
  }

  /**
   * Routes a sound into its group gain, with a convolver send for reverb.
   *
   * P2-B-03: `PositionalAudio.getOutput()` returns the **panner**, which is the
   * input of `source -> panner -> gain -> listener`. Rewiring that would sever
   * the gain, so `setVolume` would stop working and the sound would reach the
   * listener down two paths at once. The real output is `sound.gain` for both
   * classes, so that is what is re-pointed at the group.
   */
  route(entry, groupName, reverbLevel) {
    const { sound } = entry;
    const group = this.groupNode(groupName);
    if (!group) return;
    const output = sound.gain;
    if (entry.group !== group) {
      output.disconnect();
      output.connect(group);
      entry.group = group;
      // Disconnecting drops the reverb send with it, so it is rebuilt below.
      if (entry.send) {
        entry.send.disconnect();
        entry.send = null;
      }
      entry.reverbLevel = undefined;
    }
    if (reverbLevel === entry.reverbLevel) return;
    entry.reverbLevel = reverbLevel;
    if (entry.send) {
      entry.send.disconnect();
      entry.send = null;
    }
    if (!reverbLevel) return;
    // reverbLevel is in dB, as RealityKit's SpatialAudioComponent uses it.
    const send = this.context.createGain();
    send.gain.value = Math.min(1, 10 ** (reverbLevel / 20));
    output.connect(send);
    send.connect(this.reverbNode());
    entry.send = send;
  }

  /** One shared convolver, fed by a synthetic decaying-noise impulse response. */
  reverbNode() {
    if (this.reverb) return this.reverb;
    const context = this.context;
    const length = Math.floor(context.sampleRate * REVERB_SECONDS);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.5;
      }
    }
    const convolver = context.createConvolver();
    convolver.buffer = impulse;
    convolver.connect(this.listener.getInput());
    this.reverb = convolver;
    return convolver;
  }

  load(id, entry, url) {
    const wanted = url;
    const resolved = this.deps.resolveUrl(url);
    if (resolved === null) return;
    const cached = this.buffers.get(resolved);
    if (cached) {
      entry.sound.setBuffer(cached);
      if (entry.pendingPlay) this.control(id, 'play', null);
      return;
    }
    if (!this.loader) this.loader = new THREE.AudioLoader();
    this.deps.beginLoad();
    this.loader.load(
      resolved,
      (buffer) => {
        this.deps.endLoad();
        // P2-B-52: the same entry survives a url change, so the url the load
        // started for must still be the one the sound wants.
        if (this.sources.get(id) !== entry || entry.url !== wanted) return;
        this.buffers.set(resolved, buffer);
        entry.sound.setBuffer(buffer);
        if (entry.pendingPlay) {
          entry.pendingPlay = false;
          this.control(id, 'play', null);
        }
      },
      undefined,
      () => {
        this.deps.endLoad();
        if (this.sources.get(id) !== entry || entry.url !== wanted) return;
        this.deps.warnOnce(`audioLoad:${resolved}`, `audio failed to load: ${resolved}`);
      },
    );
  }

  /** `audioControl`: play, pause, stop or seek. */
  control(id, action, value) {
    const entry = this.sources.get(id);
    if (!entry || !entry.sound) return;
    const { sound } = entry;
    if (action === 'play') {
      if (!sound.buffer) {
        // The file is still loading; start as soon as it arrives.
        entry.pendingPlay = true;
        return;
      }
      this.resume();
      if (sound.isPlaying) sound.stop();
      sound.play();
      sound.setPlaybackRate(entry.spec.rate ?? 1);
    } else if (action === 'pause') {
      if (sound.isPlaying) sound.pause();
    } else if (action === 'stop') {
      // P2-B-10: stop returns to the start, so both the seek offset and three's
      // accumulated progress are cleared whether or not it was playing.
      entry.pendingPlay = false;
      if (sound.isPlaying) sound.stop();
      sound.offset = 0;
      sound._progress = 0;
    } else if (action === 'seek') {
      const target = Math.max(0, Number.isFinite(value) ? value : 0);
      const wasPlaying = sound.isPlaying;
      if (wasPlaying) sound.stop();
      sound.offset = target;
      sound._progress = 0;
      if (wasPlaying) sound.play();
    }
  }

  /** Ambient sounds are non-spatial but fade with distance (SPEC 14.1). */
  update() {
    if (!this.listener) return;
    for (const entry of this.sources.values()) {
      if (!entry.ambient || !entry.sound) continue;
      entry.object.updateWorldMatrix(true, false);
      _objectPosition.setFromMatrixPosition(entry.object.matrixWorld);
      this.camera.updateMatrixWorld(true);
      _listenerPosition.setFromMatrixPosition(this.camera.matrixWorld);
      const distance = _objectPosition.distanceTo(_listenerPosition);
      const reference = entry.spec.refDistance ?? 1;
      const falloff = reference / Math.max(reference, distance);
      entry.sound.setVolume((entry.spec.volume ?? 1) * falloff);
    }
  }

  /** Flat `[id, playing, currentTime, duration]` records for `syncAudio`. */
  syncRecords() {
    // Only sounds this engine actually holds a buffer for are reported; a sound
    // whose file never arrived has nothing to say, and the core's own state
    // stands.
    const ids = [...this.sources.keys()].filter((id) => {
      const entry = this.sources.get(id);
      return entry.sound && entry.sound.buffer;
    });
    if (this._records.length !== ids.length * 4) this._records = new Float32Array(ids.length * 4);
    let o = 0;
    for (const id of ids) {
      const entry = this.sources.get(id);
      const sound = entry.sound;
      const playing = !!(sound && sound.isPlaying);
      this._records[o++] = id;
      this._records[o++] = playing ? 1 : 0;
      this._records[o++] = sound ? currentTimeOf(sound) : 0;
      this._records[o++] = sound && sound.buffer ? sound.buffer.duration : 0;
    }
    return this._records;
  }

  /** The consumer-side view of one sound, for the native dump. */
  describe(id) {
    const entry = this.sources.get(id);
    if (!entry) return null;
    const spec = entry.spec;
    const sound = entry.sound;
    return {
      url: spec.url ?? null,
      spatial: entry.spatial,
      ambient: entry.ambient,
      loop: spec.loop === true,
      volume: spec.volume ?? 1,
      rate: spec.rate ?? 1,
      group: spec.group || 'master',
      refDistance: spec.refDistance ?? 1,
      rolloff: spec.rolloff ?? 1,
      distanceModel: spec.distanceModel || 'inverse',
      cone: spec.cone ?? null,
      reverbLevel: spec.reverbLevel ?? 0,
      playing: !!(sound && sound.isPlaying),
      currentTime: sound ? currentTimeOf(sound) : 0,
      duration: sound && sound.buffer ? sound.buffer.duration : 0,
    };
  }

  mixerState() {
    return {
      masterVolume: this.masterVolume,
      groups: { ...this.groupVolumes },
      state: this.context && this.context.state === 'running' ? 'running' : 'suspended',
    };
  }

  remove(id) {
    const entry = this.sources.get(id);
    if (!entry) return;
    this.sources.delete(id);
    if (!entry.sound) return;
    if (entry.sound.isPlaying) entry.sound.stop();
    entry.sound.onEnded = () => {};
    if (entry.send) entry.send.disconnect();
    entry.sound.removeFromParent();
    entry.sound.disconnect();
  }

  reset() {
    for (const id of [...this.sources.keys()]) this.remove(id);
    this.buffers.clear();
    // P2-B-49: a group gain left connected to the listener is an orphan that
    // survives every reload, so each one is disconnected before it is dropped.
    for (const node of this.groups.values()) node.disconnect();
    this.groups.clear();
    if (this.reverb) {
      this.reverb.disconnect();
      this.reverb = null;
    }
    this.masterVolume = 1;
    this.groupVolumes = {};
    this.reportedState = null;
  }

  /** Frees the listener and closes the context; the consumer calls this. */
  dispose() {
    this.reset();
    if (this.listener) {
      this.listener.removeFromParent();
      const context = this.listener.context;
      this.listener = null;
      if (context && typeof context.close === 'function' && context.state !== 'closed') {
        context.close().catch(() => {});
      }
    }
  }
}

const _objectPosition = new THREE.Vector3();
const _listenerPosition = new THREE.Vector3();

/**
 * P2-B-09: three accumulates the paused position into `_progress` and restarts
 * from `_progress + offset`, so both terms are needed or the reported time is
 * the seek offset while paused and under-reports for ever after a resume.
 */
function currentTimeOf(sound) {
  if (!sound.buffer) return 0;
  const base = (sound._progress || 0) + (sound.offset || 0);
  if (!sound.isPlaying) return sound.loop ? base % sound.buffer.duration : Math.min(base, sound.buffer.duration);
  const elapsed = (sound.context.currentTime - sound._startedAt) * sound.playbackRate;
  const time = base + elapsed;
  return sound.loop ? time % sound.buffer.duration : Math.min(time, sound.buffer.duration);
}
