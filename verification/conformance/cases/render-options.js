const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const marker = new S.Group();
marker.name = "marker";
scene.add(marker);

// SPEC 14.11: all three are kept and reported; adaptiveResolution only acts on
// visionOS, so anywhere else it warns.
S.render.adaptiveResolution = true;
S.environmentLighting.intensityExponent = 1.5;
S.debug.modelView = "normal";

marker.userData.adaptive = S.render.adaptiveResolution;
marker.userData.exponent = S.environmentLighting.intensityExponent;
marker.userData.modelView = S.debug.modelView;

S.onFrame(() => {
  // A value outside the documented list is refused with a warning.
  if (S.time.frame === 2) S.debug.modelView = "sparkle";
  if (S.time.frame === 3) S.debug.modelView = "uv";
});

S.mount(scene);
