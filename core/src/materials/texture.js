// Texture and TextureLoader (SPEC 3.5). Deliberately not three's Texture:
// three's TextureLoader/ImageLoader reach for `document` and `Image`, which the
// core must never touch. Decoding happens in the consumer; the core only owns
// the sampler state and the URL.

import { EventDispatcher, Vector2, ClampToEdgeWrapping } from "../util/three-exports.js";
import { host } from "../host/host.js";

export class Texture extends EventDispatcher {
  constructor(url = null) {
    super();
    this.isTexture = true;
    this.type = "Texture";
    this.url = url;
    // Set when containment refuses the url: `url` becomes null and this keeps
    // what the script asked for (SPEC 3.5, AR-34).
    this.requestedUrl = null;
    this.repeat = new Vector2(1, 1);
    this.offset = new Vector2(0, 0);
    this.wrapS = ClampToEdgeWrapping;
    this.wrapT = ClampToEdgeWrapping;
    this.flipY = true;
    this.needsUpdate = false;
    this.loaded = false;
    this.error = null;
    this.disposed = false;
    // Set when the runtime assigns a command-stream id.
    this._onLoad = null;
    this._onError = null;
    this._promise = null;
    const runtime = host();
    if (runtime) {
      runtime.registerTexture(this);
      // Containment runs now, not at the first flush, so a script that checks
      // `texture.url` right after `TextureLoader().load()` sees the refusal
      // (SPEC 3.5, AR-34). A url assigned later is checked at the next flush.
      if (this.url !== null && this.url !== undefined && runtime.resolveUrl(this.url) === null) {
        this.requestedUrl = this.url;
        this.url = null;
      }
    }
  }

  dispose() {
    this.disposed = true;
    const runtime = host();
    if (runtime) runtime.disposeTexture(this);
  }

  clone() {
    const copy = new Texture(this.url);
    copy.repeat.copy(this.repeat);
    copy.offset.copy(this.offset);
    copy.wrapS = this.wrapS;
    copy.wrapT = this.wrapT;
    copy.flipY = this.flipY;
    return copy;
  }
}

export class TextureLoader {
  constructor() {
    this.path = "";
  }

  setPath(path) {
    this.path = path === undefined || path === null ? "" : String(path);
    return this;
  }

  load(url, onLoad, onProgress, onError) {
    const texture = new Texture(this.path ? this.path + url : url);
    texture._onLoad = typeof onLoad === "function" ? onLoad : null;
    texture._onError = typeof onError === "function" ? onError : null;
    // The core has no byte counter, so onProgress is accepted for three.js
    // signature parity and never called.
    return texture;
  }

  loadAsync(url, onProgress) {
    const texture = this.load(url, undefined, onProgress, undefined);
    const promise = new Promise((resolve, reject) => {
      texture._promise = { resolve: () => resolve(texture), reject };
    });
    return promise;
  }
}
