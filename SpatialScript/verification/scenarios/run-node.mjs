#!/usr/bin/env node
// Smoke-runs every scenario script through the core in Node (no rendering),
// ticking 400 frames and checking each scenario's own verdict flags.
//
// A scenario exists to record structural statements about itself in
// `scene.userData`. Printing them and asserting nothing is how a scenario can
// report "ok" while its own verdicts say it failed (AR-07), so every
// backend-independent flag is asserted here. The physics-dependent ones are
// listed as `informational`: nothing simulates physics in Node, so the node
// lane records their value and the web lane (harness/scenarios.mjs) asserts
// them for real.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "../conformance/run-node.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.join(here, "../../core/dist/spatial-core.js"), "utf8");

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const finiteVector = (value) => Array.isArray(value) && value.length >= 3 && value.every(finite);

/**
 * Per scenario: `expect` is asserted in this lane, `informational` is printed
 * with its value and asserted by the web lane, and `noVerdicts` marks a
 * scenario that publishes nothing to assert.
 */
const EXPECTATIONS = {
  "dynamic-updates.js": {
    expect: {
      "ran every frame": (u) => u.frame === 400,
      "the ring finished being rebuilt": (u) => finite(u.ringCount) && u.ringCount >= 1,
    },
  },
  "events.js": {
    // The log only fills when input is injected, which the web lane does.
    expect: { "the event log exists": (u) => Array.isArray(u.log) },
    informational: ["log"],
  },
  "hierarchy.js": {
    expect: {
      "ran every frame": (u) => u.frame === 400,
      "the hand's world position is finite and off the origin": (u) =>
        finiteVector(u.handWorld) && u.handWorld.some((v) => Math.abs(v) > 1e-6),
    },
  },
  "hotswap-a.js": { expect: { "all five red cubes are present": (u) => u.allPresent === true, "nothing from the other script survives": (u) => u.noStaleObjects === true } },
  "hotswap-b.js": { expect: { "all three blue spheres are present": (u) => u.allPresent === true, "nothing from the other script survives": (u) => u.noStaleObjects === true } },
  "materials-lights.js": { expect: { "the 4x4 grid is complete": (u) => u.gridComplete === true, "the material types are as authored": (u) => u.materialTypes === true, "all four lights are present": (u) => u.lightsPresent === true } },
  "physics-scenarios.js": {
    expect: {
      "the raycast hit the top of the stack": (u) => u.rayTop === "stack-2",
      "the stack is intact": (u) => u.stackIntact === true,
    },
    informational: ["triggerEnters", "bobHangsBelowHinge"],
  },
  "stress.js": {
    expect: {
      "the frame time is the one the scenario asked for": (u) =>
        finite(u.avgDt) && Math.abs(u.avgDt - 1 / 60) < 1e-3,
    },
  },
  "transforms.js": {
    expect: {
      "ran every frame": (u) => u.frame === 400,
      "the sheared matrix was rejected": (u) => u.shearRejected === true,
      "and the object recovered once it was valid again": (u) => u.shearRestored === true,
      "the looker's world transform is finite": (u) => finiteVector(u.lookerWorld),
    },
  },
};

const only = process.argv.slice(2);
let failed = 0;
for (const file of fs
  .readdirSync(here)
  .filter((f) => f.endsWith(".js") && (only.length === 0 || only.includes(f.replace(/\.js$/, ""))))) {
  const host = createHost(bundle);
  const t0 = Date.now();
  try {
    host.spatial.load(fs.readFileSync(path.join(here, file), "utf8"), {
      backend: "three",
      platform: "web",
      capabilities: {},
    });
    for (let i = 0; i < 400; i++) host.tick(1 / 60);
    const dump = host.spatial.dump();
    const scene = host.spatial.Spatial.scene;
    const userData = (scene && scene.userData) || {};
    const summary = {
      objects: dump.objects.length,
      commands: host.recorded.length,
      warnings: dump.warnings,
      errors: dump.errors,
      userData,
      ms: Date.now() - t0,
    };

    const problems = [];
    // transforms.js proves shear rejection, so its one error is the verdict.
    const unexpectedErrors =
      dump.errors.length > 0 &&
      !(file === "transforms.js" && dump.errors.every((e) => String(e).includes("sheared")));
    if (unexpectedErrors) problems.push(`errors: ${JSON.stringify(dump.errors)}`);

    const rules = EXPECTATIONS[file];
    if (rules === undefined) {
      problems.push("no expectation entry: add one to run-node.mjs so this scenario asserts something");
    } else if (rules.noVerdicts) {
      // Recorded, not asserted: the scenario publishes no flags to check.
    } else {
      for (const [what, predicate] of Object.entries(rules.expect || {})) {
        let held = false;
        try {
          held = predicate(userData) === true;
        } catch (error) {
          held = false;
        }
        if (!held) problems.push(`verdict failed: ${what} (userData ${JSON.stringify(userData)})`);
      }
    }

    if (problems.length > 0) failed += 1;
    const informational = (rules && rules.informational) || [];
    const noted = informational.length
      ? ` [node-lane informational: ${informational.map((k) => `${k}=${JSON.stringify(userData[k])}`).join(", ")}]`
      : rules && rules.noVerdicts
        ? " [publishes no verdicts]"
        : "";
    console.log(
      `${problems.length ? "FAIL" : "ok  "} ${file}${noted}`,
      problems.length ? problems.join("; ") : JSON.stringify(summary).slice(0, 700),
    );
  } catch (e) {
    failed++;
    console.log(`FAIL ${file} threw: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
