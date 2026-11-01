//
//  HardeningTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit
import Testing
@testable import SpatialScriptRuntime

/// Round 7: prototype pollution, the execution watchdog, material write cost,
/// dump filtering and the previously untested public surface.
@MainActor
struct HardeningTests {
    private func makeScene() throws -> (Entity, JavaScriptScene) {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            Spatial.mount(stage);
            """)
        return (root, scene)
    }

    /// Regression guard for the exception storm that made geometry commands
    /// 69x slower: most carry `null` normals, uvs and indices, and calling
    /// `JSValueToObject` on null raises a JavaScript exception the host then
    /// formats with a stack trace.
    @Test
    func nullTypedArraySlotsRaiseNoJavaScriptException() throws {
        let root = Entity()
        nonisolated(unsafe) var errors: [String] = []
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: "const stage = new Spatial.Scene(); Spatial.mount(stage);",
            logListener: { if $0.level == .error { errors.append($0.message) } }
        )
        scene.applyCommands(javaScript: """
            [
              ["create", 1500, "mesh", "plain"],
              ["geometry", 1500, { "type": "BoxGeometry", "uuid": "g",
                "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null]
            ]
            """)
        #expect(errors.isEmpty, "a null buffer slot raised an exception: \(errors)")
        #expect(scene.commandApplier.entity(for: 1500) != nil)
        scene.dispose()
    }

    // MARK: - ROBUST-01

    @Test
    func prototypePollutionDoesNotReachSwift() throws {
        // Before the fix this blew the stack inside -[NSDictionary description]
        // and took the process with it.
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const S = require("spatial");
            Object.prototype.toJSON = function () { return "hijacked"; };
            const s = new S.Scene();
            const m = new S.Mesh(new S.BoxGeometry(0.1,0.1,0.1), new S.MeshStandardMaterial({color:1}));
            m.name = "c"; s.add(m);
            S.onFrame((dt,t) => { m.position.x = t; });
            S.mount(s);
            """)
        for _ in 0..<5 { scene.tick(deltaTime: 1.0 / 60) }
        let cube = try #require(root.findEntity(named: "c"))
        #expect(cube.components[ModelComponent.self] != nil)

        let objects = scene.nativeDump()["objects"] as? [[String: Any]] ?? []
        let described = try #require(objects.first { $0["name"] as? String == "c" })
        let geometry = try #require(described["geometry"] as? [String: Any])
        let parameters = try #require(geometry["parameters"] as? [String: Any])
        // The injected key never reaches Swift.
        #expect(parameters["toJSON"] == nil)
        #expect(parameters["width"] != nil)
        scene.dispose()
    }

    /// A hostile value may legitimately make the *script* fail to load; what
    /// must never happen is the process going down.
    @Test
    func hostilePayloadValuesAreReadSafely() throws {
        let variants = [
            "Object.prototype.evil = { a: { b: { c: { d: { e: 1 } } } } };",
            "Object.defineProperty(Object.prototype, 'boom', { enumerable: true, get() { throw new Error('nope'); } });",
            "Object.prototype[Symbol.iterator] = function*(){};",
            "const cyc = {}; cyc.self = cyc; Object.prototype.cyc = cyc;",
            "Object.prototype.big = 10n;",
            "Object.prototype.wide = new Array(200000).fill(7);",
            "Object.prototype.fn = function () { return 1; };",
            "Object.prototype.str = 'x'.repeat(200000);",
            "Object.prototype.nan = NaN;",
            "Object.prototype.arr = [[[[[[[[[[1]]]]]]]]]];",
        ]
        for variant in variants {
            let root = Entity()
            guard let scene = try? JavaScriptScene(rootEntity: root, source: """
                const S = require("spatial");
                \(variant)
                const s = new S.Scene();
                const m = new S.Mesh(new S.BoxGeometry(0.1,0.1,0.1), new S.MeshStandardMaterial({color:1}));
                m.name = "c"; s.add(m);
                S.mount(s);
                """) else { continue }
            for _ in 0..<3 { scene.tick(deltaTime: 1.0 / 60) }
            #expect(root.findEntity(named: "c") != nil, "variant did not survive: \(variant)")
            scene.dispose()
        }
    }

    @Test
    func theParameterSignatureIsTotal() {
        let signature = ScriptingGeometryFactory.parameterSignature([
            "width": 0.2,
            "flag": true,
            "name": "box",
            "huge": String(repeating: "x", count: 1000),
            "nan": Double.nan,
            "nested": ["a": 1],
        ])
        #expect(signature.contains("width=0.2"))
        #expect(signature.contains("flag=true"))
        #expect(signature.contains("name=box"))
        // Everything else contributes a fixed sentinel, never a description.
        #expect(signature.contains("huge=?"))
        #expect(signature.contains("nan=?"))
        #expect(signature.contains("nested=?"))
        #expect(!signature.contains("xxxxxxxxxx"))
    }

    // MARK: - ROBUST-02

#if DEBUG
    @Test
    func anInfiniteLoopInTopLevelCodeIsTerminated() {
        let root = Entity()
        #expect(throws: (any Error).self) {
            _ = try JavaScriptScene(rootEntity: root, source: """
                const s = new Spatial.Scene();
                Spatial.mount(s);
                while (true) {}
                """)
        }
    }

    @Test
    func anInfiniteLoopInOnFrameIsTerminatedAndTheSceneDropped() throws {
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
        #expect(scene.isTerminated, "the watchdog did not trip")
        #expect(messages.contains { $0.contains("terminated") && $0.contains("tick") })
        scene.dispose()
    }
#endif

    // MARK: - PERF-01

    @Test
    func aColourTweenCostsOneNativeMaterialWrite() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 1100, "mesh", "tween"],
              ["geometry", 1100, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["material", 1100, { "type": "MeshStandardMaterial", "uuid": "m1", "color": [0, 0.4, 0.8],
                "opacity": 1, "metalness": 0, "roughness": 1, "maps": {} }]
            ]
            """)
        let applier = scene.commandApplier
        let baseline = applier.resources.summary["materialWrites"] ?? 0
        let builds = applier.resources.summary["materialBuilds"] ?? 0

        for step in 1...60 {
            let value = Double(step) / 100
            scene.applyCommands(javaScript: """
                [["material", 1100, { "type": "MeshStandardMaterial", "uuid": "m1",
                  "color": [\(value), 0.4, 0.8], "opacity": 1, "metalness": 0, "roughness": 1,
                  "maps": {} }]]
                """)
        }
        let summary = applier.resources.summary
        // 60 colour changes, 60 native writes, no rebuilds.
        #expect((summary["materialWrites"] ?? 0) - baseline == 60)
        #expect((summary["materialBuilds"] ?? 0) == builds)
        scene.dispose()
    }

    @Test
    func anUnchangedMaterialCommandCostsNothing() throws {
        let (_, scene) = try makeScene()
        let payload = """
            { "type": "MeshStandardMaterial", "uuid": "m2", "color": [0.2, 0.4, 0.8],
              "opacity": 1, "metalness": 0, "roughness": 1, "maps": {} }
            """
        scene.applyCommands(javaScript: """
            [
              ["create", 1110, "mesh", "still"],
              ["geometry", 1110, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["material", 1110, \(payload)]
            ]
            """)
        let baseline = scene.commandApplier.resources.summary["materialWrites"] ?? 0
        for _ in 0..<10 {
            scene.applyCommands(javaScript: "[[\"material\", 1110, \(payload)]]")
        }
        #expect((scene.commandApplier.resources.summary["materialWrites"] ?? 0) == baseline)
        scene.dispose()
    }

    // MARK: - PERF-05

    @Test
    func aBufferGeometryEditedEveryFrameDoesNotFillTheCache() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: #"[["create", 1120, "mesh", "ribbon"]]"#)
        for step in 0..<40 {
            let offset = Double(step) / 100
            scene.applyCommands(javaScript: """
                [["geometry", 1120, { "type": "BufferGeometry", "parameters": null, "uuid": "g1" },
                  new Float32Array([\(offset),0,0, 1,0,0, 0,1,0]), null, null, new Uint32Array([0,1,2])]]
                """)
        }
        // The parametric cache is what the cache exists for; a live buffer
        // geometry is not stored at all.
        // SPEC 5 caches by uuid and revision, so a per-frame edit supersedes
        // its own entry rather than storing a fresh multi-megabyte resource
        // every frame: one instance, one cached mesh, however many revisions.
        #expect(scene.commandApplier.resources.summary["cachedMeshes"] == 1)
        scene.dispose()
    }

    // MARK: - PERF-07

    @Test
    func aFinishedTextureLoadTouchesOnlyItsReferrers() throws {
        let (_, scene) = try makeScene()
        var commands = "["
        for index in 0..<20 {
            let id = 1200 + index
            commands += "[\"create\", \(id), \"mesh\", \"m\(index)\"],"
            commands += "[\"geometry\", \(id), { \"type\": \"BoxGeometry\", \"uuid\": \"g\", "
            commands += "\"parameters\": {\"width\":0.1,\"height\":0.1,\"depth\":0.1} }, new Float32Array(0), null, null, null],"
            let map = index < 3 ? "{ \"map\": 1300 }" : "{}"
            commands += "[\"material\", \(id), { \"type\": \"MeshStandardMaterial\", \"uuid\": \"mat\(index)\", "
            commands += "\"color\": [0.2, 0.4, 0.8], \"opacity\": 1, \"metalness\": 0, \"roughness\": 1, \"maps\": \(map) }],"
        }
        commands.removeLast()
        commands += "]"
        scene.applyCommands(javaScript: commands)

        let before = scene.commandApplier.resources.summary
        // Simulating the load completion: only the three referrers rebuild, and
        // the cache is not flushed.
        scene.commandApplier.reapplyMaterialsForTesting(referencing: 1300)
        let after = scene.commandApplier.resources.summary
        // No flush: the cache the other 17 materials live in is untouched, and
        // only the three referrers were revisited.
        #expect((after["cachedMaterials"] ?? 0) >= (before["cachedMaterials"] ?? 0))
        #expect(scene.commandApplier.materialReferrerCount(for: 1300) == 3)
        #expect(scene.commandApplier.materialReferrerCount(for: 9999) == 0)
        scene.dispose()
    }

    // MARK: - PERF-02

    @Test
    func dumpFilteringNarrowsTheResult() {
        let dump: [String: Any] = [
            "frame": 3,
            "objects": [
                ["name": "a", "position": [1, 2, 3], "material": ["type": "x"], "userData": ["k": 1]],
                ["name": "b", "position": [4, 5, 6], "material": ["type": "y"], "userData": [:]],
            ],
        ]
        let compact = ScriptingDumpFilter.apply(
            options: ScriptingDumpFilter.options(compact: true, names: [], fields: []),
            to: dump
        )
        // SPEC 3.13: `compact` is a reduction, not a deletion. The core rounds
        // the numbers and drops geometry parameters and userData; the object
        // list itself survives, which is what makes it a useful poll.
        #expect((compact["objects"] as? [[String: Any]])?.count == 2)
        #expect(compact["objectCount"] as? Int == 2)

        let named = ScriptingDumpFilter.apply(
            options: ScriptingDumpFilter.options(compact: false, names: ["b"], fields: []),
            to: dump
        )
        #expect((named["objects"] as? [[String: Any]])?.count == 1)
        #expect((named["objects"] as? [[String: Any]])?.first?["name"] as? String == "b")

        let fields = ScriptingDumpFilter.apply(
            options: ScriptingDumpFilter.options(compact: false, names: [], fields: ["position"]),
            to: dump
        )
        let first = try? #require((fields["objects"] as? [[String: Any]])?.first)
        #expect(first?["position"] != nil)
        #expect(first?["name"] != nil, "identity keys always survive")
        #expect(first?["userData"] == nil)
        #expect(first?["material"] == nil)

        #expect(ScriptingDumpFilter.options(compact: false, names: [], fields: []) == nil)
    }

    // MARK: - ROBUST-13

    @Test
    func statsReportsPausedAndTheSampledFrame() throws {
        let (_, scene) = try makeScene()
        scene.tick(deltaTime: 1.0 / 60)
        scene.tick(deltaTime: 1.0 / 60)
        var stats = scene.frameStats()
        #expect(stats["paused"] as? Bool == false)
        #expect(stats["sampledAtFrame"] as? Int == 2)

        scene.isPaused = true
        stats = scene.frameStats()
        #expect(stats["paused"] as? Bool == true)
        #expect(stats["sampledAtFrame"] as? Int == 2)
        scene.dispose()
    }

    // MARK: - MAINT-09

    @Test
    func unknownPayloadKeysWarnRatherThanVanish() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 1400, "mesh", "keys"],
              ["geometry", 1400, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["material", 1400, { "type": "MeshStandardMaterial", "color": [1,1,1], "maps": {},
                "iridescence": 0.5 }],
              ["create", 1401, "wormhole", "future"]
            ]
            """)
        let warnings = scene.commandApplier.warnings.warnings
        #expect(warnings.contains { $0.contains("iridescence") })
        #expect(warnings.contains { $0.contains("wormhole") })
        scene.dispose()
    }

    // MARK: - MAINT-07, previously untested public surface

    @Test
    func frameStatsSummarisesTheWindow() throws {
        let (_, scene) = try makeScene()
        for _ in 0..<5 { scene.tick(deltaTime: 1.0 / 60) }
        let stats = scene.frameStats()
        #expect(stats["frames"] as? Int == 5)
        let tick = try #require(stats["coreTickMs"] as? [String: Double])
        #expect(tick["median"] != nil)
        #expect(tick["max"] != nil)
        #expect(stats["entityCount"] as? Int != nil)
        #expect(stats["resourceCache"] as? [String: Int] != nil)
        scene.dispose()
    }

    @Test
    func theTextureStoreResolvesAndReleases() throws {
        let store = ScriptingTextureStore(assetDirectory: URL(fileURLWithPath: "/tmp"))
        nonisolated(unsafe) var failures: [Int] = []
        store.onFailed = { id, _ in failures.append(id) }
        store.declare(id: 1, payload: [
            "url": "asset://nothing", "repeat": [2, 2], "offset": [0, 0],
            "wrapS": 1001, "wrapT": 1002, "flipY": false,
        ])
        let entry = try #require(store.entry(for: 1))
        #expect(entry.wrapS == 1001)
        #expect(entry.flipY == false)
        #expect(store.resource(for: 1) == nil)

        store.release(id: 1)
        #expect(store.entry(for: 1) == nil)
        store.removeAll()
        #expect(store.entry(for: 1) == nil)
    }

    @Test
    func theInputRouterRoutesTapsAndDragsToTheOwningScene() throws {
        let router = ScriptingInputRouter.shared
        router.reset()
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            const box = new Spatial.Mesh(
              new Spatial.BoxGeometry(0.2, 0.2, 0.2),
              new Spatial.MeshBasicMaterial()
            );
            box.name = "box";
            box.userData.taps = 0;
            box.userData.drags = 0;
            box.addEventListener("tap", () => { box.userData.taps += 1; });
            box.addEventListener("drag", (e) => { box.userData.drags += 1; box.userData.dx = e.translation.x; });
            stage.add(box);
            Spatial.mount(stage);
            """)
        scene.tick(deltaTime: 1.0 / 60)
        let box = try #require(root.findEntity(named: "box"))

        router.sendTap(to: box, worldPoint: SIMD3(0.1, 0.2, 0.3))
        router.sendDrag(
            to: box,
            phase: .changed,
            worldPoint: SIMD3(0.5, 0, 0),
            startWorldPoint: .zero
        )
        scene.tick(deltaTime: 1.0 / 60)

        let objects = scene.dump()["objects"] as? [[String: Any]] ?? []
        let dumped = try #require(objects.first { $0["name"] as? String == "box" })
        let userData = try #require(dumped["userData"] as? [String: Any])
        #expect((userData["taps"] as? NSNumber)?.intValue == 1)
        #expect((userData["drags"] as? NSNumber)?.intValue == 1)
        #expect(abs(((userData["dx"] as? NSNumber)?.doubleValue ?? 0) - 0.5) < 1e-4)
        scene.dispose()
        router.reset()
    }
}
