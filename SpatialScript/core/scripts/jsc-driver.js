// Driver executed by the JavaScriptCore shell (`jsc`). It is plain ES5-era
// JavaScript on purpose: it must run in whatever JSC the installed macOS ships.
//
// Usage: jsc core/scripts/jsc-driver.js -- <repoRoot> <manifestPath>
//
// The manifest is JSON produced by scripts/run-jsc.mjs and lists the bundle,
// every conformance case with its expectation and steps, and every robustness
// script. The driver prints one JSON object per line: the results the Node side
// compares against its own run.

/* global load, readFile, print, drainMicrotasks, preciseTime, performance, arguments */

// `arguments` at global scope is the shell's script argument list; it has to be
// captured out here because a function's own `arguments` would shadow it.
(function (argv) {
  "use strict";

  var root = argv[0];
  var manifestPath = argv[1];
  var manifest = JSON.parse(readFile(manifestPath));

  var FRAME = 1 / 60;

  function drain() {
    if (typeof drainMicrotasks === "function") drainMicrotasks();
  }

  function emit(record) {
    print(JSON.stringify(record));
  }

  // Each case needs a fresh runtime. JSC's shell has no realms API, so the
  // bundle is re-evaluated with `load` and the previous __spatial discarded.
  function freshRuntime(logs) {
    globalThis.__spatial = undefined;
    globalThis.__spatialNative = {
      log: function (level, message) {
        logs.push(level + ": " + message);
      },
      now: function () {
        return Date.now();
      },
    };
    load(root + "/core/dist/spatial-core.js");
    return globalThis.__spatial;
  }

  function recordCommands(commands, recorded, logs) {
    for (var i = 0; i < commands.length; i += 1) {
      recorded.push(commands[i]);
      if (commands[i][0] === "log") logs.push(commands[i][2] + ": " + commands[i][3]);
    }
  }

  function textureIdForUrl(recorded, url) {
    for (var i = 0; i < recorded.length; i += 1) {
      if (recorded[i][0] === "texture" && recorded[i][2] && recorded[i][2].url === url) return recorded[i][1];
    }
    throw new Error('no texture command recorded for url "' + url + '"');
  }

  function assetIdForUrl(recorded, url) {
    for (var i = 0; i < recorded.length; i += 1) {
      if (recorded[i][0] !== "asset" || !recorded[i][2]) continue;
      var urls = recorded[i][2];
      for (var key in urls) {
        if (Object.prototype.hasOwnProperty.call(urls, key) && urls[key] === url) return recorded[i][1];
      }
    }
    throw new Error('no asset command recorded for url "' + url + '"');
  }

  function runCase(entry) {
    var logs = [];
    var recorded = [];
    var spatial = freshRuntime(logs);
    var Spatial = spatial.Spatial;

    function idFor(name) {
      var object = Spatial.find(name);
      if (!object) throw new Error('no object named "' + name + '"');
      return spatial.idForObject(object);
    }

    function tick(dt) {
      recordCommands(spatial.tick(dt), recorded, logs);
      drain();
    }

    var loadError = null;
    try {
      spatial.load(entry.source, {
        backend: entry.backend,
        platform: entry.platform,
        assetRoot: entry.assetRoot,
      });
    } catch (error) {
      loadError = error;
    }
    drain();

    if (loadError) {
      return {
        name: entry.name,
        kind: entry.kind,
        loadError: {
          name: loadError.name,
          message: String(loadError.message),
          line: typeof loadError.line === "number" ? loadError.line : null,
          column: typeof loadError.column === "number" ? loadError.column : null,
        },
        dump: null,
      };
    }

    var stepErrors = [];
    var steps = entry.steps && entry.steps.length ? entry.steps : [{ frames: 3 }];
    for (var s = 0; s < steps.length; s += 1) {
      var step = steps[s];
      try {
        applyStep(step);
      } catch (error) {
        stepErrors.push((error.name || "Error") + ": " + error.message);
      }
      drain();
    }

    function applyStep(step) {
      var i;
      if (typeof step.frames === "number") {
        for (i = 0; i < step.frames; i += 1) tick(FRAME);
        return;
      }
      if (step.inject) {
        var inject = Spatial.inject;
        if (step.inject === "tap") {
          inject.tap(step.target, step.point ? new Spatial.Vector3(step.point[0], step.point[1], step.point[2]) : undefined);
        } else if (step.inject === "hover") {
          inject.hover(step.target, step.entering !== false);
        } else if (step.inject === "drag") {
          inject.drag(
            step.target,
            new Spatial.Vector3(step.translation[0], step.translation[1], step.translation[2]),
            { steps: step.steps || 1 },
          );
        } else if (step.inject === "key") {
          inject.key(step.code, step.down !== false);
        } else {
          throw new Error('unknown inject "' + step.inject + '"');
        }
        return;
      }
      if (step.dispatch) {
        var id;
        if (step.dispatch.texture !== undefined) id = textureIdForUrl(recorded, step.dispatch.texture);
        else if (step.dispatch.asset !== undefined) id = assetIdForUrl(recorded, step.dispatch.asset);
        else id = idFor(step.dispatch.target);
        var payload = {};
        var source = step.dispatch.payload || {};
        for (var key in source) {
          if (Object.prototype.hasOwnProperty.call(source, key)) payload[key] = source[key];
        }
        if (typeof payload.other === "string") payload.other = idFor(payload.other);
        spatial.dispatch(step.dispatch.type, id, payload);
        return;
      }
      if (step.sync) {
        var flat = [];
        for (i = 0; i < step.sync.length; i += 1) {
          var record = step.sync[i];
          var position = record.position || [0, 0, 0];
          var quaternion = record.quaternion || [0, 0, 0, 1];
          var scale = record.scale || [1, 1, 1];
          flat.push(idFor(record.target));
          flat = flat.concat(position, quaternion, scale);
        }
        spatial.sync(new Float32Array(flat));
        return;
      }
      if (step.syncBodies) {
        var bodies = [];
        for (i = 0; i < step.syncBodies.length; i += 1) {
          var body = step.syncBodies[i];
          bodies.push(idFor(body.target));
          bodies = bodies.concat(body.linear || [0, 0, 0], body.angular || [0, 0, 0], [body.sleeping ? 1 : 0]);
        }
        spatial.syncBodies(new Float32Array(bodies));
        return;
      }
      if (step.setInput) {
        spatial.setInput(step.setInput);
        return;
      }
      if (step.dispose) {
        recordCommands(spatial.dispose(), recorded, logs);
        return;
      }
      throw new Error("unknown step " + JSON.stringify(step));
    }

    var dump = spatial.dump();
    dump.errors = dump.errors.concat(stepErrors);
    dump.objectCount = dump.objects.length;
    dump.logs = logs.slice();
    return { name: entry.name, kind: entry.kind, loadError: null, dump: dump };
  }

  function runRobustness(entry) {
    var logs = [];
    var spatial = freshRuntime(logs);
    var loadError = null;
    try {
      spatial.load(entry.source, { backend: "three", platform: "web", assetRoot: entry.assetRoot });
    } catch (error) {
      loadError = error;
    }
    drain();

    if (loadError) {
      return {
        name: entry.name,
        kind: entry.kind,
        loadError: {
          name: loadError.name,
          message: String(loadError.message),
          line: typeof loadError.line === "number" ? loadError.line : null,
          column: typeof loadError.column === "number" ? loadError.column : null,
        },
        nonFinite: 0,
        tickError: null,
        objectCount: 0,
      };
    }

    var nonFinite = 0;
    var tickError = null;
    for (var i = 0; i < 200 && tickError === null; i += 1) {
      try {
        var commands = spatial.tick(FRAME);
        for (var c = 0; c < commands.length; c += 1) {
          var opcode = commands[c][0];
          if (opcode === "transforms") {
            // Packed [id, p, q, s] records; every component must be finite.
            var packed = commands[c][2];
            for (var p = 0; p < packed.length; p += 1) {
              if (!isFinite(packed[p])) nonFinite += 1;
            }
          } else if (opcode === "transform") {
            for (var v = 2; v < commands[c].length; v += 1) {
              if (!isFinite(commands[c][v])) nonFinite += 1;
            }
          }
        }
        drain();
      } catch (error) {
        tickError = (error.name || "Error") + ": " + error.message;
      }
    }
    var dump = spatial.dump();
    return {
      name: entry.name,
      kind: entry.kind,
      loadError: null,
      nonFinite: nonFinite,
      tickError: tickError,
      objectCount: dump.objects.length,
      errorCount: dump.errors.length,
    };
  }

  // preciseTime() is seconds as a double in the jsc shell; Date.now() only has
  // millisecond resolution, which is too coarse for a per-frame measurement.
  var nowMs =
    typeof preciseTime === "function"
      ? function () { return preciseTime() * 1000; }
      : typeof performance === "object" && performance && typeof performance.now === "function"
        ? function () { return performance.now(); }
        : function () { return Date.now(); };

  function round(value) {
    return Math.round(value * 1000) / 1000;
  }

  function median(samples) {
    var sorted = samples.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.floor(sorted.length / 2)];
  }

  // The SPEC section 12 budget has to be measured through the real engine
  // boundary, so the same benchmark runs inside JavaScriptCore.
  function runBenchmark(entry) {
    var logs = [];
    var spatial = freshRuntime(logs);
    spatial.load(entry.source, { backend: "realitykit", platform: "macos" });

    var samples = [];
    var records = 0;
    var commandCount = 0;
    var start;

    if (entry.mode === "creation") {
      // Only the first flush matters; each run needs its own runtime.
      for (var run = 0; run < entry.runs; run += 1) {
        var fresh = run === 0 ? spatial : freshRuntime(logs);
        if (run > 0) fresh.load(entry.source, { backend: "realitykit", platform: "macos" });
        start = nowMs();
        var created = fresh.tick(1 / 60);
        samples.push(nowMs() - start);
        commandCount = created.length;
        for (var c = 0; c < created.length; c += 1) {
          if (created[c][0] === "transforms") records = created[c][2].length / 11;
        }
      }
    } else {
      spatial.tick(1 / 60);
      for (var frame = 0; frame < entry.frames; frame += 1) {
        start = nowMs();
        var commands = spatial.tick(1 / 60);
        samples.push(nowMs() - start);
        commandCount = commands.length;
        records = 0;
        for (var i = 0; i < commands.length; i += 1) {
          if (commands[i][0] === "transforms") records = commands[i][2].length / 11;
        }
      }
    }

    return {
      name: entry.name,
      kind: entry.kind,
      mode: entry.mode,
      medianMs: round(median(samples)),
      worstMs: round(Math.max.apply(null, samples)),
      records: records,
      commandCount: commandCount,
      budgetMs: entry.budgetMs,
    };
  }

  var results = [];
  for (var i = 0; i < manifest.entries.length; i += 1) {
    var entry = manifest.entries[i];
    var result;
    try {
      if (entry.kind === "benchmark") result = runBenchmark(entry);
      else if (entry.kind === "robustness") result = runRobustness(entry);
      else result = runCase(entry);
    } catch (error) {
      result = {
        name: entry.name,
        kind: entry.kind,
        driverError: (error.name || "Error") + ": " + error.message,
      };
    }
    results.push(result);
  }

  emit({ results: results });
})(typeof arguments !== "undefined" ? Array.prototype.slice.call(arguments) : []);
