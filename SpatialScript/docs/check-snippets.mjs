#!/usr/bin/env node
// Extracts every runnable code block from the SpatialScript documentation and
// runs it against the core, so no example in the docs can rot.
//
//   node docs/check-snippets.mjs            # every doc
//   node docs/check-snippets.mjs API.md     # only files whose path contains this
//   node docs/check-snippets.mjs --verbose  # print every snippet, not only failures
//
// A fenced block is executed when its info string is exactly `js runnable`.
// Plain ```js blocks are fragments and are skipped, so a snippet that is not a
// whole script does not have to pretend to be one.
//
// Directives on the line immediately before the opening fence:
//
//   <!-- expect-error: substring -->   the snippet must produce a dump().errors
//                                      entry containing `substring`
//   <!-- snippet: backend=three, platform=web -->
//                                      load with a different backend
//                                      (default: backend=realitykit, platform=macos)
//
// Each snippet is loaded, ticked 120 times at 1/60 s, and checked. `asset`
// commands are answered with an `assetError` dispatch so that a script which
// awaits Spatial.loadAsset() settles instead of hanging.
//
// A snippet fails when it throws at load, throws out of a tick, or leaves
// anything in dump().errors. `expect-error` satisfies whichever of those three
// happens, as long as the message contains the substring.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "../conformance/run-node.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bundlePath = path.join(root, "core/dist/spatial-core.js");

const FRAME = 1 / 60;
const TICKS = 120;

/** Every markdown file the checker owns: docs/**\/*.md plus the package README. */
function markdownFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(here);
  const readme = path.join(root, "README.md");
  if (fs.existsSync(readme)) files.push(readme);
  return files.sort();
}

/**
 * Pulls out the fenced blocks marked `js runnable`, with the 1-based line of
 * the opening fence and whatever directive comment precedes it.
 */
export function extractSnippets(source, file) {
  const lines = source.split("\n");
  const snippets = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== "```js runnable") continue;
    const body = [];
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== "```") {
      body.push(lines[end]);
      end += 1;
    }
    snippets.push({
      file,
      line: i + 1,
      source: body.join("\n"),
      ...parseDirectives(i > 0 ? lines[i - 1] : ""),
    });
    i = end;
  }
  return snippets;
}

function parseDirectives(line) {
  const directives = { expectError: null, backend: "realitykit", platform: "macos" };

  const expected = /<!--\s*expect-error:\s*(.+?)\s*-->/.exec(line);
  if (expected) directives.expectError = expected[1];

  const options = /<!--\s*snippet:\s*(.+?)\s*-->/.exec(line);
  if (options) {
    for (const pair of options[1].split(/[,\s]+/)) {
      const [key, value] = pair.split("=");
      if (key === "backend" || key === "platform") directives[key] = value;
    }
  }
  return directives;
}

/**
 * Loads one snippet and ticks it. Returns the failure reasons, empty when the
 * snippet is healthy.
 */
async function runSnippet(bundleSource, snippet) {
  const host = createHost(bundleSource);
  const problems = [];

  try {
    host.spatial.load(snippet.source, {
      backend: snippet.backend,
      platform: snippet.platform,
      assetRoot: "assets",
    });
  } catch (error) {
    const message = `${error.name || "Error"}: ${error.message}`;
    if (snippet.expectError && message.includes(snippet.expectError)) return { problems, dump: null };
    problems.push(`load threw ${message}` + locate(error));
    return { problems, dump: null };
  }

  let answered = 0;
  for (let frame = 0; frame < TICKS; frame += 1) {
    try {
      host.tick(FRAME);
    } catch (error) {
      const message = `${error.name || "Error"}: ${error.message}`;
      if (snippet.expectError && message.includes(snippet.expectError)) return { problems, dump: null };
      problems.push(`tick ${frame + 1} threw ${message}`);
      return { problems, dump: null };
    }
    // A script that awaits loadAsset() would otherwise never resume, because
    // nothing in Node answers the `asset` command the core emitted.
    for (const command of host.recorded.slice(answered)) {
      if (command[0] === "asset") {
        host.spatial.dispatch("assetError", command[1], { message: "no asset loader in the snippet checker" });
      }
    }
    answered = host.recorded.length;
    // Give promise continuations inside the context a turn (top-level await,
    // loadAsset, TextureLoader.loadAsync).
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }

  const dump = host.spatial.dump();
  const errors = dump.errors;

  if (snippet.expectError) {
    const matched = errors.some((entry) => entry.includes(snippet.expectError));
    if (!matched) {
      problems.push(
        `expected an error containing ${JSON.stringify(snippet.expectError)}, got ${JSON.stringify(errors)}`,
      );
    }
  } else if (errors.length > 0) {
    for (const entry of errors) problems.push(`dump().errors: ${entry}`);
  }

  return { problems, dump };
}

function locate(error) {
  if (error.line === null || error.line === undefined) return "";
  return ` (snippet line ${error.line}${error.column === null || error.column === undefined ? "" : `, column ${error.column}`})`;
}

async function main() {
  if (!fs.existsSync(bundlePath)) {
    console.error(`core bundle not found at ${bundlePath}; run "pnpm --filter @spatialscript/core build" first`);
    process.exit(2);
  }
  const bundleSource = fs.readFileSync(bundlePath, "utf8");

  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const filters = args.filter((arg) => !arg.startsWith("--"));

  const snippets = [];
  for (const file of markdownFiles()) {
    if (filters.length > 0 && !filters.some((filter) => file.includes(filter))) continue;
    snippets.push(...extractSnippets(fs.readFileSync(file, "utf8"), file));
  }

  let failed = 0;
  for (const snippet of snippets) {
    const label = `${path.relative(root, snippet.file)}:${snippet.line}`;
    // eslint-disable-next-line no-await-in-loop
    const { problems } = await runSnippet(bundleSource, snippet);
    if (problems.length === 0) {
      if (verbose) console.log(`pass ${label}`);
      continue;
    }
    failed += 1;
    console.log(`FAIL ${label}`);
    for (const problem of problems) console.log(`     ${problem}`);
  }

  console.log("");
  console.log(`${snippets.length - failed}/${snippets.length} runnable snippets passed`);
  if (failed > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
