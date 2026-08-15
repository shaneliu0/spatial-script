// Assets (SPEC 3.12) and ImageBasedLight (SPEC 3.6).

import { Group, Box3 } from "./three-exports.js";
import { host } from "./host.js";

export class AssetGroup extends Group {
  constructor(urls) {
    super();
    this.type = "Asset";
    this.isAsset = true;
    this.urls = {
      usdz: urls.usdz === undefined ? null : urls.usdz,
      reality: urls.reality === undefined ? null : urls.reality,
      glb: urls.glb === undefined ? null : urls.glb,
      gltf: urls.gltf === undefined ? null : urls.gltf,
    };
    this.animations = [];
    this.boundingBox = new Box3();
    this.loaded = false;
    this._resolve = null;
    this._reject = null;
    this._currentAnimation = null;
  }

  playAnimation(name, options = {}) {
    const runtime = host();
    const loop = options.loop === undefined ? true : options.loop !== false;
    const speed = options.speed === undefined ? 1 : options.speed;
    this._currentAnimation = { name, loop, speed };
    if (runtime && runtime.canCommand(this, "AssetGroup.playAnimation")) {
      runtime.queueCommand(["assetAnimation", runtime.idForObject(this), name, loop, speed]);
    }
    return this;
  }

  stopAnimation() {
    const runtime = host();
    this._currentAnimation = null;
    if (runtime && runtime.canCommand(this, "AssetGroup.stopAnimation")) {
      runtime.queueCommand(["assetAnimation", runtime.idForObject(this), null, false, 1]);
    }
    return this;
  }

  toJSON() {
    return { ...this.urls };
  }
}

export class ImageBasedLight {
  constructor(url, intensity = 1) {
    this.url = url;
    this.intensity = intensity;
  }

  toJSON() {
    return { url: this.url, intensity: this.intensity };
  }
}

export function environmentJSONEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.url === b.url && a.intensity === b.intensity;
}
