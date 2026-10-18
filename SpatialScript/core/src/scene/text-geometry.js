// TextGeometry (SPEC 3.3). Vertices are generated in the core with a bundled
// default font so the web consumer can render them and computeBoundingBox()
// works. The RealityKit consumer regenerates the glyphs natively from
// `parameters` and ignores the buffers.

import { Font } from "three/examples/jsm/loaders/FontLoader.js";
import { TextGeometry as ThreeTextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { SpatialUnsupportedError } from "../util/errors.js";
import { extent } from "../util/sanitize.js";
import defaultFontData from "./fonts/helvetiker_regular.typeface.json";

let defaultFont = null;

function getDefaultFont() {
  if (defaultFont === null) defaultFont = new Font(defaultFontData);
  return defaultFont;
}

export class TextGeometry extends ThreeTextGeometry {
  constructor(text = "", options = {}) {
    const size = extent(options.size === undefined ? 0.1 : options.size, 0.1);
    const depth = extent(options.depth === undefined ? 0.01 : options.depth, 0.01);
    const font = options.font === undefined ? "default" : options.font;

    if (font !== "default") {
      throw new SpatialUnsupportedError(
        `TextGeometry font "${font}" is not available; only "default" is bundled`,
        "TextGeometry.font",
        null,
      );
    }

    super(String(text), {
      font: getDefaultFont(),
      size,
      depth,
      curveSegments: 6,
      bevelEnabled: false,
    });

    this.type = "TextGeometry";
    // Replace the ExtrudeGeometry parameters with the SpatialScript-shaped
    // ones the command stream carries.
    this.parameters = { text: String(text), size, depth, font: "default" };
  }
}
