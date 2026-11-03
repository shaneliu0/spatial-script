#!/usr/bin/env node
// Runs every robustness script: the host must survive load and 200 ticks. Load errors are
// expected only for the files listed in EXPECT_LOAD_ERROR, and must carry a line number.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "../conformance/run-node.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "robustness");
const bundle = fs.readFileSync(path.join(here, "../../core/dist/spatial-core.js"), "utf8");
const EXPECT_LOAD_ERROR = new Set(["two-scenes-no-mount.js", "syntax-error.js"]);
// Node's engine cannot locate a SyntaxError thrown by the Function constructor; JavaScriptCore is
// checked for line numbers in the core's jsc test suite instead. Semantic load errors have no line.
const REQUIRE_LINE = new Set([]);
let failed = 0;
for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".js")).sort()) {
  const host = createHost(bundle);
  let loadError = null;
  const t0 = Date.now();
  try { host.spatial.load(fs.readFileSync(path.join(dir, file), "utf8"), { backend: "three", platform: "web", capabilities: {} }); }
  catch (e) { loadError = e; }
  if (EXPECT_LOAD_ERROR.has(file)) {
    const ok = loadError && (!REQUIRE_LINE.has(file) || Number.isInteger(loadError.line));
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${file} load error: ${loadError ? `${loadError.message} (line ${loadError.line}, col ${loadError.column})` : "none"}`);
    continue;
  }
  if (loadError) { failed++; console.log(`FAIL ${file} unexpected load error: ${loadError.message} (line ${loadError.line})`); continue; }
  let tickError = null; let commands = 0; let nonFinite = 0; const nonFiniteWhere = [];
  for (let i = 0; i < 200 && !tickError; i++) {
    try {
      const cmds = host.tick(1 / 60); commands += cmds.length;
      for (const c of cmds) {
        // Every number in every payload must be finite (SPEC 2); typed arrays are scanned too.
        const scan = (v, where) => {
          if (typeof v === "number") { if (!Number.isFinite(v)) { nonFinite++; if (nonFiniteWhere.length < 5) nonFiniteWhere.push(where); } return; }
          if (ArrayBuffer.isView(v)) { for (const n of v) if (!Number.isFinite(n)) { nonFinite++; if (nonFiniteWhere.length < 5) nonFiniteWhere.push(where); } return; }
          if (Array.isArray(v)) { v.forEach((e, i) => scan(e, `${where}[${i}]`)); return; }
          if (v && typeof v === "object") { for (const k of Object.keys(v)) scan(v[k], `${where}.${k}`); }
        };
        for (let k = 1; k < c.length; k++) scan(c[k], `${c[0]}[${k}]`);
        // The recording consumer cannot load assets; answer like a consumer whose load failed.
        if (c[0] === "asset") host.spatial.dispatch("assetError", c[1], { message: "asset unavailable in the recording consumer" });
      }
    }
    catch (e) { tickError = e; }
  }
  // drain microtasks for async scripts
  await new Promise(r => setTimeout(r, 120));
  for (let i = 0; i < 20 && !tickError; i++) { try { host.tick(1 / 60); } catch (e) { tickError = e; } }
  const dump = host.spatial.dump();
  const scene = host.spatial.Spatial.scene;
  const ok = !tickError && nonFinite === 0;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${file} ${tickError ? "tick threw: " + tickError.message : ""} nonFinite=${nonFinite}${nonFiniteWhere.length ? " at " + nonFiniteWhere.join(",") : ""} objects=${dump.objects.length} cmds=${commands} errors=${dump.errors.length} warnings=${dump.warnings.length} ${Date.now() - t0}ms\n      userData=${JSON.stringify(scene && scene.userData).slice(0, 400)}\n      errors=${JSON.stringify(dump.errors).slice(0, 400)}`);
}
process.exit(failed ? 1 : 0);
