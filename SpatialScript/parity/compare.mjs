// Field-by-field comparison of a RealityKit run and a three.js run of the same script.
// Script-driven objects must match to tolerance; native-driven objects (dynamic bodies,
// manipulated or anchored objects) are compared structurally only.
export function compareCoreDumps(mac, web, { tolerance = 1e-2 } = {}) {
  const issues = [];
  const byName = (d) => Object.fromEntries(d.objects.filter((o) => o.name).map((o) => [o.name, o]));
  const a = byName(mac), b = byName(web);
  for (const name of Object.keys(a)) if (!b[name]) issues.push(`web is missing object "${name}"`);
  for (const name of Object.keys(b)) if (!a[name]) issues.push(`mac is missing object "${name}"`);
  const unnamedA = mac.objects.filter((o) => !o.name).length, unnamedB = web.objects.filter((o) => !o.name).length;
  if (unnamedA !== unnamedB) issues.push(`unnamed object count differs: mac ${unnamedA} web ${unnamedB}`);
  for (const name of Object.keys(a)) {
    const x = a[name], y = b[name]; if (!y) continue;
    // Native-driven objects: dynamic bodies, character controllers, and anything beneath one.
    const byId = Object.fromEntries(mac.objects.map((o) => [o.id, o]));
    const underNative = (o) => { let cur = o; let guard = 0; while (cur && guard++ < 2048) { if ((cur.rigidBody && cur.rigidBody.type === "dynamic") || cur.characterController) return true; cur = cur.parent != null ? byId[cur.parent] : null; } return false; };
    const nativeDriven = (o) => underNative(o);
    for (const key of ["type", "visible", "opacity", "billboard"]) if (JSON.stringify(x[key]) !== JSON.stringify(y[key])) issues.push(`${name}.${key}: mac ${JSON.stringify(x[key])} web ${JSON.stringify(y[key])}`);
    if ((x.parent == null) !== (y.parent == null)) issues.push(`${name}.parent attached differs`);
    else if (x.parent != null) { const pa = mac.objects.find((o) => o.id === x.parent), pb = web.objects.find((o) => o.id === y.parent); if ((pa && pa.name) !== (pb && pb.name)) issues.push(`${name}.parent: mac "${pa && pa.name}" web "${pb && pb.name}"`); }
    if (!nativeDriven(x)) for (const key of ["position", "quaternion", "scale", "worldPosition"]) if (!close(x[key], y[key], tolerance)) issues.push(`${name}.${key}: mac ${fmt(x[key])} web ${fmt(y[key])}`);
    if (x.geometry || y.geometry) { if ((x.geometry && x.geometry.type) !== (y.geometry && y.geometry.type)) issues.push(`${name}.geometry.type differs`); }
    if (x.material || y.material) { for (const key of ["type", "opacity", "metalness", "roughness", "transparent"]) if (JSON.stringify(x.material && x.material[key]) !== JSON.stringify(y.material && y.material[key])) issues.push(`${name}.material.${key}: mac ${JSON.stringify(x.material && x.material[key])} web ${JSON.stringify(y.material && y.material[key])}`); if (!close(x.material && x.material.color, y.material && y.material.color, 1e-3)) issues.push(`${name}.material.color: mac ${fmt(x.material && x.material.color)} web ${fmt(y.material && y.material.color)}`); }
    if (x.light || y.light) { for (const key of ["type", "intensity", "castShadow"]) if (JSON.stringify(x.light && x.light[key]) !== JSON.stringify(y.light && y.light[key])) issues.push(`${name}.light.${key} differs`); }
    if (x.rigidBody || y.rigidBody) { for (const key of ["type", "shape", "mass", "isTrigger"]) if (JSON.stringify(x.rigidBody && x.rigidBody[key]) !== JSON.stringify(y.rigidBody && y.rigidBody[key])) issues.push(`${name}.rigidBody.${key} differs`); }
    if (!same(x.interactive, y.interactive)) issues.push(`${name}.interactive: mac ${JSON.stringify(x.interactive)} web ${JSON.stringify(y.interactive)}`);
    if (!same(x.userData, y.userData)) issues.push(`${name}.userData: mac ${JSON.stringify(x.userData)} web ${JSON.stringify(y.userData)}`);
  }
  if (!same((mac.scene || {}).userData, (web.scene || {}).userData)) issues.push(`scene.userData: mac ${JSON.stringify((mac.scene || {}).userData)} web ${JSON.stringify((web.scene || {}).userData)}`);
  if (mac.errors.length !== web.errors.length) issues.push(`error count: mac ${mac.errors.length} web ${web.errors.length}`);
  return issues;
}

// Structural comparison of what each renderer actually built.
export function compareNativeDumps(mac, web, { tolerance = 1e-2 } = {}) {
  const issues = [];
  const byName = (d) => Object.fromEntries((d.objects || []).filter((o) => o.name).map((o) => [o.name, o]));
  const a = byName(mac), b = byName(web);
  for (const name of Object.keys(a)) if (!b[name]) issues.push(`three.js scene lacks "${name}"`);
  for (const name of Object.keys(b)) if (!a[name]) issues.push(`RealityKit scene lacks "${name}"`);
  for (const name of Object.keys(a)) {
    const x = a[name], y = b[name]; if (!y) continue;
    const byIdN = Object.fromEntries((mac.objects || []).map((o) => [o.id, o]));
    const dynamic = (() => { let cur = x; let guard = 0; while (cur && guard++ < 2048) { if ((cur.rigidBody && cur.rigidBody.type === "dynamic") || cur.characterController) return true; cur = cur.parent != null ? byIdN[cur.parent] : null; } return false; })();
    if (!dynamic) for (const key of ["position", "worldPosition", "scale"]) if (x[key] && y[key] && !close(x[key], y[key], tolerance)) issues.push(`native ${name}.${key}: rk ${fmt(x[key])} three ${fmt(y[key])}`);
    if (x.visible !== y.visible) issues.push(`native ${name}.visible: rk ${x.visible} three ${y.visible}`);
    if ((x.geometry && x.geometry.type) !== (y.geometry && y.geometry.type)) issues.push(`native ${name}.geometry: rk ${x.geometry && x.geometry.type} three ${y.geometry && y.geometry.type}`);
    // Portals and particle emitters use renderer-specific native materials; only meshes compare.
    const nativeMaterialComparable = x.type !== "Portal" && x.type !== "ParticleEmitter" && y.type !== "Portal" && y.type !== "ParticleEmitter";
    if (nativeMaterialComparable && (x.material && x.material.type) !== (y.material && y.material.type)) issues.push(`native ${name}.material.type differs`);
    if (nativeMaterialComparable && x.material && y.material && !close(x.material.color, y.material.color, 1e-3)) issues.push(`native ${name}.material.color: rk ${fmt(x.material.color)} three ${fmt(y.material.color)}`);
    if ((x.light && x.light.type) !== (y.light && y.light.type)) issues.push(`native ${name}.light.type differs`);
  }
  return issues;
}

// Compares console output: every log line the script printed must appear in both, in order.
export function compareLogs(mac, web) {
  const norm = (lines) => lines
    .map((l) => ({ level: l.level ?? l.type, message: l.message ?? l.text }))
    .filter((l) => l.level === "log" && typeof l.message === "string" && !l.message.startsWith("[.WebGL"))
    .map((l) => l.message);
  const a = norm(mac), b = norm(web);
  const issues = [];
  if (a.length !== b.length) issues.push(`log line count: mac ${a.length} web ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) { issues.push(`log line ${i}: mac "${a[i]}" web "${b[i]}"`); break; }
  return issues;
}

function same(u, v) { return JSON.stringify(canon(u)) === JSON.stringify(canon(v)); }
function canon(v) { if (Array.isArray(v)) return v.map(canon); if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])); return v; }
function close(u, v, tol) { if (!Array.isArray(u) || !Array.isArray(v) || u.length !== v.length) return u === v; for (let i = 0; i < u.length; i++) if (Math.abs(u[i] - v[i]) > tol) return false; return true; }
function fmt(v) { return Array.isArray(v) ? "[" + v.map((n) => Number(n).toFixed(3)).join(",") + "]" : String(v); }
