# SpatialScript guide

SpatialScript is a JavaScript scene API for building interactive 3D scenes that
render in RealityKit (macOS and visionOS) and in three.js (a browser), from one
unchanged script. It follows three.js class names, constructor signatures,
property names and method names wherever a three.js equivalent exists, so
three.js knowledge transfers directly. It is not three.js: there is no
renderer, no camera the script controls, no custom shaders and no
post-processing — you build a scene and call `Spatial.mount(scene)`, and the
host renders it. It adds what a spatial runtime needs and three.js lacks:
physics bodies and joints, tap/hover/drag/manipulation events with bubbling,
anchors, portals, particles, hand input, and whole-object opacity — and, in
phase 2, audio, video, cameras, character controllers and force fields, rig and
blend-shape control on loaded assets, shader graph materials, scene
understanding, game controllers, and a two-way channel with the app the scene is
embedded in. Features RealityKit cannot express are either absent from the
namespace or fail loudly, and no script input can crash the host or stop the
frame loop.

## Documentation

| Document | Read it when |
|---|---|
| [docs/API.md](API.md) | you need the complete reference: every class, property, default, method, and which backend supports it. Phase 1 is sections 1–17, [phase 2](API.md#phase-2) is 18–28 |
| [docs/DIFFERENCES.md](DIFFERENCES.md) | before writing your first script, if you know three.js |
| [docs/COOKBOOK.md](COOKBOOK.md) | you have a task: tappable objects, physics, portals, assets, anchors, verification |
| [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) | something does not render, fire, move, or load |
| [SPEC.md](../SPEC.md) | you are changing the runtime, not writing a script |
| [types/spatial.d.ts](../types/spatial.d.ts) | you want editor completion — the authoritative signatures |

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
[docs/DIFFERENCES.md](DIFFERENCES.md).

---

## Running a script in the macOS host

"The macOS host" in this guide means a macOS app that embeds `SpatialScriptRuntime`
and serves the dev transport described in [SPEC 11](../SPEC.md#11-dev-transport-debug-builds-only).
The transport is implemented by the host app and is not part of the Swift package.
With such a host running, it listens on `127.0.0.1:8787` in DEBUG builds only:

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
curl -s 'http://127.0.0.1:8787/dump?objects=0'
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

# replace the script but carry this.state across (SPEC 14.10)
jq -n --rawfile source scene.js '{ source: $source, preserveState: true }' \
  | curl -s -X POST --data-binary @- http://127.0.0.1:8787/script
```

`examples/push.sh <file.js> [host:port]` is the shorthand for the plain push.

`POST /script` takes either the raw script (as above) or
`{ "source": "…", "preserveState": true }`. With `preserveState`, the outgoing
script's `this.state` is read before it is disposed and handed to the new
script's `this.scriptChanged(previousState)` after load and before its first
frame. Without it, `scriptChanged` is not called at all.

The verification loop is: push, inject, dump, assert. Publish whatever you want
to assert on through `object.userData`, which the dump carries verbatim. See
[COOKBOOK recipe 17](COOKBOOK.md#17-verifying-a-scene-with-inject-and-the-dump).

For a screenshot, capture the app's window from outside the app:
`screencapture -l <windowID> out.png`. Release builds compile none of the dev
server.

### `GET /dump` options and the cheap poll

`GET /dump` and `GET /native-dump` accept the same narrowing as
[`Spatial.dump(options)`](API.md#spatialdump), as query parameters:

| Parameter | Effect |
|---|---|
| `objects=0` | no object list at all — just the scene summary, `warnings`, `errors` and `droppedErrors` |
| `compact=1` | every object, with transforms rounded to four decimals, `geometry.parameters` dropped and **`userData` dropped** |
| `names=a,b,c` | only objects with those names |
| `fields=position,visible` | only those per-object keys (`id` and `name` are always present) |

All four ride the in-context serializer, and all four take the same query string
on `/native-dump`. The top-level fields survive every combination, so
`?objects=0` is the cheapest health check there is.

**Poll a narrowed dump, and never poll a full `/native-dump`.** No tool in
`verification/perf` times a dump, so measure it yourself — build a big scene,
then time each route:

```bash
node verification/perf/gen-stress.mjs --count 10000 --static --shared-geometry --shared-material \
  | curl -s -X POST --data-binary @- http://127.0.0.1:8787/script

for q in '' '?objects=0' '?names=c1' '?fields=position'; do
  printf '%-18s ' "/dump$q"
  curl -s -o /tmp/d.json -w '%{time_total}s ' "http://127.0.0.1:8787/dump$q"
  wc -c < /tmp/d.json
  sleep 0.4     # the routes carry a 100 ms cache; do not measure the cache
done
printf '%-18s ' /native-dump
curl -s -o /tmp/n.json -w '%{time_total}s ' http://127.0.0.1:8787/native-dump; wc -c < /tmp/n.json
```

One 10 000-object run of that, for scale — re-measure rather than quoting these:

| Route | Time | Bytes |
|---|---|---|
| `GET /dump` (full) | ~50 ms | 11.2 MB |
| `GET /dump?objects=0` | 7–8 ms | 596 bytes |
| `GET /dump?names=c1` | — | 1.8 KB |
| `GET /dump?fields=position` | — | 955 KB |
| `GET /native-dump` (full) | ~620 ms | 10.7 MB |

The ordering is the durable part: `/dump` is serialised inside JavaScriptCore in
one pass, while `/native-dump` is rebuilt value by value from the live entities
and costs **an order of magnitude more**. Use the full native dump for a
one-shot comparison and a narrowed one for anything repeated. The pattern that
scales:

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

### `POST /event` and `GET /events` for the host channel

The two halves of [`Spatial.host`](API.md#spatialhost), exposed so an agent
can drive and observe the channel without an app of its own.

```bash
# app -> script: delivers to Spatial.host.on("setHue", handler)
curl -s -X POST http://127.0.0.1:8787/event \
  -d '{"name":"setHue","payload":{"hue":0.3}}'
# {"ok":true,"error":null}   ok:false when no scene is running

# script -> app: drains everything Spatial.host.send() has queued
curl -s http://127.0.0.1:8787/events | jq
# {"events":[{"name":"buttonPressed","payload":{"presses":1}}]}
```

`GET /events` **drains**: each event is returned once. A `/parity` run returns
the same events in its own response under `hostEvents`, so a deterministic plan
does not need a second request.

Host *functions* are the other direction and belong to the app: Swift registers
them with `ScriptingRuntime.register(module:function:)`, the web page with
`window.spatialHost.register(...)`. A script sees the names in
`Spatial.host.functions` and calls them with `Spatial.host.call("Module.fn", args)`.

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
   will cost on device.

The size of that difference, from the no-JIT JavaScriptCore driver
(`corepack pnpm --filter @spatialscript/core test:jsc`, medians of the best of
two runs):

| 1500 meshes, one shared geometry and material | core tick, no JIT | core tick, JIT on |
|---|---|---|
| moving every frame | **3.8 ms** | 0.381 ms |
| static (`matrixAutoUpdate = false`) | **1.7 ms** | 0.260 ms |

Roughly **an order of magnitude**, which is the number to plan against for
visionOS. An end-to-end frame rate for the app in interpreter mode has not been
re-measured on this machine; do not quote one until it has been.

`GET /stats` reports `jit` alongside the timings, so a saved measurement always
says which mode produced it. Compare interpreter runs with interpreter runs.

### `GET /stats` — what the renderer is actually doing

```bash
curl -s http://127.0.0.1:8787/stats | jq
```

Measured with `verification/perf/measure.sh --count 1500 --shared-geometry
--shared-material` — 1500 independently moving meshes, one shared geometry and
one shared material, DEBUG build, **JIT on**:

One run of it (each field also carries `mean` and `max`, elided here):

```json
{
  "frames": 120,
  "coreTickMs":       { "median": 0.381 },
  "applyMs":          { "median": 1.879 },
  "frameIntervalMs":  { "median": 8.34 },
  "commandCount":     { "median": 1 },
  "framesPerSecond": 121.0,
  "entityCount": 1503,
  "jit": true,
  "paused": false,
  "pushToFirstFrameMs": 264,
  "resourceCache": {
    "meshHits": 1499, "meshBuilds": 1, "materialHits": 1499, "materialBuilds": 1,
    "shapeHits": 0, "shapeBuilds": 0,
    "cachedMeshes": 1, "cachedMaterials": 1, "cachedShapes": 0
  }
}
```

Every number here is a median over the last 120 frames on that one scene shape
and that one engine mode, and they move between runs: `applyMs` on this scene
has measured **1.88–2.12 ms** across passes, so read it as **about 2 ms**, not
as a constant. Change the scene or turn the JIT off and they all move further —
see [interpreter mode](#interpreter-mode) and the
[performance guidance](TROUBLESHOOTING.md#memory-and-performance).

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
| `pendingLoads` | resource loads in flight (textures, assets, environment, media) | a `/parity` plan does not advance a frame while this is non-zero |
| `pushToFirstFrameMs` | the last `POST /script` to its first rendered frame | the SPEC 12 target is under 1000 ms for 1500 meshes. Measured: **289–305 ms** sharing one geometry and material, **337–364 ms** with a unique material per mesh |
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
frame, each inject applied at the exact frame the plan reaches it, and **no frame
advances while a texture, asset, environment or media load is in flight** (the
plan waits for the load to succeed or fail, up to 10 s, so a load result lands on
the same frame on every backend) — and when the plan finishes it **stops ticking
and holds the final frame** until the next `/script` or `/parity`. That is what
makes a window capture match the returned state.

Response:
`{ ok, error, dump, nativeDump, console: [{ level, message }], hostEvents, frames }`.

`hostEvents` is everything the script sent with `Spatial.host.send` during the
plan, drained into the same answer — the other half of a `hostEvent` step.

Use it whenever a screenshot has to correspond to a dump. Everything else
(`/script` + `/inject` + `/dump`) keeps running free, so the picture and the
dump can be a frame or two apart.

## Running a script in the browser harness

The web consumer runs the same script through real three.js and Rapier, in
headless Chromium.

```bash
corepack pnpm install
corepack pnpm --filter @spatialscript/core build      # core/dist/spatial-core.js
corepack pnpm --filter @spatialscript/web build       # consumers/web/dist/page.js

# render one script and write a PNG plus a dump
node consumers/web/harness/screenshot.mjs scene.js

# with injected input and extra settle frames
node consumers/web/harness/screenshot.mjs scene.js \
  --frames 30 --inject tap:cube --inject 'drag:cube:0.1,0,0' --settle 60 \
  --out cube.png --camera 0,0.3,1
```

Output lands in `consumers/web/harness/out/`: `<name>.png` and `<name>.dump.json`. The
tool prints both paths and any console errors. Options: `--frames N` (ticks
before the injections), `--settle N` (ticks after them), `--inject
type:target[:x,y,z]`, `--out`, `--out-dir`, `--camera x,y,z`, `--width`,
`--height`, and `--camera-preset mac` (the macOS host's camera and viewport, for a
shot you can hold next to a `screencapture`).

Other harness entry points: `node consumers/web/harness/scenarios.mjs` (every scenario and
robustness script, summarised), `node consumers/web/harness/bench.mjs` (frame rate under
the real animation loop), `node consumers/web/harness/parity.mjs` (the web half of the
parity gate).

## Verifying a scene

Three tools, in increasing order of what they prove.

| Tool | Proves |
|---|---|
| `Spatial.inject` + `Spatial.dump(options)` | your listeners, bubbling and state machine are right. **Does not** prove an object is reachable by a real pointer — injection bypasses hit testing. Poll `?objects=0` or `?names=`, not the full dump |
| the parity gate | the same script produces the same scene on both backends, in the core dump, the native dump and the console |
| `verification/perf/check.mjs` | the scene meets the SPEC 12 load-time, frame-rate and memory targets |
| `verification/scenarios/run-gauntlet.mjs` | the app survives every checked-in script, eleven hostile scripts and twenty-two malformed dev-server payloads with no crash report and a loadable scene afterwards |

### The parity gate

Runs one script on the macOS host and in headless Chromium with an identical,
deterministic tick plan, then diffs the core dumps, the native dumps and the
console output, and leaves the two screenshots side by side.

```bash
# the macOS host must be running with its dev server up
node verification/parity/run-parity.mjs examples/basics.js --steps verification/parity/steps/basics.json --label basics
verification/parity/run-all.sh        # every example and scenario that has a steps file
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
`verification/parity/out/<label>/`: `mac.png`, `screenshot.png` (web), `mac.dump.json`,
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
node verification/perf/check.mjs                                   # replaces the running scene
verification/perf/measure.sh --count 1500 --shared-geometry        # one ad-hoc measurement
node verification/perf/gen-stress.mjs --count 1500 --shared-geometry --shared-material > stress.js
```

`gen-stress.mjs` prints a stress scene; its flags are `--count N`,
`--shared-geometry`, `--shared-material`, `--static`, `--shadows`, `--physics`.
Defaults are the hard case: unique geometry and material per mesh, all moving.

`check.mjs` asserts the SPEC section 12 targets and prints one line per check:

```
ok   script loads: null
ok   push to first frame under 1 s: 254 ms
ok   1500 moving meshes at 60 fps or better: 120.5 fps (jit true, interval median 8.36 ms,
       core tick 0.38 ms, apply 1.98 ms)
ok   steady state emits one command per frame: 1
ok   memory does not grow between large-scene cycles: cold 744 MB, after cycle 1 743 MB, after cycle 2 743 MB
```

That run is 1500 moving meshes sharing one geometry and one material, JIT on;
the apply figure varies between **1.88 and 2.12 ms** across passes. The memory
line is a **ratio** check, not an absolute: the figures track the running
instance's resident size, which depends on how long it has been up, and it is
order-sensitive enough to fail on one run and pass on the next — re-run before
believing a failure. The load-time check passes on that shared-resource scene
and **fails** on the `gen-stress` default (unique geometry and material per
mesh), which takes 1.2 s — see the table in
[TROUBLESHOOTING](TROUBLESHOOTING.md#memory-and-performance).

**`check.mjs` replaces whatever scene is running** — it pushes its own stress
scenes and leaves the last one mounted. Re-push your script when it finishes.

`measure.sh` pushes one generated scene and prints load time, measured frame
rate, the `/stats` medians, the resource-cache build counts, and the process's
RSS and CPU — the quickest way to compare two authoring choices.

## The shared asset root

`assets` is the one asset root both backends resolve `asset://`
against, and the only part of the repository a Release build bundles — examples,
scenarios and conformance cases are DEBUG-only.

| File | Used by |
|---|---|
| `checker.png` | texture tests and tiling examples |
| `studio-env.hdr`, `studio-env.png` | `Spatial.environment`; `.hdr` works on both backends, `.exr` would not |
| `panel.gltf` | a minimal `loadAsset` target for the web |
| `rig.usdz`, `rig.glb` | the same two-joint rig for both backends — see below |
| `spatial-materials.usda` | the `Glow` graph for [`ShaderGraphMaterial`](API.md#23-shader-graph-materials) |
| `spatial-tone.wav` | every audio example and case |
| `spatial-bars.mp4`, `spatial-bars.webm` | [`VideoScreen`](API.md#19-video); RealityKit plays the mp4, the browser the webm |
| `layout.json` | `Spatial.fetchJSON` |

**The rig pair.** RealityKit cannot read glTF and three.js cannot read USD, so
`loadAsset({ usdz: "asset://rig.usdz", glb: "asset://rig.glb" })` needs two files
describing the same thing: a 0.1 × 0.4 × 0.1 box in three bands, a two-joint
skeleton (`root` at the origin, `head` 0.2 m above it, everything above the waist
bound to `head`), and one blend shape, `widen`. Rotating `head` visibly bends the
top half on both backends.

```bash
# rig.glb — three's GLTFExporter needs browser APIs, so it runs in the harness
node consumers/web/harness/make-rig.mjs

# rig.usdz — Pixar's USD Python package, written with UsdUtils.CreateNewUsdzPackage
python3 -m pip install --user usd-core
python3 tools/make-rig-usdz.py
```

Regenerate both together if you change either: the skeleton and blend-shape
cases compare them against each other.

## Running the suites

```bash

# conformance: every case in verification/conformance/cases against the core, in Node
node verification/conformance/run-node.mjs                 # or: corepack pnpm conformance:node
node verification/conformance/run-node.mjs input-tap       # one case

# conformance in a real browser, with a screenshot per case
node consumers/web/harness/run.mjs                      # or: corepack pnpm conformance:web

# demo scenarios: 400 ticks each, reporting errors, warnings and userData
node verification/scenarios/run-node.mjs

# robustness: every hostile script must survive load and 200 ticks
node verification/scenarios/run-robustness.mjs

# unit tests for the core and the web consumer
corepack pnpm -r test
corepack pnpm --filter @spatialscript/core test:jsc   # the core under JavaScriptCore

# cross-backend parity and performance (both need the macOS host running)
verification/parity/run-all.sh
node verification/perf/check.mjs
node verification/scenarios/run-gauntlet.mjs   # hostile scripts and payloads; the app must survive

# documentation snippets: every ```js runnable block in docs/ and this guide
node docs/check-snippets.mjs
node docs/check-snippets.mjs --verbose

# the RealityKit consumer
swift test
```

`node docs/check-snippets.mjs` loads each runnable snippet, ticks it 120 times,
and fails if it throws at load, throws out of a tick, or leaves anything in
`dump().errors`. Run it after editing any document here.

---

## Repository map

```
README.md                     overview and install
SPEC.md                       the contract every implementation conforms to
docs/
  GUIDE.md                    this guide
  API.md                      complete script-facing reference
  DIFFERENCES.md              what differs from three.js
  COOKBOOK.md                 task-oriented recipes
  TROUBLESHOOTING.md          symptom to cause to fix
  check-snippets.mjs          runs every runnable snippet in these docs
types/spatial.d.ts            TypeScript declarations for scripts
core/                         the shared runtime (@spatialscript/core)
  src/                        ESM sources: index.js, namespace.js, runtime.js and
                              runtime/, scene/, materials/, media/, physics/,
                              input/, host/, util/
  dist/spatial-core.js        committed esbuild bundle, loaded by both consumers
  test/                       Node unit tests
  scripts/                    build, JavaScriptCore driver, sync-to-swift
consumers/
  web/                        the three.js consumer (@spatialscript/web)
    src/                      consumer/, physics/, media/, input/, dump/, page/
    harness/                  static server, Playwright runners, screenshot,
                              parity, bench, make-rig.mjs (authors assets/rig.glb)
    test/                     Node unit tests and browser checks
    index.html                the dev page the harness serves
assets/                       the one shared asset root (`asset://`), the only
                              part Release builds bundle
examples/                     phase 1: basics, interaction, physics, animation, effects
                              phase 2: audio-video, camera, character,
                              host-channel, asset-control
  push.sh                     posts a script to the macOS host's dev server
verification/
  conformance/
    cases/                    <name>.js + <name>.expected.json (+ .steps.json)
    run-node.mjs              Node runner; exports createHost(bundleSource)
    match.mjs                 the subset matcher shared by the runners
    README.md                 how a case is written and run
  scenarios/                  longer demo scripts and their runners
    robustness/               deliberately hostile scripts
    run-node.mjs              every scenario through the core in Node
    run-robustness.mjs        every robustness script through the core in Node
    run-gauntlet.mjs          hostile scripts and payloads against the running app
  parity/                     the cross-backend gate
    run-parity.mjs            one script on both backends, same plan
    run-all.sh                every example and scenario
    compare.mjs               the dump, native-dump and log comparisons
    steps/<name>.json         per-script step plans
    out/<label>/              screenshots, dumps and issues per run
  perf/                       the SPEC 12 targets
    check.mjs                 asserts load time, frame rate and memory
    measure.sh                one ad-hoc measurement against the macOS host
    gen-stress.mjs            prints a stress scene
tools/make-rig-usdz.py        authors assets/rig.usdz
Package.swift                     Swift package: JavaScriptCore host, RealityKit consumer
Sources/SpatialScriptRuntime/ Host/, Runtime/, Applier/, Geometry/, Materials/,
                              Physics/, Media/, Input/, Camera/, Dump/, Parity/,
                              DevTransport/
  Resources/spatial-core.js   a copy of the core bundle, written by `pnpm build`
Tests/SpatialScriptRuntimeTests/
```

A script never touches anything below `core/dist/spatial-core.js`: the whole
script-facing surface is `require("spatial")`, documented in
[docs/API.md](API.md).
