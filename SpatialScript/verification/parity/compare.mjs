// Field-by-field comparison of a RealityKit run and a three.js run of the same script and plan.
//
// Rules: every key present on either side is compared unless it is in a named exemption list;
// objects are matched by a stable path (parent path, name, sibling index) so unnamed and
// duplicate-named objects are compared; non-finite numbers never compare equal to anything;
// native-driven subtrees (dynamic bodies, character controllers, and their descendants) compare
// structurally only; warnings, errors, and every log level are compared as messages, with
// per-backend exemptions for warnings that name a backend or platform.

const TOLERANCE = 1e-2;
const COLOR_TOLERANCE = 1e-3;

// Fields whose values are legitimately different between backends.
const CORE_OBJECT_EXEMPT = new Set(["id", "parent", "children", "worldPosition", "uuid"]); // ids and structure are checked through paths; uuids are per-process random
const NATIVE_OBJECT_EXEMPT = new Set(["id", "parent", "children", "nativeType", "components"]);
const NATIVE_MATERIAL_EXEMPT = new Set(); // SPEC 8: native class names live in `components`, never inside a material
// A uuid is generated per process, so `geometry.uuid` and `material.uuid` can never agree
// between two runs of the same script; sharing is compared through the paths that carry it.
const ANY_DEPTH_EXEMPT = new Set(["uuid"]);
const NATIVE_DRIVEN_FIELDS = new Set(["position", "quaternion", "scale", "worldPosition", "velocity", "isSleeping", "isOnGround", "matrix", "matrixWorld"]);
const TOP_LEVEL_EXEMPT = new Set(["backend", "platform", "objects", "warnings", "errors", "logs", "objectCount", "placeholder", "isActive", "hostFunctions"]);
// Core dumps: every top-level key on either side is compared except these. `objects`, `warnings`,
// `errors` and `logs` are compared by their own routines; `hostFunctions` differs by design
// because the web page registers none; `coreSource` names the bundle each process loaded.
const CORE_TOP_LEVEL_EXEMPT = new Set(["backend", "platform", "objects", "warnings", "errors", "logs", "objectCount", "hostFunctions", "coreSource"]);
// Warnings that exist on exactly one backend by contract (SPEC 3.x per-feature tables). Each is
// anchored to its catalogued text so an ordinary word in a script's own line can never match.
// A warning outside this list must appear on both sides, the same number of times.
const PLATFORM_ONLY_WARNINGS = [
  /^RealityKit models directivity as a single beam focus/,
  /^RealityKit's spatial audio has no reference distance/,
  /^Object3D\.manipulable is unsupported on macOS/,
  /^Object3D\.groundingShadow is unsupported on the three\.js backend/,
  /^Head anchors are visionOS only/,
  /^(Hand|Plane|Image) anchors are visionOS only/,
  /^hoverEffect "lift"/,
  /^Object3D\.renderOrder/,
  /^\.exr environments are unsupported in the three\.js consumer/,
  /^Portal crossing is unsupported in the three\.js consumer/,
  /^ShaderGraphMaterial is a RealityKit capability/,
  /^Spatial\.environment replaces the AmbientLight image based light/,
  /^On visionOS the user is the camera/,
  /^(CylinderGeometry|Partial spheres|Partial cones) .*has no RealityKit generator/,
  /^ParticleEmitter preset '.*' has no RealityKit equivalent/,
  /^Raycasts will not see the real world here: RealityKit has no scene reconstruction mesh on macOS/,
  /^raycasts will not see the real world here: the three\.js consumer has no scene reconstruction mesh/,
];
const platformOnly = (message) => PLATFORM_ONLY_WARNINGS.some((re) => re.test(String(message)));

export function compareCoreDumps(mac, web, { tolerance = TOLERANCE } = {}) {
  const issues = [];
  const a = indexByPath(mac), b = indexByPath(web);
  // Every top-level key on either side, minus the named exemptions (SPEC 14.13a); `scene` is
  // compared whole, name and userData alike.
  for (const key of Object.keys({ ...mac, ...web })) {
    if (CORE_TOP_LEVEL_EXEMPT.has(key)) continue;
    if (!(key in mac)) { issues.push(`top-level ${key}: only on web`); continue; }
    if (!(key in web)) { issues.push(`top-level ${key}: only on mac`); continue; }
    diffValue(key === "scene" ? "scene" : `dump.${key}`, mac[key], web[key], issues, tolerance, new Set(), false);
  }
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[path], y = b[path];
    if (!y) { issues.push(`web is missing object ${path}`); continue; }
    if (!x) { issues.push(`mac is missing object ${path}`); continue; }
    const nativeDriven = underNativeDriven(x, mac) || underNativeDriven(y, web);
    diffValue(path, x, y, issues, tolerance, CORE_OBJECT_EXEMPT, nativeDriven);
  }
  issues.push(...compareMessages("errors", mac.errors || [], web.errors || []));
  issues.push(...compareWarnings(mac.warnings || [], web.warnings || []));
  return issues;
}

export function compareNativeDumps(mac, web, { tolerance = TOLERANCE } = {}) {
  const issues = [];
  const a = indexByPath(mac), b = indexByPath(web);
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[path], y = b[path];
    if (!y) { issues.push(`three.js scene lacks ${path}`); continue; }
    if (!x) { issues.push(`RealityKit scene lacks ${path}`); continue; }
    const nativeDriven = underNativeDriven(x, mac) || underNativeDriven(y, web);
    const exempt = new Set([...NATIVE_OBJECT_EXEMPT]);
    // Portals and particle emitters use renderer-specific native materials.
    if (x.type === "Portal" || x.type === "ParticleEmitter") exempt.add("material");
    diffValue(`native ${path}`, x, y, issues, tolerance, exempt, nativeDriven, NATIVE_MATERIAL_EXEMPT);
  }
  for (const key of Object.keys({ ...mac, ...web })) {
    if (TOP_LEVEL_EXEMPT.has(key)) continue;
    if (!(key in mac)) { issues.push(`native top-level ${key} only on web`); continue; }
    if (!(key in web)) { issues.push(`native top-level ${key} only on mac`); continue; }
    if (key === "scene") { if ((mac.scene || {}).name !== (web.scene || {}).name) issues.push(`native scene.name: rk ${JSON.stringify(mac.scene.name)} three ${JSON.stringify(web.scene.name)}`); continue; }
    diffValue(`native ${key}`, mac[key], web[key], issues, tolerance, new Set(), false);
  }
  issues.push(...compareWarnings(mac.warnings || [], web.warnings || []).map((i) => "native " + i));
  return issues;
}

// Every console line at every level must match, in order; all mismatches are reported.
export function compareLogs(mac, web) {
  const norm = (lines) => lines
    .map((l) => ({ level: l.level ?? l.type, message: l.message ?? l.text }))
    // Only a console line that mirrors a platform-only warning is exempt; a script's own output is
    // never filtered, whatever words it contains.
    .filter((l) => typeof l.message === "string" && !l.message.startsWith("[.WebGL") && !(l.level === "warn" && platformOnly(l.message)))
    .map((l) => `${l.level}: ${stripLocation(l.message)}`);
  const a = norm(mac), b = norm(web);
  const issues = [];
  if (a.length !== b.length) issues.push(`log line count: mac ${a.length} web ${b.length}`);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) issues.push(`log line ${i}: mac ${JSON.stringify(a[i])} web ${JSON.stringify(b[i])}`);
  return issues;
}

export function compareWarnings(mac, web) {
  const strip = (list) => list.map(String).filter((w) => !platformOnly(w)).sort();
  return compareMessages("warnings", strip(mac), strip(web));
}

// JavaScriptCore and V8 disagree on the column (and sometimes the line) an error is charged to,
// so a location suffix is not part of the message being compared.
const stripLocation = (m) => String(m).replace(/\s*\(line \d+, column \d+\)/g, "");

function compareMessages(label, mac, web) {
  // Multisets: a fact reported twice on one side and once on the other is a difference.
  const count = (list) => { const c = new Map(); for (const m of list.map(stripLocation)) c.set(m, (c.get(m) || 0) + 1); return c; };
  const a = count(mac), b = count(web);
  const issues = [];
  for (const [m, n] of a) {
    const o = b.get(m) || 0;
    if (o === 0) issues.push(`${label}: only on mac: ${m.slice(0, 160)}`);
    else if (o !== n) issues.push(`${label}: mac ${n}x web ${o}x: ${m.slice(0, 160)}`);
  }
  for (const [m] of b) if (!a.has(m)) issues.push(`${label}: only on web: ${m.slice(0, 160)}`);
  return issues;
}

// ---- helpers

function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function indexByPath(dump) {
  const objects = dump.objects || [];
  const byId = new Map(objects.map((o) => [o.id, o]));
  const siblingIndex = new Map();
  const pathOf = new Map();
  const compute = (o) => {
    if (pathOf.has(o.id)) return pathOf.get(o.id);
    const parent = o.parent != null && byId.has(o.parent) ? compute(byId.get(o.parent)) : "";
    const key = `${parent}|${o.name || ""}`;
    const n = siblingIndex.get(key) || 0; siblingIndex.set(key, n + 1);
    const path = `${parent}/${o.name || "(unnamed " + (o.type || "object") + ")"}#${n}`;
    pathOf.set(o.id, path);
    return path;
  };
  const out = {};
  for (const o of objects) out[compute(o)] = o;
  return out;
}

function underNativeDriven(o, dump) {
  const byId = new Map((dump.objects || []).map((x) => [x.id, x]));
  let cur = o, guard = 0;
  while (cur && guard++ < 4096) {
    if ((cur.rigidBody && cur.rigidBody.type === "dynamic") || cur.characterController) return true;
    cur = cur.parent != null ? byId.get(cur.parent) : null;
  }
  return false;
}

export function diffValue(path, x, y, issues, tolerance, exempt, nativeDriven, materialExempt = new Set()) {
  // A media clock (audio and video `currentTime`) runs on the engine's own decoder timing, so
  // the two backends never agree to the millisecond; what must agree is whether it has advanced.
  if (/\.currentTime$/.test(path) && typeof x === "number" && typeof y === "number") {
    if ((x > 0) !== (y > 0)) issues.push(`${path}: mac ${fmt(x)} web ${fmt(y)} (one side never advanced)`);
    return;
  }
  if (isNumberArray(x) || isNumberArray(y)) {
    if (!close(x, y, /color|emissive/i.test(path) ? COLOR_TOLERANCE : tolerance)) issues.push(`${path}: mac ${fmt(x)} web ${fmt(y)}`);
    return;
  }
  if (typeof x === "number" || typeof y === "number") {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x - y) > tolerance) issues.push(`${path}: mac ${fmt(x)} web ${fmt(y)}`);
    return;
  }
  // Arrays of objects (material arrays, joints, groups) are compared element by element with
  // the same exemptions, so a per-process uuid or a native class name inside one cannot mask
  // or manufacture a difference.
  if (Array.isArray(x) && Array.isArray(y) && (x.some(isPlainObject) || y.some(isPlainObject))) {
    if (x.length !== y.length) { issues.push(`${path}: mac has ${x.length} entries, web ${y.length}`); return; }
    const inner = /\.material$/.test(path) ? new Set([...exempt, ...materialExempt]) : exempt;
    for (let i = 0; i < x.length; i += 1) diffValue(`${path}[${i}]`, x[i], y[i], issues, tolerance, inner, nativeDriven, materialExempt);
    return;
  }
  if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (exempt.has(key) || ANY_DEPTH_EXEMPT.has(key)) continue;
      if (nativeDriven && NATIVE_DRIVEN_FIELDS.has(key)) continue;
      if (key === "material" && materialExempt.size) { diffValue(`${path}.material`, x.material, y.material, issues, tolerance, materialExempt, false); continue; }
      if (!(key in x)) { issues.push(`${path}.${key}: only on web`); continue; }
      if (!(key in y)) { issues.push(`${path}.${key}: only on mac`); continue; }
      diffValue(`${path}.${key}`, x[key], y[key], issues, tolerance, new Set(), nativeDriven, materialExempt);
    }
    return;
  }
  if (!same(x, y)) issues.push(`${path}: mac ${JSON.stringify(x)} web ${JSON.stringify(y)}`);
}

function isNumberArray(v) { return Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "number"); }
function close(u, v, tol) {
  if (!Array.isArray(u) || !Array.isArray(v) || u.length !== v.length) return false;
  for (let i = 0; i < u.length; i++) { if (!Number.isFinite(u[i]) || !Number.isFinite(v[i])) return false; if (Math.abs(u[i] - v[i]) > tol) return false; }
  return true;
}
function same(u, v) { return JSON.stringify(canon(u)) === JSON.stringify(canon(v)); }
function canon(v) { if (Array.isArray(v)) return v.map(canon); if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])); return v; }
function fmt(v) { return Array.isArray(v) ? "[" + v.map((n) => (typeof n === "number" ? n.toFixed(3) : String(n))).join(",") + "]" : String(v); }
