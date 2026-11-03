#!/usr/bin/env node
// Runs one script on the macOS host (dev server) and in headless Chromium with the same steps,
// then compares core dumps, native dumps, logs, and leaves the two screenshots side by side.
//
//   node verification/parity/run-parity.mjs <script.js> [--steps steps.json] [--label name]
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
const root = path.resolve(here, "../..");
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
// The app owns three on-screen windows now — the scene, the control panel and the console — and
// CGWindowListCopyWindowInfo returns them front to back, so "the first one" is whichever the user
// last focused. The scene window is the one that is not a named UI window; picking it by exclusion
// keeps the screenshot pointed at the RealityView no matter what has focus.
const UI_WINDOW_TITLES = (process.env.SPATIAL_HOST_UI_WINDOWS ?? "").split(",").filter(Boolean);
function windowId() {
  const script = [
    "import Quartz",
    `skip = ${JSON.stringify(UI_WINDOW_TITLES)}`,
    "for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID):",
    "    if w.get('kCGWindowOwnerName') != 'SpatialHost' or w.get('kCGWindowLayer') != 0: continue",
    "    if (w.get('kCGWindowName') or '') in skip: continue",
    "    print(w['kCGWindowNumber']); break",
  ].join("\n");
  const id = execFileSync("python3", ["-c", script]).toString().trim();
  if (!id) throw new Error("the macOS host's scene window was not found on screen; is the app running with its scene window open?");
  return id;
}

// ---- Mac run: the app executes the whole plan deterministically (fixed dt, injects at exact
// frames) through POST /parity and holds the final frame so the screenshot matches the dump.
const DT = 1 / 60;
const plan = { source: fs.readFileSync(script, "utf8"), dt: DT, steps };
let macResult;
try { macResult = await mac("/parity", plan); }
catch (e) { console.log(`${label}: mac /parity failed: ${e.message}`); process.exit(2); }
const macLoadError = macResult.error ? String(macResult.error.message || macResult.error) : null;
const macDump = macResult.dump, macNative = macResult.nativeDump, macLogs = macResult.console || [];
fs.writeFileSync(path.join(outDir, "mac.dump.json"), JSON.stringify(macDump, null, 1));
fs.writeFileSync(path.join(outDir, "mac.native.json"), JSON.stringify(macNative, null, 1));
fs.writeFileSync(path.join(outDir, "mac.console.json"), JSON.stringify(macLogs, null, 1));
await new Promise((r) => setTimeout(r, 150));
execFileSync("screencapture", ["-x", "-o", "-l", windowId(), path.join(outDir, "mac.png")]);

// ---- Web run with the identical plan
const webStepsFile = path.join(outDir, "web.steps.json"); fs.writeFileSync(webStepsFile, JSON.stringify(steps));
try {
  // The browser viewport takes the Mac window's drawable size so an aspect-dependent value
  // (an orthographic camera's visible width, a picking ray) is computed from the same numbers.
  const viewport = macResult.viewport && macResult.viewport.width > 0 && macResult.viewport.height > 0
    ? ["--width", String(Math.round(macResult.viewport.width)), "--height", String(Math.round(macResult.viewport.height))]
    : [];
  execFileSync("node", [path.join(root, "consumers/web/harness/parity.mjs"), script, "--steps", webStepsFile, "--dt", String(DT), "--out-dir", outDir, "--camera-preset", "mac", ...viewport], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
} catch (e) { console.log("web harness failed:", (e.stdout || "").toString().slice(0, 300), (e.stderr || "").toString().slice(0, 500)); process.exit(2); }
// A load error is a legitimate outcome that must itself match: both backends must fail to load
// with the same message (line numbers may differ between engines).
const webConsole = JSON.parse(fs.readFileSync(path.join(outDir, "console.json"), "utf8"));
const webLoadError = (webConsole.find((l) => l.type === "loadError" || l.level === "loadError" || /^SpatialLoadError:/.test(String(l.message || ""))) || {}).message ?? null;
if (macLoadError || webLoadError) {
  // Engines differ in the stack they append and in whether the load error wrapper names
  // itself first; the message proper is what must match.
  const strip = (m) => String(m || "").split("\n")[0].replace(/^SpatialLoadError:\s*/, "").replace(/\s*\(line \d+, column \d+\)/g, "").trim();
  const ok = macLoadError && webLoadError && strip(macLoadError) === strip(webLoadError);
  console.log(`${label}: load error on ${macLoadError ? "mac" : "-"}/${webLoadError ? "web" : "-"}: ${ok ? "PARITY OK (both refuse with the same message)" : "MISMATCH mac " + JSON.stringify(macLoadError) + " web " + JSON.stringify(webLoadError)}`);
  fs.writeFileSync(path.join(outDir, "issues.json"), JSON.stringify(ok ? [] : ["load error mismatch"], null, 1));
  process.exit(ok ? 0 : 1);
}
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
const macFrames = macDump.frame, webFrames = webDump.frame;
console.log(`${label}: mac frames ${totalFrames} (dt ${dt.toFixed(5)}), objects mac ${macDump.objects.length} web ${webDump.objects.length}, native rk ${macNative.objects.length} three ${webNative.objects.length}`);
console.log(issues.length ? issues.map((i) => "  MISMATCH " + i).join("\n") : "  PARITY OK");
console.log(`  screenshots: ${path.join(outDir, "mac.png")}  ${path.join(outDir, "screenshot.png")}`);
fs.writeFileSync(path.join(outDir, "issues.json"), JSON.stringify(issues, null, 1));
process.exit(issues.length ? 1 : 0);
