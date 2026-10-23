// Guards the parity comparator: every divergence class it must catch, as a runnable check.
//   node verification/parity/compare.test.mjs   (exit code 1 when a class is missed)

import { compareCoreDumps, compareNativeDumps, compareLogs } from "./compare.mjs";
const base = () => ({ frame: 10, elapsed: 0.1, objects: [{ id: 1, name: "box", type: "Mesh", parent: 0, position: [1,2,3], quaternion: [0,0,0,1], scale: [1,1,1], visible: true, material: { type: "MeshStandardMaterial", color: [1,0,0], emissive: [0,0,0], side: 0 }, castShadow: false }, { id: 2, name: "", type: "Group", parent: 0, position: [0,0,0], quaternion: [0,0,0,1], scale: [1,1,1], visible: true }], errors: [], warnings: [], scene: { userData: {} } });
const cases = {
  nan: (w) => { w.objects[0].position = [NaN, 2, 3]; },
  unnamed: (w) => { w.objects[1].position = [5,5,5]; },
  errorsMsg: (w) => { w.errors = ["x"]; },
  warnings: (w) => { w.warnings = ["something generic"]; },
  emissive: (w) => { w.objects[0].material.emissive = [1,1,1]; },
  castShadow: (w) => { w.objects[0].castShadow = true; },
  frame: (w) => { w.frame = 11; },
  keyOnOneSide: (w) => { delete w.objects[0].castShadow; },
  mediaClockNeverAdvanced: (w) => { w.objects[0].audio = { currentTime: 0 }; },
  materialArrayElement: (w) => { w.objects[0].material = [{ type: "MeshStandardMaterial", color: [1,0,0] }, { type: "MeshStandardMaterial", color: [0,1,0] }]; },
  userDataNumber: (w) => { w.scene.userData = { height: 0.5 }; },
  topLevelIsActive: (w) => { w.isActive = false; },
  topLevelFutureKey: (w) => { w.newPhaseKey = 1; },
  sceneName: (w) => { w.scene.name = "other"; },
  duplicateWarning: (w) => { w.warnings = ["something generic", "something generic"]; },
  macOnlyWarningWithOrdinaryWord: (w) => { w.warnings = []; },
};
// Classes that must NOT be reported: engine locations, per-process uuids, a media clock that
// merely differs, and a per-run scene userData float within tolerance.
const quiet = {
  errorLocation: (m, w) => { m.errors = ["Error: boom (line 3, column 9)"]; w.errors = ["Error: boom (line 3, column 21)"]; },
  uuidInsideGeometry: (m, w) => { m.objects[0].geometry = { type: "BoxGeometry", uuid: "a" }; w.objects[0].geometry = { type: "BoxGeometry", uuid: "b" }; },
  mediaClockDrift: (m, w) => { m.objects[0].audio = { currentTime: 0.55 }; w.objects[0].audio = { currentTime: 0.19 }; },
  userDataNoise: (m, w) => { m.scene.userData = { hand: [0.1648956, 0.07] }; w.scene.userData = { hand: [0.1649522, 0.07] }; },
  platformOnlyWarning: (m, w) => { m.warnings = ["Object3D.manipulable is unsupported on macOS; ManipulationComponent is visionOS only"]; w.warnings = []; },
};
let missed = 0;
// Cases whose mutation only reads against a prepared mac side run in the paired loop below.
const PAIRED_ONLY = new Set(["macOnlyWarningWithOrdinaryWord", "duplicateWarning"]);
for (const [name, mutate] of Object.entries(cases)) { if (PAIRED_ONLY.has(name)) continue; const m = base(), w = base(); mutate(w); const issues = compareCoreDumps(m, w); if (!issues.length) { console.log("MISSED", name); missed++; } }
for (const [name, mutate] of Object.entries(cases)) { const m = base(), w = base(); if (name === "duplicateWarning") { m.warnings = ["something generic"]; } if (name === "topLevelIsActive") m.isActive = true; if (name === "sceneName") m.scene.name = "mine"; if (name === "macOnlyWarningWithOrdinaryWord") m.warnings = ["the browser panel is open"]; if (name === "mediaClockNeverAdvanced") m.objects[0].audio = { currentTime: 0.5 }; if (name === "materialArrayElement") m.objects[0].material = [{ type: "MeshStandardMaterial", color: [1,0,0] }, { type: "MeshStandardMaterial", color: [0,0,1] }]; if (name === "userDataNumber") m.scene.userData = { height: 0.9 }; mutate(w); if (!compareCoreDumps(m, w).length) { console.log("MISSED (paired)", name); missed++; } }
for (const [name, mutate] of Object.entries(quiet)) { const m = base(), w = base(); mutate(m, w); const issues = compareCoreDumps(m, w); if (issues.length) { console.log("FALSE POSITIVE", name, issues); missed++; } }
const dup = base(); dup.objects.push({ id: 3, name: "box", type: "Mesh", parent: 0, position: [9,9,9], quaternion: [0,0,0,1], scale: [1,1,1], visible: true });
const dup2 = JSON.parse(JSON.stringify(dup)); dup2.objects[0].position = [7,7,7];
if (!compareCoreDumps(dup, dup2).length) { console.log("MISSED duplicate-name first instance"); missed++; }
const l = compareLogs([{ level: "warn", message: "a" }, { level: "log", message: "b" }, { level: "log", message: "c" }], [{ level: "log", message: "b" }, { level: "log", message: "x" }]);
if (l.length < 2) { console.log("MISSED logs (all lines, warn level)", l); missed++; }
const lw = compareLogs([{ level: "log", message: "opening the browser panel: 3 items" }], [{ level: "log", message: "opening the browser panel: 99 items" }]);
if (!lw.length) { console.log("MISSED a script log line containing an ordinary backend word"); missed++; }
const lp = compareLogs([{ level: "warn", message: "Object3D.manipulable is unsupported on macOS; ManipulationComponent is visionOS only" }], []);
if (lp.length) { console.log("FALSE POSITIVE platform-only warning mirrored in the console", lp); missed++; }
const n1 = base(), n2 = base(); delete n2.objects[0].position; if (!compareNativeDumps(n1, n2).length) { console.log("MISSED native key on one side"); missed++; }
console.log(missed ? `${missed} MISSED` : "all divergence classes caught");
process.exit(missed ? 1 : 0);
