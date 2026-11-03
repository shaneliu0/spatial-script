#!/usr/bin/env node
// Holds types/spatial.d.ts and the built core to the same API surface.
//
//   node verification/conformance/exports.test.mjs
//
// docs/AGENT-PROMPT.md embeds types/spatial.d.ts verbatim and tells a generator
// that it is the exhaustive list of what exists. That claim is only true while
// the declarations and the runtime agree, so this test asserts it both ways:
//
//   * declared but not exposed -- the prompt promises an API the core does not
//     have, and a generated script calling it throws.
//   * exposed but not declared -- the prompt hides a real API, and nothing
//     reviews it.
//
// Only declarations that denote a runtime value are compared: `interface` and
// `type` are erased by TypeScript and have no value to find. `namespace limits`
// is compared separately against `Spatial.limits`, because its members live
// there rather than at the top level.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "./run-node.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const bundlePath = path.join(root, "core/dist/spatial-core.js");
const typesPath = path.join(root, "types/spatial.d.ts");

/**
 * Names declared as classes in `declare namespace Spatial` that intentionally
 * have no constructor on the namespace. Each is the *type* of a value a script
 * receives, never something a script calls `new` on, so exporting a constructor
 * would invite scripts to build one the consumer would never see.
 *
 * Anything added here needs a reason that survives review. A class that a
 * script should be able to construct belongs in core/src/namespace.js instead.
 */
const DECLARED_WITHOUT_VALUE = new Map([
  ["Material", "base class of MeshBasicMaterial/MeshStandardMaterial/MeshPhysicalMaterial/OcclusionMaterial/ShaderGraphMaterial; Mesh.material is typed by it, but a bare Material has no consumer mapping"],
  ["Light", "base class of AmbientLight/DirectionalLight/PointLight/SpotLight; carries color and intensity for the subclasses, and a bare Light has no light payload"],
  ["Camera", "base class of PerspectiveCamera/OrthographicCamera; Spatial.camera is typed `Camera | null`, and a bare Camera has no projection to emit"],
  ["AssetGroup", "the resolved value of Spatial.loadAsset(); only the loader may build one, because its contents come back from the consumer"],
  ["ForceField", "base class of the five force fields; `kind` is set by each subclass and a bare field has no effect to apply"],
]);

/** Everything the core exposes on the `require("spatial")` namespace. */
function runtimeNames() {
  if (!fs.existsSync(bundlePath)) {
    console.error(`core bundle not found at ${bundlePath}; run "pnpm --filter @spatialscript/core build" first`);
    process.exit(2);
  }
  const host = createHost(fs.readFileSync(bundlePath, "utf8"));
  // The namespace's live getters (`scene`, `camera`, `physics`, ...) are
  // defined at construction, so they enumerate before a load; loading a minimal
  // scene anyway keeps the read on the same path a real script takes.
  host.spatial.load('Spatial.mount(new (require("spatial").Scene)());', {
    backend: "realitykit",
    platform: "macos",
    assetRoot: "assets",
  });
  const spatial = host.spatial.Spatial;
  return {
    top: new Set(Object.keys(spatial)),
    limits: new Set(Object.keys(spatial.limits)),
  };
}

/**
 * The value-level names declared at the top level of `declare namespace
 * Spatial`, plus the members of its `limits` namespace.
 *
 * Top-level declarations are indented two spaces; everything nested inside a
 * class, interface or namespace body is indented four or more, which is what
 * separates the two sets without needing a TypeScript parser.
 */
export function declaredNames(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith("declare namespace Spatial {"));
  if (start === -1) throw new Error("types/spatial.d.ts has no `declare namespace Spatial {`");

  const top = new Set();
  const limits = new Set();
  let inLimits = false;

  const VALUE = /^ {2}(?:abstract )?(class|const|let|var|function|namespace) ([A-Za-z_$][A-Za-z0-9_$]*)/;
  const LIMIT_MEMBER = /^ {4}const ([A-Za-z_$][A-Za-z0-9_$]*)/;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "}") break; // end of `declare namespace Spatial`

    if (inLimits) {
      if (line === "  }") {
        inLimits = false;
        continue;
      }
      const member = LIMIT_MEMBER.exec(line);
      if (member) limits.add(member[1]);
      continue;
    }

    const match = VALUE.exec(line);
    if (!match) continue;
    const [, keyword, name] = match;
    if (keyword === "namespace") {
      if (name === "limits") inLimits = true;
      // A namespace is a value too, so it still belongs in the top-level set.
    }
    top.add(name);
  }

  return { top, limits };
}

function difference(a, b) {
  return [...a].filter((name) => !b.has(name)).sort();
}

function main() {
  const declared = declaredNames(fs.readFileSync(typesPath, "utf8"));
  const runtime = runtimeNames();

  const problems = [];

  const missing = difference(declared.top, runtime.top);
  const unexempted = missing.filter((name) => !DECLARED_WITHOUT_VALUE.has(name));
  if (unexempted.length > 0) {
    problems.push(
      `declared in types/spatial.d.ts but not exposed on the namespace: ${unexempted.join(", ")}\n` +
        "     either export it from core/src/namespace.js, or add it to DECLARED_WITHOUT_VALUE with a reason",
    );
  }

  const undeclared = difference(runtime.top, declared.top);
  if (undeclared.length > 0) {
    problems.push(
      `exposed on the namespace but not declared in types/spatial.d.ts: ${undeclared.join(", ")}\n` +
        "     docs/AGENT-PROMPT.md calls the declarations exhaustive, so every exposed name must be in them",
    );
  }

  // An exemption that stops being needed is an exemption that misleads.
  const stale = [...DECLARED_WITHOUT_VALUE.keys()].filter((name) => runtime.top.has(name) || !declared.top.has(name));
  if (stale.length > 0) {
    problems.push(
      `DECLARED_WITHOUT_VALUE lists names that no longer need an exemption: ${stale.sort().join(", ")}`,
    );
  }

  const limitsMissing = difference(declared.limits, runtime.limits);
  if (limitsMissing.length > 0) {
    problems.push(`declared under \`namespace limits\` but absent from Spatial.limits: ${limitsMissing.join(", ")}`);
  }
  const limitsUndeclared = difference(runtime.limits, declared.limits);
  if (limitsUndeclared.length > 0) {
    problems.push(`present on Spatial.limits but not declared under \`namespace limits\`: ${limitsUndeclared.join(", ")}`);
  }

  if (problems.length > 0) {
    console.log("FAIL exports conformance");
    for (const problem of problems) console.log(`     ${problem}`);
    console.log("");
    process.exit(1);
  }

  console.log(
    `exports conformance: ${runtime.top.size} namespace names and ${runtime.limits.size} limits ` +
      `match types/spatial.d.ts both ways (${DECLARED_WITHOUT_VALUE.size} declared-only base types exempted)`,
  );
}

main();
