// CPU point-sprite particle emitter (SPEC 3.10).
// Particles are simulated in world space and written into the emitter's local
// space each frame, so a moving emitter leaves a trail and portal worlds still
// clip their particles correctly.

import * as THREE from 'three';

const MAX_PARTICLES = 20000;

/** Deterministic PRNG so a fixed tick sequence produces identical screenshots. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hand-tuned stand-ins for the RealityKit presets, matched by eye against the
 * macOS host's renders: direction and spread first, then size, lifetime and fade.
 * A preset replaces every field except `isEmitting` (SPEC 3.10). Variations are
 * absolute, in the same units as the value they vary.
 */
export const PRESETS = {
  // A bright shell thrown in every direction that falls away and cools.
  fireworks: {
    shape: 'point', birthRate: 400, lifetime: 1.4, lifetimeVariation: 0.5,
    speed: 1.6, speedVariation: 0.6, size: 0.012, sizeVariation: 0.006,
    color: 0xffdd66, colorEnd: 0xff2200, opacity: 1, opacityEnd: 0,
    spreadAngle: Math.PI, acceleration: [0, -1.6, 0], loops: true,
  },
  // A short, sharp hemisphere of debris.
  impact: {
    shape: 'point', birthRate: 600, lifetime: 0.45, lifetimeVariation: 0.2,
    speed: 1.8, speedVariation: 0.8, size: 0.008, sizeVariation: 0.004,
    color: 0xffffff, colorEnd: 0x998877, opacity: 1, opacityEnd: 0,
    spreadAngle: Math.PI / 2, acceleration: [0, -5, 0], loops: false,
  },
  // Slow motes drifting up out of a small volume, shifting hue as they go.
  magic: {
    shape: 'sphere', shapeSize: [0.1, 0.1, 0.1], birthRate: 220, lifetime: 1.8,
    lifetimeVariation: 0.6, speed: 0.18, speedVariation: 0.1, size: 0.014, sizeVariation: 0.008,
    color: 0x66ccff, colorEnd: 0xcc66ff, opacity: 1, opacityEnd: 0,
    spreadAngle: Math.PI, acceleration: [0, 0.15, 0], loops: true,
  },
  // Drops released across a wide sheet, accelerating straight down.
  rain: {
    shape: 'box', shapeSize: [1, 0.05, 1], birthRate: 700, lifetime: 1.1,
    lifetimeVariation: 0.1, speed: 0, speedVariation: 0, size: 0.004, sizeVariation: 0.002,
    color: 0xaaccff, colorEnd: null, opacity: 0.85, opacityEnd: 0.85,
    spreadAngle: 0, acceleration: [0, -9.8, 0], loops: true,
  },
  // Large soft flakes falling slowly and wandering.
  snow: {
    shape: 'box', shapeSize: [1, 0.05, 1], birthRate: 200, lifetime: 3.5,
    lifetimeVariation: 1, speed: 0.06, speedVariation: 0.04, size: 0.012, sizeVariation: 0.006,
    color: 0xffffff, colorEnd: null, opacity: 0.95, opacityEnd: 0.5,
    spreadAngle: Math.PI, acceleration: [0, -0.12, 0], loops: true,
  },
  // A wide spray of hot embers that cool to red as they fall.
  sparks: {
    shape: 'point', birthRate: 500, lifetime: 0.9, lifetimeVariation: 0.4,
    speed: 0.9, speedVariation: 0.5, size: 0.01, sizeVariation: 0.006,
    color: 0xffcc55, colorEnd: 0xff3300, opacity: 1, opacityEnd: 0,
    spreadAngle: Math.PI, acceleration: [0, -2.5, 0], loops: true,
  },
  // Big translucent puffs rising and thinning out.
  smoke: {
    shape: 'sphere', shapeSize: [0.04, 0.04, 0.04], birthRate: 60, lifetime: 3,
    lifetimeVariation: 1, speed: 0.12, speedVariation: 0.06, size: 0.07, sizeVariation: 0.04,
    color: 0x999999, colorEnd: 0x333333, opacity: 0.35, opacityEnd: 0,
    spreadAngle: 0.5, acceleration: [0, 0.18, 0], loops: true,
  },
};

const DEFAULTS = {
  preset: null,
  shape: 'point',
  shapeSize: [0.1, 0.1, 0.1],
  birthRate: 100,
  lifetime: 1,
  lifetimeVariation: 0,
  speed: 1,
  speedVariation: 0,
  size: 0.01,
  sizeVariation: 0,
  color: 0xffffff,
  colorEnd: null,
  opacity: 1,
  opacityEnd: 0,
  spreadAngle: 0,
  acceleration: [0, -1, 0],
  isEmitting: true,
  burstCount: 0,
  loops: true,
  texture: null,
};

const VERTEX_SHADER = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.0, aSize * (uScale / max(0.0001, -mv.z)));
  gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT_SHADER = `
uniform sampler2D uMap;
uniform float uHasMap;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord;
  float alpha = vAlpha;
  if (uHasMap > 0.5) {
    vec4 t = texture2D(uMap, uv);
    gl_FragColor = vec4(vColor * t.rgb, alpha * t.a);
  } else {
    // Soft round sprite when no texture is supplied.
    float d = length(uv - vec2(0.5));
    float falloff = smoothstep(0.5, 0.15, d);
    if (falloff <= 0.001) discard;
    gl_FragColor = vec4(vColor, alpha * falloff);
  }
  if (gl_FragColor.a <= 0.001) discard;
}`;

export class ParticleEmitter {
  /**
   * @param {THREE.Object3D} owner the emitter object in the scene graph
   * @param {number} seed
   */
  constructor(owner, seed = 1) {
    this.owner = owner;
    this.random = mulberry32(seed);
    this.config = { ...DEFAULTS };
    this.elapsed = 0;
    this.emitAccumulator = 0;
    this.count = 0;
    this.capacity = 0;
    this._inverse = new THREE.Matrix4();
    this._world = new THREE.Vector3();

    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 300 },
        uMap: { value: null },
        uHasMap: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });
    /** Multiplied into every particle's alpha, from Object3D.opacity (SPEC 3.2). */
    this.opacityScale = 1;
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.name = '__particles';
    // Attached to the emitter, but positions are written in emitter-local space.
    owner.add(this.points);
    this._allocate(256);
  }

  dispose() {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  _allocate(capacity) {
    capacity = Math.min(MAX_PARTICLES, Math.max(capacity, 16));
    if (capacity <= this.capacity) return;
    this.capacity = capacity;
    this.px = resize(this.px, capacity);
    this.py = resize(this.py, capacity);
    this.pz = resize(this.pz, capacity);
    this.vx = resize(this.vx, capacity);
    this.vy = resize(this.vy, capacity);
    this.vz = resize(this.vz, capacity);
    this.age = resize(this.age, capacity);
    this.life = resize(this.life, capacity);
    this.baseSize = resize(this.baseSize, capacity);

    // Replacing the attributes on a live geometry would strand their GPU buffers,
    // so the renderer is told to release the current set first. The buffers are
    // re-uploaded from the new attributes on the next render.
    if (this.geometry.getAttribute('position')) this.geometry.dispose();

    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.alphas = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
  }

  /** Applies a full emitter JSON payload (`particles` opcode). */
  configure(spec, resolveTexture) {
    const next = { ...DEFAULTS, ...(spec || {}) };
    if (next.preset && PRESETS[next.preset]) {
      // A preset overrides every field except isEmitting (SPEC 3.10).
      const isEmitting = next.isEmitting;
      Object.assign(next, DEFAULTS, PRESETS[next.preset], { preset: next.preset, isEmitting });
    }
    this.config = next;
    this.colorStart = toColor(next.color);
    this.colorFinish = next.colorEnd === null || next.colorEnd === undefined
      ? null
      : toColor(next.colorEnd);

    const perSecond = Math.max(0, next.birthRate);
    const maxLife = Math.max(0.01, next.lifetime + Math.max(0, next.lifetimeVariation));
    this._allocate(Math.ceil(perSecond * maxLife) + Math.max(0, next.burstCount) + 64);

    const tex = resolveTexture ? resolveTexture(next.texture) : null;
    this.material.uniforms.uMap.value = tex || null;
    this.material.uniforms.uHasMap.value = tex ? 1 : 0;
    this.material.needsUpdate = true;
  }

  burst() {
    const n = Math.max(0, this.config.burstCount || 0);
    for (let i = 0; i < n; i++) this._spawn();
  }

  _emissionOffset(out) {
    const c = this.config;
    const s = c.shapeSize || [0.1, 0.1, 0.1];
    const sx = arrAt(s, 0), sy = arrAt(s, 1), sz = arrAt(s, 2);
    const r = this.random;
    switch (c.shape) {
      case 'sphere': {
        const u = r() * 2 - 1;
        const theta = r() * Math.PI * 2;
        const rad = Math.cbrt(r());
        const sq = Math.sqrt(1 - u * u);
        out.set(sq * Math.cos(theta) * rad * sx, u * rad * sy, sq * Math.sin(theta) * rad * sz);
        break;
      }
      case 'box':
        out.set((r() - 0.5) * sx, (r() - 0.5) * sy, (r() - 0.5) * sz);
        break;
      case 'plane':
        out.set((r() - 0.5) * sx, 0, (r() - 0.5) * sz);
        break;
      case 'cone': {
        const theta = r() * Math.PI * 2;
        const rad = Math.sqrt(r()) * sx * 0.5;
        out.set(Math.cos(theta) * rad, 0, Math.sin(theta) * rad);
        break;
      }
      default:
        out.set(0, 0, 0);
    }
    return out;
  }

  /**
   * SPEC 3.10: `spreadAngle` is the cone half-angle around +Y and applies to
   * every emission shape; the shape only decides where a particle is born. A
   * half-angle of PI is a full sphere, so `sparks` and `fireworks` spray in all
   * directions the way the RealityKit presets do.
   */
  _direction(out) {
    const spread = this.config.spreadAngle || 0;
    if (spread <= 0) {
      out.set(0, 1, 0);
      return out;
    }
    const random = this.random;
    // Uniform over the spherical cap, so the cone fills instead of hollowing out.
    const cosMin = Math.cos(Math.min(Math.PI, spread));
    const cosTheta = 1 - random() * (1 - cosMin);
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = random() * Math.PI * 2;
    out.set(sinTheta * Math.cos(phi), cosTheta, sinTheta * Math.sin(phi));
    return out;
  }

  _spawn() {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    const c = this.config;
    const r = this.random;
    const offset = _tmpA;
    this._emissionOffset(offset);
    const dir = _tmpB;
    this._direction(dir);

    // Emission happens in the emitter's world frame.
    this.owner.updateWorldMatrix(true, false);
    offset.applyMatrix4(this.owner.matrixWorld);
    dir.transformDirection(this.owner.matrixWorld);

    // RealityKit's ParticleEmitterComponent takes these variations in the same
    // units as the value they vary, so speed, lifetime and size do too.
    const speed = c.speed + (r() * 2 - 1) * (c.speedVariation || 0);
    this.px[i] = offset.x; this.py[i] = offset.y; this.pz[i] = offset.z;
    this.vx[i] = dir.x * speed; this.vy[i] = dir.y * speed; this.vz[i] = dir.z * speed;
    this.age[i] = 0;
    this.life[i] = Math.max(0.01, c.lifetime + (r() * 2 - 1) * (c.lifetimeVariation || 0));
    this.baseSize[i] = Math.max(0, c.size + (r() * 2 - 1) * (c.sizeVariation || 0));
  }

  _kill(i) {
    const last = --this.count;
    if (i === last) return;
    this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
    this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.baseSize[i] = this.baseSize[last];
  }

  update(dt) {
    const c = this.config;
    this.elapsed += dt;

    // `loops: false` emits for a single lifetime and then stops.
    const withinWindow = c.loops !== false || this.elapsed <= c.lifetime;
    if (c.isEmitting !== false && withinWindow && c.birthRate > 0) {
      this.emitAccumulator += c.birthRate * dt;
      let budget = Math.floor(this.emitAccumulator);
      this.emitAccumulator -= budget;
      while (budget-- > 0) this._spawn();
    }

    const ax = arrAt(c.acceleration, 0);
    const ay = arrAt(c.acceleration, 1);
    const az = arrAt(c.acceleration, 2);
    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this._kill(i);
        i--;
        continue;
      }
      this.vx[i] += ax * dt; this.vy[i] += ay * dt; this.vz[i] += az * dt;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
    }
    this._writeBuffers();
  }

  _writeBuffers() {
    const c = this.config;
    this.owner.updateWorldMatrix(true, false);
    this._inverse.copy(this.owner.matrixWorld).invert();
    const start = this.colorStart || new THREE.Color(1, 1, 1);
    const finish = this.colorFinish;
    const o0 = c.opacity ?? 1;
    const o1 = c.opacityEnd ?? 0;
    for (let i = 0; i < this.count; i++) {
      const t = Math.min(1, this.age[i] / this.life[i]);
      this._world.set(this.px[i], this.py[i], this.pz[i]).applyMatrix4(this._inverse);
      this.positions[i * 3 + 0] = this._world.x;
      this.positions[i * 3 + 1] = this._world.y;
      this.positions[i * 3 + 2] = this._world.z;
      if (finish) {
        this.colors[i * 3 + 0] = start.r + (finish.r - start.r) * t;
        this.colors[i * 3 + 1] = start.g + (finish.g - start.g) * t;
        this.colors[i * 3 + 2] = start.b + (finish.b - start.b) * t;
      } else {
        this.colors[i * 3 + 0] = start.r;
        this.colors[i * 3 + 1] = start.g;
        this.colors[i * 3 + 2] = start.b;
      }
      this.alphas[i] = (o0 + (o1 - o0) * t) * this.opacityScale;
      this.sizes[i] = this.baseSize[i];
    }
    this.geometry.setDrawRange(0, this.count);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
  }

  /**
   * A particle's `size` is a diameter in metres, so its pixel size is
   * `size * height / (2 * tan(fov / 2) * distance)`. Passing only half the
   * viewport height, as the shader's scale used to be, made every particle a
   * fraction of its real size.
   */
  setViewportScale(height, fov) {
    const halfFov = (fov * Math.PI) / 360;
    this.material.uniforms.uScale.value = height / (2 * Math.tan(halfFov));
  }

  /** The accumulated Object3D.opacity for this emitter's subtree. */
  setOpacity(value) {
    this.opacityScale = value;
  }
}

const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();

function resize(existing, capacity) {
  const next = new Float32Array(capacity);
  if (existing) next.set(existing.subarray(0, Math.min(existing.length, capacity)));
  return next;
}

function arrAt(v, i) {
  if (!v) return 0;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return v[i] || 0;
  return [v.x, v.y, v.z][i] || 0;
}

/** Command-stream colours are linear sRGB triples; preset colours are sRGB hex. */
function toColor(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return new THREE.Color().setRGB(value[0], value[1], value[2], THREE.LinearSRGBColorSpace);
  }
  if (typeof value === 'number') return new THREE.Color().setHex(value, THREE.SRGBColorSpace);
  if (value && value.isColor) return value.clone();
  return new THREE.Color(1, 1, 1);
}
