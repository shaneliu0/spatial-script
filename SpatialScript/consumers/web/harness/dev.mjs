// Serves the three.js consumer's page for a real browser, so a script can be
// edited and run by hand rather than through the headless harness.
//
//   node consumers/web/harness/dev.mjs [--port 8080] [--script examples/basics.js]
//
// The page has an editor and a Run button; `--script` only chooses what it
// opens with. Ctrl-C stops the server.

import { startServer, SPATIAL_ROOT } from "./server.mjs";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

const port = Number(option("port", 8080));
const script = option("script", null);

const served = await startServer(SPATIAL_ROOT, port);

const params = new URLSearchParams({ mode: "manual" });
if (script) params.set("script", script);

console.log(`SpatialScript three.js consumer: ${served.url}/consumers/web/index.html?${params}`);
console.log(`serving ${SPATIAL_ROOT}`);
if (!script) console.log("paste a script into the editor and press Run");
console.log("ctrl-c to stop");

process.on("SIGINT", () => {
  console.log("\nstopped");
  process.exit(0);
});
