#!/usr/bin/env node
// Asserts the SPEC section 12 end-to-end targets against the running macOS host (dev server on
// 127.0.0.1:8787): 1500 moving meshes sharing one geometry and material load in under 1 s and run
// at 60 fps or better, the steady state is one command per frame, and memory does not grow
// between consecutive large-to-small scene cycles (engine caches plateau after the first).
//
//   node verification/perf/check.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAC = "http://127.0.0.1:8787";
const post = async (p, body) => (await fetch(MAC + p, { method: "POST", body })).json();
const get = async (p) => (await fetch(MAC + p)).json();
const rss = () => Number(execFileSync("sh", ["-c", "ps -o rss= -p $(pgrep -x SpatialHost)"]).toString().trim()) / 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gen = (args) => execFileSync("node", [path.join(here, "gen-stress.mjs"), ...args]).toString();
const LARGE = ["--count", "1500", "--shared-geometry", "--shared-material"];
const SMALL = ["--count", "10", "--shared-geometry", "--shared-material"];

// The check replaces the running scene; the previous script is not recoverable from the app, so
// it restores the basics example on exit and says so.
const failures = [];
const restore = async () => { try { await post("/script", (await import("node:fs")).readFileSync(path.join(here, "../../examples/basics.js"), "utf8")); } catch {} };
const check = (name, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`); if (!ok) failures.push(name); };

try {
await post("/script", gen(SMALL));
await sleep(1500);
const cold = rss();

const r = await post("/script", gen(LARGE));
check("script loads", r.ok, JSON.stringify(r.error));
await sleep(3000);
const stats = await get("/stats");
check("push to first frame under 1 s", stats.pushToFirstFrameMs < 1000, `${stats.pushToFirstFrameMs.toFixed(0)} ms`);
// Frame rate from the app's own frame-interval median over its last 120 frames; the wall-clock
// count is reported beside it but is skewed by dump latency when the machine is loaded.
const a = (await get("/dump?objects=0")).frame; await sleep(2000); const b = (await get("/dump?objects=0")).frame; const wallFps = Math.max(0, (b - a) / 2);
const fps = 1000 / stats.frameIntervalMs.median;
check("1500 moving meshes at 60 fps or better", fps >= 60, `${fps.toFixed(1)} fps from the frame interval (wall-clock ${wallFps.toFixed(1)}; jit ${stats.jit}, interval median ${stats.frameIntervalMs.median.toFixed(2)} ms, core tick ${stats.coreTickMs.median.toFixed(2)} ms, apply ${stats.applyMs.median.toFixed(2)} ms)`);
check("steady state emits one command per frame", stats.commandCount.median <= 1, `${stats.commandCount.median}`);
check("no frame in the last 120 slower than 30 fps", stats.frameIntervalMs.max <= 33.4, `worst interval ${stats.frameIntervalMs.max.toFixed(2)} ms`);

// SPEC 12 says "a scene of 1500 meshes loads in under one second" with no
// exemption for a material per mesh, so this row holds the unshared scene to
// the same second. It used to need 1.5 s because RealityKit charges ~0.57 ms
// for the first write to each parameter of a freshly constructed material;
// building from a warmed prototype pays that once per process instead of once
// per material (FA-20).
const UNIQUE = ["--count", "1500", "--shared-geometry"];
const unique = await post("/script", gen(UNIQUE));
check("unique-material script loads", unique.ok, JSON.stringify(unique.error));
await sleep(3000);
const uniqueStats = await get("/stats");
check(
  "1500 meshes with a material each load under 1 s",
  uniqueStats.pushToFirstFrameMs < 1000,
  `${uniqueStats.pushToFirstFrameMs.toFixed(0)} ms (${uniqueStats.resourceCache.materialBuilds} material builds)`
);
await post("/script", gen(LARGE));
await sleep(2500);

async function cycle() {
  await post("/script", gen(LARGE)); await sleep(2000);
  await post("/script", gen(SMALL)); await sleep(3000);
  return rss();
}
const baseline = await cycle(); // warmup: a fresh process grows its heap on the first large scene; the
                                // baseline is the small scene after that, as SPEC 12 words it
const first = await cycle();
const second = await cycle();
// SPEC 12: memory returns to within 10 percent of baseline after a large scene is replaced, and
// does not grow between consecutive cycles.
check("memory returns to within 10% of baseline after each large scene", first <= baseline * 1.1 && second <= baseline * 1.1, `cold ${cold.toFixed(0)} MB, baseline after warmup ${baseline.toFixed(0)} MB, after cycle 1 ${first.toFixed(0)} MB, after cycle 2 ${second.toFixed(0)} MB`);
check("memory does not grow between large-scene cycles", second <= first * 1.1, `${first.toFixed(0)} MB then ${second.toFixed(0)} MB`);
} finally {
  // The running scene is restored whether the checks passed, failed or threw.
  await restore();
}
console.log("(the running scene was replaced during the check; examples/basics.js is loaded now)");
process.exit(failures.length ? 1 : 0);
