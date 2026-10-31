//
//  HostTransportTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import AVFoundation
import Foundation
import RealityKit
import Testing
@testable import SpatialScriptRuntime

/// SPEC 11, 14.3, 14.8, 14.10 and 14.13a: the camera a script owns, the host
/// channel, the console stream, and what a parity plan is allowed to see.
@MainActor
struct HostTransportTests {
    private func makeScene(_ body: String = "") throws -> (Entity, JavaScriptScene) {
        try ScriptingTestScene.make(body)
    }

    /// P2-B-22 and P2-B-23: SPEC 14.3 puts the camera component on the object
    /// the command names, and destroying that object gives the consumer's own
    /// camera back.
    @Test
    func theCameraComponentGoesOnTheObjectTheCommandNames() throws {
        let (_, scene) = try makeScene()
        let fallback = Entity()
        ScriptingRuntime.defaultCameraEntity = fallback
        scene.applyCommands(javaScript: """
            [["create", 5, "group", "eye"],
             ["camera", 5, { "kind": "perspective", "fov": 40, "near": 0.1, "far": 50 }]]
            """)
#if !os(visionOS)
        let camera = try #require(scene.commandApplier.records[5]?.entity)
        #expect(camera.components[PerspectiveCameraComponent.self] != nil, "no transform matching")
        #expect(scene.commandApplier.cameraRecordID == 5)
        #expect(!fallback.isEnabled)

        // Destroying the camera object gives the built-in camera back.
        scene.applyCommands(javaScript: """
            [["destroy", 5]]
            """)
        #expect(scene.commandApplier.cameraEntity == nil)
        #expect(fallback.isEnabled, "the window would render through nothing")

        // SPEC 14.13: a null kind restores it too.
        scene.applyCommands(javaScript: """
            [["create", 6, "group", "eye2"],
             ["camera", 6, { "kind": "perspective", "fov": 40 }]]
            """)
        #expect(!fallback.isEnabled)
        scene.applyCommands(javaScript: """
            [["camera", 0, { "kind": null }]]
            """)
        #expect(fallback.isEnabled)
        #expect(scene.commandApplier.cameraSpec == nil)
#endif
        ScriptingRuntime.defaultCameraEntity = nil
        scene.dispose()
    }

    /// P2-B-38 and P2-B-44: controller ids a harness sees are the reproducible
    /// `controller-<slot>` shape, and a rumble this platform cannot produce
    /// says so instead of doing nothing quietly.
    @Test
    func controllerIdsAreReproducibleAndAnUnsupportedRumbleWarns() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["controllerRumble", 0, "controller-0", 0.5, 0.2]]
            """)
        #expect(
            scene.commandApplier.warnings.warnings.contains { $0.contains("no haptics") },
            "a rumble that did nothing said nothing"
        )
        // No hardware is attached, so the reproducible default id shape is what
        // a harness sees.
        ScriptingInputRouter.shared.injectControllers([["name": "Pad"]])
        let normalized = ScriptingInputRouter.shared.controllerSnapshot()
        #expect(normalized.first?["id"] as? String == "controller-0")
        #expect((normalized.first?["buttons"] as? [String: Any])?["a"] as? Double == 0)
        #expect((normalized.first?["leftThumbstick"] as? [Double])?.count == 2)
        ScriptingInputRouter.shared.injectControllers(nil)
        scene.dispose()
    }

    /// P2-C-05: SPEC 14.10's `setHostFunctions` reaches a script that is already
    /// running, so a function registered after the load still appears in
    /// `Spatial.host.functions`.
    @Test
    func setHostFunctionsReachesTheScriptAfterLoad() throws {
        let (_, scene) = try makeScene()
        scene.tick(deltaTime: 1.0 / 60)
        #expect((scene.dump()["hostFunctions"] as? [String])?.isEmpty ?? true)

        // A registration made after the script is running still shows up.
        ScriptingRuntime.register(module: "Late", function: "call") { _ in nil }
        scene.setHostFunctions(ScriptingRuntime.hostFunctionNames)
        scene.tick(deltaTime: 1.0 / 60)
        #expect((scene.dump()["hostFunctions"] as? [String])?.contains("Late.call") == true)
        ScriptingRuntime.unregister(module: "Late", function: "call")
        scene.dispose()
    }

    /// The console is one stream, in the order the core produced the lines. A
    /// warning the core emits inside a tick comes before an error thrown in a
    /// microtask after it — the core writes both, but its log lines travel with
    /// the next command batch while a caught exception used to be written to
    /// the console the instant it was caught, which put the error first.
    @Test
    func aWarningEmittedInATickPrecedesAnErrorThrownAfterIt() throws {
        let root = Entity()
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: """
                const Spatial = require("spatial");
                const S = Spatial;
                const scene = new S.Scene();
                const box = new S.Mesh(new S.BoxGeometry(0.2, 0.2, 0.2), new S.MeshStandardMaterial());
                box.name = "box";
                scene.add(box);
                box.addEventListener("tap", () => {
                  // The core writes this line into the batch the next tick
                  // applies...
                  console.warn("first: emitted while the core dispatched");
                  // ... and this throw is caught by the host on the way out of
                  // the same call, before that batch exists.
                  throw new Error("second: thrown in the same turn");
                });
                S.mount(scene);
                """,
            assetRoot: Phase2Tests.assetRoot
        )
        scene.tick(deltaTime: 1.0 / 60)
        let id = try #require(scene.objectID(named: "box"))
        scene.dispatch(type: "tap", id: id, payload: [:])
        for _ in 0..<3 { scene.tick(deltaTime: 1.0 / 60) }
        let lines = scene.logLines.filter { $0.contains("first:") || $0.contains("second:") }
        let first = try #require(lines.firstIndex { $0.contains("first:") })
        let second = try #require(lines.firstIndex { $0.contains("second:") })
        #expect(first < second, "the console is out of order: \(lines)")
        #expect(lines[first].hasPrefix("warn: "))
        #expect(lines[second].hasPrefix("error: "))
        scene.dispose()
    }

    @Test
    func aParityPlanSeesOnlyInjectedInput() async throws {
        let router = ScriptingInputRouter.shared
        let (_, scene) = try makeScene()
        router.updatePointer(location: CGPoint(x: 12, y: 8))
        router.setMouseButton(0, down: true)
        router.beginFrame()
        let live = router.inputState(for: scene.sceneID)
        #expect((live["mouse"] as? [String: Any])?["position"] as? [Double] == [12, 8])

        // While a plan runs the live pointer is excluded, so the same plan
        // produces the same frames whatever the developer is doing.
        let outcome = await ScriptingParityPlan.run(
            [["inject": "controller", "state": ["id": "pad-1", "name": "Pad"]]],
            on: scene,
            deltaTime: 1.0 / 60
        )
        #expect(outcome.errors.isEmpty)
        router.suppressesLiveInput = true
        router.beginFrame()
        let planned = router.inputState(for: scene.sceneID)
        let mouse = try #require(planned["mouse"] as? [String: Any])
        #expect(mouse["position"] is NSNull)
        #expect(mouse["connected"] as? Bool == false)
        #expect((planned["keyboard"] as? [String: Any])?["connected"] as? Bool == false)
        // An injected controller is scripted input, so it survives.
        #expect((planned["controllers"] as? [[String: Any]])?.first?["id"] as? String == "pad-1")

        router.suppressesLiveInput = false
        router.injectControllers(nil)
        router.updatePointer(location: nil)
        router.setMouseButton(0, down: false)
        ScriptingRuntime.isPaused = false
        scene.clearPlanBudget()
        scene.dispose()
    }
}
