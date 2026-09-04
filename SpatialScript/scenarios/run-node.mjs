#!/usr/bin/env node
// Smoke-runs every scenario script through the core in Node (no rendering),
// ticking 400 frames and reporting errors, warnings, and userData markers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "../conformance/run-node.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.join(here, "../core/dist/spatial-core.js"), "utf8");
const only = process.argv.slice(2);
let failed = 0;
for (const file of fs.readdirSync(here).filter(f => f.endsWith(".js") && (only.length === 0 || only.includes(f.replace(/\.js$/, ""))))) {
  const host = createHost(bundle);
  const t0 = Date.now();
  try {
    host.spatial.load(fs.readFileSync(path.join(here, file), "utf8"), { backend: "three", platform: "web", capabilities: {} });
    for (let i = 0; i < 400; i++) host.tick(1 / 60);
    const dump = host.spatial.dump();
    const scene = host.spatial.Spatial.scene;
    const summary = { objects: dump.objects.length, commands: host.recorded.length, warnings: dump.warnings, errors: dump.errors, userData: scene && scene.userData, ms: Date.now() - t0 };
    const bad = dump.errors.length > 0 && !(file === "transforms.js" && dump.errors.every(e => String(e).includes("sheared")));
    if (bad) failed++;
    console.log(`${bad ? "FAIL" : "ok  "} ${file}`, JSON.stringify(summary).slice(0, 700));
  } catch (e) {
    failed++;
    console.log(`FAIL ${file} threw: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
