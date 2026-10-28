#!/usr/bin/env node
// Copies docs/AGENT-PROMPT.md into the Swift package resources, so the app can
// hand a generator the same document the repository reviews.
//
//   node tools/sync-agent-prompt.mjs           # copy
//   node tools/sync-agent-prompt.mjs --check   # exit 1 when the copy is stale
//
// docs/AGENT-PROMPT.md is the source of truth. The Resources copy is generated
// and must never be hand-edited: `--check` is what enforces that.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repoRoot = path.resolve(root, "..");

const sourceFile = path.join(root, "docs/AGENT-PROMPT.md");
const destFile = path.join(
  repoRoot,
  "Packages/RealityKitScripting/Sources/RealityKitScripting/Resources/agent-prompt.md",
);

function main() {
  const check = process.argv.slice(2).includes("--check");

  if (!fs.existsSync(sourceFile)) {
    console.error(`agent prompt not found at ${sourceFile}`);
    process.exit(2);
  }
  const source = fs.readFileSync(sourceFile, "utf8");

  if (check) {
    if (!fs.existsSync(destFile)) {
      console.error(`agent-prompt.md is missing from the package resources (${destFile})`);
      console.error('run "pnpm agent-prompt:sync"');
      process.exit(1);
    }
    if (fs.readFileSync(destFile, "utf8") !== source) {
      console.error("the packaged agent-prompt.md differs from docs/AGENT-PROMPT.md");
      console.error('run "pnpm agent-prompt:sync" (docs/AGENT-PROMPT.md is the source of truth)');
      process.exit(1);
    }
    console.log(`agent-prompt.md is in sync (${source.length} bytes)`);
    return;
  }

  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, source);
  console.log(`synced ${source.length} bytes -> ${destFile}`);
}

main();
