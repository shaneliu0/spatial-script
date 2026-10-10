//
//  ConformanceTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit
import Testing
@testable import RealityKitScripting

/// Runs every case in `SpatialScript/conformance/cases` through the RealityKit
/// consumer and compares both `dump()` and `nativeDump()` to `expected.json`,
/// following the same step vocabulary as `conformance/run-node.mjs`.
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
    }

    static var casesDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RealityKitScriptingTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RealityKitScripting
            .deletingLastPathComponent()   // Packages
            .deletingLastPathComponent()   // repository root
            .appending(path: "SpatialScript/conformance/cases")
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
            let result = Self.run(testCase)
            let coreDiffs = SpatialDumpMatcher.mismatches(
                expected: testCase.expected,
                actual: result.dump
            )
            if !coreDiffs.isEmpty {
                failures.append("\(testCase.name) core: \(coreDiffs.joined(separator: "; "))")
            }
            let nativeDiffs = SpatialDumpMatcher.mismatches(
                expected: Self.nativeExpectation(testCase.expected),
                actual: result.nativeDump
            )
            if !nativeDiffs.isEmpty {
                failures.append("\(testCase.name) native: \(nativeDiffs.joined(separator: "; "))")
            }
        }

        // Mismatches that belong to another component. Each is asserted as a
        // known issue, so the suite stays green while the gap is open and turns
        // red again the moment it closes or changes shape.
        let (known, unknown) = failures.reduce(into: ([String](), [String]())) { result, failure in
            if Self.knownCoreGaps[failure] != nil {
                result.0.append(failure)
            } else {
                result.1.append(failure)
            }
        }
        for failure in known {
            withKnownIssue(Comment(rawValue: "\(failure) — \(Self.knownCoreGaps[failure] ?? "")")) {
                Issue.record(Comment(rawValue: failure))
            }
        }
        failures = unknown

        let ran = cases.count - skipped.count
        print("conformance: \(ran) cases run, \(skipped.count) skipped for another backend"
            + (skipped.isEmpty ? "" : " (\(skipped.joined(separator: ", ")))"))
        #expect(
            failures.isEmpty,
            Comment(rawValue: "\(failures.count) of \(ran * 2) comparisons failed:\n"
                + failures.joined(separator: "\n"))
        )
    }

    /// Keyed by the exact mismatch text, valued by why it is not this
    /// consumer's to fix.
    static let knownCoreGaps: [String: String] = [
        "camera-unparented native: objects[\"free-camera\"]: not found (present: marker)":
            "SPEC 14.13 now says the `camera` command carries the camera object's id, so a camera "
            + "that was never added to the scene arrives as its own object. The bundled core still "
            + "emits `[\"camera\", 0, payload]` (grep '\"camera\", 0' in spatial-core.js), so no "
            + "`create` is sent for an unparented camera and the consumer has no record to attach "
            + "the component to. The consumer attaches by id and needs no change when the bundle "
            + "lands.",
        "raycast-rules core: objects[\"probe\"].userData.direct: expected 1 elements, got 2":
            "Spatial.raycast reads options.recursive but never forwards it to "
            + "__spatialNative.raycast, whose SPEC 6 signature stops at maxDistance, so a consumer "
            + "with a native raycast cannot honour recursive: false. The consumer already accepts "
            + "an optional trailing recursive argument and honours it when one is passed.",
    ]

    static func run(_ testCase: Case) -> Result {
        let root = Entity()
        let platform = testCase.expected["platform"] as? String ?? JavaScriptScene.platformName

        // SPEC 14.10: a case that names the host functions it expects is run
        // against an app that registered them. They answer through the case's
        // own `hostResult` steps, so the bodies are deferred and never reply.
        let hostFunctions = testCase.expected["hostFunctions"] as? [String] ?? []
        for name in hostFunctions {
            let parts = name.split(separator: ".", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            ScriptingRuntime.register(module: parts[0], function: parts[1]) { _, _ in }
        }

        // The input router and the controller hub are process wide, so each
        // case starts from the same empty state whatever ran before it.
        ScriptingInputRouter.shared.injectControllers(nil)
        ScriptingInputRouter.shared.beginFrame()

        let scene: JavaScriptScene
        do {
            scene = try JavaScriptScene(
                rootEntity: root,
                source: testCase.script,
                // The node runner passes the string "assets"; a file URL would
                // report an absolute path in the environment and the two
                // backends would normalise script URLs differently.
                assetRoot: URL(string: "assets")
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
        scene.dispose()
        for name in hostFunctions {
            let parts = name.split(separator: ".", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            ScriptingRuntime.unregister(module: parts[0], function: parts[1])
        }
        return Result(dump: dump, nativeDump: native)
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

    /// `nativeDump` promises transforms, hierarchy, component presence and the
    /// material and light parameters RealityKit stores. Everything else in an
    /// expectation belongs to the core alone, so it is dropped before the
    /// native comparison.
    static let nativeTopLevelKeys: Set<String> = [
        "backend", "platform", "objects", "gravity", "joints",
        // SPEC 14.13's dump additions: the native half of the gate was blind to
        // all of section 14 while these were filtered out.
        "isActive", "audioMixer", "camera", "sceneUnderstanding", "render",
        "environmentLighting", "debug", "hostFunctions", "controllers",
    ]
    static let nativeObjectKeys: Set<String> = [
        "name", "absent", "type", "parent", "visible", "position", "quaternion", "scale",
        "worldPosition", "geometry", "material", "light", "rigidBody", "opacity", "billboard",
        "groundingShadow", "hoverEffect", "manipulable", "castShadow", "receiveShadow",
        "renderOrder", "interactive", "world", "anchor", "portal",
        // SPEC 14.13's per-object additions.
        "audio", "video", "characterController", "forceField", "accessibility",
        "skeleton", "blendShapes",
    ]

    static func nativeExpectation(_ expected: [String: Any]) -> [String: Any] {
        var subset = expected.filter { nativeTopLevelKeys.contains($0.key) }
        if let objects = expected["objects"] as? [[String: Any]] {
            subset["objects"] = objects.map { object in
                object.filter { nativeObjectKeys.contains($0.key) }
            }
        }
        return subset
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
