# Conformance suite

Each case is three files in `cases/`:

| File | Required | Meaning |
|---|---|---|
| `<name>.js` | yes | the script, evaluated exactly as a SpatialScript source |
| `<name>.expected.json` | yes | a subset of `Spatial.dump()` that must match |
| `<name>.steps.json` | no | what to do before comparing; defaults to `[{ "frames": 3 }]` |

Run the node runner from the workspace root:

```sh
node conformance/run-node.mjs            # every case
node conformance/run-node.mjs input-tap  # one or more named cases
```

The exit code is non-zero when any case fails.

## Matching

`match.mjs` implements SPEC section 9: every key in the expectation must exist
in the dump with an equal value, numbers match within 1e-3, arrays match
element-wise, entries of `objects` are matched by `name`, and keys absent from
the expectation are unconstrained. A case fails when `errors` is non-empty and
the expectation does not list the error.

Three additions, all opt-in from the expectation file so a runner that does not
implement them is unaffected:

- `warnings`, `errors` and `logs` match by substring. Each expected string must
  appear inside some actual string.
- An entry in `objects` may carry `"absent": true` to assert that no object
  with that name exists.
- The runner adds two keys to the dump before matching: `objectCount` (the
  number of objects) and `logs` (every `log` command the run produced, as
  `"<level>: <message>"`). The web and Swift runners should add the same two
  keys, or skip the handful of cases that use them (`dispose`, `console-log`,
  and the `objectCount` assertions).

  Nothing else runner-specific belongs in an expectation. A case must assert
  facts every runner can read out of `Spatial.dump()`; assertions about the
  command stream itself live in `core/test`, which owns the recording
  consumer.

`backend` and `platform` in the expectation select the backend the case is
loaded with, and are then also compared. The default is
`realitykit` / `macos`.

## Step kinds

```jsonc
[
  { "frames": 3 },                                           // tick 3 frames at 1/60 s

  { "inject": "tap",   "target": "cube", "point": [0, 0, 0] },
  { "inject": "hover", "target": "cube", "entering": true },
  { "inject": "drag",  "target": "cube", "translation": [0.2, 0, 0], "steps": 2 },
  { "inject": "key",   "code": "KeyW", "down": true },

  // Anything a consumer would push in (SPEC section 6). `target` and the
  // `other` field of a collision payload are object names; `texture` and
  // `asset` name a url, resolved against the recorded texture/asset commands.
  { "dispatch": { "type": "collisionstart", "target": "a",
                  "payload": { "other": "b", "point": [0, 0, 0], "normal": [0, 1, 0], "impulse": 1 } } },
  { "dispatch": { "type": "textureLoaded", "texture": "asset://grid.png" } },
  { "dispatch": { "type": "assetLoaded", "asset": "asset://robot.usdz",
                  "payload": { "animations": ["walk"], "boundingBox": [-0.1, 0, -0.1, 0.1, 0.4, 0.1] } } },

  { "sync":       [{ "target": "ball", "position": [0, 0.2, 0], "quaternion": [0, 0, 0, 1], "scale": [1, 1, 1] }] },
  { "syncBodies": [{ "target": "ball", "linear": [0, -1, 0], "angular": [0, 0, 0], "sleeping": false }] },

  { "setInput": { "keyboard": { "down": ["KeyW"], "pressed": [] },
                  "mouse": { "position": [120, 80], "buttons": [true, false, false], "delta": [2, -1] },
                  "hands": { "left": null, "right": null } } },

  { "dispose": true },                                       // tear the scene down

  // ---- phase 2 (SPEC 14) --------------------------------------------------

  // Playback state the consumer owns. `target` is an object name.
  { "syncAudio": [{ "target": "chime", "playing": true, "currentTime": 1.5, "duration": 4 }] },
  { "syncVideo": [{ "target": "screen", "playing": true, "currentTime": 2, "duration": 12 }] },
  { "syncCharacter": [{ "target": "player", "position": [0, 1, 0],
                        "isOnGround": true, "velocity": [0, -1.5, 0] }] },
  { "syncSkeleton": { "target": "robot", "joints": { "head": [0, 1.6, 0, 0, 0, 0, 1] } } },

  { "setActive": false },                                    // the view went away
  { "hostEvent": { "name": "score", "payload": { "value": 7 } } },   // host to script
  { "hostFunctions": ["MyApp.save"] },                       // what the app registered
  { "inject": "controller", "state": { "id": "pad-1", "buttons": { "a": 1 } } },

  // An answer to something the script asked for. `call` names the host
  // function and `fetch` the url, and the runner resolves the id from the
  // recorded `hostCall` / `fetch` command.
  { "dispatch": { "type": "hostResult", "call": "MyApp.save", "payload": { "value": 1 } } },
  { "dispatch": { "type": "fetchResult", "fetch": "assets/data/notes.txt",
                  "payload": { "text": "hello" } } },

  // Media events. `ended`, `loaded` and `error` name an object like any event.
  { "dispatch": { "type": "loaded", "target": "screen",
                  "payload": { "width": 1920, "height": 1080, "duration": 12 } } },
  { "dispatch": { "type": "ended", "target": "chime" } },

  // A dispatch with no target addresses id 0 (the scene). A consumer that
  // reports controller connections this way rather than through setInput
  // names the controller in the payload, and the core hands the listener the
  // Controller object it built from it.
  { "dispatch": { "type": "audioState", "payload": { "state": "running" } } },
  { "dispatch": { "type": "controllerconnected", "payload": { "id": "pad-9", "name": "Reported" } } },

  // A hot reload on the same host: the outgoing script's `this.state` is
  // captured and handed to the new script's `scriptChanged(previousState)`
  // after load and before its first frame. `preserveState` defaults to true;
  // with it false the hook is not called at all. The backend, platform and
  // asset root of the case are kept.
  { "reload": "const S = require(\"spatial\"); ...", "preserveState": true }
]
```

The `camera` command names the camera object's own id (SPEC 14.13), so a
runner that inspects the stream must not assume id 0; `["camera", 0, { kind:
null }]` is the form that hands the viewport back.

An expectation may also carry a top-level `"hostFunctions": ["MyApp.save"]`.
The runner registers those before the script loads, the way an app registers
its functions at startup, and the same key is then compared against
`dump().hostFunctions`.

`run-node.mjs` awaits a microtask between steps so promise callbacks inside the
script (`loadAsset`, `TextureLoader.loadAsync`, a top-level `await`) run before
the next step. The JavaScriptCore runner calls `drainMicrotasks()` in the same
places. A case whose body uses top-level `await` therefore needs at least two
steps, so the continuation has a checkpoint to run in before the dump is taken:
`[{ "frames": 3 }, { "frames": 3 }]`.

## Transforms are batched

The core emits one `["transforms", 0, Float32Array]` per frame instead of
per-object `transform` commands. A runner that scans the stream for pose
changes must unpack 11-float records `[id, px, py, pz, qx, qy, qz, qw, sx, sy,
sz]`, and must copy anything it keeps: the core reuses the buffer across
frames. The single-object `transform` opcode stays part of the protocol and
consumers must still accept it; the core no longer emits it.

## Running the same cases in JavaScriptCore

`core/scripts/run-jsc.mjs` (`corepack pnpm --filter @spatialscript/core test:jsc`)
feeds every case and every `scenarios/robustness/*.js` file through the macOS
`jsc` shell, which is the engine the RealityKit host embeds. It also asserts
that a script with a syntax error reports a line number: JavaScriptCore
populates `SyntaxError.line` for the Function constructor, V8 does not.

The benchmarks in that run are executed in a second `jsc` process started with
`--useJIT=false`. An app signed with the hardened runtime and no JIT
entitlement, and every app on visionOS, runs JavaScriptCore in the interpreter,
so the interpreter number is the one that governs the frame budget. Disabling
only the DFG leaves the baseline JIT in play and is roughly twice as fast as
the interpreter, so `--useBaselineJIT=false` and `--useJIT=false` measure the
same thing.
