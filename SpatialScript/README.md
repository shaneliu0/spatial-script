# SpatialScript

SpatialScript is a JavaScript scene API for building interactive 3D scenes that
render in RealityKit (macOS and visionOS) and in three.js (a browser), from one
unchanged script. It follows three.js class names, constructor signatures,
property names and method names wherever a three.js equivalent exists, so
three.js knowledge transfers directly. It is not three.js: there is no
renderer, no camera the script controls, no custom shaders and no
post-processing — you build a scene and call `Spatial.mount(scene)`, and the
host renders it. It adds what a spatial runtime needs and three.js lacks:
physics bodies and joints, tap/hover/drag/manipulation events with bubbling,
anchors, portals, particles, hand input, and whole-object opacity. Features
RealityKit cannot express are either absent from the namespace or fail loudly,
and no script input can crash the host or stop the frame loop.

## Documentation

| Document | Read it when |
|---|---|
| [docs/API.md](docs/API.md) | you need the complete reference: every class, property, default, method, and which backend supports it |
| [docs/DIFFERENCES.md](docs/DIFFERENCES.md) | before writing your first script, if you know three.js |
| [docs/COOKBOOK.md](docs/COOKBOOK.md) | you have a task: tappable objects, physics, portals, assets, anchors, verification |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | something does not render, fire, move, or load |
| [SPEC.md](SPEC.md) | you are changing the runtime, not writing a script |
| [types/spatial.d.ts](types/spatial.d.ts) | you want editor completion — the authoritative signatures |

---

## Quick start

A complete script. Save it as `scene.js`.

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, PlaneGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, Color,
} = Spatial;

const scene = new Scene();

// Standard materials are physically based: with no light they render black.
scene.add(new AmbientLight(0xffffff, 0.35));

const sun = new DirectionalLight(0xfff4e6, 2.5);
sun.name = "sun";
sun.position.set(0.6, 1.2, 0.8);
sun.castShadow = true;
scene.add(sun);

// Units are metres. Content lives within ~0.5 m of the origin.
const floor = new Mesh(new PlaneGeometry(0.9, 0.9), new MeshStandardMaterial({ color: 0x2b2f36 }));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.2;
floor.receiveShadow = true;
scene.add(floor);

const cube = new Mesh(
  new BoxGeometry(0.16, 0.16, 0.16),
  new MeshStandardMaterial({ color: 0x3366ff, roughness: 0.35 }),
);
cube.name = "cube";
cube.castShadow = true;
scene.add(cube);

// Registering a listener is what makes an object an input target.
cube.addEventListener("tap", () => {
  cube.material.color.copy(new Color().setHSL(Math.random(), 0.7, 0.55));
});

Spatial.onFrame((deltaTime) => {
  cube.rotation.y += deltaTime * 0.8;
});

Spatial.mount(scene);
```

Five things to internalise before writing more: **units are metres**,
**`mount` replaces `render`**, **an unlit `MeshStandardMaterial` is black on
both backends**, **`Spatial.env.capabilities` tells you what the current backend
actually does** (macOS has no hands, no anchoring, no system manipulation, no
hover effect), and **`Spatial.limits` names every cap the runtime enforces** so
a generated scene can stay inside them. The rest is in
[docs/DIFFERENCES.md](docs/DIFFERENCES.md).

---

## Running a script in the macOS host

The macOS host starts an HTTP server on `127.0.0.1:8787` in DEBUG builds only.
With a macOS host app that embeds the runtime and serves this transport running:

```bash
# is it up?
curl -s http://127.0.0.1:8787/health
# {"ok":true,"port":8787,"jit":true,"watchdog":"inactive (requires interpreter mode)"}
# jit:      false when the app was launched in interpreter mode
# watchdog: "armed" only in interpreter mode; see below

# push a script; the scene is replaced immediately
examples/push.sh scene.js
# or, equivalently:
curl -s --data-binary @scene.js http://127.0.0.1:8787/script
# {"ok":true,"error":null}
# on failure: {"ok":false,"error":{"message":"ReferenceError: nope is not defined","line":12,"column":3}}

# the core's view of the scene
curl -s http://127.0.0.1:8787/dump | jq '{errors, droppedErrors, warnings, count: (.objects | length)}'
curl -s http://127.0.0.1:8787/dump | jq '.objects[] | select(.name=="cube")'

# the cheap forms, for polling (see below)
curl -s 'http://127.0.0.1:8787/dump?compact=1'
curl -s 'http://127.0.0.1:8787/dump?names=cube,floor&fields=position,visible'

# the same shape rebuilt from the live RealityKit entities: compare the two to
# check that the scene really reached the renderer
curl -s http://127.0.0.1:8787/native-dump | jq '.objects[] | select(.name=="cube")'

# console and error lines since the last call (draining)
curl -s http://127.0.0.1:8787/logs | jq -r '.logs[] | "\(.level): \(.message)"'

# synthesise input without touching the mouse
curl -s -X POST http://127.0.0.1:8787/inject -d '{"type":"tap","target":"cube"}'
curl -s -X POST http://127.0.0.1:8787/inject -d '{"type":"hover","target":"cube","entering":true}'
curl -s -X POST http://127.0.0.1:8787/inject -d '{"type":"drag","target":"cube","translation":[0.1,0,0]}'
curl -s -X POST http://127.0.0.1:8787/inject -d '{"type":"key","code":"KeyW","down":true}'
```

`examples/push.sh <file.js> [host:port]` is the shorthand for the push.

The verification loop is: push, inject, dump, assert. Publish whatever you want
to assert on through `object.userData`, which the dump carries verbatim. See
[COOKBOOK recipe 17](docs/COOKBOOK.md#17-verifying-a-scene-with-inject-and-the-dump).

For a screenshot, capture the app's window from outside the app:
`screencapture -l <windowID> out.png`. Release builds compile none of the dev
server.

### `GET /dump` options and the cheap poll

`GET /dump` and `GET /native-dump` accept the same narrowing as
[`Spatial.dump(options)`](docs/API.md#spatialdump), as query parameters:

| Parameter | Effect |
|---|---|
| `compact=1` | each object reduced to `id`, `name`, `type`, `parent`, `visible`, `position`, `quaternion`, `scale`, `worldPosition`, rounded to four decimals |
| `names=a,b,c` | only objects with those names |
| `fields=position,visible` | only those per-object keys (`id` and `name` are always present) |
| `objects=0` | no object list at all — just the scene summary, `warnings`, `errors` and `droppedErrors` |

The top-level fields survive every combination, so `?objects=0` is the cheapest
health check there is.

**Poll a narrowed dump, and never poll a full `/native-dump`.** An unfiltered
`/dump` is serialised inside JavaScriptCore in one pass, so even a 10 000-object
scene costs about **90 ms** — tolerable once, still a dropped frame if you do it
in a loop. `/native-dump` has no such fast path: it is rebuilt value by value
from the live entities, and the same scene costs about **0.6 s**. Use the full
native dump for a one-shot comparison, and `?compact=1` or `?names=` when you
need to watch it. The pattern that scales:

```bash
# once, to learn the scene
curl -s http://127.0.0.1:8787/dump | jq '.objects | map(.name)'

# then, in a loop
curl -s 'http://127.0.0.1:8787/dump?objects=0' | jq '{frame, errors, droppedErrors}'
curl -s 'http://127.0.0.1:8787/dump?names=cube&fields=position' | jq '.objects[0]'

# comparing against the renderer: narrow the native dump the same way
curl -s 'http://127.0.0.1:8787/native-dump?names=cube&fields=position,worldPosition' | jq '.objects[0]'
```

Identical requests are answered from a **100 ms cache**, keyed by path and query
string, so a tight polling loop costs one build per 100 ms rather than one per
request. Two consequences: a poll can be up to 100 ms stale, and varying the
query varies the cache key.

### Interpreter mode

Launch the macOS host with the JavaScriptCore JIT off:

```bash
SPATIAL_INTERPRETER=1 open -a YourHostApp
# or, from Xcode: add --interpreter to the scheme's arguments
```

The flag is read before JavaScriptCore initialises — it has to be, since JSC
reads its options once when its VM is first created — and does two things:

1. **It arms the watchdog.** The DEBUG 2-second execution limit cannot interrupt
   a runaway loop while the JIT is on, because the JIT's interrupt check never
   fires in this hardened process. In interpreter mode `while (true) {}` inside
   `onFrame` terminates the script and disposes the scene instead of freezing
   the app. `GET /health` reports `"watchdog": "armed"` once it is on.
2. **It mirrors visionOS performance.** visionOS never allows the JIT, so an
   interpreter run on the Mac is the closest local measurement of what a scene
   will cost on device. Measured here: 1500 independently moving meshes run at
   about **83 fps with a 3.7 ms core tick** in interpreter mode, against
   **120 fps** with the JIT.

`GET /stats` reports `jit` alongside the timings, so a saved measurement always
says which mode produced it. Compare interpreter runs with interpreter runs.

### `GET /stats` — what the renderer is actually doing

```bash
curl -s http://127.0.0.1:8787/stats | jq
```

```json
{
  "frames": 120,
  "coreTickMs":       { "mean": 0.42, "median": 0.38, "max": 1.9 },
  "applyMs":          { "mean": 0.31, "median": 0.28, "max": 2.4 },
  "frameIntervalMs":  { "mean": 8.31, "median": 8.30, "max": 9.1 },
  "commandCount":     { "mean": 1.0,  "median": 1,    "max": 42 },
  "framesPerSecond": 120.3,
  "entityCount": 1503,
  "jit": true,
  "paused": false,
  "pushToFirstFrameMs": 214,
  "resourceCache": {
    "meshHits": 1499, "meshBuilds": 1, "materialHits": 1499, "materialBuilds": 1,
    "shapeHits": 0, "shapeBuilds": 0,
    "cachedMeshes": 1, "cachedMaterials": 1, "cachedShapes": 0
  }
}
```

Over the last 120 frames:

| Field | Meaning | What to look for |
|---|---|---|
| `coreTickMs` | time inside the JavaScript core: your callbacks plus the diff | rises with the work your `onFrame` does and with the number of changed objects |
| `applyMs` | time the Swift consumer spent applying commands | a spike means a big command batch — a geometry or material re-emission, usually |
| `frameIntervalMs` | wall time between frames | 8.3 ms is 120 Hz, 16.7 ms is 60 Hz |
| `commandCount` | commands per frame | the steady state of a moving scene should be **1** (the packed `transforms` array). A steadily high count means you are re-emitting something every frame |
| `framesPerSecond` | derived from the mean interval | |
| `entityCount` | live native entities | should track `dump().objects.length`; if it keeps growing, something is not being destroyed |
| `jit` | whether JavaScriptCore is running with the JIT | `false` is interpreter mode, the visionOS-like measurement. Never compare a JIT number with an interpreter one |
| `paused` | whether the scene is held on a frame | `true` after a `/parity` plan completes |
| `pushToFirstFrameMs` | the last `POST /script` to its first rendered frame | the SPEC 12 target is under 1000 ms for 1500 meshes |
| `resourceCache` | native mesh, material and collision-shape cache counters | `meshBuilds: 1` with `meshHits: 1499` is what sharing one geometry looks like. `meshBuilds` climbing every frame means you are creating geometries in a loop |

### `POST /parity` — a deterministic run you can screenshot

```bash
jq -n --rawfile source scene.js '{
  source: $source,
  dt: 0.0166667,
  steps: [{ frames: 60 }, { inject: "tap", target: "cube" }, { frames: 30 }]
}' | curl -s -X POST --data-binary @- http://127.0.0.1:8787/parity \
   | jq '{ok, error, frames, errors: .dump.errors, warnings: .dump.warnings}'

# the held frame now matches that dump exactly
screencapture -x -o -l <windowID> parity.png
```

`steps` is the conformance step format (SPEC section 9): `{ "frames": N }` and
the four `inject` forms, in order. The app loads the script and then runs the
plan **deterministically** — every tick uses exactly `dt`, one tick per display
frame, each inject applied at the exact frame the plan reaches it — and when the
plan finishes it **stops ticking and holds the final frame** until the next
`/script` or `/parity`. That is what makes a window capture match the returned
state.

Response: `{ ok, error, dump, nativeDump, console: [{ level, message }], frames }`.

Use it whenever a screenshot has to correspond to a dump. Everything else
(`/script` + `/inject` + `/dump`) keeps running free, so the picture and the
dump can be a frame or two apart.

## Running a script in the browser harness

The web consumer runs the same script through real three.js and Rapier, in
headless Chromium.

```bash
cd SpatialScript
corepack pnpm install
corepack pnpm --filter @spatialscript/core build      # core/dist/spatial-core.js
corepack pnpm --filter @spatialscript/web build       # web/dist/page.js

# render one script and write a PNG plus a dump
node web/harness/screenshot.mjs scene.js

# with injected input and extra settle frames
node web/harness/screenshot.mjs scene.js \
  --frames 30 --inject tap:cube --inject 'drag:cube:0.1,0,0' --settle 60 \
  --out cube.png --camera 0,0.3,1
```

Output lands in `web/harness/out/`: `<name>.png` and `<name>.dump.json`. The
tool prints both paths and any console errors. Options: `--frames N` (ticks
before the injections), `--settle N` (ticks after them), `--inject
type:target[:x,y,z]`, `--out`, `--out-dir`, `--camera x,y,z`, `--width`,
`--height`, and `--camera-preset mac` (the macOS host's camera and viewport, for a
shot you can hold next to a `screencapture`).

Other harness entry points: `node web/harness/scenarios.mjs` (every scenario and
robustness script, summarised), `node web/harness/bench.mjs` (frame rate under
the real animation loop), `node web/harness/parity.mjs` (the web half of the
parity gate).

## Verifying a scene

Three tools, in increasing order of what they prove.

| Tool | Proves |
|---|---|
| `Spatial.inject` + `Spatial.dump(options)` | your listeners, bubbling and state machine are right. **Does not** prove an object is reachable by a real pointer — injection bypasses hit testing. Poll `?compact=1` or `?objects=0`, not the full dump |
| the parity gate | the same script produces the same scene on both backends, in the core dump, the native dump and the console |
| `perf/check.mjs` | the scene meets the SPEC 12 load-time, frame-rate and memory targets |

### The parity gate

Runs one script on the macOS host and in headless Chromium with an identical,
deterministic tick plan, then diffs the core dumps, the native dumps and the
console output, and leaves the two screenshots side by side.

```bash
# the macOS host must be running with its dev server up
node parity/run-parity.mjs examples/basics.js --steps parity/steps/basics.json --label basics
parity/run-all.sh        # every example and scenario that has a steps file
```

A steps file is a JSON array in the conformance format:

```json
[{ "frames": 60 },
 { "inject": "tap", "target": "cube" },
 { "frames": 5 },
 { "inject": "drag", "target": "cube", "translation": [-0.1, 0.1, 0] },
 { "frames": 60 }]
```

Scripts with no steps file get `[{ "frames": 120 }]`. Artefacts land in
`parity/out/<label>/`: `mac.png`, `screenshot.png` (web), `mac.dump.json`,
`mac.native.json`, `mac.console.json`, `dump.json`, `native.json`,
`console.json`, and `issues.json`. Output is one line per script:

```
basics: mac frames 130 (dt 0.01667), objects mac 9 web 9, native rk 9 three 9
  PARITY OK
```

`MISMATCH` lines are prefixed `core:`, `native:` or `logs:` to say which of the
three comparisons disagreed. Exit code is non-zero on any mismatch, `2` if the
macOS host is not reachable.

### The performance check

```bash
node perf/check.mjs                                   # the macOS host must be running
perf/measure.sh --count 1500 --shared-geometry        # one ad-hoc measurement
node perf/gen-stress.mjs --count 1500 --shared-geometry --shared-material > stress.js
```

`gen-stress.mjs` prints a stress scene; its flags are `--count N`,
`--shared-geometry`, `--shared-material`, `--static`, `--shadows`, `--physics`.
Defaults are the hard case: unique geometry and material per mesh, all moving.

`check.mjs` asserts the SPEC section 12 targets and prints one line per check:

```
ok   script loads: null
ok   push to first frame under 1 s: 214 ms
ok   1500 moving meshes at 60 fps or better: 120.3 fps (interval median 8.30 ms, core tick 0.38 ms, apply 0.28 ms)
ok   steady state emits one command per frame: 1
ok   memory does not grow between large-scene cycles: cold 310 MB, after cycle 1 372 MB, after cycle 2 375 MB
```

`measure.sh` pushes one generated scene and prints load time, measured frame
rate, the `/stats` medians, the resource-cache build counts, and the process's
RSS and CPU — the quickest way to compare two authoring choices.

## Running the suites

```bash
cd SpatialScript

# conformance: every case in conformance/cases against the core, in Node
node conformance/run-node.mjs                 # or: corepack pnpm conformance:node
node conformance/run-node.mjs input-tap       # one case

# conformance in a real browser, with a screenshot per case
node web/harness/run.mjs                      # or: corepack pnpm conformance:web

# demo scenarios: 400 ticks each, reporting errors, warnings and userData
node scenarios/run-node.mjs

# robustness: every hostile script must survive load and 200 ticks
node scenarios/run-robustness.mjs

# unit tests for the core and the web consumer
corepack pnpm -r test
corepack pnpm --filter @spatialscript/core test:jsc   # the core under JavaScriptCore

# cross-backend parity and performance (both need the macOS host running)
parity/run-all.sh
node perf/check.mjs

# documentation snippets: every ```js runnable block in docs/ and this README
node docs/check-snippets.mjs
node docs/check-snippets.mjs --verbose

# the RealityKit consumer
cd ../Packages/RealityKitScripting && swift test
```

`node docs/check-snippets.mjs` loads each runnable snippet, ticks it 120 times,
and fails if it throws at load, throws out of a tick, or leaves anything in
`dump().errors`. Run it after editing any document here.

---

## Repository map

```
./
  SpatialScript/
    README.md                     this file
    SPEC.md                       the contract every implementation conforms to
    docs/
      API.md                      complete script-facing reference
      DIFFERENCES.md              what differs from three.js
      COOKBOOK.md                 task-oriented recipes
      TROUBLESHOOTING.md          symptom to cause to fix
      check-snippets.mjs          runs every runnable snippet in these docs
    types/spatial.d.ts            TypeScript declarations for scripts
    core/                         the shared runtime
      src/                        ESM sources
      dist/spatial-core.js        committed esbuild bundle, loaded by both consumers
      test/                       Node unit tests
      scripts/                    build, JavaScriptCore driver, sync-to-swift
    web/                          the three.js consumer
      src/                        renderer, Rapier physics, command applier
      harness/                    dev server, Playwright runners, screenshot, parity, bench
      assets/                     textures and models the harness serves
    conformance/
      cases/                      <name>.js + <name>.expected.json (+ .steps.json)
      run-node.mjs                Node runner; exports createHost(bundleSource)
      match.mjs                   the subset matcher shared by the runners
    parity/                       the cross-backend gate
      run-parity.mjs              one script on both backends, same plan
      run-all.sh                  every example and scenario
      compare.mjs                 the dump, native-dump and log comparisons
      steps/<name>.json           per-script step plans
      out/<label>/                screenshots, dumps and issues per run
    perf/                         the SPEC 12 targets
      check.mjs                   asserts load time, frame rate and memory
      measure.sh                  one ad-hoc measurement against the macOS host
      gen-stress.mjs              prints a stress scene
    examples/                     basics, interaction, physics, animation, effects
      push.sh                     posts a script to the macOS host's dev server
    scenarios/                    longer demo scripts and their runners
      robustness/                 deliberately hostile scripts
  Packages/RealityKitScripting/   Swift package: JavaScriptCore host, RealityKit consumer
    Sources/RealityKitScripting/  JavaScriptScene, command appliers, input, native dump
      Resources/spatial-core.js   a copy of the core bundle
    Tests/RealityKitScriptingTests/
```

A script never touches anything below `core/dist/spatial-core.js`: the whole
script-facing surface is `require("spatial")`, documented in
[docs/API.md](docs/API.md).
