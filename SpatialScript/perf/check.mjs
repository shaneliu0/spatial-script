#!/usr/bin/env node
// Asserts the SPEC section 12 end-to-end targets against the running macOS host (dev server on
// 127.0.0.1:8787): 1500 moving meshes sharing one geometry and material load in under 1 s and run
// at 60 fps or better, the steady state is one command per frame, and memory does not grow
// between consecutive large-to-small scene cycles (engine caches plateau after the first).
//
//   node perf/check.mjs
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

const failures = [];
const check = (name, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`); if (!ok) failures.push(name); };

await post("/script", gen(SMALL));
await sleep(1500);
const cold = rss();

const r = await post("/script", gen(LARGE));
check("script loads", r.ok, JSON.stringify(r.error));
await sleep(3000);
const stats = await get("/stats");
check("push to first frame under 1 s", stats.pushToFirstFrameMs < 1000, `${stats.pushToFirstFrameMs.toFixed(0)} ms`);
const a = (await get("/dump")).frame; await sleep(2000); const b = (await get("/dump")).frame; const fps = (b - a) / 2;
check("1500 moving meshes at 60 fps or better", fps >= 60, `${fps.toFixed(1)} fps (jit ${stats.jit}, interval median ${stats.frameIntervalMs.median.toFixed(2)} ms, core tick ${stats.coreTickMs.median.toFixed(2)} ms, apply ${stats.applyMs.median.toFixed(2)} ms)`);
check("steady state emits one command per frame", stats.commandCount.median <= 1, `${stats.commandCount.median}`);

async function cycle() {
  await post("/script", gen(LARGE)); await sleep(2000);
  await post("/script", gen(SMALL)); await sleep(3000);
  return rss();
}
const first = await cycle();
const second = await cycle();
check("memory does not grow between large-scene cycles", second <= first * 1.1, `cold ${cold.toFixed(0)} MB, after cycle 1 ${first.toFixed(0)} MB, after cycle 2 ${second.toFixed(0)} MB`);

process.exit(failures.length ? 1 : 0);
