// Portal (SPEC 3.11). A Mesh carrying a PlaneGeometry whose surface shows the
// contents of a separate world Group.

import { MeshBasicMaterial } from "./three-exports.js";
import { PlaneGeometry } from "./geometry.js";
import { Mesh } from "./scene-classes.js";
import { extent } from "./sanitize.js";

export class Portal extends Mesh {
  constructor(options = {}) {
    const width = extent(options.width === undefined ? 0.5 : options.width, 0.5);
    const height = extent(options.height === undefined ? 0.5 : options.height, 0.5);
    super(new PlaneGeometry(width, height), new MeshBasicMaterial({ color: 0xffffff }));
    this.type = "Portal";
    this.isPortal = true;
    this._width = width;
    this._height = height;
    this.crossing = options.crossing === true;
    this.world = options.world === undefined ? null : options.world;
    if (this.world && !this.world.isObject3D) {
      throw new TypeError("Portal.world must be a Group or other Object3D");
    }
  }

  get width() {
    return this._width;
  }

  set width(value) {
    const next = extent(value, this._width);
    if (next === this._width) return;
    this._width = next;
    this.#rebuild();
  }

  get height() {
    return this._height;
  }

  set height(value) {
    const next = extent(value, this._height);
    if (next === this._height) return;
    this._height = next;
    this.#rebuild();
  }

  /** Both backends must agree on the portal surface, so the plane is rebuilt. */
  #rebuild() {
    const previous = this.geometry;
    this.geometry = new PlaneGeometry(this._width, this._height);
    if (previous && typeof previous.dispose === "function") previous.dispose();
  }

  toJSON(idFor) {
    return {
      worldId: this.world ? idFor(this.world) : null,
      width: this.width,
      height: this.height,
      crossing: this.crossing,
    };
  }
}

export function portalJSONEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.worldId === b.worldId && a.width === b.width && a.height === b.height && a.crossing === b.crossing;
}
