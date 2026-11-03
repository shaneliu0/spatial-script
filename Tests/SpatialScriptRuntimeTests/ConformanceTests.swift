//
//  ConformanceTests.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit
import Testing
@testable import SpatialScriptRuntime

/// Runs every case in `verification/conformance/cases` through the RealityKit
/// consumer and compares both `dump()` and `nativeDump()` to `expected.json`,
/// following the same step vocabulary as `verification/conformance/run-node.mjs`.
@MainActor
struct ConformanceTests {
    static let frame = 1.0 / 60

    struct Case {
        let name: String
        let script: String
        let expected: [String: Any]
        let steps: [[String: Any]]?
    }

    struct Result {
        let dump: [String: Any]
        let nativeDump: [String: Any]
        /// Object name -> the keys the *plan* itself supplied on that object.
        /// Empty for a case whose plan supplies none.
        var injectedAssetKeys: [String: Set<String>] = [:]
    }

    /// Dispatch types that hand a consumer's asset load result to the core
    /// (`core/src/runtime/frame.js:396, 423`). A plan that sends one is
    /// standing in for the consumer's own loader, so the native side never
    /// loaded anything and cannot be asked what it holds.
    static let assetResultDispatches: Set<String> = ["assetLoaded", "assetError"]

    /// The same idea for the other direction SPEC 14.13 defines: a plan step
    /// that posts a consumer's own measurement supplies those keys for the
    /// object it names, so the native dump is not asked for them either.
    static let syncStepKeys: [String: Set<String>] = [
        "syncCharacter": ["isOnGround", "velocity"],
        "syncBodies": ["velocity", "isSleeping"],
    ]

    /// What such a result sets on the object it targets, from the same place:
    /// `loaded`, `animations`, the rig and the blend shapes it names, and the
    /// bounds. `asset` rides along because it describes the same load.
    static let assetResultKeys: Set<String> = [
        "loaded", "animations", "skeleton", "blendShapes", "boundingBox", "asset",
    ]

    static var casesDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // SpatialScriptRuntimeTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
            .appending(path: "verification/conformance/cases")
    }

    static func loadCases() throws -> [Case] {
        let directory = casesDirectory
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let contents = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        let scripts = contents
            .filter { $0.pathExtension == "js" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        var cases: [Case] = []
        for script in scripts {
            let name = script.deletingPathExtension().lastPathComponent
            let expectedURL = directory.appending(path: "\(name).expected.json")
            guard let expectedData = try? Data(contentsOf: expectedURL) else { continue }
            let expected = try JSONSerialization.jsonObject(with: expectedData) as? [String: Any] ?? [:]
            let stepsURL = directory.appending(path: "\(name).steps.json")
            var steps: [[String: Any]]?
            if let stepsData = try? Data(contentsOf: stepsURL) {
                steps = try JSONSerialization.jsonObject(with: stepsData) as? [[String: Any]]
            }
            cases.append(
                Case(
                    name: name,
                    script: try String(contentsOf: script, encoding: .utf8),
                    expected: expected,
                    steps: steps
                )
            )
        }
        return cases
    }

    @Test
    func conformanceCasesMatchBothDumps() throws {
        let cases = try Self.loadCases()
        let skipReason = Comment(
            rawValue: "No conformance cases are present at \(Self.casesDirectory.path); "
            + "they land with the shared core bundle."
        )
        withKnownIssue(skipReason, isIntermittent: true) {
            #expect(!cases.isEmpty, skipReason)
        } when: {
            cases.isEmpty
        }
        guard !cases.isEmpty else { return }

        var failures: [String] = []
        var skipped: [String] = []
        for testCase in cases {
            let backend = testCase.expected["backend"] as? String ?? "realitykit"
            guard backend == "realitykit" else {
                skipped.append("\(testCase.name) (backend \(backend))")
                continue
            }
            // A case that names a platform is written for that one; this
            // runner only speaks for the platform it is built as.
            if let platform = testCase.expected["platform"] as? String,
               platform != JavaScriptScene.platformName {
                skipped.append("\(testCase.name) (platform \(platform))")
                continue
            }
            let comparison = Self.evaluate(testCase)
            if !comparison.core.isEmpty {
                failures.append("\(testCase.name) core: \(comparison.core.joined(separator: "; "))")
            }
            if !comparison.native.isEmpty {
                failures.append("\(testCase.name) native: \(comparison.native.joined(separator: "; "))")
            }
        }

        // AR-17: a gap is keyed by its **exact** failure text, so a message that
        // grows a word stops matching and shows up as a failure rather than
        // being swallowed by a widened match. `withKnownIssue` is deliberately
        // not `isIntermittent`, so a listed gap that stops failing turns the
        // suite red too: every suppression has to be a demonstrated failure.
        let recorded = Set(failures)
        // Driven by the map, not by the failures: a listed gap that no longer
        // fails records nothing inside `withKnownIssue`, which is itself a
        // failure ("known issue was not recorded"). Every entry therefore has
        // to be a gap that is still demonstrably open.
        for gap in Self.harnessGaps.keys.sorted() {
            withKnownIssue(Comment(rawValue: "\(gap) — \(Self.harnessGaps[gap] ?? "")")) {
                if recorded.contains(gap) { Issue.record(Comment(rawValue: gap)) }
            }
        }
        failures = failures.filter { Self.harnessGaps[$0] == nil }

        let ran = cases.count - skipped.count
        print("conformance: \(ran) cases run, \(skipped.count) skipped for another backend"
            + (skipped.isEmpty ? "" : " (\(skipped.joined(separator: ", ")))"))
        // AR-16: the skip set was printed and never asserted, so a case could
        // opt this lane out by editing one word of its expectation. The list is
        // checked in: opting a case out now has to be done in the same diff.
        #expect(
            Set(skipped.map { $0.split(separator: " ").first.map(String.init) ?? $0 })
                == Self.expectedSkips,
            "the set of cases this backend skips changed"
        )
        #expect(
            failures.isEmpty,
            Comment(rawValue: "\(failures.count) of \(ran * 2) comparisons failed:\n"
                + failures.joined(separator: "\n"))
        )
    }

    /// Runs one case and returns the mismatches in each lane.
    static func evaluate(_ testCase: Case) -> (core: [String], native: [String]) {
        let result = run(testCase)
        let core = SpatialDumpMatcher.mismatches(expected: testCase.expected, actual: result.dump)
        let native = SpatialDumpMatcher.mismatches(
            expected: nativeExpectation(
                testCase.expected,
                native: result.nativeDump,
                injectedAssetKeys: result.injectedAssetKeys
            ),
            actual: result.nativeDump
        )
        return (core, native)
    }

    /// AR-16: the cases this backend does not run, by name. A case opts out by
    /// naming another `backend` or `platform` in its expectation; that has to
    /// show up here in the same change.
    static let expectedSkips: Set<String> = [
        "capabilities-phase2",          // backend three
        "object-flags",                 // backend three
        "shader-graph-web-fallback",    // backend three
        "robust-camera-visionos",       // platform visionos
    ]

    /// FA-34: with the key allowlist gone, every key both dumps carry is
    /// compared, and one comparison is then decided by the platform rather
    /// than by the mirror. Each is keyed by its exact
    /// failure text and asserted as a known issue, so it stays visible, turns
    /// the suite red if its shape changes, and turns it red again if it ever
    /// stops failing.
    ///
    /// Nothing here is a mirror defect, and nothing here is suppressed on
    /// trust: each was verified live against the running app, where the same
    /// comparison passes.
    static let harnessGaps: [String: String] = [
        "anchor native: objects[\"head\"].isAnchored: expected 1, got false":
            "SPEC 3.11: only visionOS anchors. The plan injects an `anchored` event, "
            + "which the core believes and macOS RealityKit cannot produce (FA-14).",
    ]

    /// Synchronous on purpose, and this is the one place it matters. The
    /// runner holds the main actor for the whole case, so nothing this
    /// consumer starts asynchronously — a USDZ read, a static mesh shape —
    /// can complete inside it. That is the same position the web consumer
    /// takes deliberately with its `manualBridge`: under a plan, load results
    /// come from the plan. Yielding here instead lets real loaders answer
    /// mid-case and the cases stop describing anything reproducible.
    static func run(_ testCase: Case) -> Result {
        let root = Entity()
        let platform = testCase.expected["platform"] as? String ?? JavaScriptScene.platformName

        // SPEC 14.10: a case that names the host functions it expects is run
        // against an app that registered them. They answer through the case's
        // own `hostResult` steps, so the bodies are deferred and never reply.
        // The registry is process wide, so a case that expects none must start
        // with none whatever ran before it — the same isolation the input
        // router and the controller hub already get.
        for name in ScriptingRuntime.hostFunctionNames {
            let parts = name.split(separator: ".", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            ScriptingRuntime.unregister(module: parts[0], function: parts[1])
        }
        let hostFunctions = testCase.expected["hostFunctions"] as? [String] ?? []
        for name in hostFunctions {
            let parts = name.split(separator: ".", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            ScriptingRuntime.register(module: parts[0], function: parts[1]) { _, _ in }
        }

        // The input router and the controller hub are process wide, so each
        // case starts from the same empty state whatever ran before it.
        ScriptingInputRouter.shared.injectControllers(nil)
        ScriptingInputRouter.shared.resetPointerButtons()
        ScriptingInputRouter.shared.beginFrame()

        let scene: JavaScriptScene
        do {
            scene = try JavaScriptScene(
                rootEntity: root,
                source: testCase.script,
                // Two different things, kept apart on purpose. The core's root
                // is the string the node runner uses, because the expectations
                // carry the urls it produces and a file URL here would make
                // every media case compare an absolute path...
                assetRoot: URL(string: "assets"),
                // ...while the bytes really do live in SPEC 3.5's shared asset
                // folder, so `asset://rig.usdz` and `assets/rig.usdz` load here
                // exactly as they do in the app.
                assetDirectory: Phase2Tests.assetRoot
            )
        } catch let error as JavaScriptScene.ScriptError {
            let dump: [String: Any] = [
                "backend": "realitykit",
                "platform": platform,
                "frame": 0,
                "elapsed": 0,
                "objects": [[String: Any]](),
                "objectCount": 0,
                "joints": [[String: Any]](),
                "gravity": [0, -9.81, 0],
                "environment": NSNull(),
                "warnings": [String](),
                "errors": [error.message],
                "logs": [String](),
            ]
            // A load error belongs to the core; the native side has no scene.
            var native = dump
            native["errors"] = [String]()
            return Result(dump: dump, nativeDump: native)
        } catch {
            let dump: [String: Any] = ["errors": [error.localizedDescription]]
            return Result(dump: dump, nativeDump: dump)
        }

        // SPEC 14.13's entry point, which is the path the node and web runners
        // take too; registering alone would be a different mechanism.
        scene.setHostFunctions(ScriptingRuntime.hostFunctionNames)

        var stepErrors: [String] = []
        for step in testCase.steps ?? [["frames": 3]] {
            if let frames = step["frames"] as? Int {
                for _ in 0..<frames {
                    // The system does this once per display frame; a headless
                    // run has to do it too or every frame sees one stale
                    // snapshot.
                    ScriptingInputRouter.shared.beginFrame()
                    scene.tick(deltaTime: frame)
                }
                continue
            }
            // Every other step kind is applied by the interpreter this runner
            // shares with the dev transport's parity plan, so a step added for
            // one is available to the other.
            let applied = ScriptingSceneStep.apply(
                step,
                to: scene,
                errors: &stepErrors,
                reloadSource: { Self.reloadSource($0, near: testCase.name) }
            )
            if !applied { stepErrors.append("Error: unknown step \(step)") }
        }

        var dump = scene.dump()
        dump["objectCount"] = (dump["objects"] as? [[String: Any]])?.count ?? 0
        dump["logs"] = scene.logLines
        var errors = dump["errors"] as? [String] ?? []
        errors.append(contentsOf: stepErrors)
        dump["errors"] = errors

        let native = scene.nativeDump()
        let injectedAssetKeys = Self.injectedAssetKeys(
            steps: testCase.steps ?? [],
            scene: scene,
            native: native
        )
        scene.dispose()
        for name in hostFunctions {
            let parts = name.split(separator: ".", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            ScriptingRuntime.unregister(module: parts[0], function: parts[1])
        }
        return Result(dump: dump, nativeDump: native, injectedAssetKeys: injectedAssetKeys)
    }

    /// The keys a plan supplies itself, by object name — an asset load result
    /// it dispatches, or a consumer measurement it posts. A `dispatch`
    /// step naming an asset url is the harness playing the part of this
    /// consumer's loader (the web consumer calls the same thing a
    /// `manualBridge`), so what that result puts on the object is the plan's
    /// word and not something the native side could have read off a file.
    /// Everything else on that object, and every other object, stays compared.
    private static func injectedAssetKeys(
        steps: [[String: Any]],
        scene: JavaScriptScene,
        native: [String: Any]
    ) -> [String: Set<String>] {
        var namesByID: [Int: String] = [:]
        for object in native["objects"] as? [[String: Any]] ?? [] {
            if let id = (object["id"] as? NSNumber)?.intValue, let name = object["name"] as? String {
                namesByID[id] = name
            }
        }

        var exempt: [String: Set<String>] = [:]
        for step in steps {
            if let dispatch = step["dispatch"] as? [String: Any],
               let type = dispatch["type"] as? String,
               assetResultDispatches.contains(type),
               let url = dispatch["asset"] as? String,
               let id = scene.assetID(forURL: url),
               let name = namesByID[id] {
                var keys = assetResultKeys
                for key in (dispatch["payload"] as? [String: Any])?.keys ?? [:].keys {
                    keys.insert(key)
                }
                exempt[name, default: []].formUnion(keys)
            }
            for (kind, keys) in syncStepKeys {
                guard let records = step[kind] as? [[String: Any]] else { continue }
                for record in records {
                    guard let name = record["target"] as? String else { continue }
                    exempt[name, default: []].formUnion(keys)
                }
            }
        }
        return exempt
    }

    /// `[id, playing, currentTime, duration]` per record, shared by the audio
    /// and video channels of SPEC 14.13.
    private static func mediaRecords(
        _ records: [[String: Any]],
        in scene: JavaScriptScene,
        errors: inout [String]
    ) -> [Float] {
        var flat: [Float] = []
        for record in records {
            guard let id = scene.objectID(named: record["target"] as? String ?? "") else {
                errors.append("Error: no object named \(record["target"] ?? "")")
                continue
            }
            flat.append(Float(id))
            flat.append(record["playing"] as? Bool == true ? 1 : 0)
            flat.append(Float((record["currentTime"] as? NSNumber)?.doubleValue ?? 0))
            flat.append(Float((record["duration"] as? NSNumber)?.doubleValue ?? 0))
        }
        return flat
    }

    /// A `reload` step carries the next script inline, or names a file beside
    /// the case when it ends in `.js`.
    private static func reloadSource(_ value: String, near caseName: String) -> String {
        guard value.hasSuffix(".js"), !value.contains("\n") else { return value }
        let url = casesDirectory.appending(path: value)
        return (try? String(contentsOf: url, encoding: .utf8)) ?? value
    }

    private static func floats(_ value: Any?) -> [Float]? {
        (value as? [Any])?.compactMap { ($0 as? NSNumber)?.floatValue }
    }

    /// FA-34: the native comparison used to filter an expectation through a
    /// hand-kept allowlist of key names, so every key added to both dumps
    /// arrived with no gate at all — which is how NR-02 shipped. The filter is
    /// now the native dump itself: at every depth, a key both dumps carry is
    /// compared, and only a key the native dump does not have is dropped.
    ///
    /// Three lanes are exempt by name, for a reason rather than a list:
    /// `warnings`, `errors` and `logs` are each side's own text about its own
    /// platform (SPEC 12 asks the consumer to warn about what *it* cannot do),
    /// and `userData` is the script's bag, which the native mirror never keeps
    /// because nothing in RealityKit holds it.
    static let nativeExemptKeys: Set<String> = ["warnings", "errors", "logs", "userData"]

    static func nativeExpectation(
        _ expected: [String: Any],
        native: [String: Any],
        injectedAssetKeys: [String: Set<String>] = [:]
    ) -> [String: Any] {
        var subset = nativeFiltered(expected: expected, native: native) as? [String: Any] ?? [:]
        // A plan that dispatches an asset result is standing in for this
        // consumer's loader, so the keys that result supplies describe the
        // plan, not the mirror, and only on the object it targeted. Derived
        // from the step list at run time — no case names take part.
        guard !injectedAssetKeys.isEmpty,
              let objects = subset["objects"] as? [[String: Any]] else { return subset }
        subset["objects"] = objects.map { object in
            guard let name = object["name"] as? String,
                  let exempt = injectedAssetKeys[name] else { return object }
            return object.filter { !exempt.contains($0.key) }
        }
        return subset
    }

    private static func nativeFiltered(expected: Any, native: Any?) -> Any {
        if let expectedDict = expected as? [String: Any] {
            guard let nativeDict = native as? [String: Any] else { return expected }
            var out: [String: Any] = [:]
            for (key, value) in expectedDict where !nativeExemptKeys.contains(key) {
                // `name` and `absent` identify the object rather than describing
                // it, so they are always carried through.
                if key == "name" || key == "absent" {
                    out[key] = value
                    continue
                }
                guard let nativeValue = nativeDict[key] else { continue }
                out[key] = nativeFiltered(expected: value, native: nativeValue)
            }
            return out
        }
        if let expectedArray = expected as? [Any] {
            guard let nativeArray = native as? [Any] else { return expected }
            let nativeObjects = nativeArray.compactMap { $0 as? [String: Any] }
            return expectedArray.enumerated().map { index, element -> Any in
                if let dict = element as? [String: Any],
                   let name = dict["name"] as? String,
                   let match = nativeObjects.first(where: { $0["name"] as? String == name }) {
                    return nativeFiltered(expected: element, native: match)
                }
                guard index < nativeArray.count else { return element }
                return nativeFiltered(expected: element, native: nativeArray[index])
            }
        }
        return expected
    }

    /// The exemption is derived from the plan, never from a case name: only an
    /// object whose asset result the plan itself dispatched loses the keys that
    /// result supplies, and only those keys. A plan that dispatches nothing
    /// exempts nothing, so a load this consumer really got wrong is reported.
    @Test
    func onlyAPlanSuppliedAssetResultExemptsTheKeysItSupplies() throws {
        // Loads a file that really exists, so nothing here depends on a
        // fixture: the native side starts the load and, in this synchronous
        // runner, has not finished it — exactly the position a plan-supplied
        // result stands in for.
        let script = """
            const Spatial = require("spatial");
            const S = Spatial;
            const scene = new S.Scene();
            S.mount(scene);
            S.loadAsset({ usdz: "asset://rig.usdz" }).then((asset) => {
              asset.name = "rig";
              scene.add(asset);
            });
            """
        let expected: [String: Any] = [
            "objects": [["name": "rig", "loaded": true, "animations": ["walk", "idle"]]],
        ]
        let dispatchStep: [String: Any] = [
            "dispatch": [
                "type": "assetLoaded",
                "asset": "asset://rig.usdz",
                "payload": ["animations": ["walk", "idle"], "joints": ["root", "head"]],
            ],
        ]

        // With the plan supplying the result: named, and the keys that result
        // supplied are not asked of the native dump.
        let supplied = Case(
            name: "plan-supplied",
            script: script,
            expected: expected,
            steps: [["frames": 1], dispatchStep, ["frames": 2]]
        )
        let suppliedResult = Self.run(supplied)
        let exempt = try #require(suppliedResult.injectedAssetKeys["rig"])
        #expect(exempt.isSuperset(of: ["loaded", "animations", "joints", "skeleton"]))
        #expect(Self.evaluate(supplied).native.isEmpty)
        // The native dump really does disagree: the exemption is the only
        // reason that comparison passed.
        let unexempted = SpatialDumpMatcher.mismatches(
            expected: Self.nativeExpectation(expected, native: suppliedResult.nativeDump),
            actual: suppliedResult.nativeDump
        )
        #expect(
            unexempted.contains { $0.contains("loaded") },
            "the same dump must fail without the exemption: \(unexempted)"
        )

        // No such dispatch: nothing is exempt and the mismatch is reported.
        let unsupplied = Case(
            name: "plan-silent",
            script: script,
            expected: expected,
            steps: [["frames": 3]]
        )
        let unsuppliedResult = Self.run(unsupplied)
        #expect(unsuppliedResult.injectedAssetKeys.isEmpty)
        #expect(!Self.evaluate(unsupplied).native.isEmpty, "a plan that injects nothing exempts nothing")

        // And the exemption is per object: a second object in the same plan
        // keeps every key.
        let twoObjects: [String: Any] = [
            "objects": [
                ["name": "rig", "loaded": true],
                ["name": "other", "visible": false],
            ],
        ]
        let neighbour = Case(
            name: "plan-supplied-neighbour",
            script: script + """
                const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial());
                box.name = "other";
                scene.add(box);
                """,
            expected: twoObjects,
            steps: [["frames": 1], dispatchStep, ["frames": 2]]
        )
        let neighbourDiffs = Self.evaluate(neighbour).native
        #expect(
            neighbourDiffs.contains { $0.contains("\"other\"") && $0.contains("visible") },
            "only the object the result targeted is exempt: \(neighbourDiffs)"
        )
    }

    @Test
    func subsetMatcherFollowsTheSpecifiedRules() {
        let actual: [String: Any] = [
            "frame": 3,
            "objects": [
                ["name": "cube", "position": [0.1, 0.2, 0.3], "visible": true],
                ["name": "sphere", "position": [1, 1, 1], "visible": false],
            ],
            "warnings": ["MeshStandardMaterial.wireframe is unsupported in RealityKit"],
            "errors": [String](),
        ]
        #expect(SpatialDumpMatcher.mismatches(
            expected: [
                "frame": 3,
                "objects": [["name": "cube", "position": [0.1005, 0.2, 0.3]]],
                "warnings": ["wireframe is unsupported"],
            ],
            actual: actual
        ).isEmpty)

        #expect(!SpatialDumpMatcher.mismatches(
            expected: ["objects": [["name": "cube", "position": [0.5, 0.2, 0.3]]]],
            actual: actual
        ).isEmpty)

        #expect(!SpatialDumpMatcher.mismatches(
            expected: ["objects": [["name": "missing"]]],
            actual: actual
        ).isEmpty)

        #expect(SpatialDumpMatcher.mismatches(
            expected: ["objects": [["name": "missing", "absent": true]]],
            actual: actual
        ).isEmpty)

        #expect(!SpatialDumpMatcher.mismatches(
            expected: ["objects": [["name": "cube", "absent": true]]],
            actual: actual
        ).isEmpty)

        #expect(!SpatialDumpMatcher.mismatches(
            expected: ["warnings": ["something else"]],
            actual: actual
        ).isEmpty)

        #expect(!SpatialDumpMatcher.mismatches(
            expected: ["frame": 3],
            actual: ["frame": 3, "errors": ["unexpected"]]
        ).isEmpty)
    }
}

/// FA-46: SPEC 10 says the Swift runner keeps a port of `match.mjs` that a
/// shared-fixture test holds equal to it. This is that test: one fixture per
/// SPEC 9 matching rule, in both directions, run through both matchers.
@MainActor
struct MatcherEquivalenceTests {
    struct Fixture {
        var name: String
        var rule: String
        var expected: [String: Any]
        var actual: [String: Any]?
    }

    static var fixturesURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "Fixtures/matcher-fixtures.json")
    }

    static var driverURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "Fixtures/run-match-fixtures.mjs")
    }

    static var matcherURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // SpatialScriptRuntimeTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
            .appending(path: "verification/conformance/match.mjs")
    }

    static func fixtures() throws -> [Fixture] {
        let data = try Data(contentsOf: fixturesURL)
        let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let raw = root?["fixtures"] as? [[String: Any]] ?? []
        return raw.map {
            Fixture(
                name: $0["name"] as? String ?? "",
                rule: $0["rule"] as? String ?? "",
                expected: $0["expected"] as? [String: Any] ?? [:],
                actual: $0["actual"] as? [String: Any]
            )
        }
    }

    /// `[name: matched]` from the JavaScript matcher, or nil when node is not
    /// on this machine.
    static func nodeVerdicts() throws -> [String: Bool]? {
        let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
        guard let node else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [driverURL.path, fixturesURL.path, matcherURL.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let decoded = try JSONSerialization.jsonObject(with: output) as? [[String: Any]] ?? []
        return decoded.reduce(into: [String: Bool]()) {
            $0[$1["name"] as? String ?? ""] = $1["matched"] as? Bool ?? false
        }
    }

    @Test
    func bothMatchersReturnTheSameVerdictForEveryFixture() throws {
        let fixtures = try Self.fixtures()
        #expect(fixtures.count >= 30, "the fixture set covers every SPEC 9 rule")
        guard let node = try Self.nodeVerdicts() else {
            Issue.record("node is not installed, so match.mjs could not be run")
            return
        }
        #expect(node.count == fixtures.count)
        for fixture in fixtures {
            let swiftMatched = SpatialDumpMatcher.mismatches(
                expected: fixture.expected,
                actual: fixture.actual ?? [:]
            ).isEmpty
            // A `null` actual is "no dump at all", which both matchers refuse.
            let swiftVerdict = fixture.actual == nil ? false : swiftMatched
            let nodeVerdict = try #require(node[fixture.name], "\(fixture.name) is missing")
            #expect(
                swiftVerdict == nodeVerdict,
                """
                \(fixture.name) (\(fixture.rule)): \
                Swift said \(swiftVerdict ? "match" : "no match"), \
                match.mjs said \(nodeVerdict ? "match" : "no match")
                """
            )
        }
    }

    /// Every rule named in SPEC 9 has at least one fixture, in both directions.
    @Test
    func everyMatchingRuleHasAFixture() throws {
        let fixtures = try Self.fixtures()
        let rules = Set(fixtures.map(\.rule))
        let required = [
            "every key in expected must exist in actual with an equal value",
            "numbers match within 1e-3",
            "arrays match element-wise",
            "entries of objects are matched by name",
            "keys absent from expected are unconstrained",
            "warnings, errors and logs match by substring",
            "an entry may carry absent: true to assert no such object exists",
            "an empty substring list asserts nothing was recorded on that channel",
            "an unexpected error always fails the case",
            "a null expectation matches null or a missing value",
            "nested objects are compared key by key",
            "a dump that is not an object fails",
        ]
        for rule in required {
            #expect(rules.contains(rule), "no fixture for: \(rule)")
        }
    }
}
