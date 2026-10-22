// Texture release (SPEC 5, `["texture", id, null]`) observed entirely through
// the dump: the map ids in each material tell the whole story.
//
//   ids: grid = 1 (first texture built), panel = 2, probe = 3
//
// While `grid` is disposed but still referenced its id stays reserved, so the
// texture created next must be given a different id. Once the last reference
// is dropped the id is released, and only then may a new texture reuse it.
const Spatial = require("spatial");
const { Scene, Mesh, PlaneGeometry, MeshStandardMaterial, TextureLoader } = Spatial;

const scene = new Scene();
const loader = new TextureLoader();

const grid = loader.load("asset://grid.png");
const panel = new Mesh(new PlaneGeometry(0.3, 0.3), new MeshStandardMaterial({ map: grid }));
panel.name = "panel";
scene.add(panel);

const probe = new Mesh(new PlaneGeometry(0.1, 0.1), new MeshStandardMaterial());
probe.name = "probe";
probe.position.x = 0.4;
scene.add(probe);

Spatial.onFrame(() => {
  const frame = Spatial.time.frame;

  // Disposed while a material still names it: the release has to wait.
  if (frame === 2) {
    grid.dispose();
    panel.userData.disposed = grid.disposed;
    panel.userData.stillMapped = panel.material.map === grid;
  }

  // Created while the disposed texture is still referenced: it must not be
  // handed the reserved id, which the dump shows as a different `maps.map`.
  if (frame === 3) probe.material.map = loader.load("asset://second.png");

  // Dropping the last reference is what lets the release go out.
  if (frame === 5) panel.material = new MeshStandardMaterial({ color: 0xffffff });

  // Once released the id is free again, so this texture reuses it.
  if (frame === 8) panel.material.map = loader.load("asset://third.png");

  probe.userData.frame = frame;
});

Spatial.mount(scene);
