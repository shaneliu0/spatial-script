const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const head = new S.Anchor("head");
head.name = "head";
head.userData.events = [];
scene.add(head);

const table = new S.Anchor({ plane: "horizontal", minimumBounds: new S.Vector2(0.3, 0.4) });
table.name = "table";
scene.add(table);

const palm = new S.Anchor({ hand: "left", location: "palm" });
palm.name = "palm";
scene.add(palm);

const poster = new S.Anchor({ image: "poster" });
poster.name = "poster";
scene.add(poster);

const fixed = new S.Anchor({ world: new S.Matrix4().makeTranslation(0.1, 0.2, 0.3) });
fixed.name = "fixed";
scene.add(fixed);

const badge = new S.Mesh(new S.BoxGeometry(0.05, 0.05, 0.05), new S.MeshStandardMaterial());
badge.name = "badge";
head.add(badge);

head.addEventListener("anchored", () => head.userData.events.push("anchored"));
head.addEventListener("unanchored", () => head.userData.events.push("unanchored"));

let badAnchor = null;
try {
  new S.Anchor({ plane: "diagonal" });
} catch (error) {
  badAnchor = error.name;
}
head.userData.badAnchor = badAnchor;

S.mount(scene);
