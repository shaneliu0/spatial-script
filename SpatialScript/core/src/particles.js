// ParticleEmitter (SPEC 3.10). An Object3D whose whole configuration is
// mirrored into the `particles` command.

import { Object3D, Vector3, Color } from "./three-exports.js";
import { atLeast, clamp, intAtLeast, finite, vector3Array, colorArray, pick } from "./sanitize.js";
import { host } from "./host.js";

const PRESETS = new Set(["fireworks", "impact", "magic", "rain", "snow", "sparks", "smoke"]);
const SHAPES = new Set(["point", "sphere", "box", "cone", "plane"]);


export class ParticleEmitter extends Object3D {
  constructor(options = {}) {
    super();
    this.type = "ParticleEmitter";
    this.isParticleEmitter = true;

    const preset = pick(options, "preset", null);
    if (preset !== null && !PRESETS.has(preset)) {
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
  }

  burst() {
    const runtime = host();
    if (runtime && runtime.canCommand(this, "ParticleEmitter.burst")) {
      runtime.queueCommand(["particlesBurst", runtime.idForObject(this)]);
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
