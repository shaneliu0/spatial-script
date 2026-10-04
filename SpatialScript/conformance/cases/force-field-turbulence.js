const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const storm = new S.TurbulenceForceField({ strength: 1.5, noiseScale: 0.25, radius: 5 });
storm.name = "storm";
scene.add(storm);

const gust = new S.TurbulenceForceField();
gust.name = "gust";
scene.add(gust);

S.onFrame(() => {
  if (S.time.frame === 2) {
    gust.strength = 3;
    gust.noiseScale = 0.5;
    scene.userData.noiseScale = gust.noiseScale;
  }
});

S.mount(scene);
