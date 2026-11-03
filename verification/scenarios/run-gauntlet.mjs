// Hostile-input gauntlet against the running macOS host (dev server on 127.0.0.1:8787).
//
//   node verification/scenarios/run-gauntlet.mjs
//
// Pushes every example, scenario and robustness script, then a set of hostile
// scripts and malformed dev-server payloads, and after each step asks the app
// whether it is still alive. It ends by counting the process's crash reports
// against the count it started with. Exit 1 when the server stops answering,
// a step leaves the scene unable to load the next script, or a crash report
// appears. Nothing here asserts scene content: that is the conformance and
// parity lanes' job. This lane asserts survival.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const BASE = "http://127.0.0.1:8787";
const REPORTS = path.join(os.homedir(), "Library/Logs/DiagnosticReports");

const failures = [];
let steps = 0;

const HOST_APP = process.env.SPATIAL_HOST_APP ?? "SpatialHost";

function crashReports() {
  try {
    return fs.readdirSync(REPORTS).filter((f) => f.startsWith(HOST_APP)).length;
  } catch {
    return 0;
  }
}

async function post(route, body, { raw = false, timeout = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(BASE + route, {
      method: "POST",
      body: raw ? body : JSON.stringify(body),
      headers: { "content-type": raw ? "text/plain" : "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function alive(label) {
  steps += 1;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${BASE}/health`, { signal: controller.signal });
    clearTimeout(timer);
    const health = await response.json();
    if (health.ok !== true) failures.push(`${label}: /health answered but ok is ${health.ok}`);
  } catch (error) {
    failures.push(`${label}: the dev server stopped answering (${error.message})`);
    return false;
  }
  return true;
}

async function push(label, source) {
  const result = await post("/script", { source });
  if (result.status >= 500) failures.push(`${label}: /script answered ${result.status}: ${result.text.slice(0, 160)}`);
  await new Promise((r) => setTimeout(r, 250));
  return alive(label);
}

// ---- 1. every checked-in script, in turn
const scriptDirs = ["examples", "verification/scenarios", "verification/scenarios/robustness"];
const scripts = scriptDirs.flatMap((dir) =>
  fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f)),
);

// ---- 2. hostile scripts: each one is a thing an agent might write by mistake or on purpose
const hostileScripts = {
  "prototype pollution": `
    Object.prototype.polluted = { toString() { throw new Error("poisoned"); } };
    Array.prototype.push = function () { throw new Error("no push"); };
    const S = require("spatial"); const scene = new S.Scene();
    scene.add(new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial()));
    S.mount(scene);`,
  "getter that throws on every read": `
    const S = require("spatial"); const scene = new S.Scene();
    const m = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
    Object.defineProperty(m, "name", { get() { throw new Error("no name for you"); } });
    scene.add(m); S.mount(scene);`,
  "a proxy as a material": `
    const S = require("spatial"); const scene = new S.Scene();
    const trap = new Proxy(new S.MeshStandardMaterial(), { get(t, k) { if (k === "color") throw new Error("trap"); return Reflect.get(t, k); } });
    scene.add(new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), trap)); S.mount(scene);`,
  "ten thousand objects with huge names": `
    const S = require("spatial"); const scene = new S.Scene();
    const g = new S.BoxGeometry(0.02, 0.02, 0.02), mat = new S.MeshStandardMaterial();
    for (let i = 0; i < 10000; i++) { const m = new S.Mesh(g, mat); m.name = "n".repeat(5000) + i; m.position.set((i % 100) * 0.03, Math.floor(i / 100) * 0.03, 0); scene.add(m); }
    S.mount(scene);`,
  "every callback throws": `
    const S = require("spatial"); const scene = new S.Scene();
    const m = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial()); m.name = "cube"; scene.add(m);
    m.addEventListener("tap", () => { throw new Error("tap"); }); m.addEventListener("hover", () => { throw new Error("hover"); });
    m.update = () => { throw new Error("update"); }; S.onFrame(() => { throw new Error("frame"); });
    setInterval(() => { throw new Error("timer"); }, 1); S.mount(scene);`,
  "non-finite everything": `
    const S = require("spatial"); const scene = new S.Scene();
    const m = new S.Mesh(new S.BoxGeometry(NaN, Infinity, -Infinity), new S.MeshStandardMaterial({ color: NaN, opacity: Infinity }));
    m.position.set(NaN, Infinity, -Infinity); m.scale.set(0, NaN, 1e308); scene.add(m);
    scene.add(new S.PointLight(NaN, Infinity, NaN)); S.mount(scene);
    S.onFrame(() => { m.rotation.x = NaN; });`,
  "physics abuse": `
    const S = require("spatial"); const scene = new S.Scene();
    for (let i = 0; i < 200; i++) { const m = new S.Mesh(new S.SphereGeometry(0.01), new S.MeshStandardMaterial()); m.position.set(0, i * 0.001, 0);
      m.rigidBody = new S.RigidBody({ type: "dynamic", mass: i === 0 ? 1e-9 : 1e9, restitution: 5, friction: -1 }); scene.add(m); }
    S.mount(scene); S.onFrame(() => { for (const o of scene.children) if (o.rigidBody) o.rigidBody.applyImpulse(new S.Vector3(1e6, 1e6, 1e6)); });`,
  "mount and remount in a loop": `
    const S = require("spatial"); let n = 0;
    S.onFrame(() => { const scene = new S.Scene(); scene.add(new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial())); S.mount(scene); n++; });
    const first = new S.Scene(); S.mount(first);`,
  "dispose while referenced": `
    const S = require("spatial"); const scene = new S.Scene();
    const t = new S.TextureLoader().load("asset://checker.png"); const mat = new S.MeshStandardMaterial({ map: t });
    const m = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), mat); scene.add(m); S.mount(scene);
    S.onFrame(() => { t.dispose(); mat.dispose(); m.geometry.dispose(); scene.remove(m); scene.add(m); });`,
  "recursive structures in userData and host events": `
    const S = require("spatial"); const scene = new S.Scene(); const a = {}; a.self = a; scene.userData.loop = a;
    const m = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial()); m.userData.deep = a; scene.add(m);
    S.mount(scene); S.onFrame(() => { try { S.host.send("loop", a); } catch (e) {} S.dump(); });`,
  "async body that never settles": `
    const S = require("spatial"); const scene = new S.Scene(); S.mount(scene);
    await new Promise(() => {});`,
};

// ---- 3. malformed dev-server payloads
const hostilePayloads = [
  ["/inject", "not json at all", true],
  ["/inject", "{", true],
  ["/inject", JSON.stringify({ type: "tap", target: "x".repeat(200000) })],
  ["/inject", JSON.stringify({ type: "drag", target: "cube", translation: ["a", null, {}] })],
  ["/inject", JSON.stringify({ type: "key", code: 12345, down: "maybe" })],
  ["/inject", JSON.stringify({ type: "__proto__", target: { __proto__: { polluted: true } } })],
  ["/inject", JSON.stringify({ type: "controller", controllers: [{ id: null, buttons: { a: "yes" }, leftThumbstick: [NaN, 1e400] }] })],
  ["/inject", JSON.stringify({ type: "hover", target: "cube", entering: 1 })],
  ["/inject", JSON.stringify({ type: "unknown-kind" })],
  ["/inject", JSON.stringify({})],
  ["/inject", "[]", true],
  ["/inject", JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ type: "tap", target: `t${i}` })))],
  ["/event", JSON.stringify({ name: "x".repeat(100000), payload: { a: "b".repeat(100000) } })],
  ["/event", JSON.stringify({ name: 42 })],
  ["/event", "null", true],
  ["/script", JSON.stringify({ source: 12 })],
  ["/script", JSON.stringify({ source: " ".repeat(1000) })],
  ["/script", JSON.stringify({ source: "x".repeat(5_000_000) })],
  ["/script", "{ \"source\": ", true],
  ["/parity", JSON.stringify({ source: "const S = require('spatial'); S.mount(new S.Scene());", dt: -1, steps: [{ frames: -5 }, { frames: 1e9 }] })],
  ["/parity", JSON.stringify({ source: "const S = require('spatial'); S.mount(new S.Scene());", dt: NaN, steps: "nope" })],
  ["/parity", JSON.stringify({ steps: [{ dispatch: { type: "assetLoaded", id: 999999, payload: null } }] })],
];

async function main() {
  const baselineReports = crashReports();
  if (!(await alive("start"))) {
    console.log("the app is not running; start the Debug macOS host first");
    process.exit(2);
  }
  console.log(`crash reports at start: ${baselineReports}`);

  for (const relative of scripts) {
    if (!(await push(relative, fs.readFileSync(path.join(root, relative), "utf8")))) break;
  }
  console.log(`scripts pushed: ${scripts.length}`);

  for (const [label, source] of Object.entries(hostileScripts)) {
    if (!(await push(`hostile script: ${label}`, source))) break;
  }
  console.log(`hostile scripts pushed: ${Object.keys(hostileScripts).length}`);

  // A known-good scene before the payloads, so a payload that breaks the
  // scene shows up as the next /script failing rather than as silence.
  const good = "const S = require('spatial'); const scene = new S.Scene(); const m = new S.Mesh(new S.BoxGeometry(0.1,0.1,0.1), new S.MeshStandardMaterial()); m.name = 'cube'; m.addEventListener('tap', () => {}); scene.add(m); S.mount(scene);";
  await push("known-good scene before payloads", good);
  for (const [route, body] of hostilePayloads) {
    const label = `payload ${route} ${String(body).slice(0, 40)}`;
    try {
      const result = await post(route, body, { raw: true, timeout: route === "/parity" ? 150000 : 15000 });
      if (result.status >= 500) failures.push(`${label}: answered ${result.status}`);
    } catch (error) {
      failures.push(`${label}: request failed (${error.message})`);
    }
    if (!(await alive(label))) break;
  }
  console.log(`hostile payloads sent: ${hostilePayloads.length}`);

  // The scene must still load a normal script after all of that.
  const final = await post("/script", fs.readFileSync(path.join(root, "examples/basics.js"), "utf8"), { raw: true });
  if (final.status !== 200 || !JSON.parse(final.text).ok) failures.push(`final basics load answered ${final.status}: ${final.text.slice(0, 160)}`);
  await new Promise((r) => setTimeout(r, 500));
  try {
    const dump = await (await fetch(`${BASE}/dump?names=`)).json();
    const count = Array.isArray(dump.objects) ? dump.objects.length : 0;
    if (count === 0) failures.push(`final basics scene has no objects: ${JSON.stringify(dump).slice(0, 200)}`);
  } catch (error) {
    failures.push(`final dump failed (${error.message})`);
  }

  await new Promise((r) => setTimeout(r, 1500));
  const reports = crashReports();
  if (reports > baselineReports) failures.push(`${reports - baselineReports} new crash report(s) under ${REPORTS}`);

  console.log(`steps: ${steps}, crash reports now: ${reports}`);
  if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    process.exit(1);
  }
  console.log("gauntlet: the app survived every step with no new crash report (examples/basics.js is loaded now)");
}

main().catch((error) => {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`gauntlet aborted: ${error.message}`);
  process.exit(1);
});
