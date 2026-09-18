#!/usr/bin/env node
// Runs one script on the macOS host (dev server) and in headless Chromium with the same steps,
// then compares core dumps, native dumps, logs, and leaves the two screenshots side by side.
//
//   node parity/run-parity.mjs <script.js> [--steps steps.json] [--label name]
//
// The macOS host must be running with its dev server on 127.0.0.1:8787. The browser run ticks
// exactly the frame count the Mac reported, at dt = elapsed / frames, so script-driven state
// is deterministic in both.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareCoreDumps, compareNativeDumps, compareLogs } from "./compare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const script = path.resolve(args[0]);
const stepsFile = args.includes("--steps") ? path.resolve(args[args.indexOf("--steps") + 1]) : null;
const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : path.basename(script, ".js");
const outDir = path.join(here, "out", label); fs.mkdirSync(outDir, { recursive: true });
const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, "utf8")) : [{ frames: 120 }];
const MAC = "http://127.0.0.1:8787";

async function mac(pathname, body) {
  const res = await fetch(MAC + pathname, body === undefined ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  return res.json();
}
function windowId() {
  return execFileSync("python3", ["-c", `import Quartz\nfor w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID):\n    if w.get('kCGWindowOwnerName')=='SpatialHost' and w.get('kCGWindowLayer')==0: print(w['kCGWindowNumber']); break`]).toString().trim();
}

// ---- Mac run: the app executes the whole plan deterministically (fixed dt, injects at exact
// frames) through POST /parity and holds the final frame so the screenshot matches the dump.
const DT = 1 / 60;
const plan = { source: fs.readFileSync(script, "utf8"), dt: DT, steps };
let macResult;
try { macResult = await mac("/parity", plan); }
catch (e) { console.log(`${label}: mac /parity failed: ${e.message}`); process.exit(2); }
if (macResult.error) console.log(`${label}: mac load error: ${macResult.error.message}`);
const macDump = macResult.dump, macNative = macResult.nativeDump, macLogs = macResult.console || [];
fs.writeFileSync(path.join(outDir, "mac.dump.json"), JSON.stringify(macDump, null, 1));
fs.writeFileSync(path.join(outDir, "mac.native.json"), JSON.stringify(macNative, null, 1));
fs.writeFileSync(path.join(outDir, "mac.console.json"), JSON.stringify(macLogs, null, 1));
await new Promise((r) => setTimeout(r, 150));
execFileSync("screencapture", ["-x", "-o", "-l", windowId(), path.join(outDir, "mac.png")]);

// ---- Web run with the identical plan
const webStepsFile = path.join(outDir, "web.steps.json"); fs.writeFileSync(webStepsFile, JSON.stringify(steps));
try {
  execFileSync("node", [path.join(root, "web/harness/parity.mjs"), script, "--steps", webStepsFile, "--dt", String(DT), "--out-dir", outDir, "--camera-preset", "mac"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
} catch (e) { console.log("web harness failed:", (e.stdout || "").toString().slice(0, 300), (e.stderr || "").toString().slice(0, 500)); process.exit(2); }
const webDump = JSON.parse(fs.readFileSync(path.join(outDir, "dump.json"), "utf8"));
const webNative = JSON.parse(fs.readFileSync(path.join(outDir, "native.json"), "utf8"));
const webLogs = JSON.parse(fs.readFileSync(path.join(outDir, "console.json"), "utf8"));
const totalFrames = macDump.frame, dt = DT;

// ---- Compare
const issues = [
  ...compareCoreDumps(macDump, webDump).map((i) => "core: " + i),
  ...compareNativeDumps(macNative, webNative).map((i) => "native: " + i),
  ...compareLogs(macLogs, webLogs).map((i) => "logs: " + i),
];
console.log(`${label}: mac frames ${totalFrames} (dt ${dt.toFixed(5)}), objects mac ${macDump.objects.length} web ${webDump.objects.length}, native rk ${macNative.objects.length} three ${webNative.objects.length}`);
console.log(issues.length ? issues.map((i) => "  MISMATCH " + i).join("\n") : "  PARITY OK");
console.log(`  screenshots: ${path.join(outDir, "mac.png")}  ${path.join(outDir, "screenshot.png")}`);
fs.writeFileSync(path.join(outDir, "issues.json"), JSON.stringify(issues, null, 1));
process.exit(issues.length ? 1 : 0);
