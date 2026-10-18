// ParticleEmitter (SPEC 3.10). An Object3D whose whole configuration is
// mirrored into the `particles` command.

import { Object3D, Vector3, Color } from "../util/three-exports.js";
import { atLeast, clamp, intAtLeast, finite, vector3Array, colorArray, pick } from "../util/sanitize.js";
import { host } from "../host/host.js";
import { objectKeys } from "../util/builtins.js";

/**
 * The hand-tuned parameter sets SPEC 3.10 names. A preset overrides every
 * authored field except `isEmitting`, and the core resolves it here so the
 * object, the wire payload and the dump all report what is rendered rather
 * than leaving each consumer to apply the rule itself (AR-15, AR-33).
 */
const PRESETS = {
  // A bright shell thrown in every direction that falls away and cools.
  fireworks: {
    shape: "point", birthRate: 400, lifetime: 1.4, lifetimeVariation: 0.5,
    speed: 1.6, speedVariation: 0.6, size: 0.012, sizeVariation: 0.006,
    color: 0xffdd66, colorEnd: 0xff2200, opacity: 1, opacityEnd: 0,
    spreadAngle: Math.PI, acceleration: [0, -1.6, 0], loops: true,
  },
  // A short, sharp hemisphere of debris. One shot, not a loop.
  impact: {
    shape: "point", birthRate: 600, lifetime: 0.45, lifetimeVariation: 0.2,
    speed: 1.8, speedVariation: 0.8, size: 0.008, sizeVariation: 0.004,
    color: 0xffffff, colorEnd: 0x998877, opacity: 1, opacityEnd: 0,
    spreadAngle: Math.PI / 2, acceleration: [0, -5, 0], loops: false,
  },
  // Slow motes drifting up out of a small volume, shifting hue as they go.
  magic: {
    shape: "sphere", shapeSize: [0.1, 0.1, 0.1], birthRate: 220, lifetime: 1.8,
    lifetimeVariation: 0.6, speed: 0.18, speedVariation: 0.1, size: 0.014, sizeVariation: 0.008,
    color: 0x66ccff, colorEnd: 0xcc66ff, opacity: 1, opacityEnd: 0,
    spreadAngle: Math.PI, acceleration: [0, 0.15, 0], loops: true,
  },
  // Drops released across a wide sheet, accelerating straight down.
  rain: {
    shape: "box", shapeSize: [1, 0.05, 1], birthRate: 700, lifetime: 1.1,
    lifetimeVariation: 0.1, speed: 0, speedVariation: 0, size: 0.004, sizeVariation: 0.002,
    color: 0xaaccff, colorEnd: null, opacity: 0.85, opacityEnd: 0.85,
    spreadAngle: 0, acceleration: [0, -9.8, 0], loops: true,
  },
  // Large soft flakes falling slowly and wandering.
  snow: {
    shape: "box", shapeSize: [1, 0.05, 1], birthRate: 200, lifetime: 3.5,
    lifetimeVariation: 1, speed: 0.06, speedVariation: 0.04, size: 0.012, sizeVariation: 0.006,
    color: 0xffffff, colorEnd: null, opacity: 0.95, opacityEnd: 0.5,
    spreadAngle: Math.PI, acceleration: [0, -0.12, 0], loops: true,
  },
  // A wide spray of hot embers that cool to red as they fall.
  sparks: {
    shape: "point", birthRate: 500, lifetime: 0.9, lifetimeVariation: 0.4,
    speed: 0.9, speedVariation: 0.5, size: 0.01, sizeVariation: 0.006,
    color: 0xffcc55, colorEnd: 0xff3300, opacity: 1, opacityEnd: 0,
    spreadAngle: Math.PI, acceleration: [0, -2.5, 0], loops: true,
  },
  // Big translucent puffs rising and thinning out.
  smoke: {
    shape: "sphere", shapeSize: [0.04, 0.04, 0.04], birthRate: 60, lifetime: 3,
    lifetimeVariation: 1, speed: 0.12, speedVariation: 0.06, size: 0.07, sizeVariation: 0.04,
    color: 0x999999, colorEnd: 0x333333, opacity: 0.35, opacityEnd: 0,
    spreadAngle: 0.5, acceleration: [0, 0.18, 0], loops: true,
  },
};

const SHAPES = new Set(["point", "sphere", "box", "cone", "plane"]);


export class ParticleEmitter extends Object3D {
  constructor(options = {}) {
    super();
    this.type = "ParticleEmitter";
    this.isParticleEmitter = true;

    const preset = pick(options, "preset", null);
    if (preset !== null && PRESETS[preset] === undefined) {
      throw new TypeError(`ParticleEmitter.preset "${preset}" is not a known preset`);
    }
    const shape = pick(options, "shape", "point");
    if (!SHAPES.has(shape)) {
      throw new TypeError(`ParticleEmitter.shape "${shape}" is not a known emitter shape`);
    }

    this.preset = preset;
    this.shape = shape;
    this.shapeSize = pick(options, "shapeSize", new Vector3(0.1, 0.1, 0.1));
    this.birthRate = pick(options, "birthRate", 100);
    this.lifetime = pick(options, "lifetime", 1);
    this.lifetimeVariation = pick(options, "lifetimeVariation", 0);
    this.speed = pick(options, "speed", 1);
    this.speedVariation = pick(options, "speedVariation", 0);
    this.size = pick(options, "size", 0.01);
    this.sizeVariation = pick(options, "sizeVariation", 0);
    this.color = new Color(pick(options, "color", 0xffffff));
    const colorEnd = pick(options, "colorEnd", null);
    this.colorEnd = colorEnd === null ? null : new Color(colorEnd);
    this.opacity = pick(options, "opacity", 1);
    this.opacityEnd = pick(options, "opacityEnd", 0);
    this.spreadAngle = pick(options, "spreadAngle", 0);
    this.acceleration = pick(options, "acceleration", new Vector3(0, -1, 0));
    this.isEmitting = pick(options, "isEmitting", true) !== false;
    this.burstCount = pick(options, "burstCount", 0);
    this.loops = pick(options, "loops", true) !== false;
    this.texture = pick(options, "texture", null);

    // The preset wins over everything the author wrote except `isEmitting`
    // (SPEC 3.10), and it is applied here so `emitter.loops`, the `particles`
    // payload and `dump()` all report the same thing.
    if (preset !== null) this.applyPreset(preset);
  }

  /** Writes a preset's field values onto this emitter. `isEmitting` is kept. */
  applyPreset(name) {
    const values = PRESETS[name];
    if (values === undefined) return this;
    this.preset = name;
    for (const key of objectKeys(values)) {
      const value = values[key];
      if (key === "shapeSize" || key === "acceleration") {
        this[key] = new Vector3(value[0], value[1], value[2]);
      } else if (key === "color") {
        this.color = new Color(value);
      } else if (key === "colorEnd") {
        this.colorEnd = value === null ? null : new Color(value);
      } else {
        this[key] = value;
      }
    }
    return this;
  }

  burst() {
    const runtime = host();
    if (runtime && runtime.canCommand(this, "ParticleEmitter.burst")) {
      runtime.queueCommand(["particlesBurst", runtime.idForObject(this)], this);
    }
    return this;
  }

  toJSON(textureIdFor) {
    // Rates, counts and sizes are non-negative; opacities are 0..1.
    return {
      preset: this.preset,
      shape: this.shape,
      shapeSize: [
        atLeast(this.shapeSize.x, 0, 0.1),
        atLeast(this.shapeSize.y, 0, 0.1),
        atLeast(this.shapeSize.z, 0, 0.1),
      ],
      birthRate: atLeast(this.birthRate, 0, 100),
      lifetime: atLeast(this.lifetime, 0, 1),
      lifetimeVariation: atLeast(this.lifetimeVariation, 0, 0),
      speed: finite(this.speed, 1),
      speedVariation: atLeast(this.speedVariation, 0, 0),
      size: atLeast(this.size, 0, 0.01),
      sizeVariation: atLeast(this.sizeVariation, 0, 0),
      color: colorArray(this.color, 1),
      colorEnd: this.colorEnd ? colorArray(this.colorEnd, 1) : null,
      opacity: clamp(this.opacity, 0, 1, 1),
      opacityEnd: clamp(this.opacityEnd, 0, 1, 0),
      spreadAngle: clamp(this.spreadAngle, 0, Math.PI, 0),
      acceleration: vector3Array(this.acceleration, 0, -1, 0),
      isEmitting: this.isEmitting,
      burstCount: intAtLeast(this.burstCount, 0, 0),
      loops: this.loops,
      texture: this.texture && textureIdFor ? textureIdFor(this.texture) : null,
    };
  }
}

// ParticleEmitter reuses Object3D.opacity for the particle start opacity, so
// the emitter itself never emits a separate `opacity` command.
ParticleEmitter.prototype.isParticleEmitter = true;
