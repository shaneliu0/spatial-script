// Runs match.mjs over the matcher fixtures the Swift port also runs (SPEC 10), and asserts the
// verdict each fixture records. A change to match.mjs alone is caught here; a change to the Swift
// port alone is caught by MatcherEquivalenceTests; a change to both must edit the fixture file.
//
//   node verification/conformance/match.test.mjs   (exit 1 on any disagreement)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchDump } from "./match.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesPath = path.resolve(
  here,
  "../../Tests/SpatialScriptRuntimeTests/Fixtures/matcher-fixtures.json",
);
const { fixtures } = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
let failed = 0;
for (const fixture of fixtures) {
  if (typeof fixture.matches !== "boolean") { console.log(`FAIL ${fixture.name}: fixture records no verdict`); failed += 1; continue; }
  const diffs = matchDump(fixture.expected, fixture.actual);
  const matched = diffs.length === 0;
  if (matched !== fixture.matches) {
    console.log(`FAIL ${fixture.name}: expected ${fixture.matches ? "a match" : "no match"} (${fixture.rule}), got ${matched ? "a match" : JSON.stringify(diffs)}`);
    failed += 1;
  }
}
console.log(failed ? `${failed} of ${fixtures.length} matcher fixtures disagree` : `${fixtures.length}/${fixtures.length} matcher fixtures agree with match.mjs`);
process.exit(failed ? 1 : 0);
