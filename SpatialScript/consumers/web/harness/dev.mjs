// Serves the three.js consumer's page for a real browser, so a script can be
// edited and run by hand rather than through the headless harness.
//
//   node consumers/web/harness/dev.mjs [--port 8080] [--script examples/basics.js]
//
// The app opens on its paste page; `--script` only chooses what it opens
// with. Pass `--page index.html` for the bare harness page instead.
// Ctrl-C stops the server.

import { startServer, SPATIAL_ROOT } from "./server.mjs";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

const port = Number(option("port", 8080));
const script = option("script", null);
const page = option("page", "app.html");

const served = await startServer(SPATIAL_ROOT, port);

// No `mode`: the bundle's default is `auto`, which is the render loop and the
// resize listener the app needs. `manual` is for the headless harness, which
// ticks by hand, and would leave this page frozen on its first frame.
const params = new URLSearchParams();
if (script) params.set("script", script);

const query = params.toString();
console.log(`SpatialScript three.js consumer: ${served.url}/consumers/web/${page}${query ? `?${query}` : ""}`);
console.log(`serving ${SPATIAL_ROOT}`);
if (!script) console.log("paste a script into the editor and press Run");
console.log("ctrl-c to stop");

process.on("SIGINT", () => {
  console.log("\nstopped");
  process.exit(0);
});
