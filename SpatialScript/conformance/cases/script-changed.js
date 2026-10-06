const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const marker = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
marker.name = "marker";
scene.add(marker);

// SPEC 14.10: the state a hot reload carries across. The replacement script
// receives exactly this object in scriptChanged(previousState).
this.state = { score: 12, run: "first", path: [1, 2, 3] };

S.mount(scene);
