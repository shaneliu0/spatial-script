//
//  EngineModeTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit
import Testing
@testable import RealityKitScripting

/// Round 8: the JavaScriptCore engine mode reported to a harness, and the
/// in-context dump serialisation that replaced the per-value boundary crossing.
@MainActor
struct EngineModeTests {
    private func makeScene(_ source: String) throws -> (Entity, JavaScriptScene) {
        let root = Entity()
        return (root, try JavaScriptScene(rootEntity: root, source: source))
    }

    // MARK: - Engine mode

    @Test
    func theHealthPayloadReportsTheEngineMode() throws {
        let health = ScriptingRuntime.healthFields()

        #expect(health["ok"] as? Bool == true)
        let jit = try #require(health["jit"] as? Bool, "GET /health must report the engine mode")
        let watchdog = try #require(health["watchdog"] as? String)

        #expect(jit == ScriptingRuntime.isJITEnabled)
#if DEBUG
        // The two fields must agree: the execution limit cannot interrupt a
        // JIT-compiled loop in this host, so it only claims to be armed in
        // interpreter mode.
        if ScriptingWatchdog.isAvailable {
            #expect(watchdog == (jit ? "inactive (requires interpreter mode)" : "armed"))
        } else {
            #expect(watchdog == "unavailable")
        }
#else
        #expect(watchdog == "release build: no watchdog")
#endif
        // Serialisable as-is: the dev transport hands this straight to JSON.
        #expect(JSONSerialization.isValidJSONObject(health))
    }

    @Test
    func theStatsPayloadReportsTheEngineMode() throws {
        let (_, scene) = try makeScene("""
            const s = new Spatial.Scene();
            Spatial.mount(s);
            """)
        scene.tick(deltaTime: 1.0 / 60)
        let stats = scene.frameStats()
        #expect(stats["jit"] as? Bool == ScriptingRuntime.isJITEnabled)
        scene.dispose()
    }

    @Test
    func interpreterModeIsOffUnlessItIsAskedFor() {
        // Nothing in the test environment asks for it, so the default holds and
        // `configureJavaScriptEngine` is a no-op that leaves the JIT alone.
        #expect(ScriptingRuntime.isInterpreterModeRequested == false)
        #expect(ScriptingRuntime.configureJavaScriptEngine() == false)
        #expect(ScriptingRuntime.isJITEnabled)
    }

    // MARK: - Dump serialisation

    @Test
    func theSerialisedDumpMatchesTheDictionaryDump() throws {
        let (_, scene) = try makeScene("""
            const s = new Spatial.Scene();
            for (let i = 0; i < 25; i += 1) {
              const m = new Spatial.Mesh(new Spatial.BoxGeometry(1, 1, 1), new Spatial.MeshStandardMaterial());
              m.name = 'box' + i;
              m.position.set(i, 0, 0);
              s.add(m);
            }
            Spatial.mount(s);
            """)
        scene.tick(deltaTime: 1.0 / 60)

        let data = try #require(scene.dumpJSON(options: nil), "the in-context path must serve a clean context")
        let parsed = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let reference = scene.dump()

        let serialised = try #require(parsed["objects"] as? [[String: Any]])
        let expected = try #require(reference["objects"] as? [[String: Any]])
        #expect(serialised.count == expected.count)
        #expect(serialised.count == 25)
        #expect(serialised.compactMap { $0["name"] as? String } == expected.compactMap { $0["name"] as? String })
        #expect(parsed["frame"] as? Int == reference["frame"] as? Int)
        scene.dispose()
    }

    /// The fast path must not become a way back to walking the prototype
    /// chain: `JSON.stringify` honours `toJSON`, so a polluted prototype sends
    /// the dump back through the bounded own-property reader.
    @Test
    func aPollutedPrototypeFallsBackToTheBoundedReader() throws {
        let (_, scene) = try makeScene("""
            const s = new Spatial.Scene();
            Spatial.mount(s);
            """)
        scene.tick(deltaTime: 1.0 / 60)
        #expect(scene.dumpJSON(options: nil) != nil)

        scene.inject("Object.prototype.polluted = 1;")
        #expect(scene.dumpJSON(options: nil) == nil, "an enumerable prototype key must refuse the fast path")
        scene.inject("delete Object.prototype.polluted;")

        scene.inject("Object.defineProperty(Object.prototype, 'toJSON', { value: () => ({ evil: true }) });")
        #expect(scene.dumpJSON(options: nil) == nil, "a prototype toJSON must refuse the fast path")

        // The dictionary dump still answers, and still with the real scene.
        let fallback = scene.dump()
        #expect(fallback["objects"] != nil)
        #expect(fallback["evil"] == nil)
        scene.dispose()
    }

    @Test
    func aFilteredDumpKeepsTheSwiftPath() throws {
        let (_, scene) = try makeScene("""
            const s = new Spatial.Scene();
            const m = new Spatial.Mesh(new Spatial.BoxGeometry(1, 1, 1), new Spatial.MeshStandardMaterial());
            m.name = 'only';
            s.add(m);
            Spatial.mount(s);
            """)
        scene.tick(deltaTime: 1.0 / 60)
        // `compact` is the core's to apply, so it rides the in-context
        // serialiser; only `names` and `fields` take the Swift reader.
        let options = ScriptingDumpFilter.options(compact: true, names: [], fields: [])
        #expect(scene.dumpJSON(options: options) != nil)
        let narrowed = ScriptingDumpFilter.options(compact: false, names: ["only"], fields: [])
        #expect(scene.dumpJSON(options: narrowed) == nil)
        let compact = scene.dump(options: options)
        // The core owns `compact`; the Swift filter only narrows `names` and
        // `fields`, so the reduced object list comes through.
        #expect((compact["objects"] as? [[String: Any]])?.count == 1)
        #expect(compact["objectCount"] as? Int == 1)
        scene.dispose()
    }

    // MARK: - Termination reporting

#if DEBUG
    @Test
    func aTerminatedSceneLogsOnlyItsOwnExplanation() throws {
        let root = Entity()
        nonisolated(unsafe) var messages: [String] = []
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: """
                const s = new Spatial.Scene();
                Spatial.onFrame(() => { while (true) {} });
                Spatial.mount(s);
                """,
            logListener: { messages.append($0.message) }
        )
        scene.tick(deltaTime: 1.0 / 60)
        scene.tick(deltaTime: 1.0 / 60)
        #expect(scene.isTerminated)
        // JavaScriptCore's termination exception has no message; the bare
        // "undefined" it used to produce is noise, not a second failure.
        let noise = messages.filter {
            let trimmed = $0.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed == "undefined" || trimmed == "null" || trimmed.isEmpty
        }
        #expect(noise.isEmpty, "unexpected follow-up log lines: \(noise)")
        #expect(messages.contains { $0.contains("The script was terminated") })
        scene.dispose()
    }
#endif
}
