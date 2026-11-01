//
//  RobustnessTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit
import Testing
@testable import SpatialScriptRuntime

/// SPEC 2's robustness rule: a malformed command is ignored or warned about,
/// never fatal. Every case here traps or corrupts the mirror without the fixes.
@MainActor
struct RobustnessTests {
    private func makeScene() throws -> (Entity, JavaScriptScene) {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            Spatial.mount(stage);
            """)
        return (root, scene)
    }

    @Test
    func malformedCommandsAreWarnedAboutRatherThanFatal() throws {
        let (_, scene) = try makeScene()
        // A bare object has no `length`; converting undefined through Int traps.
        scene.applyCommands(javaScript: "[{}]")
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("not an array") })

        scene.applyCommands(javaScript: "[[]]")
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("no opcode") })

        scene.applyCommands(javaScript: """
            [
              [null, 1],
              [1234, 1],
              ["create"],
              ["create", NaN, "mesh", "x"],
              ["transform", 999999, NaN, Infinity, -Infinity, 0, 0, 0, 1, 1, 1, 1],
              ["transforms", 0, new Float32Array([NaN, 1, 2, 3, 0, 0, 0, 1, 1, 1, 1])],
              ["transforms", 0, new Float32Array([1, 2, 3])],
              ["transforms", 0, new Float32Array(0)],
              ["transforms", 0, "not a typed array"],
              ["geometry", 1, null, null, null, null, null],
              ["material", 1, "not an object"],
              ["opacity", 1, NaN],
              ["rigidBody", 1, 42],
              ["light", 1, undefined],
              ["particles", 1, []],
              "a bare string",
              12345
            ]
            """)
        // Still alive and still applying real commands afterwards.
        scene.applyCommands(javaScript: #"[["create", 900, "group", "survivor"]]"#)
        #expect(scene.commandApplier.entity(for: 900) != nil)
        scene.dispose()
    }

    @Test
    func randomCommandArraysNeverTrap() throws {
        let (_, scene) = try makeScene()
        let opcodes = [
            "create", "destroy", "parent", "name", "transform", "transforms", "visible",
            "geometry", "material", "texture", "light", "shadow", "opacity", "billboard",
            "groundingShadow", "hoverEffect", "manipulable", "renderOrder", "interactive",
            "rigidBody", "bodyImpulse", "bodyForce", "bodyTorque", "bodyVelocity", "joint",
            "gravity", "particles", "particlesBurst", "anchor", "portal", "world", "asset",
            "assetAnimation", "environment", "log", "notAnOpcode", "",
        ]
        let values = [
            "null", "undefined", "NaN", "Infinity", "-Infinity", "0", "-1", "1e40",
            "\"text\"", "true", "false", "{}", "[]", "{ type: null }",
            "new Float32Array([NaN])", "new Float32Array(3)", "new Uint32Array([1, 2])",
            "[1, 2, 3]", "{ length: NaN }",
        ]

        var generator = SystemRandomNumberGenerator()
        for _ in 0..<300 {
            var command = "[["
            command += "\"\(opcodes.randomElement(using: &generator)!)\""
            let arity = Int.random(in: 0...6, using: &generator)
            for _ in 0..<arity {
                command += ", \(values.randomElement(using: &generator)!)"
            }
            command += "]]"
            scene.applyCommands(javaScript: command)
        }

        scene.applyCommands(javaScript: #"[["create", 901, "group", "alive"]]"#)
        #expect(scene.commandApplier.entity(for: 901) != nil)
        scene.dispose()
    }

    @Test
    func typedArraysOfTheWrongLengthDropOnlyTheTail() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: #"[["create", 910, "group", "a"], ["create", 911, "group", "b"]]"#)
        // Two whole records plus four stray floats.
        scene.applyCommands(javaScript: """
            [["transforms", 0, new Float32Array([
              910, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1,
              911, 0, 2, 0, 0, 0, 0, 1, 1, 1, 1,
              910, 5, 5
            ])]]
            """)
        #expect(try #require(scene.commandApplier.entity(for: 910)).position == SIMD3<Float>(1, 0, 0))
        #expect(try #require(scene.commandApplier.entity(for: 911)).position == SIMD3<Float>(0, 2, 0))
        scene.dispose()
    }

    @Test
    func aStaleExceptionDoesNotDiscardTheNextFrame() throws {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            const cube = new Spatial.Mesh(
              new Spatial.BoxGeometry(0.1, 0.1, 0.1),
              new Spatial.MeshBasicMaterial()
            );
            cube.name = "cube";
            cube.addEventListener("tap", () => { throw new Error("listener blew up"); });
            stage.add(cube);
            Spatial.onFrame((dt) => { cube.position.x += dt; });
            Spatial.mount(stage);
            """)
        scene.tick(deltaTime: 1.0 / 60)
        let created = try #require(root.findEntity(named: "cube"))

        // A throwing listener leaves an exception in the context slot.
        scene.injectTap(target: "cube")
        scene.tick(deltaTime: 1.0 / 60)
        let afterThrow = created.position.x

        // The next frame's commands must still be applied.
        scene.tick(deltaTime: 1.0 / 60)
        #expect(created.position.x > afterThrow, "a stale exception discarded the frame")
        scene.dispose()
    }

    @Test
    func disposeLeavesTheSharedRootClean() throws {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            stage.add(new Spatial.AmbientLight(0xffffff, 1));
            const a = new Spatial.Mesh(new Spatial.BoxGeometry(0.1, 0.1, 0.1), new Spatial.MeshBasicMaterial());
            a.name = "a"; a.rigidBody = new Spatial.RigidBody({ type: "static" });
            const b = new Spatial.Mesh(new Spatial.BoxGeometry(0.1, 0.1, 0.1), new Spatial.MeshBasicMaterial());
            b.name = "b"; b.rigidBody = new Spatial.RigidBody({ mass: 1 });
            stage.add(a); stage.add(b);
            Spatial.physics.add(new Spatial.Joint({ type: "fixed", bodyA: a, bodyB: b }));
            Spatial.mount(stage);
            """)
        scene.tick(deltaTime: 1.0 / 60)
        scene.tick(deltaTime: 1.0 / 60)
        #expect(root.components[PhysicsJointsComponent.self] != nil)
        #expect(root.components[ImageBasedLightReceiverComponent.self] != nil)

        scene.dispose()
        // The joints leave the root immediately; the bodies they pinned stay one
        // more frame so RealityKit's deferred joint deletion cannot dereference
        // a freed entity.
        // Emptied rather than removed: removing the component leaves
        // RealityKit's deferred joint deletion list undrained.
        #expect(root.components[PhysicsJointsComponent.self]?.joints.isEmpty == true)
        #expect(root.components[ImageBasedLightReceiverComponent.self] == nil)
        #expect(root.components[PhysicsSimulationComponent.self] == nil)
        // The pins stay one more frame: the queued constraint still points at
        // them, so removing them with the joints is what crashed RealityKit.
        #expect(ScriptingPhysicsGraveyard.shared.pendingCount > 0)

        for _ in 0..<ScriptingPhysicsGraveyard.framesToHold {
            ScriptingPhysicsGraveyard.shared.advance()
        }
        // The next script reuses this entity, so nothing may survive here.
        #expect(root.children.isEmpty)
        #expect(ScriptingPhysicsGraveyard.shared.pendingCount == 0)
    }

    @Test
    func destroyingAJointsBodyClearsTheJointBeforeTheEntityGoes() throws {
        let (root, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 1000, "mesh", "anchorBody"],
              ["geometry", 1000, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 1000, { "type": "static", "mass": 1, "shape": "box" }],
              ["create", 1001, "mesh", "bob"],
              ["geometry", 1001, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 1001, { "type": "dynamic", "mass": 1, "shape": "box" }],
              ["joint", 1010, { "type": "revolute", "bodyA": 1000, "bodyB": 1001,
                "anchorA": [0, 0, 0], "anchorB": [0, 0.2, 0], "axis": [0, 0, 1], "limits": null }]
            ]
            """)
        #expect(root.components[PhysicsJointsComponent.self]?.joints.count == 1)
        let bob = try #require(scene.commandApplier.entity(for: 1001))
        #expect(bob.components[GeometricPinsComponent.self] != nil)

        scene.applyCommands(javaScript: #"[["destroy", 1001]]"#)
        // Frame N: only the joint is gone. Everything the queued constraint
        // still points at stays put.
        #expect(root.components[PhysicsJointsComponent.self]?.joints.isEmpty == true)
        #expect(bob.parent === root, "the pinned entity left in the same frame as its joint")
        #expect(bob.components[GeometricPinsComponent.self] != nil, "a pin left with its joint")
        #expect(bob.components[PhysicsBodyComponent.self] != nil)

        // Frame N+1: the pins, the body and the entity follow.
        for _ in 0..<ScriptingPhysicsGraveyard.framesToHold {
            ScriptingPhysicsGraveyard.shared.advance()
        }
        #expect(bob.parent == nil)
        #expect(bob.components[GeometricPinsComponent.self] == nil)
        #expect(bob.components[PhysicsBodyComponent.self] == nil)

        scene.dispose()
        ScriptingPhysicsGraveyard.shared.drain()
    }

    @Test
    func removingABodyRestoresTheHitTestFilter() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 920, "mesh", "solid"],
              ["geometry", 920, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["interactive", 920, { "tap": true, "hover": false, "drag": false }],
              ["rigidBody", 920, { "type": "static", "mass": 1, "shape": "box" }]
            ]
            """)
        let entity = try #require(scene.commandApplier.entity(for: 920))
        #expect(entity.components[CollisionComponent.self]?.filter.group == ScriptingCommandApplier.physicsGroup)

        scene.applyCommands(javaScript: #"[["rigidBody", 920, null]]"#)
        #expect(entity.components[PhysicsBodyComponent.self] == nil)
        // Back in the hit-test group, or gestures would stop reaching it.
        let filter = try #require(entity.components[CollisionComponent.self]?.filter)
        #expect(filter.group == ScriptingCommandApplier.hitTestGroup)
        #expect(filter.mask == ScriptingCommandApplier.hitTestGroup)
        scene.dispose()
    }

    @Test
    func destroyingABodyRebuildsTheJoints() throws {
        let (root, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 930, "mesh", "a"],
              ["geometry", 930, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 930, { "type": "static", "mass": 1, "shape": "box" }],
              ["create", 931, "mesh", "b"],
              ["geometry", 931, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 931, { "type": "dynamic", "mass": 1, "shape": "box" }],
              ["joint", 940, { "type": "fixed", "bodyA": 930, "bodyB": 931,
                "anchorA": [0, 0, 0], "anchorB": [0, 0, 0], "axis": [0, 1, 0], "limits": null }]
            ]
            """)
        #expect(root.components[PhysicsJointsComponent.self]?.joints.count == 1)

        scene.applyCommands(javaScript: #"[["destroy", 931]]"#)
        #expect(root.components[PhysicsJointsComponent.self]?.joints.isEmpty == true)
        scene.dispose()
    }

    @Test
    func detachedObjectsAreNeitherSyncedNorRaycastable() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 950, "mesh", "wall"],
              ["geometry", 950, { "type": "BoxGeometry", "parameters": {"width":0.5,"height":0.5,"depth":0.02} },
               new Float32Array(0), null, null, null],
              ["transform", 950, 0, 0, -0.5, 0, 0, 0, 1, 1, 1, 1],
              ["rigidBody", 950, { "type": "dynamic", "mass": 1, "shape": "box" }]
            ]
            """)
        let applier = scene.commandApplier
        applier.sampleBodyMotion(deltaTime: 1.0 / 60)
        #expect(!applier.nativeDrivenSyncRecords().isEmpty)
        #expect(!applier.raycast(origin: .zero, direction: SIMD3(0, 0, -1), maxDistance: 2).isEmpty)

        scene.applyCommands(javaScript: #"[["parent", 950, -1]]"#)
        #expect(applier.nativeDrivenSyncRecords().isEmpty, "a detached body was synced back")
        #expect(
            applier.raycast(origin: .zero, direction: SIMD3(0, 0, -1), maxDistance: 2).isEmpty,
            "a detached mesh was raycastable"
        )
        scene.dispose()
    }

    @Test
    func invisibleObjectsAreNotRaycastable() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 960, "mesh", "hidden"],
              ["geometry", 960, { "type": "BoxGeometry", "parameters": {"width":0.5,"height":0.5,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["transform", 960, 0, 0, -0.5, 0, 0, 0, 1, 1, 1, 1],
              ["visible", 960, false]
            ]
            """)
        let applier = scene.commandApplier
        #expect(applier.raycast(origin: .zero, direction: SIMD3(0, 0, -1), maxDistance: 3).isEmpty)
        scene.applyCommands(javaScript: #"[["visible", 960, true]]"#)
        #expect(!applier.raycast(origin: .zero, direction: SIMD3(0, 0, -1), maxDistance: 3).isEmpty)
        scene.dispose()
    }

    @Test
    func nonFiniteOpacityIsRefused() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["create", 970, "group", "ghost"], ["opacity", 970, NaN]]
            """)
        let entity = try #require(scene.commandApplier.entity(for: 970))
        #expect(entity.components[OpacityComponent.self] == nil)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("finite") })

        scene.applyCommands(javaScript: #"[["opacity", 970, 0.5]]"#)
        #expect(entity.components[OpacityComponent.self]?.opacity == 0.5)
        scene.dispose()
    }

    @Test
    func theMaterialCacheIsBounded() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: #"[["create", 980, "mesh", "tween"]]"#)
        scene.applyCommands(javaScript: """
            [["geometry", 980, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
              new Float32Array(0), null, null, null]]
            """)
        // A tweened colour mints a new key every frame.
        for step in 0..<(ScriptingResourceCache.capacity + 200) {
            let value = Double(step) / 10000
            scene.applyCommands(javaScript: """
                [["material", 980, { "type": "MeshStandardMaterial", "uuid": "tweened",
                  "color": [\(value), 0.4, 0.8], "opacity": 1, "metalness": 0, "roughness": 1,
                  "maps": {} }]]
                """)
        }
        let cached = scene.commandApplier.resources.summary["cachedMaterials"] ?? 0
        #expect(cached <= ScriptingResourceCache.capacity, "the material cache grew unbounded")
        scene.dispose()
    }

    @Test
    func releasingATextureFreesItAndIgnoresItsLoad() throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var events: [String] = []
        scene.commandApplier.dispatch = { type, _, _ in events.append(type) }
        scene.applyCommands(javaScript: """
            [["texture", 990, { "url": "asset://gone", "repeat": [1, 1], "offset": [0, 0],
              "wrapS": 1000, "wrapT": 1000, "flipY": true }]]
            """)
        #expect(scene.commandApplier.textures.entry(for: 990) != nil)

        scene.applyCommands(javaScript: #"[["texture", 990, null]]"#)
        #expect(scene.commandApplier.textures.entry(for: 990) == nil)
        #expect(scene.commandApplier.textures.resource(for: 990) == nil)
        #expect(!events.contains("textureLoaded"))
        scene.dispose()
    }

    @Test
    func aRealityViewTeardownReleasesEveryScene() throws {
        weak var weakScene: JavaScriptScene?
        do {
            let root = Entity()
            let scene = try JavaScriptScene(
                rootEntity: root,
                source: "const stage = new Spatial.Scene(); Spatial.mount(stage);"
            )
            scene.tick(deltaTime: 1.0 / 60)
            weakScene = scene
            // No dispose: the view went away and only the router still holds it.
            ScriptingInputRouter.shared.reset()
        }
        #expect(weakScene == nil, "the input router is still retaining the scene")
        #expect(ScriptingInputRouter.shared.pointerRayProvider == nil)
    }

    @Test
    func edgeInputIsSharedByEveryScene() throws {
        let router = ScriptingInputRouter.shared
        router.reset()
        let first = UUID()
        let second = UUID()
        router.beginFrame()
        let a = router.inputState(for: first)
        let b = router.inputState(for: second)
        // Both scenes see the same frame, not one swallowing the edge state.
        let aMouse = a["mouse"] as? [String: Any]
        let bMouse = b["mouse"] as? [String: Any]
        #expect(aMouse?["delta"] as? [Double] == bMouse?["delta"] as? [Double])
        #expect(
            (a["keyboard"] as? [String: Any])?["pressed"] as? [String]
                == (b["keyboard"] as? [String: Any])?["pressed"] as? [String]
        )
        router.reset()
    }

}
