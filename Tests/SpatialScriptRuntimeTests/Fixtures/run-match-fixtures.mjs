// Runs verification/conformance/match.mjs over the shared matcher fixtures and
// prints one verdict per fixture as JSON. The Swift port is run over the same
// file and must agree with every verdict (SPEC 10).
//
// Usage: node run-match-fixtures.mjs <fixtures.json> <match.mjs>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [, , fixturesPath, matcherPath] = process.argv;
const { matchDump } = await import(pathToFileURL(matcherPath).href);
const { fixtures } = JSON.parse(readFileSync(fixturesPath, "utf8"));

const verdicts = fixtures.map((fixture) => {
  const diffs = matchDump(fixture.expected, fixture.actual);
  return { name: fixture.name, matched: diffs.length === 0, diffs };
});

process.stdout.write(JSON.stringify(verdicts));
