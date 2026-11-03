//
//  PhysicsTests.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import AVFoundation
import Foundation
import RealityKit
import Testing
@testable import SpatialScriptRuntime

/// SPEC 3.7, 6 and 14.4: rigid bodies and their shapes, collisions, raycasts,
/// and the character controllers and force fields that move things natively.
@MainActor
struct PhysicsTests {
    private func makeSceneWithMesh() throws -> (Entity, JavaScriptScene) {
        try ScriptingTestScene.makeWithMesh()
    }

    /// FA-04: SPEC 3.7's `"mesh"` is a static triangle mesh, and a dynamic body
    /// cannot have one, so it is refused by name rather than silently boxed.
    @Test
    func aStaticMeshShapeIsBuiltAndRefusedForADynamicBody() async throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["rigidBody", 1, { "type": "static", "shape": "mesh" }]]
            """)
        let record = try #require(scene.commandApplier.records[1])
        #expect(record.bodyShape == "mesh")
        for _ in 0..<200 where !record.hasStaticMeshShape {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(record.hasStaticMeshShape, "a static mesh collider was never built")

        scene.applyCommands(javaScript: """
            [["create", 2, "mesh", "mover"],
             ["geometry", 2, { "type": "BoxGeometry", "parameters": { "width": 1, "height": 1, "depth": 1 } },
                              null, null, null, null],
             ["rigidBody", 2, { "type": "dynamic", "shape": "mesh" }]]
            """)
        #expect(
            scene.commandApplier.warnings.warnings.contains { $0.contains("static only") },
            "\(scene.commandApplier.warnings.warnings)"
        )
        // The dump reports the shape that exists, not the one asked for.
        #expect(scene.commandApplier.records[2]?.bodyShape == "convex")
        scene.dispose()
    }

    /// P2-B-42 and P2-B-43: a detached character reports no motion at all — its
    /// world position is really a local one — and a force field declared
    /// without a radius still gets a bounded one.
    @Test
    func aDetachedCharacterDoesNotSyncAndAFieldWithoutARadiusIsBounded() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["characterController", 1, { "radius": 0.2, "height": 1, "gravity": false }]]
            """)
        #expect(scene.commandApplier.characterSyncRecords().count == 8)
        scene.applyCommands(javaScript: """
            [["visible", 1, true], ["parent", 1, -1]]
            """)
        // Detached: its world position is really a local one, so it is not
        // reported at all rather than reported wrongly.
        let record = try #require(scene.commandApplier.records[1])
        record.entity.removeFromParent()
        #expect(scene.commandApplier.characterSyncRecords().isEmpty)

        scene.applyCommands(javaScript: """
            [["create", 2, "group", "field"],
             ["forceField", 2, { "kind": "VortexForceField", "strength": 1 }]]
            """)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("no radius") })
        #expect(scene.commandApplier.records[2]?.extras?.forceField?.applied == true)
        scene.dispose()
    }

    /// FA-11: at most one hit per object, over meshes only.
    @Test
    func aRaycastReportsEachObjectAtMostOnce() throws {
        let (_, scene) = try makeSceneWithMesh()
        // A child of the same record must not add a second hit.
        let record = try #require(scene.commandApplier.records[1])
        let child = ModelEntity()
        child.name = "part"
        record.entity.addChild(child)
        scene.applyCommands(javaScript: """
            [["create", 2, "group", "bodyOnly"], ["rigidBody", 2, { "type": "static" }]]
            """)
        let values = scene.raycastValues(
            origin: SIMD3(0, 0, 4),
            direction: SIMD3(0, 0, -1)
        )
        var ids: [Int] = []
        var index = 0
        while index + 7 < values.count { ids.append(Int(values[index])); index += 8 }
        #expect(ids.count == Set(ids).count, "one object reported more than one hit")
        // A group with a collider but no mesh is not a raycast hit (SPEC 3.7).
        #expect(!ids.contains(2))
        scene.dispose()
    }

    /// FA-30: SPEC 3.7 needs at least one rigid body in the pair.
    @Test
    func twoHitTestCollidersDoNotReportACollision() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["create", 2, "mesh", "other"],
             ["geometry", 2, { "type": "BoxGeometry", "parameters": { "width": 1, "height": 1, "depth": 1 } },
                              null, null, null, null],
             ["interactive", 1, { "tap": true }],
             ["interactive", 2, { "tap": true }]]
            """)
        nonisolated(unsafe) var events: [String] = []
        scene.commandApplier.dispatch = { type, _, _ in events.append(type) }
        let a = try #require(scene.commandApplier.records[1]?.entity)
        let b = try #require(scene.commandApplier.records[2]?.entity)
        scene.commandApplier.reportCollisionForTesting(
            a, b, began: true, impulse: 1, position: .zero, normal: SIMD3(0, 1, 0)
        )
        #expect(events.isEmpty, "neither object is a rigid body")

        scene.applyCommands(javaScript: """
            [["rigidBody", 2, { "type": "dynamic" }]]
            """)
        scene.commandApplier.reportCollisionForTesting(
            a, b, began: true, impulse: 1, position: .zero, normal: SIMD3(0, 1, 0)
        )
        #expect(events.contains("collisionstart"))
        scene.dispose()
    }

    /// FA-25: SPEC 6 — a negative maxDistance means unbounded.
    @Test
    func anUnboundedRaycastIsUnbounded() throws {
        let (_, scene) = try makeSceneWithMesh()
        let record = try #require(scene.commandApplier.records[1])
        record.entity.position = SIMD3(0, 0, -5000)
        // -1 is SPEC 6's unbounded ray.
        let values = scene.commandApplier.raycast(
            origin: SIMD3(0, 0, 0),
            direction: SIMD3(0, 0, -1),
            maxDistance: -1
        )
        #expect(!values.isEmpty, "a 5 km hit was clipped at 1000 m")
        scene.dispose()
    }

    /// An unbounded ray still has to hit what is right in front of it:
    /// `greatestFiniteMagnitude` made `scene.raycast` return nothing at all.
    @Test
    func anUnboundedRaycastStillHitsSomethingOneMetreAway() throws {
        let (_, scene) = try makeSceneWithMesh()
        let record = try #require(scene.commandApplier.records[1])
        record.entity.position = SIMD3(0, 0, -1)
        let values = scene.commandApplier.raycast(
            origin: SIMD3(0, 0, 0),
            direction: SIMD3(0, 0, -1),
            maxDistance: -1
        )
        #expect(values.count >= 8, "an unbounded ray missed an object one metre away")
        #expect(Int(values.first ?? 0) == 1)
        #expect(values[7] > 0.4 && values[7] < 1.1, "distance \(values.count >= 8 ? values[7] : -1)")
        scene.dispose()
    }
}
