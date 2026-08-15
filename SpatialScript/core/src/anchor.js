// Anchor (SPEC 3.11). A Group whose anchoring request is mirrored into the
// `anchor` command. The consumer reports success through the `anchored` and
// `unanchored` events.

import { Group, Vector2, Matrix4 } from "./three-exports.js";
import { atLeast, finite } from "./sanitize.js";

const PLANES = new Set(["horizontal", "vertical", "any"]);
const HANDS = new Set(["left", "right"]);
const HAND_LOCATIONS = new Set(["palm", "wrist", "indexFingerTip", "thumbTip", "aboveHand"]);

export class Anchor extends Group {
  constructor(target = "head") {
    super();
    this.type = "Anchor";
    this.isAnchor = true;
    this.isAnchored = false;
    this.request = normalizeRequest(target);
  }

  toJSON() {
    return this.request;
  }
}

function normalizeRequest(target) {
  if (typeof target === "string") {
    if (target !== "head") {
      throw new TypeError(`Anchor("${target}") is not a known anchor shorthand; use "head"`);
    }
    return { kind: "head" };
  }
  if (target === null || typeof target !== "object") {
    throw new TypeError("Anchor expects \"head\" or an options object");
  }

  if (target.plane !== undefined) {
    if (!PLANES.has(target.plane)) {
      throw new TypeError(`Anchor plane "${target.plane}" must be horizontal, vertical or any`);
    }
    const bounds = target.minimumBounds instanceof Vector2 ? target.minimumBounds : new Vector2(0.2, 0.2);
    return {
      kind: "plane",
      plane: target.plane,
      minimumBounds: [atLeast(bounds.x, 0, 0.2), atLeast(bounds.y, 0, 0.2)],
    };
  }

  if (target.hand !== undefined) {
    if (!HANDS.has(target.hand)) throw new TypeError(`Anchor hand "${target.hand}" must be left or right`);
    const location = target.location === undefined ? "palm" : target.location;
    if (!HAND_LOCATIONS.has(location)) {
      throw new TypeError(`Anchor hand location "${location}" is not supported`);
    }
    return { kind: "hand", hand: target.hand, location };
  }

  if (target.image !== undefined) {
    return { kind: "image", image: String(target.image) };
  }

  if (target.world !== undefined) {
    const matrix = target.world instanceof Matrix4 ? target.world : new Matrix4();
    const identity = new Matrix4().elements;
    return {
      kind: "world",
      matrix: Array.from(matrix.elements, (value, index) => finite(value, identity[index])),
    };
  }

  throw new TypeError("Anchor options must name one of plane, hand, image or world");
}

export function anchorJSONEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "head":
      return true;
    case "plane":
      return (
        a.plane === b.plane &&
        a.minimumBounds[0] === b.minimumBounds[0] &&
        a.minimumBounds[1] === b.minimumBounds[1]
      );
    case "hand":
      return a.hand === b.hand && a.location === b.location;
    case "image":
      return a.image === b.image;
    case "world": {
      for (let i = 0; i < 16; i += 1) if (a.matrix[i] !== b.matrix[i]) return false;
      return true;
    }
    default:
      return false;
  }
}
