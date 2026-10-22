#!/usr/bin/env node
// Runs the core bundle inside JavaScriptCore, the engine the RealityKit host
// embeds, and checks that it produces the same results as Node.
//
//   corepack pnpm --filter @spatialscript/core test:jsc
//
// Every conformance case is matched against its expectation, every robustness
// script must survive load plus 200 ticks with no non-finite transform, and a
// script with a syntax error must report a line number (JSC populates
// SyntaxError.line, which V8 does not).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matchDump } from "../../verification/conformance/match.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.resolve(here, "..");
const root = path.resolve(coreRoot, "..");

export const JSC_PATH =
  "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc";

const casesDir = path.join(root, "verification/conformance/cases");
const robustnessDir = path.join(root, "verification/scenarios/robustness");

// The syntax error the driver must locate, and the line it sits on.
const SYNTAX_CASE = "syntax-error.js";
const SYNTAX_LINE = 4;

export function jscAvailable() {
  try {
    fs.accessSync(JSC_PATH, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function loadJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function buildManifest() {
  const entries = [];

  for (const file of fs.readdirSync(casesDir).filter((name) => name.endsWith(".js")).sort()) {
    const name = file.slice(0, -3);
    const expectedPath = path.join(casesDir, `${name}.expected.json`);
    if (!fs.existsSync(expectedPath)) continue;
    const expected = loadJSON(expectedPath);
    const stepsPath = path.join(casesDir, `${name}.steps.json`);
    const backend = expected.backend || "realitykit";
    entries.push({
      kind: "case",
      name,
      source: fs.readFileSync(path.join(casesDir, file), "utf8"),
      steps: fs.existsSync(stepsPath) ? loadJSON(stepsPath) : null,
      backend,
      platform: expected.platform || (backend === "realitykit" ? "macos" : "web"),
      assetRoot: "assets",
      // Registered before load, the way an app registers its functions.
      hostFunctions: Array.isArray(expected.hostFunctions) ? expected.hostFunctions : null,
    });
  }

  for (const file of fs.readdirSync(robustnessDir).filter((name) => name.endsWith(".js")).sort()) {
    entries.push({
      kind: "robustness",
      name: file,
      source: fs.readFileSync(path.join(robustnessDir, file), "utf8"),
      assetRoot: "assets",
    });
  }

  return { entries };
}

/**
 * The stress.js shape the macOS host runs and the docs publish: `count` meshes
 * sharing one geometry **and one material**, every one moved each frame when
 * `moving`. The static variant sets `matrixAutoUpdate = false` after baking
 * the transform, which is the static hint the docs point readers at — running
 * anything else here makes the published table describe a scene nothing
 * measures (AR-12).
 */
export function benchmarkSource(count, moving) {
  return `
    const Spatial = require("spatial");
    const { Scene, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight, AmbientLight } = Spatial;
    const scene = new Scene();
    scene.add(new AmbientLight(0xffffff, 0.5));
    const sun = new DirectionalLight(0xffffff, 3);
    sun.position.set(1, 2, 2);
    scene.add(sun);
    const geo = new BoxGeometry(0.012, 0.012, 0.012);
    const material = new MeshStandardMaterial({ color: 0x6699ff });
    const cubes = [];
    const N = ${count}, side = Math.ceil(Math.cbrt(N));
    for (let i = 0; i < N; i++) {
      const m = new Mesh(geo, material);
      m.name = "c" + i;
      m.position.set(
        ((i % side) - side / 2) * 0.03,
        ((Math.floor(i / side) % side) - side / 2) * 0.03,
        (Math.floor(i / side / side) - side / 2) * 0.03,
      );
      scene.add(m);
      cubes.push(m);
    }
    ${moving ? "" : `for (let i = 0; i < N; i++) { cubes[i].updateMatrix(); cubes[i].matrixAutoUpdate = false; }`}
    ${moving
      ? `Spatial.onFrame((dt, t) => {
      for (let i = 0; i < N; i++) {
        const c = cubes[i];
        c.rotation.y = t + i * 0.01;
        c.position.y += Math.sin(t * 2 + i) * 0.0005;
      }
    });`
      : ""}
    Spatial.mount(scene);
  `;
}

/**
 * Benchmarks run in their own no-JIT process: the macOS host is signed with the
 * hardened runtime and no JIT entitlement, and visionOS never grants a JIT, so
 * the interpreter number is the one that matters.
 */
export function benchmarkManifest() {
  const entries = [];
  for (const count of [500, 1000, 1500, 2000]) {
    for (const moving of [true, false]) {
      entries.push({
        kind: "benchmark",
        mode: "steady",
        name: `tick ${count} ${moving ? "moving" : "static"} meshes`,
        source: benchmarkSource(count, moving),
        frames: 60,
        // The 1500-mesh shape is the macOS host's; the 2000-mesh one is SPEC 12's
        // own budget, and the spec states a per-tick bound, so that entry is
        // asserted on the worst frame rather than the median (AR-10).
        budgetMs: moving ? (count === 1500 ? STRESS_BUDGET_MS : count === 2000 ? SPEC_BUDGET_MS : null) : null,
        budgetOn: count === 2000 && moving ? "worst" : "median",
      });
    }
  }
  entries.push({
    kind: "benchmark",
    mode: "creation",
    name: "first flush of 1500 meshes sharing one geometry",
    source: benchmarkSource(1500, false),
    runs: 5,
    budgetMs: 400,
  });
  return { entries };
}

// The interpreter budget asserted for the 1500-mesh stress scene. The measured
// median sits comfortably below it; see the note in the README.
export const STRESS_BUDGET_MS = 6;

/** SPEC 12: 2000 objects with transform changes apply within 8 ms per tick. */
export const SPEC_BUDGET_MS = 8;

export function runInJSC(manifest, extraArgs = []) {
  const manifestPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "spatialscript-jsc-")),
    "manifest.json",
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const stdout = execFileSync(
    JSC_PATH,
    [...extraArgs, path.join(coreRoot, "scripts/jsc-driver.js"), "--", root, manifestPath],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true });

  const lines = stdout.trim().split("\n").filter((line) => line.startsWith("{"));
  if (lines.length === 0) throw new Error(`the JavaScriptCore driver printed nothing:\n${stdout}`);
  return JSON.parse(lines[lines.length - 1]).results;
}

/** Compares one driver result against the expectation; returns a diff list. */
export function checkResult(result) {
  if (result.driverError) return [`driver error: ${result.driverError}`];

  if (result.kind === "benchmark") {
    if (result.budgetMs === null || result.budgetMs === undefined) return [];
    if (result.budgetOn === "worst") {
      return result.worstMs < result.budgetMs
        ? []
        : [`worst frame ${result.worstMs} ms exceeds the ${result.budgetMs} ms budget`];
    }
    return result.medianMs < result.budgetMs
      ? []
      : [`median ${result.medianMs} ms exceeds the ${result.budgetMs} ms budget`];
  }

  if (result.kind === "robustness") {
    const diffs = [];
    if (result.name === SYNTAX_CASE) {
      if (!result.loadError) {
        diffs.push("expected a load error for a script with a syntax error");
      } else if (result.loadError.line !== SYNTAX_LINE) {
        diffs.push(
          `JavaScriptCore should locate the syntax error on line ${SYNTAX_LINE}, got ${result.loadError.line}`,
        );
      }
      return diffs;
    }
    if (result.name === "two-scenes-no-mount.js") {
      // A semantic load error legitimately has no line.
      if (!result.loadError) diffs.push("expected a load error for two unmounted scenes");
      return diffs;
    }
    if (result.loadError) diffs.push(`unexpected load error: ${result.loadError.message}`);
    if (result.tickError) diffs.push(`tick threw: ${result.tickError}`);
    if (result.nonFinite > 0) diffs.push(`${result.nonFinite} non-finite transform components reached the stream`);
    return diffs;
  }

  const expected = loadJSON(path.join(casesDir, `${result.name}.expected.json`));
  if (result.loadError) {
    const dump = {
      backend: expected.backend || "realitykit",
      platform: expected.platform || "macos",
      frame: 0,
      elapsed: 0,
      objects: [],
      objectCount: 0,
      joints: [],
      gravity: [0, -9.81, 0],
      environment: null,
      warnings: [],
      logs: [],
      errors: [`${result.loadError.name}: ${result.loadError.message}`],
    };
    return matchDump(expected, dump);
  }
  return matchDump(expected, result.dump);
}

function main() {
  if (!jscAvailable()) {
    console.log(`skipped: no JavaScriptCore shell at ${JSC_PATH}`);
    return;
  }
  const bundle = path.join(coreRoot, "dist/spatial-core.js");
  if (!fs.existsSync(bundle)) {
    console.error(`core bundle not found at ${bundle}; run the build first`);
    process.exit(2);
  }

  const results = runInJSC(buildManifest());
  // Benchmarks run again with the JIT disabled, which is how the engine runs
  // inside a hardened-runtime app and on visionOS.
  const benchmarks = runInJSC(benchmarkManifest(), ["--useJIT=false"]);
  results.push(...benchmarks);
  let passed = 0;
  const failures = [];

  for (const result of results) {
    const diffs = checkResult(result);
    const label =
      result.kind === "robustness"
        ? `robustness/${result.name}`
        : result.kind === "benchmark"
          ? `benchmark/${result.name}`
          : result.name;
    if (diffs.length === 0) {
      passed += 1;
      console.log(`pass ${label}`);
    } else {
      failures.push(label);
      console.log(`FAIL ${label}`);
      for (const diff of diffs) console.log(`     ${diff}`);
    }
  }

  console.log("");
  for (const result of results.filter((entry) => entry.kind === "benchmark")) {
    console.log(
      `JavaScriptCore (no JIT): ${result.name} - median ${result.medianMs} ms, worst ${result.worstMs} ms, ` +
        `${result.records} transform records, ${result.commandCount} commands` +
        (result.budgetMs
          ? ` [budget ${result.budgetMs} ms on the ${result.budgetOn === "worst" ? "worst frame" : "median"}` +
            `, headroom ${(
              (1 - (result.budgetOn === "worst" ? result.worstMs : result.medianMs) / result.budgetMs) *
              100
            ).toFixed(0)}%]`
          : ""),
    );
  }

  const syntax = results.find((result) => result.name === SYNTAX_CASE);
  if (syntax && syntax.loadError) {
    console.log("");
    console.log(
      `JavaScriptCore located the syntax error at line ${syntax.loadError.line}, column ${syntax.loadError.column}`,
    );
  }

  console.log("");
  console.log(`${passed}/${results.length} JavaScriptCore checks passed`);
  if (failures.length > 0) {
    console.log(`failed: ${failures.join(", ")}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
