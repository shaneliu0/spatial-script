//
//  ResourceTests.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import AVFoundation
import Foundation
import RealityKit
import Testing
@testable import SpatialScriptRuntime

/// SPEC 5 and 14.5: the mesh and material caches, where this consumer reads
/// bytes from, the loads it is still waiting on, and the rig an asset arrives
/// with.
@MainActor
struct ResourceTests {
    private func makeScene(_ body: String = "") throws -> (Entity, JavaScriptScene) {
        try ScriptingTestScene.make(body)
    }

    /// The authoring prompt is a packaged resource, and the one failure that
    /// would reach a user silently is the bundle not carrying it: the accessor
    /// falls back to a short note, and the app would copy that note to the
    /// clipboard instead of the prompt. Assert the real document loads.
    @Test
    func theAuthoringPromptShipsInTheResourceBundle() throws {
        #expect(SpatialAgentPrompt.isAvailable, "agent-prompt.md is missing from the bundle")

        let text = SpatialAgentPrompt.text
        #expect(text != SpatialAgentPrompt.missingResourceNote, "the accessor returned its fallback note")

        // Markers that only the real, complete document carries: the framing,
        // the mandatory call, the embedded declarations, and a class from the
        // far end of them.
        for marker in ["# Hard rules", "Spatial.mount(scene)", "# The complete API", "class TurbulenceForceField"] {
            #expect(text.contains(marker), "the packaged prompt is missing \(marker)")
        }
        #expect(text.count > 50_000, "the packaged prompt is truncated at \(text.count) characters")
    }

    /// FA-06 and FA-07: SPEC 5 keys a mesh by uuid and revision, so sharers
    /// build once and an edit of the same instance rebuilds.
    ///
    /// The revision values here are the ones the core really emits. It is an
    /// opaque token, not a number: `core/src/util/diff.js` builds it as
    /// `"<structural>:<position>:<normal>:<uv>:<index>"` from the attribute
    /// versions, where an absent attribute contributes `-1`. A fixture using
    /// numbers cannot fail, because a number and a string that both fail to
    /// parse collapse to the same key.
    @Test
    func meshesAreCachedByUUIDAndRevision() throws {
        let (_, scene) = try makeScene()
        // Two objects sharing one BufferGeometry instance build one mesh.
        // Positions and indices only, so the token reads 0:0:-1:-1:0.
        for id in 1...2 {
            scene.applyCommands(javaScript: """
                [["create", \(id), "mesh", "b\(id)"],
                 ["geometry", \(id), { "type": "BufferGeometry", "parameters": {},
                                    "uuid": "shared-buffer", "revision": "0:0:-1:-1:0" },
                  new Float32Array([0,0,0, 1,0,0, 1,1,0]), null, null, new Uint32Array([0,1,2])]]
                """)
        }
        var cache = scene.commandApplier.resources.summary
        #expect(cache["meshBuilds"] as? Int == 1, "1500 sharers must not build 1500 meshes")
        #expect(cache["meshHits"] as? Int == 1)

        // The in-place edit the core reports by bumping the position version.
        // The mesh must be rebuilt: serving the pre-edit resource leaves the
        // stale triangle on screen.
        scene.applyCommands(javaScript: """
            [["geometry", 1, { "type": "BufferGeometry", "parameters": {},
                               "uuid": "shared-buffer", "revision": "0:1:-1:-1:0" },
              new Float32Array([0,0,0, 2,0,0, 2,2,0]), null, null, new Uint32Array([0,1,2])]]
            """)
        cache = scene.commandApplier.resources.summary
        #expect(cache["meshBuilds"] as? Int == 2, "an in-place edit must rebuild")
        #expect(cache["cachedMeshes"] as? Int == 1, "one instance, one entry")

        // Two *separate* parametric instances with the same numbers share one
        // mesh, and a structural rebuild of one still builds again.
        let builds = cache["meshBuilds"] as? Int ?? 0
        scene.applyCommands(javaScript: """
            [["create", 3, "mesh", "p1"],
             ["geometry", 3, { "type": "BoxGeometry", "parameters": { "width": 1, "height": 1, "depth": 1 },
                               "uuid": "box-1", "revision": "0:0:0:0:0" }, null, null, null, null],
             ["create", 4, "mesh", "p2"],
             ["geometry", 4, { "type": "BoxGeometry", "parameters": { "width": 1, "height": 1, "depth": 1 },
                               "uuid": "box-2", "revision": "0:0:0:0:0" }, null, null, null, null]]
            """)
        #expect(
            (scene.commandApplier.resources.summary["meshBuilds"] as? Int ?? 0) == builds + 1,
            "two instances with the same parameters must share one mesh"
        )
        scene.applyCommands(javaScript: """
            [["geometry", 3, { "type": "BoxGeometry", "parameters": { "width": 1, "height": 1, "depth": 1 },
                               "uuid": "box-1", "revision": "1:0:0:0:0" }, null, null, null, null]]
            """)
        #expect((scene.commandApplier.resources.summary["meshBuilds"] as? Int ?? 0) == builds + 2)
        scene.dispose()
    }

    /// NR-01: the caches are bounded, but an entry a live record still draws is
    /// never a candidate for eviction. Past 512 distinct resources the oldest
    /// objects lost their mesh: SPEC 5 lets the core re-send a geometry with
    /// null buffers once it has been delivered, so an evicted entry cannot be
    /// rebuilt and the object goes invisible.
    @Test
    func evictionSparesResourcesThatLiveRecordsStillDraw() throws {
        let (_, scene) = try makeScene()
        let count = 600
        var commands: [String] = []
        for id in 1...count {
            let colour = Double(id) / 1000
            commands.append("""
                ["create", \(id), "mesh", "m\(id)"],
                ["geometry", \(id), { "type": "BufferGeometry", "parameters": {},
                                   "uuid": "buf-\(id)", "revision": "0:0:-1:-1:0" },
                 new Float32Array([0,0,0, \(id),0,0, \(id),1,0]), null, null, new Uint32Array([0,1,2])],
                ["material", \(id), { "type": "MeshStandardMaterial", "uuid": "mat-\(id)",
                                   "color": [\(colour), 0.2, 0.3], "opacity": 1, "transparent": false,
                                   "side": 0, "wireframe": false, "metalness": 0, "roughness": 1 }]
                """)
        }
        scene.applyCommands(javaScript: "[" + commands.joined(separator: ",") + "]")
        var cache = scene.commandApplier.resources.summary
        #expect(
            cache["cachedMeshes"] as? Int == count,
            "\(count) live geometries: \(cache["cachedMeshes"] ?? -1) cached"
        )
        #expect(
            cache["cachedMaterials"] as? Int == count,
            "\(count) live materials: \(cache["cachedMaterials"] ?? -1) cached"
        )

        // What the core really sends for a geometry it has already delivered:
        // the descriptor with null buffers. It must hit the cache.
        let buildsBefore = cache["meshBuilds"] as? Int ?? 0
        scene.applyCommands(javaScript: """
            [["geometry", 1, { "type": "BufferGeometry", "parameters": {},
                               "uuid": "buf-1", "revision": "0:0:-1:-1:0" }, null, null, null, null]]
            """)
        #expect(
            scene.commandApplier.resources.summary["meshBuilds"] as? Int == buildsBefore,
            "a buffer-less re-send of a live geometry must hit the cache"
        )
        // The cache counters above are the real assertion; this one keeps the
        // symptom the original defect showed in the console.
        #expect(
            !scene.commandApplier.warnings.warnings.contains { $0.contains("produced no mesh") },
            "\(scene.commandApplier.warnings.warnings)"
        )
        #expect((scene.commandApplier.records[1]?.entity as? ModelEntity)?.model?.mesh != nil)

        // Releasing half the scene evicts exactly those halves' resources.
        let doomed = (1...count / 2).map { "[\"destroy\", \($0)]" }.joined(separator: ",")
        scene.applyCommands(javaScript: "[" + doomed + "]")
        cache = scene.commandApplier.resources.summary
        #expect(
            cache["cachedMeshes"] as? Int == count / 2,
            "only the released meshes go: \(cache["cachedMeshes"] ?? -1)"
        )
        // A survivor is still served from the cache.
        let buildsAfter = cache["meshBuilds"] as? Int ?? 0
        scene.applyCommands(javaScript: """
            [["geometry", 400, { "type": "BufferGeometry", "parameters": {},
                                 "uuid": "buf-400", "revision": "0:0:-1:-1:0" }, null, null, null, null]]
            """)
        #expect(scene.commandApplier.resources.summary["meshBuilds"] as? Int == buildsAfter)

        // The bound still holds for entries nothing draws: one object handed a
        // fresh geometry instance 2000 times keeps one reference, and the
        // orphans are evicted.
        for step in 1...2000 {
            scene.applyCommands(javaScript: """
                [["geometry", 400, { "type": "BufferGeometry", "parameters": {},
                                     "uuid": "churn-\(step)", "revision": "0:0:-1:-1:0" },
                  new Float32Array([0,0,0, 1,0,0, 1,\(step),0]), null, null, new Uint32Array([0,1,2])]]
                """)
        }
        let bounded = scene.commandApplier.resources.summary["cachedMeshes"] as? Int ?? 0
        #expect(bounded < 900, "unreferenced entries must still be evicted: \(bounded)")
        scene.dispose()
    }

    /// Destroying the last user of a buffer geometry drops its mesh, and
    /// disposing the scene drops every cached resource it built.
    @Test
    func disposingASceneDropsItsCachedGeometries() throws {
        let (_, scene) = try makeScene()
        for id in 1...2 {
            scene.applyCommands(javaScript: """
                [["create", \(id), "mesh", "b\(id)"],
                 ["geometry", \(id), { "type": "BufferGeometry", "parameters": {},
                                    "uuid": "buf-\(id)", "revision": "0:0:-1:-1:0" },
                  new Float32Array([0,0,0, 1,0,0, 1,1,0]), null, null, new Uint32Array([0,1,2])]]
                """)
        }
        #expect(scene.commandApplier.resources.summary["cachedMeshes"] as? Int == 2)

        scene.applyCommands(javaScript: """
            [["destroy", 1]]
            """)
        #expect(
            scene.commandApplier.resources.summary["cachedMeshes"] as? Int == 1,
            "the destroyed object's mesh stayed in the cache"
        )

        scene.dispose()
        #expect(scene.commandApplier.resources.summary["cachedMeshes"] as? Int == 0)
    }

    /// The core warns once for a mesh whose geometry has no vertices, so this
    /// consumer saying the same thing again put one fact in the dump twice and
    /// only on this backend. An empty geometry is now skipped silently; a
    /// geometry that carried vertices and still produced no mesh is a native
    /// failure the core cannot see, and still warns.
    @Test
    func anEmptyGeometryIsSkippedSilentlyAndARealFailureStillWarns() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["create", 1, "mesh", "empty"],
             ["geometry", 1, { "type": "BufferGeometry", "parameters": {},
                               "uuid": "empty-1", "revision": "0:0:-1:-1:-1" },
              new Float32Array(0), null, null, null]]
            """)
        #expect(
            !scene.commandApplier.warnings.warnings.contains { $0.contains("produced no mesh") },
            "the core already warned about this: \(scene.commandApplier.warnings.warnings)"
        )
        #expect(scene.commandApplier.records[1]?.mesh == nil)

        // A geometry with vertices that RealityKit refuses: one position is not
        // a triangle, so nothing can be built out of it.
        scene.applyCommands(javaScript: """
            [["create", 2, "mesh", "broken"],
             ["geometry", 2, { "type": "BufferGeometry", "parameters": {},
                               "uuid": "broken-1", "revision": "0:0:-1:-1:0" },
              new Float32Array([0, 0, 0]), null, null, new Uint32Array([0, 1, 2])]]
            """)
        #expect(
            scene.commandApplier.warnings.warnings.contains { $0.contains("produced no mesh") },
            "a native failure must still be reported: \(scene.commandApplier.warnings.warnings)"
        )
        scene.dispose()
    }

    /// SPEC 14.13a: a plan frame must not advance while a load is in flight,
    /// so the consumer counts what it is waiting on. Asset, texture and
    /// environment loads all raise the count, and every one of them lowers it
    /// again whether it succeeds or fails.
    @Test
    func loadsInFlightAreCountedUntilTheyAnswer() async throws {
        let (_, scene) = try makeScene()
        #expect(scene.pendingLoads == 0)
        scene.applyCommands(javaScript: """
            [["create", 1, "asset", "figure"],
             ["asset", 1, { "usdz": "asset://rig.usdz" }],
             ["create", 2, "asset", "ghost"],
             ["asset", 2, { "usdz": "asset://not-here.usdz" }],
             ["texture", 3, { "url": "asset://checker.png" }],
             ["texture", 4, { "url": "asset://not-here.png" }],
             ["environment", 0, { "url": "asset://studio-env.hdr", "intensity": 1 }]]
            """)
        #expect(
            scene.pendingLoads >= 4,
            "the assets, the environment and any texture still reading: \(scene.pendingLoadURLs)"
        )
        #expect(scene.pendingLoadURLs.contains("asset://rig.usdz"))

        // Every one of them answers, including the two that cannot be found.
        for _ in 0..<400 where scene.pendingLoads > 0 {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(scene.pendingLoads == 0, "still waiting on \(scene.pendingLoadURLs)")
        scene.dispose()
    }

    /// AR-3a: the core's asset root and this consumer's asset directory are two
    /// different things. A headless runner has to give the core the relative
    /// string the node runner uses, so both dumps carry the same url text —
    /// which used to leave the native loaders with a relative URL and no bytes
    /// to read. They are separate parameters now.
    @Test
    func aRelativeAssetRootStillLoadsRealBytesFromTheAssetDirectory() async throws {
        let root = Entity()
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: "const stage = new Spatial.Scene(); Spatial.mount(stage);",
            // What the node runner passes, and what both dumps report.
            assetRoot: URL(string: "assets"),
            // Where the bytes really are.
            assetDirectory: Phase2Tests.assetRoot
        )
        #expect(scene.assetRoot?.path == "assets")

        nonisolated(unsafe) var events: [(String, Int, [String: Any]?)] = []
        scene.commandApplier.dispatch = { type, id, payload in events.append((type, id, payload)) }
        scene.applyCommands(javaScript: """
            [["create", 1, "asset", "bundled"],
             ["asset", 1, { "usdz": "asset://rig.usdz" }],
             ["create", 2, "asset", "relative"],
             ["asset", 2, { "usdz": "assets/rig.usdz" }]]
            """)
        for _ in 0..<400 where events.filter({ $0.0 == "assetLoaded" }).count < 2 {
            try? await Task.sleep(for: .milliseconds(10))
        }
        let loaded = events.filter { $0.0 == "assetLoaded" }.map(\.1).sorted()
        #expect(
            loaded == [1, 2],
            "both urls must find real bytes; errors: \(events.filter { $0.0 == "assetError" }.map { $0.2 ?? [:] })"
        )
        #expect(scene.commandApplier.records[1]?.assetContainer != nil)
        #expect(scene.commandApplier.records[2]?.assetContainer != nil)
        scene.dispose()
    }

    /// P2-B-21: a pose set while a native animation is playing is held, not
    /// lost, and replayed on the frame the animation stops.
    @Test
    func skeletonEditsHeldDuringAnAnimationAreReplayedWhenItStops() async throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var loaded = false
        scene.commandApplier.dispatch = { type, _, _ in if type == "assetLoaded" { loaded = true } }
        scene.applyCommands(javaScript: """
            [["create", 1, "asset", "figure"], ["asset", 1, { "usdz": "asset://rig.usdz" }]]
            """)
        for _ in 0..<400 where !loaded { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(loaded)

        let record = try #require(scene.commandApplier.records[1])
        let state = try #require(record.extras?.skeleton)
        let entity = try #require(state.poseEntity)

        // Stand in for a running native animation: the applier only asks
        // whether one is playing.
        state.animationOverrides = true
        state.pendingJoints["head"] = (SIMD3(0, 0.2, 0), simd_quatf(ix: 0, iy: 0.7071068, iz: 0, r: 0.7071068))
        let before = try #require(
            entity.components[SkeletalPosesComponent.self]?.poses.default?["root/head"]
        )
        #expect(abs(before.rotation.real - 1) < 1e-4)

        // The frame the animation stops is the frame the held edits land.
        scene.commandApplier.replayHeldSkeletonEdits()
        let after = try #require(
            entity.components[SkeletalPosesComponent.self]?.poses.default?["root/head"]
        )
        #expect(abs(after.rotation.imag.y - 0.7071068) < 1e-4, "the held pose was lost forever")
        #expect(!state.animationOverrides)
        scene.dispose()
    }
}
