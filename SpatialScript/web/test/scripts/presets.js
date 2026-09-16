// All seven particle presets side by side, for eyeballing against the macOS host.
const S = require("spatial");
const scene = new S.Scene();
scene.add(new S.AmbientLight(0xffffff, 1));
const sun = new S.DirectionalLight(0xffffff, 2); sun.position.set(1, 2, 1); scene.add(sun);

const names = ["fireworks", "sparks", "impact", "magic", "rain", "snow", "smoke"];
names.forEach((preset, i) => {
  const fx = new S.ParticleEmitter({ preset });
  fx.name = preset;
  fx.position.set((i - (names.length - 1) / 2) * 1.3, 0, 0);
  scene.add(fx);

  const label = new S.Mesh(
    new S.TextGeometry(preset, { size: 0.09, depth: 0.004 }),
    new S.MeshStandardMaterial({ color: 0xffffff, emissive: 0x555555 }),
  );
  label.geometry.computeBoundingBox();
  const b = label.geometry.boundingBox;
  label.geometry.translate(-(b.max.x + b.min.x) / 2, 0, 0);
  label.name = preset + "-label";
  label.position.set(fx.position.x, -1.15, 0);
  scene.add(label);
});

S.mount(scene);
